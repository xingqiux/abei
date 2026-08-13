use std::collections::BTreeSet;

use globset::Glob;
use regex::Regex;
use sha2::{Digest, Sha256};

use super::model::{Node, ParserFlowDefinition};

const MAX_NODES: usize = 64;
const MAX_SCRIPT_BYTES: usize = 64 * 1024;
const MAX_YAML_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DataKind {
    Package,
    Artifacts,
    Links,
    Records,
    Drafts,
}

pub(crate) fn parse_yaml(source: &str) -> Result<ParserFlowDefinition, String> {
    if source.len() > MAX_YAML_BYTES {
        return Err("ParserFlow YAML 不能超过 256 KiB。".to_owned());
    }
    let definition = serde_yaml_ng::from_str(source)
        .map_err(|error| format!("ParserFlow YAML 无法解析：{error}"))?;
    validate(&definition)?;
    Ok(definition)
}

pub(crate) fn to_yaml(definition: &ParserFlowDefinition) -> Result<String, String> {
    validate(definition)?;
    serde_yaml_ng::to_string(definition).map_err(|error| error.to_string())
}

pub(crate) fn checksum(definition: &ParserFlowDefinition) -> Result<String, String> {
    validate(definition)?;
    let canonical = serde_json::to_vec(definition).map_err(|error| error.to_string())?;
    Ok(Sha256::digest(canonical)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

pub(crate) fn validate(definition: &ParserFlowDefinition) -> Result<(), String> {
    if definition.schema_version != 1 {
        return Err(format!(
            "不支持 ParserFlow schema_version {}。",
            definition.schema_version
        ));
    }
    validate_key("channel_key", &definition.channel_key)?;
    if definition.nodes.is_empty() || definition.nodes.len() > MAX_NODES {
        return Err(format!("ParserFlow 必须包含 1 到 {MAX_NODES} 个节点。"));
    }
    if definition.output.require.len() > 32 {
        return Err("output.require 最多 32 个字段。".to_owned());
    }

    let mut ids = BTreeSet::new();
    let mut kind = DataKind::Package;
    for node in definition.nodes.iter().filter(|node| node.enabled) {
        validate_key("节点 id", &node.id)?;
        if !ids.insert(&node.id) {
            return Err(format!("节点 id {} 重复。", node.id));
        }
        kind = validate_node(node.operation.kind(), &node.operation, kind)
            .map_err(|error| format!("节点 {}：{error}", node.id))?;
    }
    if kind != DataKind::Drafts {
        return Err("流程最后必须产出 BillRowDraft，请添加 normalize_bill_rows 节点。".to_owned());
    }
    Ok(())
}

fn validate_node(label: &str, node: &Node, input: DataKind) -> Result<DataKind, String> {
    match node {
        Node::FirstAvailable { choices, .. } => {
            require(input, DataKind::Package, label)?;
            if choices.is_empty() || choices.len() > 16 {
                return Err("choices 必须包含 1 到 16 个输入选择器。".to_owned());
            }
            for choice in choices {
                if let Some(pattern) = &choice.filename {
                    validate_glob(pattern)?;
                }
            }
            Ok(DataKind::Artifacts)
        }
        Node::SelectTextBody { .. }
        | Node::SelectHtmlBody { .. }
        | Node::SelectAttachment { .. } => {
            if input != DataKind::Package {
                return Err(format!("{label} 必须直接读取 MailPackage。"));
            }
            if let Node::SelectAttachment { filename, .. } = node
                && let Some(pattern) = filename
            {
                validate_glob(pattern)?;
            }
            Ok(DataKind::Artifacts)
        }
        Node::SelectArtifact { filename, .. } => {
            require(input, DataKind::Artifacts, label)?;
            if let Some(pattern) = filename {
                validate_glob(pattern)?;
            }
            Ok(DataKind::Artifacts)
        }
        Node::ExtractLinks { selector } => {
            require(input, DataKind::Artifacts, label)?;
            if let Some(selector) = selector {
                scraper::Selector::parse(selector)
                    .map_err(|_| "selector 不是有效 CSS selector。".to_owned())?;
            }
            Ok(DataKind::Links)
        }
        Node::Download {
            allowed_domains,
            timeout_seconds,
            max_bytes,
        } => {
            require(input, DataKind::Links, label)?;
            if allowed_domains.is_empty() || allowed_domains.len() > 32 {
                return Err("allowed_domains 必须包含 1 到 32 个域名。".to_owned());
            }
            for domain in allowed_domains {
                validate_domain(domain)?;
            }
            if !(1..=60).contains(timeout_seconds) {
                return Err("timeout_seconds 必须在 1 到 60 秒之间。".to_owned());
            }
            if *max_bytes == 0 || *max_bytes > 25 * 1024 * 1024 {
                return Err("max_bytes 必须在 1 到 25 MiB 之间。".to_owned());
            }
            Ok(DataKind::Artifacts)
        }
        Node::DecodeText { candidates } => {
            require(input, DataKind::Artifacts, label)?;
            if candidates.is_empty() || candidates.len() > 8 {
                return Err("candidates 必须包含 1 到 8 个字符集。".to_owned());
            }
            Ok(DataKind::Artifacts)
        }
        Node::Unzip { .. } | Node::PdfToText { .. } => {
            require(input, DataKind::Artifacts, label)?;
            Ok(DataKind::Artifacts)
        }
        Node::CsvTable {
            delimiter,
            header_contains,
        } => {
            require(input, DataKind::Artifacts, label)?;
            if delimiter.as_ref().is_some_and(|value| value.len() != 1) {
                return Err("delimiter 必须是一个 ASCII 字符。".to_owned());
            }
            if header_contains.len() > 64 {
                return Err("header_contains 最多 64 项。".to_owned());
            }
            Ok(DataKind::Records)
        }
        Node::XlsxSheet {
            header_contains, ..
        } => {
            require(input, DataKind::Artifacts, label)?;
            if header_contains.len() > 64 {
                return Err("header_contains 最多 64 项。".to_owned());
            }
            Ok(DataKind::Records)
        }
        Node::HtmlTable { selector } => {
            require(input, DataKind::Artifacts, label)?;
            scraper::Selector::parse(selector)
                .map_err(|_| "selector 不是有效 CSS selector。".to_owned())?;
            Ok(DataKind::Records)
        }
        Node::HtmlElements {
            row_selector,
            fields,
            document_fields,
        } => {
            require(input, DataKind::Artifacts, label)?;
            scraper::Selector::parse(row_selector)
                .map_err(|_| "row_selector 不是有效 CSS selector。".to_owned())?;
            if fields.is_empty() || fields.len() > 64 {
                return Err("fields 必须包含 1 到 64 个字段。".to_owned());
            }
            for selector in fields.values() {
                scraper::Selector::parse(selector)
                    .map_err(|_| format!("字段 selector {selector} 不合法。"))?;
            }
            if document_fields.len() > 32 {
                return Err("document_fields 最多 32 个字段。".to_owned());
            }
            for selector in document_fields.values() {
                scraper::Selector::parse(selector)
                    .map_err(|_| format!("文档字段 selector {selector} 不合法。"))?;
            }
            Ok(DataKind::Records)
        }
        Node::TextLines { field, .. } => {
            require(input, DataKind::Artifacts, label)?;
            validate_field(field)?;
            Ok(DataKind::Records)
        }
        Node::FixedWidthTable { columns, .. } => {
            require(input, DataKind::Artifacts, label)?;
            if columns.is_empty() || columns.len() > 64 {
                return Err("columns 必须包含 1 到 64 列。".to_owned());
            }
            for column in columns {
                validate_field(&column.name)?;
                if column.end.is_some_and(|end| end <= column.start) {
                    return Err(format!("列 {} 的 end 必须大于 start。", column.name));
                }
            }
            Ok(DataKind::Records)
        }
        Node::WhitespaceTable {
            columns,
            first_column_regex,
            min_columns,
        } => {
            require(input, DataKind::Artifacts, label)?;
            if columns.is_empty() || columns.len() > 64 {
                return Err("columns 必须包含 1 到 64 列。".to_owned());
            }
            for column in columns {
                validate_field(column)?;
            }
            if let Some(pattern) = first_column_regex {
                Regex::new(pattern)
                    .map_err(|error| format!("first_column_regex 不合法：{error}"))?;
            }
            if min_columns.is_some_and(|count| count == 0 || count > columns.len()) {
                return Err("min_columns 必须在 1 到 columns 数量之间。".to_owned());
            }
            Ok(DataKind::Records)
        }
        Node::Switch { cases, .. } => {
            require(input, DataKind::Artifacts, label)?;
            if cases.is_empty() || cases.len() > 16 {
                return Err("cases 必须包含 1 到 16 个分支。".to_owned());
            }
            for case in cases {
                if case.filename.is_none() && case.mime.is_none() {
                    return Err("每个 switch 分支至少要配置 filename 或 mime。".to_owned());
                }
                if let Some(pattern) = &case.filename {
                    validate_glob(pattern)?;
                }
                validate_table_parser(&case.parser)?;
            }
            Ok(DataKind::Records)
        }
        Node::GroupRows {
            count,
            start,
            end,
            separator,
        } => {
            require_records(input, label)?;
            match (count, start, end) {
                (Some(count), None, None) if (1..=128).contains(count) => {}
                (None, Some(start), Some(end)) => {
                    validate_row_condition(start)?;
                    validate_row_condition(end)?;
                }
                _ => {
                    return Err(
                        "group_rows 必须配置 1..128 的 count，或同时配置 start 和 end。".to_owned(),
                    );
                }
            }
            if separator.chars().count() > 32 {
                return Err("separator 最多 32 个字符。".to_owned());
            }
            Ok(DataKind::Records)
        }
        Node::SplitRows {
            field,
            delimiter,
            target,
            ..
        } => {
            require_records(input, label)?;
            validate_field(field)?;
            if let Some(target) = target {
                validate_field(target)?;
            }
            if delimiter.is_empty() || delimiter.chars().count() > 32 {
                return Err("delimiter 必须是 1 到 32 个字符。".to_owned());
            }
            Ok(DataKind::Records)
        }
        Node::RenameFields { mapping } => {
            require_records(input, label)?;
            validate_mapping(mapping)?;
            Ok(DataKind::Records)
        }
        Node::PickFields { fields } | Node::NormalizeText { fields } => {
            require_records(input, label)?;
            if fields.is_empty() || fields.len() > 64 {
                return Err("fields 必须包含 1 到 64 个字段。".to_owned());
            }
            for field in fields {
                validate_field(field)?;
            }
            Ok(DataKind::Records)
        }
        Node::JoinFields {
            target, sources, ..
        } => {
            require_records(input, label)?;
            validate_field(target)?;
            if sources.is_empty() || sources.len() > 16 {
                return Err("sources 必须包含 1 到 16 个字段。".to_owned());
            }
            Ok(DataKind::Records)
        }
        Node::SetConstant { values } => {
            require_records(input, label)?;
            validate_mapping(values)?;
            Ok(DataKind::Records)
        }
        Node::MapValues { field, values, .. } => {
            require_records(input, label)?;
            validate_field(field)?;
            if values.is_empty() || values.len() > 256 {
                return Err("values 必须包含 1 到 256 个映射。".to_owned());
            }
            Ok(DataKind::Records)
        }
        Node::FilterRows {
            field,
            operator,
            value,
        } => {
            require_records(input, label)?;
            validate_field(field)?;
            if value.chars().count() > 512 {
                return Err("value 最多 512 个字符。".to_owned());
            }
            if matches!(operator, super::model::TextOperator::Regex) {
                Regex::new(value).map_err(|error| format!("regex 不合法：{error}"))?;
            }
            Ok(DataKind::Records)
        }
        Node::ParseMoney { source, target, .. } | Node::ParseDate { source, target, .. } => {
            require_records(input, label)?;
            validate_field(source)?;
            validate_field(target)?;
            Ok(DataKind::Records)
        }
        Node::ValidateRows { required } => {
            require_records(input, label)?;
            if required.is_empty() || required.len() > 32 {
                return Err("required 必须包含 1 到 32 个字段。".to_owned());
            }
            Ok(DataKind::Records)
        }
        Node::TransformScript { source } => {
            require_records(input, label)?;
            if source.trim().is_empty() || source.len() > MAX_SCRIPT_BYTES {
                return Err("脚本必须非空且不能超过 64 KiB。".to_owned());
            }
            let engine = super::script::sandbox_engine(std::time::Duration::from_millis(200));
            engine
                .compile(source)
                .map_err(|error| format!("Rhai 无法编译：{error}"))?;
            Ok(DataKind::Records)
        }
        Node::NormalizeBillRows { default_currency } => {
            require_records(input, label)?;
            if default_currency.len() != 3
                || !default_currency
                    .bytes()
                    .all(|byte| byte.is_ascii_uppercase())
            {
                return Err("default_currency 必须是 3 位大写代码。".to_owned());
            }
            Ok(DataKind::Drafts)
        }
    }
}

fn require(actual: DataKind, expected: DataKind, label: &str) -> Result<(), String> {
    if actual == expected {
        Ok(())
    } else {
        Err(format!("{label} 的输入类型不对，当前是 {actual:?}。"))
    }
}

fn require_records(input: DataKind, label: &str) -> Result<(), String> {
    require(input, DataKind::Records, label)
}

fn validate_key(label: &str, value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 80
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_')
        })
    {
        Err(format!(
            "{label} 只能使用小写字母、数字、中划线和下划线，最多 80 个字符。"
        ))
    } else {
        Ok(())
    }
}

