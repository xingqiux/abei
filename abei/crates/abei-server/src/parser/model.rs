use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ParserFlowDefinition {
    #[serde(default = "schema_version")]
    pub schema_version: u16,
    pub channel_key: String,
    #[serde(default)]
    pub statement_kind: Option<String>,
    pub nodes: Vec<NodeDefinition>,
    #[serde(default)]
    pub output: OutputRequirements,
}

fn schema_version() -> u16 {
    1
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct NodeDefinition {
    pub id: String,
    #[serde(default = "enabled")]
    pub enabled: bool,
    #[serde(flatten)]
    pub operation: Node,
}

fn enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Node {
    FirstAvailable {
        choices: Vec<ArtifactSelector>,
        #[serde(default = "required")]
        required: bool,
    },
    SelectTextBody {
        #[serde(default = "required")]
        required: bool,
    },
    SelectHtmlBody {
        #[serde(default = "required")]
        required: bool,
    },
    SelectAttachment {
        #[serde(default)]
        filename: Option<String>,
        #[serde(default)]
        mime: Option<String>,
        #[serde(default = "required")]
        required: bool,
    },
    SelectArtifact {
        #[serde(default)]
        filename: Option<String>,
        #[serde(default)]
        mime: Option<String>,
        #[serde(default = "required")]
        required: bool,
    },
    ExtractLinks {
        #[serde(default)]
        selector: Option<String>,
    },
    Download {
        allowed_domains: Vec<String>,
        #[serde(default = "download_timeout_seconds")]
        timeout_seconds: u64,
        #[serde(default = "download_max_bytes")]
        max_bytes: usize,
    },
    DecodeText {
        #[serde(default = "default_encodings")]
        candidates: Vec<String>,
    },
    Unzip {
        #[serde(default)]
        password_key: Option<String>,
    },
    PdfToText {
        #[serde(default)]
        password_key: Option<String>,
    },
    CsvTable {
        #[serde(default)]
        delimiter: Option<String>,
        #[serde(default)]
        header_contains: Vec<String>,
    },
    XlsxSheet {
        #[serde(default)]
        sheet: Option<String>,
        #[serde(default)]
        header_contains: Vec<String>,
    },
    HtmlTable {
        selector: String,
    },
    HtmlElements {
        row_selector: String,
        fields: BTreeMap<String, String>,
        #[serde(default)]
        document_fields: BTreeMap<String, String>,
    },
    TextLines {
        #[serde(default)]
        start_contains: Option<String>,
        #[serde(default)]
        end_contains: Option<String>,
        #[serde(default = "required")]
        skip_empty: bool,
        #[serde(default = "line_field")]
        field: String,
    },
    FixedWidthTable {
        columns: Vec<FixedColumn>,
        #[serde(default)]
        skip_contains: Vec<String>,
    },
    WhitespaceTable {
        columns: Vec<String>,
        #[serde(default)]
        first_column_regex: Option<String>,
        #[serde(default)]
        min_columns: Option<usize>,
    },
    Switch {
        cases: Vec<TableSwitchCase>,
        #[serde(default = "required")]
        required: bool,
    },
    GroupRows {
        #[serde(default)]
        count: Option<usize>,
        #[serde(default)]
        start: Option<RowCondition>,
        #[serde(default)]
        end: Option<RowCondition>,
        #[serde(default = "newline")]
        separator: String,
    },
    SplitRows {
        field: String,
        delimiter: String,
        #[serde(default)]
        target: Option<String>,
        #[serde(default = "required")]
        trim: bool,
        #[serde(default = "required")]
        skip_empty: bool,
    },
    RenameFields {
        mapping: BTreeMap<String, String>,
    },
    PickFields {
        fields: Vec<String>,
    },
    JoinFields {
        target: String,
        sources: Vec<String>,
        #[serde(default = "space")]
        separator: String,
    },
    SetConstant {
        values: BTreeMap<String, String>,
    },
    MapValues {
        field: String,
        values: BTreeMap<String, String>,
        #[serde(default)]
        default: Option<String>,
    },
    NormalizeText {
        fields: Vec<String>,
    },
    FilterRows {
        field: String,
        operator: TextOperator,
        value: String,
    },
    ParseMoney {
        source: String,
        #[serde(default = "signed_amount")]
        target: String,
        #[serde(default)]
        negative_when: BTreeMap<String, Vec<String>>,
    },
    ParseDate {
        source: String,
        #[serde(default = "occurred_at")]
        target: String,
        #[serde(default)]
        formats: Vec<String>,
        #[serde(default)]
        timezone: Option<String>,
    },
    ValidateRows {
        required: Vec<String>,
    },
    TransformScript {
        source: String,
    },
    NormalizeBillRows {
        #[serde(default = "default_currency")]
        default_currency: String,
    },
}

fn required() -> bool {
    true
}

fn download_timeout_seconds() -> u64 {
    15
}

fn download_max_bytes() -> usize {
    25 * 1024 * 1024
}

fn newline() -> String {
    "\n".to_owned()
}

fn default_encodings() -> Vec<String> {
    ["utf-8", "gb18030", "gbk", "big5"]
        .into_iter()
        .map(str::to_owned)
        .collect()
}

fn line_field() -> String {
    "line".to_owned()
}

fn space() -> String {
    " ".to_owned()
}

fn signed_amount() -> String {
    "signed_amount".to_owned()
}

fn occurred_at() -> String {
    "occurred_at".to_owned()
}

fn default_currency() -> String {
    "CNY".to_owned()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FixedColumn {
    pub name: String,
    pub start: usize,
    #[serde(default)]
    pub end: Option<usize>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ArtifactSelector {
    pub source: ArtifactSource,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArtifactSource {
    TextBody,
    HtmlBody,
    Attachment,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RowCondition {
    pub field: String,
    pub operator: TextOperator,
    pub value: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TableSwitchCase {
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
    pub parser: TableParser,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum TableParser {
    CsvTable {
        #[serde(default)]
        delimiter: Option<String>,
        #[serde(default)]
        header_contains: Vec<String>,
    },
    XlsxSheet {
        #[serde(default)]
        sheet: Option<String>,
        #[serde(default)]
        header_contains: Vec<String>,
    },
    HtmlTable {
        selector: String,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum TextOperator {
    Equals,
    Contains,
    Prefix,
    Suffix,
    Regex,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct OutputRequirements {
    #[serde(default = "default_required_fields")]
    pub require: Vec<String>,
}

fn default_required_fields() -> Vec<String> {
    ["occurred_at", "signed_amount", "currency_code"]
        .into_iter()
        .map(str::to_owned)
        .collect()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct MailPackage {
    pub message: MailMetadata,
    pub text_body: Option<ArtifactRef>,
    pub html_body: Option<ArtifactRef>,
    pub attachments: Vec<ArtifactRef>,
    #[serde(skip)]
    pub(crate) artifacts: Vec<Artifact>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct MailMetadata {
    pub message_id: Option<String>,
    pub from: Option<String>,
    pub to: Vec<String>,
    pub subject: Option<String>,
    pub received_at: Option<String>,
    pub headers: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct ArtifactRef {
    pub id: String,
    pub kind: ArtifactKind,
    pub mime: String,
    pub filename: String,
    pub size: usize,
    pub sha256: String,
    pub parent_id: Option<String>,
    pub source: SourceLocator,
}

#[derive(Debug, Clone)]
pub(crate) struct Artifact {
    pub reference: ArtifactRef,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArtifactKind {
    TextBody,
    HtmlBody,
    Attachment,
    ArchiveEntry,
    Download,
    DecodedText,
    PdfText,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct SourceLocator {
    pub artifact_id: Option<String>,
    pub sheet: Option<String>,
    pub page: Option<u32>,
    pub row: Option<u32>,
    pub dom_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct RawRecord {
    pub fields: BTreeMap<String, String>,
    pub locator: SourceLocator,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct BillDocumentDraft {
    pub channel_key: String,
    pub statement_kind: Option<String>,
    pub account_hint: Option<String>,
    pub period_start: Option<String>,
    pub period_end: Option<String>,
    pub exported_at: Option<String>,
    pub declared_row_count: Option<u32>,
    pub source_metadata: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct BillRowDraft {
    pub occurred_at: String,
    pub posted_at: Option<String>,
    pub signed_amount: String,
    pub currency_code: String,
    pub foreign_amount: Option<String>,
    pub foreign_currency_code: Option<String>,
    pub balance_after: Option<String>,
    pub description: String,
    pub counterparty: Option<String>,
    pub counterparty_account: Option<String>,
    pub account_hint: Option<String>,
    pub payment_method: Option<String>,
    pub provider_transaction_id: Option<String>,
    pub merchant_order_id: Option<String>,
    pub provider_category: Option<String>,
    pub provider_status: Option<String>,
    pub remark: Option<String>,
    pub source_locator: SourceLocator,
    pub raw_fields: BTreeMap<String, String>,
    pub warnings: Vec<Diagnostic>,
    pub issues: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct InvalidRow {
    pub locator: SourceLocator,
    pub raw_fields: BTreeMap<String, String>,
    pub issues: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct Diagnostic {
    pub severity: Severity,
    pub code: String,
    pub message: String,
    pub node_id: Option<String>,
    pub locator: Option<SourceLocator>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Severity {
    Warning,
    Error,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub(crate) struct ParseMetrics {
    pub duration_ms: u64,
    pub input_artifacts: usize,
    pub records: usize,
    pub valid_rows: usize,
    pub invalid_rows: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct NodeResult {
    pub node_id: String,
    pub node_type: String,
    pub duration_ms: u64,
    pub input_count: usize,
    pub output_count: usize,
    pub diagnostics: Vec<Diagnostic>,
    pub preview: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct ParseOutput {
    pub document: BillDocumentDraft,
    pub valid_rows: Vec<BillRowDraft>,
    pub invalid_rows: Vec<InvalidRow>,
    pub warnings: Vec<Diagnostic>,
    pub metrics: ParseMetrics,
    pub node_results: Vec<NodeResult>,
    #[serde(skip)]
    pub(crate) artifacts: Vec<Artifact>,
}

impl Node {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::FirstAvailable { .. } => "first_available",
            Self::SelectTextBody { .. } => "select_text_body",
            Self::SelectHtmlBody { .. } => "select_html_body",
            Self::SelectAttachment { .. } => "select_attachment",
            Self::SelectArtifact { .. } => "select_artifact",
            Self::ExtractLinks { .. } => "extract_links",
            Self::Download { .. } => "download",
            Self::DecodeText { .. } => "decode_text",
            Self::Unzip { .. } => "unzip",
            Self::PdfToText { .. } => "pdf_to_text",
            Self::CsvTable { .. } => "csv_table",
            Self::XlsxSheet { .. } => "xlsx_sheet",
            Self::HtmlTable { .. } => "html_table",
            Self::HtmlElements { .. } => "html_elements",
            Self::TextLines { .. } => "text_lines",
            Self::FixedWidthTable { .. } => "fixed_width_table",
            Self::WhitespaceTable { .. } => "whitespace_table",
            Self::Switch { .. } => "switch",
            Self::GroupRows { .. } => "group_rows",
            Self::SplitRows { .. } => "split_rows",
            Self::RenameFields { .. } => "rename_fields",
            Self::PickFields { .. } => "pick_fields",
            Self::JoinFields { .. } => "join_fields",
            Self::SetConstant { .. } => "set_constant",
            Self::MapValues { .. } => "map_values",
            Self::NormalizeText { .. } => "normalize_text",
            Self::FilterRows { .. } => "filter_rows",
            Self::ParseMoney { .. } => "parse_money",
            Self::ParseDate { .. } => "parse_date",
            Self::ValidateRows { .. } => "validate_rows",
            Self::TransformScript { .. } => "transform_script",
            Self::NormalizeBillRows { .. } => "normalize_bill_rows",
        }
    }
}
