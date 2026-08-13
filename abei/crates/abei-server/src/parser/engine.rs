use std::collections::BTreeMap;
use std::io::{Cursor, Read};
use std::net::IpAddr;
use std::path::Path;
use std::process::Stdio;
use std::time::Instant;

use calamine::{Data, Reader, open_workbook_auto_from_rs};
use encoding_rs::Encoding;
use futures_util::StreamExt;
use globset::Glob;
use mail_parser::{Address, MessageParser, MimeHeaders, PartType};
use regex::Regex;
use scraper::{ElementRef, Html, Selector};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tempfile::tempdir;
use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time};
use tokio::fs;
use tokio::process::Command;
use tokio::time::{Duration, timeout};
use zip::ZipArchive;
use zip::result::ZipError;

use super::definition;
use super::model::{
    Artifact, ArtifactKind, ArtifactRef, ArtifactSelector, ArtifactSource, BillDocumentDraft,
    BillRowDraft, Diagnostic, InvalidRow, MailMetadata, MailPackage, Node, NodeResult,
    ParseMetrics, ParseOutput, ParserFlowDefinition, RawRecord, RowCondition, Severity,
    SourceLocator, TableParser, TextOperator,
};
use super::script;

const MAX_EML_BYTES: usize = 25 * 1024 * 1024;
const MAX_ARTIFACT_BYTES: usize = 25 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 128;
const MAX_ARCHIVE_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECORDS: usize = 10_000;
const MAX_COLUMNS: usize = 128;
const PREVIEW_ITEMS: usize = 25;
const PDF_TIMEOUT: Duration = Duration::from_secs(15);
const SECRET_REJECTED_MARKER: &str = "[secret_rejected]";