fn validate_field(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > 120 {
        Err("字段名必须是 1 到 120 个字符。".to_owned())
    } else {
        Ok(())
    }
}

fn validate_mapping(mapping: &std::collections::BTreeMap<String, String>) -> Result<(), String> {
    if mapping.is_empty() || mapping.len() > 128 {
        return Err("mapping 必须包含 1 到 128 项。".to_owned());
    }
    for (left, right) in mapping {
        validate_field(left)?;
        validate_field(right)?;
    }
    Ok(())
}

fn validate_glob(pattern: &str) -> Result<(), String> {
    Glob::new(pattern)
        .map(|_| ())
        .map_err(|error| format!("文件名 glob 不合法：{error}"))
}

fn validate_domain(domain: &str) -> Result<(), String> {
    if domain.is_empty()
        || domain.len() > 253
        || domain != domain.trim().to_ascii_lowercase()
        || domain.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || label.starts_with('-')
                || label.ends_with('-')
                || !label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        Err(format!(
            "域名 {domain:?} 不合法；请填写不带协议和端口的小写域名。"
        ))
    } else {
        Ok(())
    }
}

fn validate_row_condition(condition: &super::model::RowCondition) -> Result<(), String> {
    validate_field(&condition.field)?;
    if condition.value.chars().count() > 512 {
        return Err("行条件 value 最多 512 个字符。".to_owned());
    }
    if matches!(condition.operator, super::model::TextOperator::Regex) {
        Regex::new(&condition.value).map_err(|error| format!("regex 不合法：{error}"))?;
    }
    Ok(())
}

fn validate_table_parser(parser: &super::model::TableParser) -> Result<(), String> {
    match parser {
        super::model::TableParser::CsvTable {
            delimiter,
            header_contains,
        } => {
            if delimiter
                .as_ref()
                .is_some_and(|value| value.len() != 1 || !value.is_ascii())
            {
                return Err("CSV delimiter 必须是一个 ASCII 字符。".to_owned());
            }
            if header_contains.len() > 64 {
                return Err("header_contains 最多 64 项。".to_owned());
            }
        }
        super::model::TableParser::XlsxSheet {
            header_contains, ..
        } => {
            if header_contains.len() > 64 {
                return Err("header_contains 最多 64 项。".to_owned());
            }
        }
        super::model::TableParser::HtmlTable { selector } => {
            scraper::Selector::parse(selector)
                .map_err(|_| "HTML table selector 不合法。".to_owned())?;
        }
    }
    Ok(())
}