pub(crate) fn is_secret_rejected(error: &str) -> bool {
    error.contains(SECRET_REJECTED_MARKER)
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ParseContext {
    pub timezone: String,
    pub secrets: BTreeMap<String, String>,
}

pub(crate) async fn execute(
    definition: &ParserFlowDefinition,
    raw_eml: &[u8],
    context: &ParseContext,
) -> Result<ParseOutput, String> {
    definition::validate(definition)?;
    let started = Instant::now();
    let package = package_from_eml(raw_eml)?;
    let input_artifacts = package.artifacts.len();
    let mut artifacts = package.artifacts.clone();
    let mut data = PipelineData::Package(Box::new(package));
    let mut invalid_rows = Vec::new();
    let mut warnings = Vec::new();
    let mut node_results = Vec::new();
    let timezone = if context.timezone.trim().is_empty() {
        "UTC"
    } else {
        context.timezone.trim()
    };

    for node in definition.nodes.iter().filter(|node| node.enabled) {
        let node_started = Instant::now();
        let input_count = data.count();
        let execution = execute_node(
            &node.id,
            &node.operation,
            data,
            &context.secrets,
            timezone,
            &definition.output.require,
        )
        .await
        .map_err(|error| format!("节点 {} ({})：{error}", node.id, node.operation.kind()))?;
        for artifact in execution.data.artifacts() {
            if !artifacts
                .iter()
                .any(|known| known.reference.id == artifact.reference.id)
            {
                artifacts.push(artifact.clone());
            }
        }
        data = execution.data;
        invalid_rows.extend(execution.invalid_rows);
        warnings.extend(execution.diagnostics.clone());
        node_results.push(NodeResult {
            node_id: node.id.clone(),
            node_type: node.operation.kind().to_owned(),
            duration_ms: node_started.elapsed().as_millis() as u64,
            input_count,
            output_count: data.count(),
            diagnostics: execution.diagnostics,
            preview: data.preview(),
        });
    }

    let PipelineData::Drafts(valid_rows) = data else {
        return Err("流程没有产出 BillRowDraft。".to_owned());
    };
    let records = valid_rows.len() + invalid_rows.len();
    Ok(ParseOutput {
        document: BillDocumentDraft {
            channel_key: definition.channel_key.clone(),
            statement_kind: definition.statement_kind.clone(),
            declared_row_count: u32::try_from(records).ok(),
            ..BillDocumentDraft::default()
        },
        metrics: ParseMetrics {
            duration_ms: started.elapsed().as_millis() as u64,
            input_artifacts,
            records,
            valid_rows: valid_rows.len(),
            invalid_rows: invalid_rows.len(),
        },
        valid_rows,
        invalid_rows,
        warnings,
        node_results,
        artifacts,
    })
}

pub(crate) fn package_from_eml(raw: &[u8]) -> Result<MailPackage, String> {
    if raw.is_empty() || raw.len() > MAX_EML_BYTES {
        return Err("EML 必须非空且不能超过 25 MiB。".to_owned());
    }
    let message = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| "EML/MIME 无法解析。".to_owned())?;
    let mut artifacts = Vec::new();

    let text_body = message.body_text(0).map(|body| {
        let artifact = make_artifact(
            ArtifactKind::TextBody,
            "text/plain; charset=utf-8",
            "body.txt",
            None,
            body.as_bytes().to_vec(),
            artifacts.len(),
        );
        let reference = artifact.reference.clone();
        artifacts.push(artifact);
        reference
    });
    let html_body = message.body_html(0).map(|body| {
        let artifact = make_artifact(
            ArtifactKind::HtmlBody,
            "text/html; charset=utf-8",
            "body.html",
            None,
            body.as_bytes().to_vec(),
            artifacts.len(),
        );
        let reference = artifact.reference.clone();
        artifacts.push(artifact);
        reference
    });

    let mut attachments = Vec::new();
    for (position, part) in message.attachments().enumerate() {
        let Some(bytes) = part_bytes(&part.body) else {
            continue;
        };
        if bytes.len() > MAX_ARTIFACT_BYTES {
            return Err(format!("附件 {} 超过 25 MiB。", position + 1));
        }
        let filename = safe_filename(
            part.attachment_name()
                .unwrap_or(&format!("attachment-{}", position + 1)),
        );
        let mime = part
            .content_type()
            .map(content_type_string)
            .unwrap_or_else(|| mime_from_filename(&filename).to_owned());
        let artifact = make_artifact(
            ArtifactKind::Attachment,
            &mime,
            &filename,
            None,
            bytes,
            artifacts.len(),
        );
        attachments.push(artifact.reference.clone());
        artifacts.push(artifact);
    }

    let from = message
        .from()
        .and_then(Address::first)
        .and_then(|address| address.address.as_deref())
        .map(str::to_owned);
    let to = message
        .to()
        .map(|addresses| {
            addresses
                .iter()
                .filter_map(|address| address.address.as_deref())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut headers = BTreeMap::new();
    insert_header(&mut headers, "message-id", message.message_id());
    insert_header(&mut headers, "subject", message.subject());
    insert_header(&mut headers, "from", from.as_deref());

    Ok(MailPackage {
        message: MailMetadata {
            message_id: message.message_id().map(str::to_owned),
            from,
            to,
            subject: message.subject().map(str::to_owned),
            received_at: message.date().map(ToString::to_string),
            headers,
        },
        text_body,
        html_body,
        attachments,
        artifacts,
    })
}

enum PipelineData {
    Package(Box<MailPackage>),
    Artifacts(Vec<Artifact>),
    Links(Vec<DownloadLink>),
    Records(Vec<RawRecord>),
    Drafts(Vec<BillRowDraft>),
}

impl PipelineData {
    fn artifacts(&self) -> &[Artifact] {
        match self {
            Self::Package(package) => &package.artifacts,
            Self::Artifacts(values) => values,
            Self::Links(_) | Self::Records(_) | Self::Drafts(_) => &[],
        }
    }

    fn count(&self) -> usize {
        match self {
            Self::Package(package) => package.artifacts.len(),
            Self::Artifacts(values) => values.len(),
            Self::Links(values) => values.len(),
            Self::Records(values) => values.len(),
            Self::Drafts(values) => values.len(),
        }
    }

    fn preview(&self) -> Value {
        match self {
            Self::Package(package) => json!({
                "message": package.message,
                "artifacts": package.artifacts.iter().take(PREVIEW_ITEMS)
                    .map(|artifact| &artifact.reference).collect::<Vec<_>>(),
            }),
            Self::Artifacts(values) => serde_json::to_value(
                values
                    .iter()
                    .take(PREVIEW_ITEMS)
                    .map(|value| &value.reference)
                    .collect::<Vec<_>>(),
            )
            .unwrap_or_else(|_| json!([])),
            Self::Links(values) => {
                serde_json::to_value(values.iter().take(PREVIEW_ITEMS).collect::<Vec<_>>())
                    .unwrap_or_else(|_| json!([]))
            }
            Self::Records(values) => {
                serde_json::to_value(values.iter().take(PREVIEW_ITEMS).collect::<Vec<_>>())
                    .unwrap_or_else(|_| json!([]))
            }
            Self::Drafts(values) => {
                serde_json::to_value(values.iter().take(PREVIEW_ITEMS).collect::<Vec<_>>())
                    .unwrap_or_else(|_| json!([]))
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct DownloadLink {
    url: String,
    source: SourceLocator,
}

struct NodeExecution {
    data: PipelineData,
    invalid_rows: Vec<InvalidRow>,
    diagnostics: Vec<Diagnostic>,
}

impl NodeExecution {
    fn data(data: PipelineData) -> Self {
        Self {
            data,
            invalid_rows: Vec::new(),
            diagnostics: Vec::new(),
        }
    }
}

async fn execute_node(
    node_id: &str,
    node: &Node,
    data: PipelineData,
    secrets: &BTreeMap<String, String>,
    timezone: &str,
    output_requirements: &[String],
) -> Result<NodeExecution, String> {
    match node {
        Node::FirstAvailable { choices, required } => {
            let package = expect_package(data)?;
            let selected = first_available(&package, choices)?;
            selected_from_package(package, selected, *required)
        }
        Node::SelectTextBody { required } => {
            let package = expect_package(data)?;
            let selected = package.text_body.iter().cloned().collect();
            selected_from_package(package, selected, *required)
        }
        Node::SelectHtmlBody { required } => {
            let package = expect_package(data)?;
            let selected = package.html_body.iter().cloned().collect();
            selected_from_package(package, selected, *required)
        }
        Node::SelectAttachment {
            filename,
            mime,
            required,
        } => {
            let package = expect_package(data)?;
            let filename = compile_optional_glob(filename.as_deref())?;
            let selected = package
                .attachments
                .iter()
                .filter(|reference| artifact_matches(reference, filename.as_ref(), mime.as_deref()))
                .cloned()
                .collect::<Vec<_>>();
            selected_from_package(package, selected, *required)
        }
        Node::SelectArtifact {
            filename,
            mime,
            required,
        } => {
            let filename = compile_optional_glob(filename.as_deref())?;
            let selected = expect_artifacts(data)?
                .into_iter()
                .filter(|artifact| {
                    artifact_matches(&artifact.reference, filename.as_ref(), mime.as_deref())
                })
                .collect::<Vec<_>>();
            require_nonempty(selected, *required, "没有找到符合条件的工件")
        }
        Node::ExtractLinks { selector } => {
            let mut links = Vec::new();
            for artifact in expect_artifacts(data)? {
                links.extend(extract_links(&artifact, selector.as_deref())?);
                if links.len() > MAX_RECORDS {
                    return Err("单次解析最多提取 10,000 个链接。".to_owned());
                }
            }
            Ok(NodeExecution::data(PipelineData::Links(links)))
        }
        Node::Download {
            allowed_domains,
            timeout_seconds,
            max_bytes,
        } => {
            let mut artifacts = Vec::new();
            for (position, link) in expect_links(data)?.into_iter().enumerate() {
                artifacts.push(
                    download_link(
                        &link,
                        allowed_domains,
                        Duration::from_secs(*timeout_seconds),
                        *max_bytes,
                        position,
                    )
                    .await?,
                );
            }
            Ok(NodeExecution::data(PipelineData::Artifacts(artifacts)))
        }
        Node::DecodeText { candidates } => {
            let artifacts = expect_artifacts(data)?;
            let mut decoded = Vec::with_capacity(artifacts.len());
            for (position, artifact) in artifacts.into_iter().enumerate() {
                let text = decode_text(&artifact.bytes, candidates)?;
                decoded.push(make_artifact(
                    ArtifactKind::DecodedText,
                    "text/plain; charset=utf-8",
                    &artifact.reference.filename,
                    Some(artifact.reference.id.clone()),
                    text.into_bytes(),
                    position,
                ));
            }
            Ok(NodeExecution::data(PipelineData::Artifacts(decoded)))
        }
        Node::Unzip { password_key } => {
            let password = password_key
                .as_ref()
                .map(|key| {
                    secrets
                        .get(key)
                        .map(String::as_str)
                        .ok_or_else(|| format!("缺少 ZIP 密钥 {key}。"))
                })
                .transpose()?;
            let mut extracted = Vec::new();
            for artifact in expect_artifacts(data)? {
                extracted.extend(unzip_artifact(&artifact, password)?);
                if extracted.len() > MAX_ARCHIVE_ENTRIES {
                    return Err("ZIP 展开后的文件总数超过 128。".to_owned());
                }
            }
            Ok(NodeExecution::data(PipelineData::Artifacts(extracted)))
        }
        Node::PdfToText { password_key } => {
            let password = password_key
                .as_ref()
                .map(|key| {
                    secrets
                        .get(key)
                        .map(String::as_str)
                        .ok_or_else(|| format!("缺少 PDF 密钥 {key}。"))
                })
                .transpose()?;
            let mut converted = Vec::new();
            for (position, artifact) in expect_artifacts(data)?.into_iter().enumerate() {
                let text = pdf_to_text(&artifact.bytes, password).await?;
                converted.push(make_artifact(
                    ArtifactKind::PdfText,
                    "text/plain; charset=utf-8",
                    &format!("{}.txt", artifact.reference.filename),
                    Some(artifact.reference.id.clone()),
                    text,
                    position,
                ));
            }
            Ok(NodeExecution::data(PipelineData::Artifacts(converted)))
        }
        Node::CsvTable {
            delimiter,
            header_contains,
        } => {
            let delimiter = delimiter
                .as_deref()
                .map(|value| value.as_bytes()[0])
                .unwrap_or(b',');
            let mut records = Vec::new();
            for artifact in expect_artifacts(data)? {
                records.extend(csv_records(&artifact, delimiter, header_contains)?);
                enforce_record_limit(records.len())?;
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::XlsxSheet {
            sheet,
            header_contains,
        } => {
            let mut records = Vec::new();
            for artifact in expect_artifacts(data)? {
                records.extend(xlsx_records(&artifact, sheet.as_deref(), header_contains)?);
                enforce_record_limit(records.len())?;
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::HtmlTable { selector } => {
            let mut records = Vec::new();
            for artifact in expect_artifacts(data)? {
                records.extend(html_table_records(&artifact, selector)?);
                enforce_record_limit(records.len())?;
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::HtmlElements {
            row_selector,
            fields,
            document_fields,
        } => {
            let mut records = Vec::new();
            for artifact in expect_artifacts(data)? {
                records.extend(html_element_records(
                    &artifact,
                    row_selector,
                    fields,
                    document_fields,
                )?);
                enforce_record_limit(records.len())?;
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::TextLines {
            start_contains,
            end_contains,
            skip_empty,
            field,
        } => {
            let mut records = Vec::new();
            for artifact in expect_artifacts(data)? {
                records.extend(text_line_records(
                    &artifact,
                    start_contains.as_deref(),
                    end_contains.as_deref(),
                    *skip_empty,
                    field,
                )?);
                enforce_record_limit(records.len())?;
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::FixedWidthTable {
            columns,
            skip_contains,
        } => {
            let mut records = Vec::new();
            for artifact in expect_artifacts(data)? {
                let text = utf8_text(&artifact)?;
                for (line_index, line) in text.lines().enumerate() {
                    if line.trim().is_empty()
                        || skip_contains.iter().any(|value| line.contains(value))
                    {
                        continue;
                    }
                    let characters = line.chars().collect::<Vec<_>>();
                    let fields = columns
                        .iter()
                        .map(|column| {
                            let end = column.end.unwrap_or(characters.len()).min(characters.len());
                            let value = if column.start < end {
                                characters[column.start..end].iter().collect::<String>()
                            } else {
                                String::new()
                            };
                            (column.name.clone(), clean_text(&value))
                        })
                        .collect();
                    records.push(RawRecord {
                        fields,
                        locator: locator(&artifact.reference.id, Some((line_index + 1) as u32)),
                    });
                }
                enforce_record_limit(records.len())?;
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::WhitespaceTable {
            columns,
            first_column_regex,
            min_columns,
        } => {
            let mut records = Vec::new();
            for artifact in expect_artifacts(data)? {
                records.extend(whitespace_table_records(
                    &artifact,
                    columns,
                    first_column_regex.as_deref(),
                    min_columns.unwrap_or(columns.len()),
                )?);
                enforce_record_limit(records.len())?;
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::Switch { cases, required } => {
            let mut records = Vec::new();
            let mut matched = 0_usize;
            for artifact in expect_artifacts(data)? {
                let mut selected_case = None;
                for case in cases {
                    let filename = compile_optional_glob(case.filename.as_deref())?;
                    if artifact_matches(
                        &artifact.reference,
                        filename.as_ref(),
                        case.mime.as_deref(),
                    ) {
                        selected_case = Some(case);
                        break;
                    }
                }
                if let Some(case) = selected_case {
                    matched += 1;
                    records.extend(parse_table_artifact(&artifact, &case.parser)?);
                    enforce_record_limit(records.len())?;
                }
            }
            if *required && matched == 0 {
                return Err("没有工件命中任何 switch 分支。".to_owned());
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::GroupRows {
            count,
            start,
            end,
            separator,
        } => {
            let records = group_rows(
                expect_records(data)?,
                *count,
                start.as_ref(),
                end.as_ref(),
                separator,
            )?;
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::SplitRows {
            field,
            delimiter,
            target,
            trim,
            skip_empty,
        } => {
            let records = split_rows(
                expect_records(data)?,
                field,
                delimiter,
                target.as_deref().unwrap_or(field),
                *trim,
                *skip_empty,
            )?;
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::RenameFields { mapping } => {
            let mut records = expect_records(data)?;
            for record in &mut records {
                for (source, target) in mapping {
                    if source == target {
                        continue;
                    }
                    if let Some(value) = record.fields.remove(source) {
                        record.fields.insert(target.clone(), value);
                    }
                }
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::PickFields { fields } => {
            let mut records = expect_records(data)?;
            for record in &mut records {
                record.fields.retain(|key, _| fields.contains(key));
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::JoinFields {
            target,
            sources,
            separator,
        } => {
            let mut records = expect_records(data)?;
            for record in &mut records {
                let value = sources
                    .iter()
                    .filter_map(|source| record.fields.get(source))
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join(separator);
                record.fields.insert(target.clone(), value);
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::SetConstant { values } => {
            let mut records = expect_records(data)?;
            for record in &mut records {
                record.fields.extend(values.clone());
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::MapValues {
            field,
            values,
            default,
        } => {
            let mut records = expect_records(data)?;
            for record in &mut records {
                let mapped = record
                    .fields
                    .get(field)
                    .and_then(|value| values.get(value))
                    .cloned()
                    .or_else(|| default.clone());
                if let Some(value) = mapped {
                    record.fields.insert(field.clone(), value);
                }
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::NormalizeText { fields } => {
            let mut records = expect_records(data)?;
            for record in &mut records {
                for field in fields {
                    if let Some(value) = record.fields.get_mut(field) {
                        *value = clean_text(value);
                    }
                }
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::FilterRows {
            field,
            operator,
            value,
        } => {
            let regex = matches!(operator, TextOperator::Regex)
                .then(|| Regex::new(value).map_err(|error| error.to_string()))
                .transpose()?;
            let records = expect_records(data)?
                .into_iter()
                .filter(|record| {
                    let actual = record.fields.get(field).map(String::as_str).unwrap_or("");
                    match operator {
                        TextOperator::Equals => actual == value,
                        TextOperator::Contains => actual.contains(value),
                        TextOperator::Prefix => actual.starts_with(value),
                        TextOperator::Suffix => actual.ends_with(value),
                        TextOperator::Regex => {
                            regex.as_ref().is_some_and(|regex| regex.is_match(actual))
                        }
                    }
                })
                .collect();
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::ParseMoney {
            source,
            target,
            negative_when,
        } => {
            let mut records = expect_records(data)?;
            for record in &mut records {
                let raw = record.fields.get(source).cloned().unwrap_or_default();
                let mut amount = script::normalize_money(&raw)?;
                let negative = negative_when.iter().any(|(field, values)| {
                    record
                        .fields
                        .get(field)
                        .is_some_and(|value| values.contains(value))
                });
                if negative && !amount.starts_with('-') && amount != "0" {
                    amount.insert(0, '-');
                }
                record.fields.insert(target.clone(), amount);
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::ParseDate {
            source,
            target,
            formats,
            timezone: _,
        } => {
            let mut records = expect_records(data)?;
            for record in &mut records {
                let raw = record.fields.get(source).cloned().unwrap_or_default();
                let parsed = normalize_date(&raw, formats)?;
                record.fields.insert(target.clone(), parsed);
            }
            Ok(NodeExecution::data(PipelineData::Records(records)))
        }
        Node::ValidateRows { required } => {
            let mut valid = Vec::new();
            let mut invalid = Vec::new();
            for record in expect_records(data)? {
                let missing = required
                    .iter()
                    .filter(|field| {
                        record
                            .fields
                            .get(*field)
                            .is_none_or(|value| value.trim().is_empty())
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                if missing.is_empty() {
                    valid.push(record);
                } else {
                    invalid.push(invalid_record(
                        record,
                        node_id,
                        "required_fields_missing",
                        format!("缺少必填字段：{}", missing.join("、")),
                    ));
                }
            }
            Ok(NodeExecution {
                data: PipelineData::Records(valid),
                invalid_rows: invalid,
                diagnostics: Vec::new(),
            })
        }
        Node::TransformScript { source } => {
            let transformed =
                script::transform_records(source, &expect_records(data)?, timezone, node_id)?;
            Ok(NodeExecution {
                data: PipelineData::Records(transformed.records),
                invalid_rows: Vec::new(),
                diagnostics: transformed.diagnostics,
            })
        }
        Node::NormalizeBillRows { default_currency } => {
            let mut valid = Vec::new();
            let mut invalid = Vec::new();
            for mut record in expect_records(data)? {
                record
                    .fields
                    .entry("currency_code".to_owned())
                    .or_insert_with(|| default_currency.clone());
                match normalize_bill_row(&record, output_requirements, node_id) {
                    Ok(row) => valid.push(row),
                    Err(issue) => invalid.push(InvalidRow {
                        locator: record.locator,
                        raw_fields: record.fields,
                        issues: vec![issue],
                    }),
                }
            }
            Ok(NodeExecution {
                data: PipelineData::Drafts(valid),
                invalid_rows: invalid,
                diagnostics: Vec::new(),
            })
        }
    }
}

fn expect_package(data: PipelineData) -> Result<MailPackage, String> {
    match data {
        PipelineData::Package(value) => Ok(*value),
        _ => Err("节点需要 MailPackage 输入。".to_owned()),
    }
}

fn expect_artifacts(data: PipelineData) -> Result<Vec<Artifact>, String> {
    match data {
        PipelineData::Artifacts(value) => Ok(value),
        _ => Err("节点需要 Artifact 输入。".to_owned()),
    }
}

fn expect_links(data: PipelineData) -> Result<Vec<DownloadLink>, String> {
    match data {
        PipelineData::Links(value) => Ok(value),
        _ => Err("节点需要链接输入。".to_owned()),
    }
}

fn expect_records(data: PipelineData) -> Result<Vec<RawRecord>, String> {
    match data {
        PipelineData::Records(value) => Ok(value),
        _ => Err("节点需要 RawRecord 输入。".to_owned()),
    }
}

fn first_available(
    package: &MailPackage,
    choices: &[ArtifactSelector],
) -> Result<Vec<ArtifactRef>, String> {
    for choice in choices {
        let filename = compile_optional_glob(choice.filename.as_deref())?;
        let candidates: Vec<&ArtifactRef> = match choice.source {
            ArtifactSource::TextBody => package.text_body.iter().collect(),
            ArtifactSource::HtmlBody => package.html_body.iter().collect(),
            ArtifactSource::Attachment => package.attachments.iter().collect(),
        };
        let selected = candidates
            .into_iter()
            .filter(|reference| {
                artifact_matches(reference, filename.as_ref(), choice.mime.as_deref())
            })
            .cloned()
            .collect::<Vec<_>>();
        if !selected.is_empty() {
            return Ok(selected);
        }
    }
    Ok(Vec::new())
}

fn selected_from_package(
    package: MailPackage,
    selected: Vec<ArtifactRef>,
    required: bool,
) -> Result<NodeExecution, String> {
    let ids = selected
        .iter()
        .map(|value| value.id.as_str())
        .collect::<Vec<_>>();
    let artifacts = package
        .artifacts
        .into_iter()
        .filter(|artifact| ids.contains(&artifact.reference.id.as_str()))
        .collect::<Vec<_>>();
    require_nonempty(artifacts, required, "邮件中没有找到所需内容")
}

fn require_nonempty(
    artifacts: Vec<Artifact>,
    required: bool,
    message: &str,
) -> Result<NodeExecution, String> {
    if required && artifacts.is_empty() {
        Err(format!("{message}。"))
    } else {
        Ok(NodeExecution::data(PipelineData::Artifacts(artifacts)))
    }
}

fn compile_optional_glob(pattern: Option<&str>) -> Result<Option<globset::GlobMatcher>, String> {
    pattern
        .map(|value| {
            Glob::new(value)
                .map(|glob| glob.compile_matcher())
                .map_err(|error| error.to_string())
        })
        .transpose()
}

fn artifact_matches(
    artifact: &ArtifactRef,
    filename: Option<&globset::GlobMatcher>,
    mime: Option<&str>,
) -> bool {
    filename.is_none_or(|pattern| pattern.is_match(&artifact.filename))
        && mime.is_none_or(|expected| mime_matches(&artifact.mime, expected))
}

fn mime_matches(actual: &str, expected: &str) -> bool {
    let actual = actual.split(';').next().unwrap_or(actual).trim();
    if let Some(prefix) = expected.strip_suffix("/*") {
        actual.starts_with(&format!("{prefix}/"))
    } else {
        actual.eq_ignore_ascii_case(expected)
    }
}

fn extract_links(artifact: &Artifact, selector: Option<&str>) -> Result<Vec<DownloadLink>, String> {
    let text = utf8_text(artifact)?;
    let mut urls = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    if artifact.reference.mime.starts_with("text/html") || selector.is_some() {
        let selector_text = selector.unwrap_or("a[href]");
        let compiled =
            Selector::parse(selector_text).map_err(|_| "链接 selector 不合法。".to_owned())?;
        let document = Html::parse_document(text);
        for (index, element) in document.select(&compiled).enumerate() {
            let Some(raw) = element.value().attr("href") else {
                continue;
            };
            if let Some(url) = absolute_web_url(raw)
                && seen.insert(url.clone())
            {
                urls.push(DownloadLink {
                    url,
                    source: SourceLocator {
                        artifact_id: Some(artifact.reference.id.clone()),
                        dom_path: Some(format!("{selector_text}:nth-of-type({})", index + 1)),
                        ..SourceLocator::default()
                    },
                });
            }
        }
    } else {
        let pattern = Regex::new(r#"https?://[^\s<>\"']+"#).expect("static URL regex");
        for (index, found) in pattern.find_iter(text).enumerate() {
            let raw = found
                .as_str()
                .trim_end_matches(['.', ',', ';', ')', ']', '}']);
            if let Some(url) = absolute_web_url(raw)
                && seen.insert(url.clone())
            {
                urls.push(DownloadLink {
                    url,
                    source: SourceLocator {
                        artifact_id: Some(artifact.reference.id.clone()),
                        row: Some((index + 1) as u32),
                        ..SourceLocator::default()
                    },
                });
            }
        }
    }
    Ok(urls)
}

fn absolute_web_url(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw.trim()).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.to_string())
}

async fn download_link(
    link: &DownloadLink,
    allowed_domains: &[String],
    request_timeout: Duration,
    max_bytes: usize,
    position: usize,
) -> Result<Artifact, String> {
    let url = reqwest::Url::parse(&link.url).map_err(|_| "账单链接不是有效 URL。".to_owned())?;
    if url.scheme() != "https" {
        return Err("账单下载只允许 HTTPS。".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("账单链接不能包含用户名或密码。".to_owned());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "账单链接缺少域名。".to_owned())?
        .to_ascii_lowercase();
    if !allowed_domains
        .iter()
        .any(|domain| domain_allows(domain, &host))
    {
        return Err(format!("下载域名 {host} 不在 allowlist。"));
    }
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "账单链接端口无法确定。".to_owned())?;
    if port != 443 {
        return Err("账单下载只允许 HTTPS 默认端口 443。".to_owned());
    }
    let addresses = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|_| format!("无法解析下载域名 {host}。"))?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(format!("下载域名 {host} 解析到非公网地址，已拒绝。"));
    }
    let client = reqwest::Client::builder()
        .connect_timeout(request_timeout.min(Duration::from_secs(10)))
        .timeout(request_timeout)
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(&host, &addresses)
        .build()
        .map_err(|error| format!("无法创建下载客户端：{error}"))?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("下载账单失败：{error}"))?;
    if response.status().is_redirection() {
        return Err("账单下载不允许 HTTP 重定向。".to_owned());
    }
    if !response.status().is_success() {
        return Err(format!("账单下载返回 HTTP {}。", response.status()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(format!("下载文件超过 {} 字节。", max_bytes));
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(';').next().unwrap_or(value).trim().to_owned())
        .unwrap_or_else(|| "application/octet-stream".to_owned());
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("下载账单正文失败：{error}"))?;
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            return Err(format!("下载文件超过 {} 字节。", max_bytes));
        }
        bytes.extend_from_slice(&chunk);
    }
    let filename = url
        .path_segments()
        .and_then(|mut segments| segments.rfind(|value| !value.is_empty()))
        .filter(|value| !value.is_empty())
        .unwrap_or("download.bin");
    Ok(make_artifact(
        ArtifactKind::Download,
        &mime,
        filename,
        link.source.artifact_id.clone(),
        bytes,
        position,
    ))
}

fn domain_allows(allowed: &str, host: &str) -> bool {
    host == allowed || host.ends_with(&format!(".{allowed}"))
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            !(address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_broadcast()
                || address.is_documentation()
                || address.is_unspecified()
                || address.is_multicast()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || (octets[0] == 198 && matches!(octets[1], 18 | 19))
                || octets[0] >= 240)
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            !(address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8))
        }
    }
}

fn decode_text(bytes: &[u8], candidates: &[String]) -> Result<String, String> {
    for candidate in candidates {
        if candidate.eq_ignore_ascii_case("utf-8") {
            if let Ok(value) = std::str::from_utf8(bytes) {
                return Ok(value.trim_start_matches('\u{feff}').to_owned());
            }
            continue;
        }
        let Some(encoding) = Encoding::for_label(candidate.as_bytes()) else {
            continue;
        };
        let (value, _, had_errors) = encoding.decode(bytes);
        if !had_errors {
            return Ok(value.trim_start_matches('\u{feff}').to_owned());
        }
    }
    Err(format!(
        "无法使用候选字符集 {} 解码文本。",
        candidates.join("、")
    ))
}

fn unzip_artifact(artifact: &Artifact, password: Option<&str>) -> Result<Vec<Artifact>, String> {
    let mut archive = ZipArchive::new(Cursor::new(&artifact.bytes))
        .map_err(|error| format!("ZIP 无法打开：{error}"))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("ZIP 文件数超过 128。".to_owned());
    }
    let mut total = 0_u64;
    let mut extracted = Vec::new();
    for index in 0..archive.len() {
        let mut file = match password {
            Some(password) => archive.by_index_decrypt(index, password.as_bytes()),
            None => archive.by_index(index),
        }
        .map_err(|error| match error {
            ZipError::InvalidPassword => format!(
                "{SECRET_REJECTED_MARKER} ZIP 密码不正确（第 {} 项）。",
                index + 1
            ),
            other => format!("ZIP 第 {} 项无法读取：{other}", index + 1),
        })?;
        if file.is_dir() {
            continue;
        }
        if file.is_symlink() {
            return Err(format!("ZIP 项 {} 是符号链接，已拒绝。", file.name()));
        }
        let path = file
            .enclosed_name()
            .ok_or_else(|| format!("ZIP 项 {} 路径越界。", file.name()))?;
        if file.size() > MAX_ARTIFACT_BYTES as u64 {
            return Err(format!("ZIP 项 {} 超过 25 MiB。", file.name()));
        }
        total = total
            .checked_add(file.size())
            .ok_or_else(|| "ZIP 展开大小溢出。".to_owned())?;
        if total > MAX_ARCHIVE_TOTAL_BYTES {
            return Err("ZIP 总展开大小超过 64 MiB。".to_owned());
        }
        let filename = safe_filename(path.to_string_lossy().as_ref());
        let mut bytes = Vec::with_capacity(file.size() as usize);
        file.by_ref()
            .take((MAX_ARTIFACT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                let message = error.to_string();
                if message.to_ascii_lowercase().contains("authentication") {
                    format!("{SECRET_REJECTED_MARKER} ZIP 密码不正确。")
                } else {
                    format!("ZIP 项 {filename} 解压失败：{message}")
                }
            })?;
        if bytes.len() > MAX_ARTIFACT_BYTES {
            return Err(format!("ZIP 项 {filename} 超过 25 MiB。"));
        }
        extracted.push(make_artifact(
            ArtifactKind::ArchiveEntry,
            mime_from_filename(&filename),
            &filename,
            Some(artifact.reference.id.clone()),
            bytes,
            index,
        ));
    }
    Ok(extracted)
}

async fn pdf_to_text(bytes: &[u8], password: Option<&str>) -> Result<Vec<u8>, String> {
    pdf_to_text_with(bytes, password, "pdftotext", PDF_TIMEOUT).await
}

async fn pdf_to_text_with(
    bytes: &[u8],
    password: Option<&str>,
    program: &str,
    process_timeout: Duration,
) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err("PDF 超过 25 MiB。".to_owned());
    }
    let directory = tempdir().map_err(|error| format!("无法创建 PDF 临时目录：{error}"))?;
    let input = directory.path().join("input.pdf");
    let output = directory.path().join("output.txt");
    fs::write(&input, bytes)
        .await
        .map_err(|error| format!("无法写入 PDF 临时文件：{error}"))?;
    let mut command = Command::new(program);
    command
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .arg("-layout")
        .arg("-enc")
        .arg("UTF-8");
    if let Some(password) = password {
        command.arg("-upw").arg(password);
    }
    command.arg(&input).arg(&output);
    let process_output = timeout(process_timeout, command.output())
        .await
        .map_err(|_| format!("pdftotext 执行超过 {} 毫秒。", process_timeout.as_millis()))?
        .map_err(|error| format!("无法启动 pdftotext：{error}"))?;
    if !process_output.status.success() {
        let stderr = String::from_utf8_lossy(&process_output.stderr);
        let normalized = stderr.to_ascii_lowercase();
        if normalized.contains("password")
            && (normalized.contains("incorrect")
                || normalized.contains("wrong")
                || normalized.contains("invalid"))
        {
            return Err(format!("{SECRET_REJECTED_MARKER} PDF 密码不正确。"));
        }
        let detail = stderr.trim().chars().take(300).collect::<String>();
        return Err(if detail.is_empty() {
            format!("pdftotext 退出，状态码 {}。", process_output.status)
        } else {
            format!("pdftotext 退出，状态码 {}：{detail}", process_output.status)
        });
    }
    let metadata = fs::metadata(&output)
        .await
        .map_err(|error| format!("pdftotext 没有生成文本：{error}"))?;
    if metadata.len() > MAX_ARTIFACT_BYTES as u64 {
        return Err("PDF 转换后的文本超过 25 MiB。".to_owned());
    }
    fs::read(output)
        .await
        .map_err(|error| format!("PDF 文本无法读取：{error}"))
}

fn parse_table_artifact(
    artifact: &Artifact,
    parser: &TableParser,
) -> Result<Vec<RawRecord>, String> {
    match parser {
        TableParser::CsvTable {
            delimiter,
            header_contains,
        } => csv_records(
            artifact,
            delimiter
                .as_deref()
                .and_then(|value| value.as_bytes().first().copied())
                .unwrap_or(b','),
            header_contains,
        ),
        TableParser::XlsxSheet {
            sheet,
            header_contains,
        } => xlsx_records(artifact, sheet.as_deref(), header_contains),
        TableParser::HtmlTable { selector } => html_table_records(artifact, selector),
    }
}

fn group_rows(
    records: Vec<RawRecord>,
    count: Option<usize>,
    start: Option<&RowCondition>,
    end: Option<&RowCondition>,
    separator: &str,
) -> Result<Vec<RawRecord>, String> {
    if let Some(count) = count {
        return records
            .chunks(count)
            .map(|group| merge_record_group(group, separator))
            .collect();
    }
    let (Some(start), Some(end)) = (start, end) else {
        return Err("group_rows 缺少分组条件。".to_owned());
    };
    let mut output = Vec::new();
    let mut current = Vec::new();
    for record in records {
        if current.is_empty() {
            if !row_condition_matches(&record, start)? {
                continue;
            }
            current.push(record);
        } else {
            current.push(record);
        }
        let closes = match current.last() {
            Some(record) => row_condition_matches(record, end)?,
            None => false,
        };
        if closes {
            output.push(merge_record_group(&current, separator)?);
            current.clear();
        }
    }
    if !current.is_empty() {
        return Err("group_rows 找到开始行，但在输入结束前没有找到结束行。".to_owned());
    }
    enforce_record_limit(output.len())?;
    Ok(output)
}

fn merge_record_group(group: &[RawRecord], separator: &str) -> Result<RawRecord, String> {
    let first = group
        .first()
        .ok_or_else(|| "不能合并空记录组。".to_owned())?;
    let mut values = BTreeMap::<String, Vec<String>>::new();
    for record in group {
        for (field, value) in &record.fields {
            if !value.trim().is_empty() {
                values.entry(field.clone()).or_default().push(value.clone());
            }
        }
    }
    let fields = values
        .into_iter()
        .map(|(field, values)| {
            let value = if values.iter().all(|value| value == &values[0]) {
                values[0].clone()
            } else {
                values.join(separator)
            };
            (field, value)
        })
        .collect();
    Ok(RawRecord {
        fields,
        locator: first.locator.clone(),
    })
}

fn split_rows(
    records: Vec<RawRecord>,
    field: &str,
    delimiter: &str,
    target: &str,
    trim: bool,
    skip_empty: bool,
) -> Result<Vec<RawRecord>, String> {
    let mut output = Vec::new();
    for record in records {
        let value = record.fields.get(field).cloned().unwrap_or_default();
        for part in value.split(delimiter) {
            let part = if trim { part.trim() } else { part };
            if skip_empty && part.is_empty() {
                continue;
            }
            let mut split = record.clone();
            split.fields.insert(target.to_owned(), part.to_owned());
            output.push(split);
            enforce_record_limit(output.len())?;
        }
    }
    Ok(output)
}

fn row_condition_matches(record: &RawRecord, condition: &RowCondition) -> Result<bool, String> {
    let actual = record
        .fields
        .get(&condition.field)
        .map(String::as_str)
        .unwrap_or("");
    Ok(match condition.operator {
        TextOperator::Equals => actual == condition.value,
        TextOperator::Contains => actual.contains(&condition.value),
        TextOperator::Prefix => actual.starts_with(&condition.value),
        TextOperator::Suffix => actual.ends_with(&condition.value),
        TextOperator::Regex => Regex::new(&condition.value)
            .map_err(|error| format!("regex 不合法：{error}"))?
            .is_match(actual),
    })
}

fn csv_records(
    artifact: &Artifact,
    delimiter: u8,
    header_contains: &[String],
) -> Result<Vec<RawRecord>, String> {
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .has_headers(false)
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(artifact.bytes.as_slice());
    let rows = reader
        .records()
        .take(MAX_RECORDS + 51)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("CSV 无法解析：{error}"))?;
    let header_index = find_header(rows.iter().map(|row| row.iter()), header_contains)?;
    let headers = rows[header_index]
        .iter()
        .enumerate()
        .map(|(index, value)| unique_header(value, index))
        .collect::<Vec<_>>();
    if headers.len() > MAX_COLUMNS {
        return Err("CSV 列数超过 128。".to_owned());
    }
    rows.into_iter()
        .enumerate()
        .skip(header_index + 1)
        .filter(|(_, row)| row.iter().any(|value| !value.trim().is_empty()))
        .take(MAX_RECORDS + 1)
        .map(|(index, row)| {
            let fields = headers
                .iter()
                .enumerate()
                .map(|(column, header)| {
                    (
                        header.clone(),
                        row.get(column).unwrap_or_default().trim().to_owned(),
                    )
                })
                .collect();
            Ok(RawRecord {
                fields,
                locator: locator(&artifact.reference.id, Some((index + 1) as u32)),
            })
        })
        .collect()
}

fn xlsx_records(
    artifact: &Artifact,
    requested_sheet: Option<&str>,
    header_contains: &[String],
) -> Result<Vec<RawRecord>, String> {
    let mut workbook = open_workbook_auto_from_rs(Cursor::new(artifact.bytes.clone()))
        .map_err(|error| format!("工作簿无法打开：{error}"))?;
    let sheet_names = match requested_sheet {
        Some(name) => vec![name.to_owned()],
        None => workbook.sheet_names().to_vec(),
    };
    for name in sheet_names {
        let range = workbook
            .worksheet_range(&name)
            .map_err(|error| format!("工作表 {name} 无法读取：{error}"))?;
        let rows = range.rows().collect::<Vec<_>>();
        let text_rows = rows
            .iter()
            .map(|row| row.iter().map(cell_text).collect::<Vec<_>>())
            .collect::<Vec<_>>();
        let Ok(header_index) = find_header(
            text_rows.iter().map(|row| row.iter().map(String::as_str)),
            header_contains,
        ) else {
            continue;
        };
        let headers = text_rows[header_index]
            .iter()
            .enumerate()
            .map(|(index, value)| unique_header(value, index))
            .collect::<Vec<_>>();
        if headers.len() > MAX_COLUMNS {
            return Err("工作表列数超过 128。".to_owned());
        }
        let records = text_rows
            .into_iter()
            .enumerate()
            .skip(header_index + 1)
            .filter(|(_, row)| row.iter().any(|value| !value.trim().is_empty()))
            .take(MAX_RECORDS + 1)
            .map(|(index, row)| RawRecord {
                fields: headers
                    .iter()
                    .enumerate()
                    .map(|(column, header)| {
                        (header.clone(), row.get(column).cloned().unwrap_or_default())
                    })
                    .collect(),
                locator: SourceLocator {
                    artifact_id: Some(artifact.reference.id.clone()),
                    sheet: Some(name.clone()),
                    row: Some((index + 1) as u32),
                    ..SourceLocator::default()
                },
            })
            .collect::<Vec<_>>();
        enforce_record_limit(records.len())?;
        return Ok(records);
    }
    Err("没有找到符合表头条件的工作表。".to_owned())
}

fn html_table_records(artifact: &Artifact, selector: &str) -> Result<Vec<RawRecord>, String> {
    let document = Html::parse_document(utf8_text(artifact)?);
    let table_selector =
        Selector::parse(selector).map_err(|_| "CSS selector 不合法。".to_owned())?;
    let row_selector = Selector::parse("tr").expect("static selector");
    let th_selector = Selector::parse("th").expect("static selector");
    let td_selector = Selector::parse("td").expect("static selector");
    let mut output = Vec::new();
    for (table_index, table) in document.select(&table_selector).enumerate() {
        let mut headers: Option<Vec<String>> = None;
        for (row_index, row) in table.select(&row_selector).enumerate() {
            let headings = row
                .select(&th_selector)
                .map(element_text)
                .collect::<Vec<_>>();
            if headers.is_none() && !headings.is_empty() {
                headers = Some(
                    headings
                        .iter()
                        .enumerate()
                        .map(|(index, value)| unique_header(value, index))
                        .collect(),
                );
                continue;
            }
            let cells = row
                .select(&td_selector)
                .map(element_text)
                .collect::<Vec<_>>();
            if cells.is_empty() {
                continue;
            }
            let headers = headers.get_or_insert_with(|| {
                (0..cells.len())
                    .map(|index| format!("column_{}", index + 1))
                    .collect()
            });
            output.push(RawRecord {
                fields: headers
                    .iter()
                    .enumerate()
                    .map(|(index, header)| {
                        (
                            header.clone(),
                            cells.get(index).cloned().unwrap_or_default(),
                        )
                    })
                    .collect(),
                locator: SourceLocator {
                    artifact_id: Some(artifact.reference.id.clone()),
                    row: Some((row_index + 1) as u32),
                    dom_path: Some(format!(
                        "{selector}:nth-of-type({}) tr:nth-of-type({})",
                        table_index + 1,
                        row_index + 1
                    )),
                    ..SourceLocator::default()
                },
            });
        }
    }
    enforce_record_limit(output.len())?;
    Ok(output)
}

fn html_element_records(
    artifact: &Artifact,
    row_selector: &str,
    fields: &BTreeMap<String, String>,
    document_fields: &BTreeMap<String, String>,
) -> Result<Vec<RawRecord>, String> {
    let document = Html::parse_document(utf8_text(artifact)?);
    let row_selector_compiled =
        Selector::parse(row_selector).map_err(|_| "row_selector 不合法。".to_owned())?;
    let selectors = fields
        .iter()
        .map(|(field, selector)| {
            Selector::parse(selector)
                .map(|compiled| (field, compiled))
                .map_err(|_| format!("字段 {field} 的 selector 不合法。"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let document_values = document_fields
        .iter()
        .map(|(field, selector)| {
            Selector::parse(selector)
                .map_err(|_| format!("文档字段 {field} 的 selector 不合法。"))
                .map(|compiled| {
                    (
                        field.clone(),
                        document
                            .select(&compiled)
                            .next()
                            .map(element_text)
                            .unwrap_or_default(),
                    )
                })
        })
        .collect::<Result<BTreeMap<_, _>, _>>()?;
    let records = document
        .select(&row_selector_compiled)
        .take(MAX_RECORDS + 1)
        .enumerate()
        .map(|(index, row)| RawRecord {
            fields: document_values
                .clone()
                .into_iter()
                .chain(selectors.iter().map(|(field, selector)| {
                    (
                        (*field).clone(),
                        row.select(selector)
                            .next()
                            .map(element_text)
                            .unwrap_or_default(),
                    )
                }))
                .collect(),
            locator: SourceLocator {
                artifact_id: Some(artifact.reference.id.clone()),
                row: Some((index + 1) as u32),
                dom_path: Some(format!("{row_selector}:nth-of-type({})", index + 1)),
                ..SourceLocator::default()
            },
        })
        .collect::<Vec<_>>();
    enforce_record_limit(records.len())?;
    Ok(records)
}

fn text_line_records(
    artifact: &Artifact,
    start_contains: Option<&str>,
    end_contains: Option<&str>,
    skip_empty: bool,
    field: &str,
) -> Result<Vec<RawRecord>, String> {
    let mut started = start_contains.is_none();
    let mut records = Vec::new();
    for (index, line) in utf8_text(artifact)?.lines().enumerate() {
        if !started {
            if start_contains.is_some_and(|marker| line.contains(marker)) {
                started = true;
            }
            continue;
        }
        if end_contains.is_some_and(|marker| line.contains(marker)) {
            break;
        }
        if skip_empty && line.trim().is_empty() {
            continue;
        }
        records.push(RawRecord {
            fields: BTreeMap::from([(field.to_owned(), line.to_owned())]),
            locator: locator(&artifact.reference.id, Some((index + 1) as u32)),
        });
        enforce_record_limit(records.len())?;
    }
    Ok(records)
}

fn whitespace_table_records(
    artifact: &Artifact,
    columns: &[String],
    first_column_regex: Option<&str>,
    min_columns: usize,
) -> Result<Vec<RawRecord>, String> {
    let separator = Regex::new(r"\s{2,}").expect("static whitespace regex");
    let first = first_column_regex
        .map(Regex::new)
        .transpose()
        .map_err(|error| format!("first_column_regex 不合法：{error}"))?;
    let mut output = Vec::new();
    for (index, line) in utf8_text(artifact)?.lines().enumerate() {
        let mut values = separator
            .split(line.trim())
            .map(clean_text)
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if values.len() < min_columns
            || first
                .as_ref()
                .is_some_and(|pattern| !pattern.is_match(&values[0]))
        {
            continue;
        }
        if values.len() > columns.len() {
            let tail = values.split_off(columns.len() - 1).join(" ");
            values.push(tail);
        }
        output.push(RawRecord {
            fields: columns
                .iter()
                .enumerate()
                .map(|(column, name)| {
                    (
                        name.clone(),
                        values.get(column).cloned().unwrap_or_default(),
                    )
                })
                .collect(),
            locator: locator(&artifact.reference.id, Some((index + 1) as u32)),
        });
        enforce_record_limit(output.len())?;
    }
    Ok(output)
}

fn normalize_date(value: &str, formats: &[String]) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("日期为空。".to_owned());
    }
    if let Ok(parsed) = OffsetDateTime::parse(value, &Rfc3339) {
        return Ok(parsed.to_string());
    }
    let defaults = [
        "[year]-[month]-[day] [hour]:[minute]:[second]",
        "[year]-[month]-[day] [hour]:[minute]",
        "[year]/[month]/[day] [hour]:[minute]:[second]",
        "[year]/[month]/[day] [hour]:[minute]",
        "[year]-[month]-[day]",
        "[year]/[month]/[day]",
    ];
    let formats = if formats.is_empty() {
        defaults
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>()
    } else {
        formats.to_vec()
    };
    for format in formats {
        let Ok(format) = time::format_description::parse_borrowed::<2>(&format) else {
            continue;
        };
        if let Ok(parsed) = PrimitiveDateTime::parse(value, &format) {
            return Ok(parsed.to_string());
        }
        if let Ok(parsed) = Date::parse(value, &format) {
            return Ok(PrimitiveDateTime::new(parsed, Time::MIDNIGHT).to_string());
        }
    }
    Err(format!("无法识别日期 {value:?}。"))
}

#[allow(clippy::result_large_err)]
fn normalize_bill_row(
    record: &RawRecord,
    output_requirements: &[String],
    node_id: &str,
) -> Result<BillRowDraft, Diagnostic> {
    let missing = output_requirements
        .iter()
        .filter(|field| {
            record
                .fields
                .get(*field)
                .is_none_or(|value| value.trim().is_empty())
        })
        .cloned()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(error_diagnostic(
            node_id,
            &record.locator,
            "required_fields_missing",
            format!("缺少输出必填字段：{}", missing.join("、")),
        ));
    }
    let amount = script::normalize_money(field(record, "signed_amount"))
        .map_err(|message| error_diagnostic(node_id, &record.locator, "invalid_amount", message))?;
    let currency = field(record, "currency_code").to_ascii_uppercase();
    if currency.len() != 3 || !currency.bytes().all(|value| value.is_ascii_uppercase()) {
        return Err(error_diagnostic(
            node_id,
            &record.locator,
            "invalid_currency",
            "currency_code 必须是 3 位大写代码。".to_owned(),
        ));
    }
    let description = optional_field(record, "description")
        .or_else(|| optional_field(record, "counterparty"))
        .or_else(|| optional_field(record, "merchant_order_id"))
        .or_else(|| optional_field(record, "remark"))
        .unwrap_or_default();
    if description.is_empty() {
        return Err(error_diagnostic(
            node_id,
            &record.locator,
            "description_missing",
            "description 为空，且无法从交易对方或备注派生。".to_owned(),
        ));
    }
    Ok(BillRowDraft {
        occurred_at: field(record, "occurred_at").to_owned(),
        posted_at: optional_field(record, "posted_at"),
        signed_amount: amount,
        currency_code: currency,
        foreign_amount: optional_field(record, "foreign_amount"),
        foreign_currency_code: optional_field(record, "foreign_currency_code"),
        balance_after: optional_field(record, "balance_after"),
        description,
        counterparty: optional_field(record, "counterparty"),
        counterparty_account: optional_field(record, "counterparty_account"),
        account_hint: optional_field(record, "account_hint"),
        payment_method: optional_field(record, "payment_method"),
        provider_transaction_id: optional_field(record, "provider_transaction_id"),
        merchant_order_id: optional_field(record, "merchant_order_id"),
        provider_category: optional_field(record, "provider_category"),
        provider_status: optional_field(record, "provider_status"),
        remark: optional_field(record, "remark"),
        source_locator: record.locator.clone(),
        raw_fields: record.fields.clone(),
        warnings: Vec::new(),
        issues: Vec::new(),
    })
}

fn field<'a>(record: &'a RawRecord, name: &str) -> &'a str {
    record.fields.get(name).map(String::as_str).unwrap_or("")
}

fn optional_field(record: &RawRecord, name: &str) -> Option<String> {
    record
        .fields
        .get(name)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn invalid_record(record: RawRecord, node_id: &str, code: &str, message: String) -> InvalidRow {
    InvalidRow {
        locator: record.locator.clone(),
        raw_fields: record.fields,
        issues: vec![error_diagnostic(node_id, &record.locator, code, message)],
    }
}

fn error_diagnostic(
    node_id: &str,
    locator: &SourceLocator,
    code: &str,
    message: String,
) -> Diagnostic {
    Diagnostic {
        severity: Severity::Error,
        code: code.to_owned(),
        message,
        node_id: Some(node_id.to_owned()),
        locator: Some(locator.clone()),
    }
}

fn make_artifact(
    kind: ArtifactKind,
    mime: &str,
    filename: &str,
    parent_id: Option<String>,
    bytes: Vec<u8>,
    position: usize,
) -> Artifact {
    let checksum = hex_sha256(&bytes);
    let id = format!("artifact-{position}-{}", &checksum[..12]);
    Artifact {
        reference: ArtifactRef {
            id: id.clone(),
            kind,
            mime: mime.to_owned(),
            filename: safe_filename(filename),
            size: bytes.len(),
            sha256: checksum,
            parent_id,
            source: SourceLocator {
                artifact_id: Some(id),
                ..SourceLocator::default()
            },
        },
        bytes,
    }
}

fn part_bytes(part: &PartType<'_>) -> Option<Vec<u8>> {
    match part {
        PartType::Text(value) | PartType::Html(value) => Some(value.as_bytes().to_vec()),
        PartType::Binary(value) | PartType::InlineBinary(value) => Some(value.to_vec()),
        PartType::Message(value) => Some(value.raw_message.to_vec()),
        PartType::Multipart(_) => None,
    }
}

fn content_type_string(value: &mail_parser::ContentType<'_>) -> String {
    value
        .subtype()
        .map(|subtype| format!("{}/{subtype}", value.ctype()))
        .unwrap_or_else(|| value.ctype().to_owned())
}

fn safe_filename(value: &str) -> String {
    Path::new(value)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty() && *value != "." && *value != "..")
        .unwrap_or("artifact.bin")
        .chars()
        .take(240)
        .collect()
}

fn mime_from_filename(filename: &str) -> &'static str {
    match Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "csv" => "text/csv",
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "pdf" => "application/pdf",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xls" => "application/vnd.ms-excel",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn insert_header(headers: &mut BTreeMap<String, Vec<String>>, name: &str, value: Option<&str>) {
    if let Some(value) = value {
        headers.insert(name.to_owned(), vec![value.to_owned()]);
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn utf8_text(artifact: &Artifact) -> Result<&str, String> {
    std::str::from_utf8(&artifact.bytes).map_err(|_| {
        format!(
            "工件 {} 不是 UTF-8 文本，请先使用 decode_text。",
            artifact.reference.filename
        )
    })
}

fn clean_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn element_text(element: ElementRef<'_>) -> String {
    clean_text(&element.text().collect::<Vec<_>>().join(" "))
}

fn find_header<'a, I, R>(rows: I, required: &[String]) -> Result<usize, String>
where
    I: IntoIterator<Item = R>,
    R: IntoIterator<Item = &'a str>,
{
    rows.into_iter()
        .take(50)
        .enumerate()
        .find_map(|(index, row)| {
            let values = row.into_iter().map(clean_text).collect::<Vec<_>>();
            (required.is_empty()
                || required
                    .iter()
                    .all(|expected| values.iter().any(|actual| actual.contains(expected))))
            .then_some(index)
        })
        .ok_or_else(|| format!("前 50 行没有找到表头：{}。", required.join("、")))
}

fn unique_header(value: &str, index: usize) -> String {
    let value = clean_text(value);
    if value.is_empty() {
        format!("column_{}", index + 1)
    } else {
        value
    }
}

fn cell_text(value: &Data) -> String {
    match value {
        Data::Empty => String::new(),
        Data::DateTime(value) if value.is_datetime() => {
            let (year, month, day, hour, minute, second, millisecond) = value.to_ymd_hms_milli();
            if millisecond == 0 {
                format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}")
            } else {
                format!(
                    "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}.{millisecond:03}"
                )
            }
        }
        _ => value.to_string(),
    }
}

fn locator(artifact_id: &str, row: Option<u32>) -> SourceLocator {
    SourceLocator {
        artifact_id: Some(artifact_id.to_owned()),
        row,
        ..SourceLocator::default()
    }
}

fn enforce_record_limit(count: usize) -> Result<(), String> {
    if count > MAX_RECORDS {
        Err("单次解析最多产生 10,000 条记录。".to_owned())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::parser::definition::parse_yaml;
    use zip::write::SimpleFileOptions;

    #[tokio::test]
    async fn csv_mail_runs_end_to_end() {
        let raw = concat!(
            "From: bank@example.com\r\n",
            "To: user@example.com\r\n",
            "Subject: statement\r\n",
            "MIME-Version: 1.0\r\n",
            "Content-Type: multipart/mixed; boundary=x\r\n\r\n",
            "--x\r\nContent-Type: text/plain\r\n\r\nstatement\r\n",
            "--x\r\nContent-Type: text/csv; name=statement.csv\r\n",
            "Content-Disposition: attachment; filename=statement.csv\r\n\r\n",
            "date,amount,merchant\r\n2026-08-11 12:30:00,12.50,Coffee\r\n",
            "--x--\r\n"
        );
        let flow = parse_yaml(
            r#"
schema_version: 1
channel_key: demo
nodes:
  - id: select
    type: select_attachment
    filename: "*.csv"
  - id: table
    type: csv_table
    header_contains: [date, amount]
  - id: fields
    type: rename_fields
    mapping:
      date: occurred_at
      amount: signed_amount
      merchant: description
  - id: currency
    type: set_constant
    values:
      currency_code: CNY
  - id: normalize
    type: normalize_bill_rows
"#,
        )
        .unwrap();
        let output = execute(&flow, raw.as_bytes(), &ParseContext::default())
            .await
            .unwrap();
        assert_eq!(output.valid_rows.len(), 1);
        assert_eq!(output.valid_rows[0].signed_amount, "12.5");
        assert_eq!(output.valid_rows[0].description, "Coffee");
        assert_eq!(output.node_results.len(), 5);
    }

    #[test]
    fn zip_rejects_parent_path_and_large_metadata() {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            writer
                .start_file("../../outside.csv", SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"a,b\n1,2\n").unwrap();
            writer.finish().unwrap();
        }
        let artifact = make_artifact(
            ArtifactKind::Attachment,
            "application/zip",
            "unsafe.zip",
            None,
            cursor.into_inner(),
            0,
        );
        let error = unzip_artifact(&artifact, None).unwrap_err();
        assert!(error.contains("路径越界"), "{error}");
    }

    #[test]
    fn html_table_keeps_source_locator() {
        let artifact = make_artifact(
            ArtifactKind::HtmlBody,
            "text/html",
            "body.html",
            None,
            b"<table id='b'><tr><th>Date</th><th>Amount</th></tr><tr><td>2026-08-11</td><td>8</td></tr></table>".to_vec(),
            0,
        );
        let rows = html_table_records(&artifact, "#b").unwrap();
        assert_eq!(rows[0].fields["Amount"], "8");
        assert!(rows[0].locator.dom_path.is_some());
    }

    #[test]
    fn decoding_supports_gb18030() {
        let (bytes, _, _) = encoding_rs::GB18030.encode("交易时间,金额");
        assert_eq!(
            decode_text(&bytes, &["utf-8".to_owned(), "gb18030".to_owned()]).unwrap(),
            "交易时间,金额"
        );
    }

    #[test]
    fn first_available_uses_the_first_existing_input() {
        let package = package_from_eml(
            b"From: bank@example.com\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>statement</p>",
        )
        .unwrap();
        let choices = vec![
            ArtifactSelector {
                source: ArtifactSource::Attachment,
                filename: Some("*.csv".to_owned()),
                mime: None,
            },
            ArtifactSelector {
                source: ArtifactSource::HtmlBody,
                filename: None,
                mime: None,
            },
        ];
        let selected = first_available(&package, &choices).unwrap();
        assert_eq!(selected.len(), 1);
        assert!(matches!(selected[0].kind, ArtifactKind::HtmlBody));
    }

    #[test]
    fn html_link_extraction_ignores_script_text_and_deduplicates() {
        let artifact = make_artifact(
            ArtifactKind::HtmlBody,
            "text/html",
            "body.html",
            None,
            br#"<script>https://evil.example/file</script><a href="https://bill.example/a.csv">A</a><a href="https://bill.example/a.csv">A2</a>"#.to_vec(),
            0,
        );
        let links = extract_links(&artifact, None).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].url, "https://bill.example/a.csv");
        assert!(links[0].source.dom_path.is_some());
    }

    #[test]
    fn html_elements_include_document_fields_in_every_record() {
        let raw_eml =
            include_bytes!("../../../../testdata/parser-workbench/cmb-credit-daily-sample.eml");
        let message = MessageParser::default().parse(raw_eml).unwrap();
        let html = message.body_html(0).unwrap();
        let artifact = make_artifact(
            ArtifactKind::HtmlBody,
            "text/html",
            "body.html",
            None,
            html.as_bytes().to_vec(),
            0,
        );
        let records = html_element_records(
            &artifact,
            "#fixBand3 > table > tbody > tr[style*='height:61.6px']",
            &BTreeMap::from([("time".to_owned(), "span#fixBand5 font".to_owned())]),
            &BTreeMap::from([(
                "statement_date".to_owned(),
                "#loopHeader1 font[style*='font-size:19px']".to_owned(),
            )]),
        )
        .unwrap();

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].fields["statement_date"], "2026/08/11 每日账单");
        assert_eq!(records[0].fields["time"], "08:30:00");
    }

    #[tokio::test]
    async fn download_rejects_plain_http_and_private_dns() {
        let source = SourceLocator::default();
        let error = download_link(
            &DownloadLink {
                url: "http://bill.example/a.csv".to_owned(),
                source: source.clone(),
            },
            &["bill.example".to_owned()],
            Duration::from_secs(1),
            1024,
            0,
        )
        .await
        .unwrap_err();
        assert!(error.contains("HTTPS"), "{error}");

        let error = download_link(
            &DownloadLink {
                url: "https://localhost/a.csv".to_owned(),
                source,
            },
            &["localhost".to_owned()],
            Duration::from_secs(1),
            1024,
            0,
        )
        .await
        .unwrap_err();
        assert!(error.contains("非公网地址"), "{error}");
    }

    #[test]
    fn switch_parses_the_first_matching_table_case() {
        let artifact = make_artifact(
            ArtifactKind::Attachment,
            "text/csv",
            "statement.csv",
            None,
            b"date,amount\n2026-08-11,12.5\n".to_vec(),
            0,
        );
        let parser = TableParser::CsvTable {
            delimiter: None,
            header_contains: vec!["date".to_owned(), "amount".to_owned()],
        };
        let rows = parse_table_artifact(&artifact, &parser).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].fields["amount"], "12.5");
    }

    #[test]
    fn group_and_split_rows_preserve_source_location() {
        let records = vec![
            RawRecord {
                fields: BTreeMap::from([("line".to_owned(), "merchant".to_owned())]),
                locator: SourceLocator {
                    row: Some(4),
                    ..SourceLocator::default()
                },
            },
            RawRecord {
                fields: BTreeMap::from([("line".to_owned(), "12.00".to_owned())]),
                locator: SourceLocator {
                    row: Some(5),
                    ..SourceLocator::default()
                },
            },
        ];
        let grouped = group_rows(records, Some(2), None, None, "\n").unwrap();
        assert_eq!(grouped[0].fields["line"], "merchant\n12.00");
        assert_eq!(grouped[0].locator.row, Some(4));

        let split = split_rows(grouped, "line", "\n", "part", true, true).unwrap();
        assert_eq!(split.len(), 2);
        assert_eq!(split[1].fields["part"], "12.00");
        assert_eq!(split[1].locator.row, Some(4));
    }

    #[tokio::test]
    async fn pdf_process_is_killed_at_the_timeout() {
        let program = "/usr/bin/yes";
        if !Path::new(program).exists() {
            return;
        }
        let error = pdf_to_text_with(b"%PDF-1.4", None, program, Duration::from_millis(25))
            .await
            .unwrap_err();
        assert!(error.contains("执行超过"), "{error}");
    }
}
