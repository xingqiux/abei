use std::collections::{BTreeMap, HashMap, HashSet};
use std::str::FromStr;

use deadpool_postgres::{GenericClient, Pool, Transaction};
use rust_decimal::Decimal;
use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const LEGACY_TABLES: &[&str] = &[
    "bill_mail_messages",
    "bill_tasks",
    "bill_artifacts",
    "bill_statement_imports",
    "bill_statement_rows",
];

#[derive(Debug, Clone, Copy)]
pub struct Options {
    pub apply: bool,
    pub max_difference_samples: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            apply: false,
            max_difference_samples: 100,
        }
    }
}

#[derive(Debug, Default, Serialize)]
pub struct Report {
    pub mode: &'static str,
    pub legacy_tables_present: Vec<String>,
    pub source_counts: BTreeMap<String, u64>,
    pub planned_counts: BTreeMap<String, u64>,
    pub existing_counts: BTreeMap<String, u64>,
    pub inserted_counts: BTreeMap<String, u64>,
    pub target_counts: BTreeMap<String, u64>,
    pub semantic_changes: BTreeMap<String, u64>,
    pub blockers: Vec<Finding>,
    pub warnings: Vec<Finding>,
    pub comparison: Comparison,
    pub audit_run_id: Option<i64>,
    pub report_checksum: String,
}

impl Report {
    pub fn can_apply(&self) -> bool {
        self.blockers.is_empty()
    }

    fn finish_checksum(&mut self) -> Result<(), String> {
        self.report_checksum.clear();
        self.report_checksum = sha256(
            &serde_json::to_vec(self).map_err(|error| format!("无法序列化迁移报告：{error}"))?,
        );
        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct Finding {
    pub code: String,
    pub entity: String,
    pub legacy_id: Option<i64>,
    pub message: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Comparison {
    pub compared_rows: u64,
    pub matched_rows: u64,
    pub differing_rows: u64,
    pub missing_rows: u64,
    pub field_differences: BTreeMap<String, u64>,
    pub samples: Vec<DifferenceSample>,
}

#[derive(Debug, Serialize)]
pub struct DifferenceSample {
    pub legacy_row_id: i64,
    pub target_row_id: Option<i64>,
    pub fields: Vec<String>,
}

#[derive(Default)]
struct Snapshot {
    tables: Vec<String>,
    messages: Vec<Value>,
    tasks: Vec<Value>,
    artifacts: Vec<Value>,
    imports: Vec<Value>,
    rows: Vec<Value>,
}

#[derive(Clone)]
struct Flow {
    id: i64,
    version: i32,
    checksum: String,
}

struct Plan {
    snapshot: Snapshot,
    tasks: Vec<TaskPlan>,
    orphan_message_ids: Vec<i64>,
}

struct TaskPlan {
    legacy_id: i64,
    user_id: i64,
    legacy_message_id: Option<i64>,
    flow: Flow,
    flow_slug: String,
    channel_key: String,
    source: String,
    status: String,
    summary: Option<String>,
    account_hint: Option<String>,
    received_at: Option<String>,
    period_start: Option<String>,
    period_end: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    metadata: Value,
    imports: Vec<Value>,
    artifacts: Vec<Value>,
    rows: Vec<RowPlan>,
}

struct RowPlan {
    legacy_id: i64,
    user_id: i64,
    row_number: i32,
    source_locator: Value,
    raw_fields: Value,
    occurred_at: String,
    signed_amount: String,
    currency_code: String,
    counterparty: Option<String>,
    counterparty_account: Option<String>,
    description: String,
    account_hint: Option<String>,
    payment_method: Option<String>,
    provider_transaction_id: Option<String>,
    merchant_order_id: Option<String>,
    provider_category: Option<String>,
    provider_status: Option<String>,
    remark: Option<String>,
    external_key: String,
    fingerprint: String,
    duplicate_legacy_id: Option<i64>,
    duplicate_state: String,
    status: String,
    issues: Value,
    dismissed_reason: Option<String>,
    dismissed_at: Option<String>,
    firefly_type: Option<String>,
    firefly_date: Option<String>,
    firefly_amount: Option<String>,
    firefly_description: Option<String>,
    source_name: Option<String>,
    destination_name: Option<String>,
    category_name: Option<String>,
    tags: Option<Vec<String>>,
    notes: Option<String>,
    suggested_by: Option<String>,
    suggested_at: Option<String>,
    user_modified_at: Option<String>,
    transaction_group_id: Option<i64>,
    last_import_error: Option<String>,
    event_group_id: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

pub async fn run(pool: &Pool, options: Options) -> Result<Report, String> {
    let max_samples = options.max_difference_samples.clamp(1, 1_000);
    let mut client = pool.get().await.map_err(display)?;
    if !options.apply {
        let snapshot = load_snapshot(&client).await?;
        let flows = load_flows(&client).await?;
        let (plan, mut report) = build_plan(snapshot, &flows)?;
        report.mode = "dry-run";
        report.existing_counts = target_counts(&client).await?;
        report.target_counts = report.existing_counts.clone();
        if report.blockers.is_empty() && !plan.tasks.is_empty() {
            report.comparison = compare_existing(&client, &plan, max_samples).await?;
        }
        report.finish_checksum()?;
        return Ok(report);
    }

    let transaction = client.transaction().await.map_err(display)?;
    transaction
        .batch_execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .await
        .map_err(display)?;
    transaction
        .query_one("SELECT pg_advisory_xact_lock($1)", &[&4_163_241_991_i64])
        .await
        .map_err(display)?;
    let snapshot = load_snapshot(&transaction).await?;
    let flows = load_flows(&transaction).await?;
    let (plan, mut report) = build_plan(snapshot, &flows)?;
    report.mode = "apply";
    report.existing_counts = target_counts(&transaction).await?;
    if !report.blockers.is_empty() {
        report.target_counts = report.existing_counts.clone();
        report.finish_checksum()?;
        transaction.rollback().await.map_err(display)?;
        return Ok(report);
    }

    apply_plan(&transaction, &plan, &mut report).await?;
    report.target_counts = target_counts(&transaction).await?;
    report.comparison = compare_existing(&transaction, &plan, max_samples).await?;
    let audit_id: i64 = transaction
        .query_one(
            "SELECT nextval('abei_ai.legacy_bill_migration_runs_id_seq')::bigint",
            &[],
        )
        .await
        .map_err(display)?
        .get(0);
    report.audit_run_id = Some(audit_id);
    *report
        .target_counts
        .entry("audit_runs".to_owned())
        .or_default() += 1;
    report.finish_checksum()?;
    let report_json = serde_json::to_value(&report).map_err(display)?;
    let source_counts = serde_json::to_value(&report.source_counts).map_err(display)?;
    let target_counts = serde_json::to_value(&report.target_counts).map_err(display)?;
    let comparison = serde_json::to_value(&report.comparison).map_err(display)?;
    transaction
        .execute(
            "INSERT INTO abei_ai.legacy_bill_migration_runs
               (id, mode, source_counts, target_counts, comparison, report, report_checksum)
             VALUES ($1, 'apply', $2, $3, $4, $5, $6)",
            &[
                &audit_id,
                &source_counts,
                &target_counts,
                &comparison,
                &report_json,
                &report.report_checksum,
            ],
        )
        .await
        .map_err(display)?;
    transaction.commit().await.map_err(display)?;
    Ok(report)
}

async fn load_snapshot<C>(client: &C) -> Result<Snapshot, String>
where
    C: GenericClient + Sync,
{
    let mut snapshot = Snapshot::default();
    for table in LEGACY_TABLES {
        if table_exists(client, table).await? {
            snapshot.tables.push((*table).to_owned());
        }
    }
    snapshot.messages = load_json_rows(client, "bill_mail_messages", false).await?;
    snapshot.tasks = load_json_rows(client, "bill_tasks", false).await?;
    snapshot.artifacts = load_json_rows(client, "bill_artifacts", false).await?;
    snapshot.imports = load_json_rows(client, "bill_statement_imports", false).await?;
    snapshot.rows = load_json_rows(client, "bill_statement_rows", true).await?;
    Ok(snapshot)
}

async fn table_exists<C>(client: &C, table: &str) -> Result<bool, String>
where
    C: GenericClient + Sync,
{
    client
        .query_one(
            "SELECT to_regclass($1) IS NOT NULL",
            &[&format!("public.{table}")],
        )
        .await
        .map_err(display)
        .map(|row| row.get(0))
}

async fn load_json_rows<C>(
    client: &C,
    table: &str,
    with_amount_text: bool,
) -> Result<Vec<Value>, String>
where
    C: GenericClient + Sync,
{
    if !table_exists(client, table).await? {
        return Ok(Vec::new());
    }
    let expression = if with_amount_text {
        "to_jsonb(source_row) || jsonb_build_object('__amount_text', source_row.amount::text, '__firefly_amount_text', source_row.firefly_amount::text)"
    } else {
        "to_jsonb(source_row)"
    };
    let sql = format!("SELECT {expression} AS data FROM public.{table} source_row ORDER BY id");
    client
        .query(&sql, &[])
        .await
        .map_err(display)
        .map(|rows| rows.into_iter().map(|row| row.get(0)).collect())
}

async fn load_flows<C>(client: &C) -> Result<HashMap<String, Flow>, String>
where
    C: GenericClient + Sync,
{
    let rows = client
        .query(
            "SELECT f.slug, f.id, f.current_version, v.checksum
             FROM abei_ai.parser_flows f
             JOIN abei_ai.parser_flow_versions v
               ON v.flow_id = f.id AND v.version = f.current_version
             WHERE f.owner_user_id IS NULL AND f.status = 'published'",
            &[],
        )
        .await
        .map_err(display)?;
    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.get::<_, String>(0),
                Flow {
                    id: row.get(1),
                    version: row.get(2),
                    checksum: row.get(3),
                },
            )
        })
        .collect())
}

fn build_plan(snapshot: Snapshot, flows: &HashMap<String, Flow>) -> Result<(Plan, Report), String> {
    let mut report = Report {
        legacy_tables_present: snapshot.tables.clone(),
        ..Report::default()
    };
    set_count(
        &mut report.source_counts,
        "mail_messages",
        snapshot.messages.len(),
    );
    set_count(&mut report.source_counts, "tasks", snapshot.tasks.len());
    set_count(
        &mut report.source_counts,
        "artifacts",
        snapshot.artifacts.len(),
    );
    set_count(
        &mut report.source_counts,
        "statement_imports",
        snapshot.imports.len(),
    );
    set_count(&mut report.source_counts, "rows", snapshot.rows.len());

    let messages: HashMap<i64, &Value> = indexed(&snapshot.messages);
    let tasks: HashMap<i64, &Value> = indexed(&snapshot.tasks);
    let mut artifacts_by_task: HashMap<i64, Vec<Value>> = HashMap::new();
    for artifact in &snapshot.artifacts {
        match integer(artifact, "bill_task_id") {
            Some(task_id) if tasks.contains_key(&task_id) => {
                artifacts_by_task
                    .entry(task_id)
                    .or_default()
                    .push(artifact.clone());
            }
            _ => report.warnings.push(finding(
                "orphan_artifact",
                "artifact",
                integer(artifact, "id"),
                "旧工件没有可迁移的任务，保留在 legacy 表中。",
            )),
        }
    }
    let mut imports_by_task: HashMap<i64, Vec<Value>> = HashMap::new();
    for import in &snapshot.imports {
        match integer(import, "bill_task_id") {
            Some(task_id) if tasks.contains_key(&task_id) => {
                imports_by_task
                    .entry(task_id)
                    .or_default()
                    .push(import.clone());
            }
            _ => report.warnings.push(finding(
                "orphan_statement_import",
                "statement_import",
                integer(import, "id"),
                "旧导入批次没有可迁移的任务，保留在 legacy 表中。",
            )),
        }
    }
    let mut rows_by_task: HashMap<i64, Vec<Value>> = HashMap::new();
    for row in &snapshot.rows {
        match integer(row, "bill_task_id") {
            Some(task_id) if tasks.contains_key(&task_id) => {
                rows_by_task.entry(task_id).or_default().push(row.clone());
            }
            _ => report.blockers.push(finding(
                "orphan_row",
                "row",
                integer(row, "id"),
                "旧流水没有对应任务，不能在不丢失来源关系的情况下迁移。",
            )),
        }
    }

    let mut task_plans = Vec::new();
    let mut used_message_ids = HashSet::new();
    let mut synthetic_message_count = 0_usize;
    for task in &snapshot.tasks {
        let Some(task_id) = integer(task, "id") else {
            report
                .blockers
                .push(finding("missing_id", "task", None, "旧任务缺少 id。"));
            continue;
        };
        let Some(user_id) = integer(task, "user_id") else {
            report.blockers.push(finding(
                "missing_user_id",
                "task",
                Some(task_id),
                "旧任务缺少 user_id。",
            ));
            continue;
        };
        let task_imports = imports_by_task.remove(&task_id).unwrap_or_default();
        let task_artifacts = artifacts_by_task.remove(&task_id).unwrap_or_default();
        for artifact in &task_artifacts {
            if normalize_hash(text(artifact, "checksum").as_deref()).is_none() {
                report.warnings.push(finding(
                    "artifact_checksum_synthesized",
                    "artifact",
                    integer(artifact, "id"),
                    "旧工件没有有效 SHA-256；将对其元数据生成迁移校验值，并在 metadata 中标明。",
                ));
            }
        }
        let source_rows = rows_by_task.remove(&task_id).unwrap_or_default();
        let Some(flow_slug) = flow_slug(task, &task_imports, &task_artifacts) else {
            report.blockers.push(finding(
                "unknown_parser_flow",
                "task",
                Some(task_id),
                "无法把旧任务映射到已发布的内置解析流程。",
            ));
            continue;
        };
        let Some(flow) = flows.get(flow_slug).cloned() else {
            report.blockers.push(finding(
                "parser_flow_not_installed",
                "task",
                Some(task_id),
                format!("内置解析流程 {flow_slug} 尚未安装。"),
            ));
            continue;
        };
        if text(task, "profile_id").is_none() && text(task, "source").as_deref() == Some("cmb") {
            report.warnings.push(finding(
                "cmb_profile_inferred",
                "task",
                Some(task_id),
                format!("旧招商任务没有 profile_id，按工件类型推断为 {flow_slug}。"),
            ));
        }
        let mut sorted_rows = source_rows;
        sorted_rows.sort_by_key(|row| {
            (
                integer(row, "bill_statement_import_id").unwrap_or(i64::MAX),
                integer(row, "row_number").unwrap_or(i64::MAX),
                integer(row, "id").unwrap_or(i64::MAX),
            )
        });
        let mut row_plans = Vec::with_capacity(sorted_rows.len());
        for (index, row) in sorted_rows.iter().enumerate() {
            match map_row(row, task, index + 1, &mut report) {
                Ok(mapped) => row_plans.push(mapped),
                Err(message) => {
                    report
                        .blockers
                        .push(finding("invalid_row", "row", integer(row, "id"), message))
                }
            }
        }
        let account_hint = row_plans.iter().find_map(|row| row.account_hint.clone());
        let legacy_message_id = integer(task, "bill_mail_message_id")
            .filter(|message_id| messages.contains_key(message_id));
        if legacy_message_id.is_none() {
            synthetic_message_count += 1;
        }
        if integer(task, "bill_mail_message_id").is_some() && legacy_message_id.is_none() {
            report.warnings.push(finding(
                "missing_mail_message",
                "task",
                Some(task_id),
                "旧任务引用的邮件不存在，将创建带来源标记的占位邮件。",
            ));
        }
        if let Some(message_id) = legacy_message_id
            && !used_message_ids.insert(message_id)
        {
            synthetic_message_count += 1;
            report.warnings.push(finding(
                "shared_mail_message",
                "task",
                Some(task_id),
                "多个旧任务引用同一邮件，后续任务将使用可追溯的迁移副本。",
            ));
        }
        let (period_start, period_end) = import_period(&task_imports);
        let channel_key = channel_for_flow(flow_slug).to_owned();
        let task_plan = TaskPlan {
            legacy_id: task_id,
            user_id,
            legacy_message_id,
            flow,
            flow_slug: flow_slug.to_owned(),
            channel_key,
            source: text(task, "source").unwrap_or_else(|| "unknown".to_owned()),
            status: text(task, "status").unwrap_or_else(|| "unknown".to_owned()),
            summary: text(task, "summary"),
            account_hint,
            received_at: text(task, "received_at"),
            period_start,
            period_end,
            created_at: text(task, "created_at"),
            updated_at: text(task, "updated_at"),
            metadata: value(task, "metadata")
                .cloned()
                .unwrap_or_else(|| json!({})),
            imports: task_imports,
            artifacts: task_artifacts,
            rows: row_plans,
        };
        task_plans.push(task_plan);
    }

    let referenced: HashSet<i64> = task_plans
        .iter()
        .filter_map(|task| task.legacy_message_id)
        .collect();
    let orphan_message_ids = snapshot
        .messages
        .iter()
        .filter_map(|message| integer(message, "id"))
        .filter(|id| !referenced.contains(id))
        .collect::<Vec<_>>();
    set_count(
        &mut report.planned_counts,
        "mail_messages",
        snapshot.messages.len() + synthetic_message_count,
    );
    set_count(&mut report.planned_counts, "documents", task_plans.len());
    set_count(
        &mut report.planned_counts,
        "revisions",
        task_plans
            .iter()
            .filter(|task| !task.rows.is_empty())
            .count(),
    );
    set_count(
        &mut report.planned_counts,
        "artifacts",
        task_plans
            .iter()
            .filter(|task| !task.rows.is_empty())
            .map(|task| task.artifacts.len())
            .sum(),
    );
    set_count(
        &mut report.planned_counts,
        "rows",
        task_plans.iter().map(|task| task.rows.len()).sum(),
    );
    set_count(
        &mut report.planned_counts,
        "import_attempts",
        task_plans
            .iter()
            .flat_map(|task| &task.rows)
            .filter(|row| row.status == "imported" && row.transaction_group_id.is_some())
            .count(),
    );
    report.semantic_changes.insert(
        "firefly_external_id_replaced_with_stable_abei_id".to_owned(),
        task_plans.iter().map(|task| task.rows.len() as u64).sum(),
    );
    report.semantic_changes.insert(
        "legacy_split_parent_dismissed".to_owned(),
        task_plans
            .iter()
            .flat_map(|task| &task.rows)
            .filter(|row| row.dismissed_reason.as_deref() == Some("legacy_split_parent"))
            .count() as u64,
    );

    Ok((
        Plan {
            snapshot,
            tasks: task_plans,
            orphan_message_ids,
        },
        report,
    ))
}

fn map_row(
    row: &Value,
    task: &Value,
    sequence: usize,
    report: &mut Report,
) -> Result<RowPlan, String> {
    let legacy_id = integer(row, "id").ok_or_else(|| "旧流水缺少 id。".to_owned())?;
    let legacy_task_id =
        integer(row, "bill_task_id").ok_or_else(|| "旧流水缺少 bill_task_id。".to_owned())?;
    let user_id = integer(row, "user_id").ok_or_else(|| "旧流水缺少 user_id。".to_owned())?;
    if integer(task, "user_id") != Some(user_id) {
        return Err("旧流水和任务属于不同用户。".to_owned());
    }
    let raw_amount = text(row, "__firefly_amount_text").or_else(|| text(row, "__amount_text"));
    let parsed_amount = raw_amount.as_deref().and_then(decimal);
    let firefly_type = normalized_type(text(row, "firefly_type"), text(row, "direction"));
    let signed = signed_amount(
        parsed_amount.unwrap_or(Decimal::ZERO),
        firefly_type.as_deref(),
        text(row, "direction").as_deref(),
    );
    let mut issues = Vec::new();
    if parsed_amount.is_none() {
        issues.push(issue(
            "legacy_amount_missing",
            "旧流水没有可用金额，迁移为 0，入账前必须确认。",
        ));
        report.warnings.push(finding(
            "amount_defaulted",
            "row",
            Some(legacy_id),
            "旧流水金额为空或无效，迁移值为 0。",
        ));
    }
    let occurred_at = text(row, "occurred_at")
        .or_else(|| text(row, "firefly_date"))
        .or_else(|| text(row, "created_at"))
        .unwrap_or_else(|| "1970-01-01 00:00:00+00".to_owned());
    if text(row, "occurred_at").is_none() && text(row, "firefly_date").is_none() {
        issues.push(issue(
            "legacy_date_missing",
            "旧流水没有交易时间，暂用创建时间，入账前必须确认。",
        ));
    }
    let (currency_code, assumed_currency) = currency(row);
    if assumed_currency {
        issues.push(issue(
            "legacy_currency_assumed",
            "旧流水没有标准币种字段，暂按 CNY 迁移。",
        ));
        *report
            .semantic_changes
            .entry("currency_assumed_cny".to_owned())
            .or_default() += 1;
    }
    let counterparty = text(row, "counterparty");
    let description = first_text(row, &["firefly_description", "description", "counterparty"])
        .unwrap_or_else(|| format!("Legacy bill row #{legacy_id}"));
    let source_name = text(row, "source_name");
    let destination_name = text(row, "destination_name");
    let payment_method = text(row, "payment_method");
    let account_hint = payment_method
        .clone()
        .or_else(|| match firefly_type.as_deref() {
            Some("deposit") => destination_name.clone(),
            _ => source_name.clone(),
        });
    let old_status = text(row, "status").unwrap_or_else(|| "pending".to_owned());
    let review_state = text(row, "review_state");
    let transaction_group_id = integer(row, "transaction_group_id");
    let (status, dismissed_reason) = if transaction_group_id.is_some() {
        ("imported".to_owned(), None)
    } else if old_status == "split" {
        (
            "dismissed".to_owned(),
            Some("legacy_split_parent".to_owned()),
        )
    } else if old_status == "dismissed" || review_state.as_deref() == Some("excluded") {
        (
            "dismissed".to_owned(),
            text(row, "dismissed_reason")
                .or_else(|| text(row, "excluded_reason"))
                .or_else(|| Some("legacy_excluded".to_owned())),
        )
    } else {
        ("pending".to_owned(), None)
    };
    if (old_status == "imported" || review_state.as_deref() == Some("booked"))
        && transaction_group_id.is_none()
    {
        issues.push(issue(
            "legacy_import_result_missing",
            "旧记录显示已入账，但没有交易组 ID，已转为待确认，禁止假定成功。",
        ));
    }
    if old_status == "failed" {
        issues.push(issue(
            "legacy_import_failed",
            text(row, "error_message")
                .as_deref()
                .unwrap_or("旧链路最后一次入账失败。"),
        ));
    }
    if review_state.as_deref() == Some("pending_confirm") {
        issues.push(issue(
            "legacy_pending_confirmation",
            text(row, "confirm_reason")
                .as_deref()
                .unwrap_or("旧链路要求人工确认。"),
        ));
    }
    let duplicate_state = match text(row, "duplicate_state").as_deref() {
        Some("duplicate") => "duplicate",
        Some("conflict") => "conflict",
        _ => "unique",
    }
    .to_owned();
    if duplicate_state != "unique" {
        issues.push(issue(
            &format!("duplicate_{duplicate_state}"),
            "旧链路标记了可能重复的流水，请保留人工判断。",
        ));
    }
    if status == "pending" {
        issues.push(issue(
            "account_mapping_required",
            "旧记录只有账户名称，入账前需要重新确认 Firefly 账户 ID。",
        ));
    }
    let provider_transaction_id = text(row, "platform_order_no");
    let merchant_order_id = text(row, "merchant_order_no");
    let external_key = text(row, "external_key")
        .or_else(|| {
            provider_transaction_id
                .as_ref()
                .map(|id| format!("provider:{}:{}", channel_for_task(task), id))
        })
        .unwrap_or_else(|| format!("legacy:bill-row:{legacy_id}"));
    let fingerprint = normalize_hash(text(row, "fingerprint").as_deref())
        .unwrap_or_else(|| sha256(external_key.as_bytes()));
    let source_locator = json!({
        "legacy_bill_statement_row_id": legacy_id,
        "legacy_bill_task_id": legacy_task_id,
        "legacy_bill_statement_import_id": integer(row, "bill_statement_import_id"),
        "legacy_row_number": integer(row, "row_number")
    });
    let raw_fields = json!({
        "legacy_raw_data": value(row, "raw_data").cloned().unwrap_or(Value::Null),
        "legacy_editable_data": value(row, "editable_data").cloned().unwrap_or(Value::Null),
        "legacy_metadata": value(row, "metadata").cloned().unwrap_or(Value::Null),
        "legacy_review": {
            "status": old_status,
            "review_state": review_state,
            "confirm_reason": text(row, "confirm_reason"),
            "excluded_reason": text(row, "excluded_reason"),
            "hint_flags": value(row, "hint_flags").cloned().unwrap_or(Value::Null)
        }
    });
    let firefly_amount = parsed_amount.map(|amount| normalized_decimal(amount.abs()));
    let firefly_date = text(row, "firefly_date")
        .or_else(|| text(row, "occurred_at"))
        .and_then(|date| date_prefix(&date));
    let dismissed_at = if status == "dismissed" {
        text(row, "dismissed_at").or_else(|| text(row, "updated_at"))
    } else {
        None
    };
    Ok(RowPlan {
        legacy_id,
        user_id,
        row_number: i32::try_from(sequence).map_err(|_| "单个任务的流水超过 i32 范围。")?,
        source_locator,
        raw_fields,
        occurred_at,
        signed_amount: normalized_decimal(signed),
        currency_code,
        counterparty,
        counterparty_account: text(row, "counterparty_account"),
        description: description.clone(),
        account_hint,
        payment_method,
        provider_transaction_id,
        merchant_order_id,
        provider_category: text(row, "platform_category"),
        provider_status: text(row, "transaction_status"),
        remark: text(row, "remark"),
        external_key,
        fingerprint,
        duplicate_legacy_id: integer(row, "duplicate_of_row_id"),
        duplicate_state,
        status,
        issues: Value::Array(issues),
        dismissed_reason,
        dismissed_at,
        firefly_type,
        firefly_date,
        firefly_amount,
        firefly_description: text(row, "firefly_description").or(Some(description)),
        source_name,
        destination_name,
        category_name: text(row, "category_name"),
        tags: tags(value(row, "tags")),
        notes: text(row, "notes"),
        suggested_by: text(row, "suggested_by"),
        suggested_at: text(row, "suggested_at"),
        user_modified_at: text(row, "user_modified_at"),
        transaction_group_id,
        last_import_error: text(row, "error_message"),
        event_group_id: text(row, "event_group_id"),
        created_at: text(row, "created_at"),
        updated_at: text(row, "updated_at"),
    })
}

async fn apply_plan(
    transaction: &Transaction<'_>,
    plan: &Plan,
    report: &mut Report,
) -> Result<(), String> {
    let tasks_by_message =
        plan.tasks
            .iter()
            .fold(HashMap::<i64, Vec<&TaskPlan>>::new(), |mut map, task| {
                if let Some(message_id) = task.legacy_message_id {
                    map.entry(message_id).or_default().push(task);
                }
                map
            });
    let mut target_messages = HashMap::<i64, i64>::new();
    for message in &plan.snapshot.messages {
        let legacy_id = integer(message, "id").ok_or_else(|| "旧邮件缺少 id。".to_owned())?;
        let route = tasks_by_message
            .get(&legacy_id)
            .and_then(|tasks| tasks.first())
            .copied();
        let (target_id, inserted) = ensure_primary_message(transaction, message, route).await?;
        target_messages.insert(legacy_id, target_id);
        if inserted {
            increment(&mut report.inserted_counts, "mail_messages");
        }
    }
    for legacy_id in &plan.orphan_message_ids {
        if !target_messages.contains_key(legacy_id) {
            return Err(format!("旧邮件 {legacy_id} 未进入迁移映射。"));
        }
    }

    let mut target_rows = HashMap::<i64, i64>::new();
    let mut inserted_rows = HashSet::new();
    for task in &plan.tasks {
        let mut message_id = match task
            .legacy_message_id
            .and_then(|id| target_messages.get(&id).copied())
        {
            Some(id) => id,
            None => {
                let (id, inserted) = ensure_task_message(transaction, task, None).await?;
                if inserted {
                    increment(&mut report.inserted_counts, "mail_messages");
                }
                id
            }
        };
        if let Some(existing_document) = transaction
            .query_opt(
                "SELECT id, legacy_bill_task_id FROM abei_ai.bill_documents WHERE mail_message_id = $1",
                &[&message_id],
            )
            .await
            .map_err(display)?
        {
            let existing_legacy: Option<i64> = existing_document.get(1);
            if existing_legacy != Some(task.legacy_id) {
                let legacy_message = task
                    .legacy_message_id
                    .and_then(|id| plan.snapshot.messages.iter().find(|message| integer(message, "id") == Some(id)));
                let (synthetic_id, inserted) = ensure_task_message(transaction, task, legacy_message).await?;
                message_id = synthetic_id;
                if inserted {
                    increment(&mut report.inserted_counts, "mail_messages");
                }
            }
        }
        let (document_id, inserted) = ensure_document(transaction, task, message_id).await?;
        if inserted {
            increment(&mut report.inserted_counts, "documents");
        }
        let (job_id, job_inserted) = ensure_parse_job(transaction, task, document_id).await?;
        if job_inserted {
            increment(&mut report.inserted_counts, "parse_jobs");
        }
        if task.rows.is_empty() {
            continue;
        }
        let revision_inserted = ensure_revision(transaction, task, document_id, job_id).await?;
        if revision_inserted {
            increment(&mut report.inserted_counts, "revisions");
        }
        migrate_artifacts(transaction, task, document_id, report).await?;
        for row in &task.rows {
            let (target_id, inserted) = ensure_row(transaction, row, document_id).await?;
            target_rows.insert(row.legacy_id, target_id);
            if inserted {
                inserted_rows.insert(row.legacy_id);
                increment(&mut report.inserted_counts, "rows");
            }
        }
    }

    for task in &plan.tasks {
        for row in &task.rows {
            if !inserted_rows.contains(&row.legacy_id) {
                continue;
            }
            if let Some(duplicate_legacy_id) = row.duplicate_legacy_id
                && let (Some(target_id), Some(duplicate_id)) = (
                    target_rows.get(&row.legacy_id),
                    target_rows.get(&duplicate_legacy_id),
                )
            {
                transaction
                    .execute(
                        "UPDATE abei_ai.bill_rows SET duplicate_of_row_id = $2, updated_at = now()
                         WHERE id = $1 AND duplicate_of_row_id IS NULL",
                        &[target_id, duplicate_id],
                    )
                    .await
                    .map_err(display)?;
            }
        }
    }
    migrate_event_links(transaction, plan, &target_rows, report).await?;
    migrate_import_attempts(transaction, plan, &target_rows, report).await?;
    Ok(())
}

async fn ensure_primary_message(
    transaction: &Transaction<'_>,
    message: &Value,
    route: Option<&TaskPlan>,
) -> Result<(i64, bool), String> {
    let legacy_id = integer(message, "id").ok_or_else(|| "旧邮件缺少 id。".to_owned())?;
    if let Some(row) = transaction
        .query_opt(
            "SELECT id FROM abei_ai.mail_messages WHERE legacy_bill_mail_message_id = $1",
            &[&legacy_id],
        )
        .await
        .map_err(display)?
    {
        return Ok((row.get(0), false));
    }
    let user_id =
        integer(message, "user_id").ok_or_else(|| format!("旧邮件 {legacy_id} 缺少 user_id。"))?;
    let mut checksum = normalize_hash(text(message, "checksum").as_deref());
    let mut message_id = text(message, "message_id");
    let natural = if let Some(value) = message_id.as_deref() {
        transaction
            .query_opt(
                "SELECT id, legacy_bill_mail_message_id FROM abei_ai.mail_messages
                 WHERE user_id = $1 AND message_id = $2",
                &[&user_id, &value],
            )
            .await
            .map_err(display)?
    } else if let Some(value) = checksum.as_deref() {
        transaction
            .query_opt(
                "SELECT id, legacy_bill_mail_message_id FROM abei_ai.mail_messages
                 WHERE user_id = $1 AND raw_checksum = $2",
                &[&user_id, &value],
            )
            .await
            .map_err(display)?
    } else {
        None
    };
    if let Some(row) = natural {
        let target_id: i64 = row.get(0);
        let assigned: Option<i64> = row.get(1);
        if assigned.is_none() || assigned == Some(legacy_id) {
            transaction
                .execute(
                    "UPDATE abei_ai.mail_messages SET legacy_bill_mail_message_id = $2,
                       match_diagnostics = match_diagnostics || $3::jsonb, updated_at = now()
                     WHERE id = $1",
                    &[
                        &target_id,
                        &legacy_id,
                        &json!([{ "kind": "legacy_migration_natural_match", "legacy_bill_mail_message_id": legacy_id }]),
                    ],
                )
                .await
                .map_err(display)?;
            return Ok((target_id, false));
        }
        message_id = None;
        checksum = None;
    }
    insert_message(
        transaction,
        message,
        route,
        Some(legacy_id),
        None,
        message_id,
        checksum,
    )
    .await
}

async fn ensure_task_message(
    transaction: &Transaction<'_>,
    task: &TaskPlan,
    legacy_message: Option<&Value>,
) -> Result<(i64, bool), String> {
    if let Some(row) = transaction
        .query_opt(
            "SELECT id FROM abei_ai.mail_messages WHERE legacy_bill_task_id = $1",
            &[&task.legacy_id],
        )
        .await
        .map_err(display)?
    {
        return Ok((row.get(0), false));
    }
    let fallback = json!({
        "id": task.legacy_id,
        "user_id": task.user_id,
        "subject": task.summary,
        "received_at": task.received_at,
        "created_at": task.created_at,
        "updated_at": task.updated_at
    });
    insert_message(
        transaction,
        legacy_message.unwrap_or(&fallback),
        Some(task),
        None,
        Some(task.legacy_id),
        None,
        None,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn insert_message(
    transaction: &Transaction<'_>,
    message: &Value,
    route: Option<&TaskPlan>,
    legacy_message_id: Option<i64>,
    legacy_task_id: Option<i64>,
    message_id: Option<String>,
    checksum: Option<String>,
) -> Result<(i64, bool), String> {
    let source_id = legacy_message_id.or(legacy_task_id).unwrap_or(1);
    let user_id = route
        .map(|task| task.user_id)
        .or_else(|| integer(message, "user_id"))
        .ok_or_else(|| "迁移邮件缺少 user_id。".to_owned())?;
    let raw_path = text(message, "raw_path");
    let to_addresses = text(message, "to_address").into_iter().collect::<Vec<_>>();
    let classification = if route.is_some() {
        "matched"
    } else {
        "unclassified"
    };
    let headers = json!({
        "legacy": {
            "bill_mail_message_id": legacy_message_id,
            "bill_task_id": legacy_task_id,
            "message_id": text(message, "message_id"),
            "mailbox": text(message, "mailbox"),
            "body_text_path": text(message, "body_text_path"),
            "body_html_path": text(message, "body_html_path"),
            "checksum": text(message, "checksum"),
            "sync_cursor": text(message, "sync_cursor")
        }
    });
    let body_structure = json!({
        "legacy_body_text_path": text(message, "body_text_path"),
        "legacy_body_html_path": text(message, "body_html_path")
    });
    let diagnostics = json!([{
        "kind": "legacy_migration",
        "legacy_bill_mail_message_id": legacy_message_id,
        "legacy_bill_task_id": legacy_task_id
    }]);
    let row = transaction
        .query_one(
            "INSERT INTO abei_ai.mail_messages
               (user_id, mailbox_user_id, folder, uid_validity, uid, message_id,
                from_address, to_addresses, subject, received_at, headers, body_structure,
                content_state, raw_path, raw_checksum, classification, channel_key,
                parser_flow_id, legacy_channel_key, match_diagnostics,
                legacy_bill_mail_message_id, legacy_bill_task_id, created_at, updated_at)
             VALUES ($1,NULL,$2,1,$3,$4,$5,$6,$7,$8::text::timestamptz,$9,$10,$11,$12,$13,$14,
                     $15,$16,$17,$18,$19,$20,COALESCE($21::text::timestamptz,now()),
                     COALESCE($22::text::timestamptz,now()))
             RETURNING id",
            &[
                &user_id,
                &if legacy_task_id.is_some() {
                    "legacy-task"
                } else {
                    "legacy"
                },
                &source_id,
                &message_id,
                &text(message, "from_address"),
                &to_addresses,
                &text(message, "subject").or_else(|| route.and_then(|task| task.summary.clone())),
                &text(message, "received_at")
                    .or_else(|| route.and_then(|task| task.received_at.clone())),
                &headers,
                &body_structure,
                &if raw_path.is_some() {
                    "cached"
                } else {
                    "unavailable"
                },
                &raw_path,
                &checksum,
                &classification,
                &route.map(|task| task.channel_key.as_str()),
                &route.map(|task| task.flow.id),
                &route.map(|task| task.source.as_str()),
                &diagnostics,
                &legacy_message_id,
                &legacy_task_id,
                &text(message, "created_at"),
                &text(message, "updated_at"),
            ],
        )
        .await
        .map_err(display)?;
    Ok((row.get(0), true))
}

async fn ensure_document(
    transaction: &Transaction<'_>,
    task: &TaskPlan,
    message_id: i64,
) -> Result<(i64, bool), String> {
    if let Some(row) = transaction
        .query_opt(
            "SELECT id FROM abei_ai.bill_documents WHERE legacy_bill_task_id = $1",
            &[&task.legacy_id],
        )
        .await
        .map_err(display)?
    {
        return Ok((row.get(0), false));
    }
    let lifecycle = if task.status == "archived" {
        "archived"
    } else {
        "active"
    };
    let row = transaction
        .query_one(
            "INSERT INTO abei_ai.bill_documents
               (user_id, mail_message_id, channel_key, parser_flow_id, parser_flow_version,
                lifecycle, summary, account_hint, period_start, period_end, received_at,
                legacy_bill_task_id, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text::date,$10::text::date,
                     $11::text::timestamptz,$12,COALESCE($13::text::timestamptz,now()),
                     COALESCE($14::text::timestamptz,now()))
             RETURNING id",
            &[
                &task.user_id,
                &message_id,
                &task.channel_key,
                &task.flow.id,
                &task.flow.version,
                &lifecycle,
                &task.summary,
                &task.account_hint,
                &task.period_start,
                &task.period_end,
                &task.received_at,
                &task.legacy_id,
                &task.created_at,
                &task.updated_at,
            ],
        )
        .await
        .map_err(display)?;
    Ok((row.get(0), true))
}

async fn ensure_parse_job(
    transaction: &Transaction<'_>,
    task: &TaskPlan,
    document_id: i64,
) -> Result<(i64, bool), String> {
    if let Some(row) = transaction
        .query_opt(
            "SELECT id FROM abei_ai.parse_jobs WHERE bill_document_id = $1 AND target_revision = 1",
            &[&document_id],
        )
        .await
        .map_err(display)?
    {
        return Ok((row.get(0), false));
    }
    let (status, stage, waiting_reason, error_code, error_message) = if !task.rows.is_empty() {
        ("succeeded", "finished", None, None, None)
    } else if task.status.contains("secret") || task.status.contains("password") {
        (
            "waiting_input",
            "unlock",
            Some("secret_required"),
            None,
            None,
        )
    } else {
        (
            "failed",
            "finished",
            None,
            Some("legacy_unparsed"),
            Some("旧任务没有解析流水，可在新工作台中显式重新解析。"),
        )
    };
    let finished_at = if status == "waiting_input" {
        None
    } else {
        task.updated_at.clone()
    };
    let progress = json!({
        "stage": stage,
        "legacy_migration": true,
        "legacy_bill_task_id": task.legacy_id,
        "rows_valid": task.rows.len(),
        "rows_invalid": 0
    });
    let row = transaction
        .query_one(
            "INSERT INTO abei_ai.parse_jobs
               (user_id, bill_document_id, target_revision, parser_flow_id, parser_flow_version,
                definition_checksum, status, stage, progress, waiting_reason, error_code,
                error_message, requested_at, started_at, finished_at, updated_at)
             VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                     COALESCE($12::text::timestamptz,now()),$13::text::timestamptz,
                     $14::text::timestamptz,COALESCE($15::text::timestamptz,now())) RETURNING id",
            &[
                &task.user_id,
                &document_id,
                &task.flow.id,
                &task.flow.version,
                &task.flow.checksum,
                &status,
                &stage,
                &progress,
                &waiting_reason,
                &error_code,
                &error_message,
                &task.created_at,
                &task.created_at,
                &finished_at,
                &task.updated_at,
            ],
        )
        .await
        .map_err(display)?;
    Ok((row.get(0), true))
}

async fn ensure_revision(
    transaction: &Transaction<'_>,
    task: &TaskPlan,
    document_id: i64,
    job_id: i64,
) -> Result<bool, String> {
    if transaction
        .query_opt(
            "SELECT 1 FROM abei_ai.bill_document_revisions
             WHERE bill_document_id = $1 AND revision = 1",
            &[&document_id],
        )
        .await
        .map_err(display)?
        .is_some()
    {
        return Ok(false);
    }
    let mut totals = BTreeMap::<String, Decimal>::new();
    for row in &task.rows {
        let amount = Decimal::from_str(&row.signed_amount).map_err(display)?;
        *totals.entry(row.currency_code.clone()).or_default() += amount;
    }
    let totals = totals
        .into_iter()
        .map(|(currency, amount)| (currency, Value::String(normalized_decimal(amount))))
        .collect::<Map<_, _>>();
    let imports = task
        .imports
        .iter()
        .map(|import| {
            json!({
                "id": integer(import, "id"),
                "profile_id": text(import, "profile_id"),
                "original_filename": text(import, "original_filename"),
                "archived_filename": text(import, "archived_filename"),
                "period_start": text(import, "period_start"),
                "period_end": text(import, "period_end"),
                "row_count": integer(import, "row_count"),
                "status": text(import, "status"),
                "metadata": value(import, "metadata").cloned().unwrap_or(Value::Null)
            })
        })
        .collect::<Vec<_>>();
    let statement_metadata = json!({
        "legacy_migration": true,
        "legacy_bill_task_id": task.legacy_id,
        "legacy_profile_id": task.flow_slug,
        "legacy_task_metadata": task.metadata,
        "legacy_statement_imports": imports
    });
    transaction
        .execute(
            "INSERT INTO abei_ai.bill_document_revisions
               (bill_document_id, revision, parse_job_id, parser_flow_id, parser_flow_version,
                statement_metadata, valid_row_count, invalid_row_count, amount_totals,
                warnings, metrics, node_results, created_at)
             VALUES ($1,1,$2,$3,$4,$5,$6,0,$7,
                     '[{\"code\":\"legacy_migration\",\"message\":\"由旧账单表迁移\"}]'::jsonb,
                     $8,'[]'::jsonb,COALESCE($9::text::timestamptz,now()))",
            &[
                &document_id,
                &job_id,
                &task.flow.id,
                &task.flow.version,
                &statement_metadata,
                &(task.rows.len() as i32),
                &Value::Object(totals),
                &json!({ "legacy_rows": task.rows.len(), "legacy_artifacts": task.artifacts.len() }),
                &task.updated_at,
            ],
        )
        .await
        .map_err(display)?;
    transaction
        .execute(
            "UPDATE abei_ai.bill_documents SET active_revision = 1, updated_at = now()
             WHERE id = $1 AND active_revision IS NULL",
            &[&document_id],
        )
        .await
        .map_err(display)?;
    Ok(true)
}

async fn migrate_artifacts(
    transaction: &Transaction<'_>,
    task: &TaskPlan,
    document_id: i64,
    report: &mut Report,
) -> Result<(), String> {
    let mut used_keys = HashSet::new();
    let mut mapped = HashMap::<i64, i64>::new();
    for artifact in &task.artifacts {
        let Some(legacy_id) = integer(artifact, "id") else {
            continue;
        };
        if let Some(row) = transaction
            .query_opt(
                "SELECT id FROM abei_ai.bill_artifacts WHERE legacy_bill_artifact_id = $1",
                &[&legacy_id],
            )
            .await
            .map_err(display)?
        {
            mapped.insert(legacy_id, row.get(0));
            continue;
        }
        let kind = text(artifact, "kind").unwrap_or_else(|| "legacy".to_owned());
        let original_filename =
            text(artifact, "filename").unwrap_or_else(|| format!("legacy-artifact-{legacy_id}"));
        let normalized_checksum = normalize_hash(text(artifact, "checksum").as_deref());
        let checksum = normalized_checksum
            .clone()
            .unwrap_or_else(|| sha256(artifact.to_string().as_bytes()));
        let mut filename = original_filename.clone();
        if !used_keys.insert((checksum.clone(), filename.clone())) {
            filename = format!("{original_filename}.legacy-{legacy_id}");
        }
        let metadata = json!({
            "legacy_migration": true,
            "legacy_bill_artifact_id": legacy_id,
            "legacy_parent_artifact_id": integer(artifact, "derived_from_artifact_id"),
            "legacy_filename": original_filename,
            "legacy_checksum": text(artifact, "checksum"),
            "checksum_provenance": if normalized_checksum.is_some() { "content" } else { "metadata_fallback" },
            "legacy_metadata": value(artifact, "metadata").cloned().unwrap_or(Value::Null)
        });
        let mime_type = mime_type(&kind, &filename);
        let generation_stage = generation_stage(&kind);
        let size = value(artifact, "metadata")
            .and_then(|metadata| integer(metadata, "size"))
            .unwrap_or(0)
            .max(0);
        let row = transaction
            .query_one(
                "INSERT INTO abei_ai.bill_artifacts
                   (user_id, bill_document_id, revision, kind, filename, path, checksum, size,
                    encrypted, metadata, mime_type, generation_stage, legacy_bill_artifact_id,
                    created_at)
                 VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                         COALESCE($13::text::timestamptz,now())) RETURNING id",
                &[
                    &task.user_id,
                    &document_id,
                    &kind,
                    &filename,
                    &text(artifact, "path"),
                    &checksum,
                    &size,
                    &boolean(artifact, "encrypted").unwrap_or(false),
                    &metadata,
                    &mime_type,
                    &generation_stage,
                    &legacy_id,
                    &text(artifact, "created_at"),
                ],
            )
            .await
            .map_err(display)?;
        mapped.insert(legacy_id, row.get(0));
        increment(&mut report.inserted_counts, "artifacts");
    }
    for artifact in &task.artifacts {
        let Some(legacy_id) = integer(artifact, "id") else {
            continue;
        };
        let Some(parent_legacy_id) = integer(artifact, "derived_from_artifact_id") else {
            continue;
        };
        if let (Some(target_id), Some(parent_id)) =
            (mapped.get(&legacy_id), mapped.get(&parent_legacy_id))
        {
            transaction
                .execute(
                    "UPDATE abei_ai.bill_artifacts SET parent_artifact_id = $2
                     WHERE id = $1 AND parent_artifact_id IS NULL",
                    &[target_id, parent_id],
                )
                .await
                .map_err(display)?;
        }
    }
    Ok(())
}

async fn ensure_row(
    transaction: &Transaction<'_>,
    row: &RowPlan,
    document_id: i64,
) -> Result<(i64, bool), String> {
    if let Some(existing) = transaction
        .query_opt(
            "SELECT id FROM abei_ai.bill_rows WHERE legacy_bill_statement_row_id = $1",
            &[&row.legacy_id],
        )
        .await
        .map_err(display)?
    {
        return Ok((existing.get(0), false));
    }
    let inserted = transaction
        .query_one(
            "INSERT INTO abei_ai.bill_rows
               (user_id, bill_document_id, revision, row_number, source_locator, raw_fields,
                occurred_at, signed_amount, currency_code, counterparty, counterparty_account,
                description, account_hint, payment_method, provider_transaction_id,
                merchant_order_id, provider_category, provider_status, remark, external_key,
                fingerprint, fingerprint_version, duplicate_state, status, issues,
                dismissed_reason, dismissed_at, firefly_type, firefly_date, firefly_amount,
                firefly_description, source_name, destination_name, category_name, tags, notes,
                suggested_by, suggested_at, user_modified_at, transaction_group_id,
                last_import_error, legacy_bill_statement_row_id, created_at, updated_at)
             VALUES ($1,$2,1,$3,$4,$5,$6,$7::text::numeric,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                     $18,$19,$20,1,$21,$22,$23,$24,$25::text::timestamptz,$26,
                     $27::text::date,$28::text::numeric,$29,$30,$31,$32,$33,$34,$35,
                     $36::text::timestamptz,$37::text::timestamptz,$38,$39,$40,
                     COALESCE($41::text::timestamptz,now()),
                     COALESCE($42::text::timestamptz,now()))
             RETURNING id",
            &[
                &row.user_id,
                &document_id,
                &row.row_number,
                &row.source_locator,
                &row.raw_fields,
                &row.occurred_at,
                &row.signed_amount,
                &row.currency_code,
                &row.counterparty,
                &row.counterparty_account,
                &row.description,
                &row.account_hint,
                &row.payment_method,
                &row.provider_transaction_id,
                &row.merchant_order_id,
                &row.provider_category,
                &row.provider_status,
                &row.remark,
                &row.external_key,
                &row.fingerprint,
                &row.duplicate_state,
                &row.status,
                &row.issues,
                &row.dismissed_reason,
                &row.dismissed_at,
                &row.firefly_type,
                &row.firefly_date,
                &row.firefly_amount,
                &row.firefly_description,
                &row.source_name,
                &row.destination_name,
                &row.category_name,
                &row.tags,
                &row.notes,
                &row.suggested_by,
                &row.suggested_at,
                &row.user_modified_at,
                &row.transaction_group_id,
                &row.last_import_error,
                &row.legacy_id,
                &row.created_at,
                &row.updated_at,
            ],
        )
        .await
        .map_err(display)?;
    Ok((inserted.get(0), true))
}

async fn migrate_event_links(
    transaction: &Transaction<'_>,
    plan: &Plan,
    target_rows: &HashMap<i64, i64>,
    report: &mut Report,
) -> Result<(), String> {
    let mut groups = HashMap::<(i64, String), Vec<i64>>::new();
    for task in &plan.tasks {
        for row in &task.rows {
            if let (Some(group), Some(target_id)) =
                (&row.event_group_id, target_rows.get(&row.legacy_id))
            {
                groups
                    .entry((row.user_id, group.clone()))
                    .or_default()
                    .push(*target_id);
            }
        }
    }
    for ((user_id, group), mut ids) in groups {
        ids.sort_unstable();
        ids.dedup();
        for left_index in 0..ids.len() {
            for right_index in (left_index + 1)..ids.len() {
                let inserted = transaction
                    .execute(
                        "INSERT INTO abei_ai.bill_row_links
                           (user_id, left_row_id, right_row_id, relation, confidence, evidence)
                         VALUES ($1,$2,$3,'cross_source_candidate',1,$4)
                         ON CONFLICT (left_row_id, right_row_id, relation) DO NOTHING",
                        &[
                            &user_id,
                            &ids[left_index],
                            &ids[right_index],
                            &json!({ "legacy_migration": true, "legacy_event_group_id": group }),
                        ],
                    )
                    .await
                    .map_err(display)?;
                if inserted > 0 {
                    increment(&mut report.inserted_counts, "row_links");
                }
            }
        }
    }
    Ok(())
}

async fn migrate_import_attempts(
    transaction: &Transaction<'_>,
    plan: &Plan,
    target_rows: &HashMap<i64, i64>,
    report: &mut Report,
) -> Result<(), String> {
    for task in &plan.tasks {
        for row in &task.rows {
            let (Some(group_id), Some(target_row_id)) = (
                row.transaction_group_id,
                target_rows.get(&row.legacy_id).copied(),
            ) else {
                continue;
            };
            if transaction
                .query_opt(
                    "SELECT 1 FROM abei_ai.bill_import_attempts
                     WHERE bill_row_id = $1 AND status IN ('succeeded','reconciled')",
                    &[&target_row_id],
                )
                .await
                .map_err(display)?
                .is_some()
            {
                continue;
            }
            let attempt_no: i32 = transaction
                .query_one(
                    "SELECT COALESCE(max(attempt_no),0)::int + 1
                     FROM abei_ai.bill_import_attempts WHERE bill_row_id = $1",
                    &[&target_row_id],
                )
                .await
                .map_err(display)?
                .get(0);
            let attempt_id = Uuid::new_v4().to_string();
            let external_id = format!("abei:bill-row:{target_row_id}");
            let payload = json!({
                "legacy_migration": true,
                "type": row.firefly_type,
                "date": row.firefly_date,
                "amount": row.firefly_amount,
                "currency_code": row.currency_code,
                "description": row.firefly_description,
                "source_name": row.source_name,
                "destination_name": row.destination_name,
                "category_name": row.category_name,
                "tags": row.tags,
                "external_id": external_id
            });
            let payload_hash = sha256(serde_json::to_string(&payload).map_err(display)?.as_bytes());
            transaction
                .execute(
                    "INSERT INTO abei_ai.bill_import_attempts
                       (id, user_id, bill_row_id, attempt_no, status, external_id, payload_hash,
                        payload_snapshot, transaction_group_id, created_at, updated_at, finished_at)
                     VALUES ($1,$2,$3,$4,'reconciled',$5,$6,$7,$8,
                             COALESCE($9::text::timestamptz,now()),
                             COALESCE($10::text::timestamptz,now()),
                             COALESCE($10::text::timestamptz,now()))",
                    &[
                        &attempt_id,
                        &row.user_id,
                        &target_row_id,
                        &attempt_no,
                        &external_id,
                        &payload_hash,
                        &payload,
                        &group_id,
                        &row.created_at,
                        &row.updated_at,
                    ],
                )
                .await
                .map_err(display)?;
            increment(&mut report.inserted_counts, "import_attempts");
        }
    }
    Ok(())
}

async fn compare_existing<C>(
    client: &C,
    plan: &Plan,
    max_samples: usize,
) -> Result<Comparison, String>
where
    C: GenericClient + Sync,
{
    let rows = client
        .query(
            "SELECT to_jsonb(target_row) || jsonb_build_object(
                '__signed_amount_text', target_row.signed_amount::text,
                '__firefly_amount_text', target_row.firefly_amount::text) AS data
             FROM abei_ai.bill_rows target_row
             WHERE legacy_bill_statement_row_id IS NOT NULL",
            &[],
        )
        .await
        .map_err(display)?;
    let targets = rows
        .into_iter()
        .map(|row| row.get::<_, Value>(0))
        .filter_map(|row| integer(&row, "legacy_bill_statement_row_id").map(|id| (id, row)))
        .collect::<HashMap<_, _>>();
    let mut comparison = Comparison::default();
    for expected in plan.tasks.iter().flat_map(|task| &task.rows) {
        let Some(actual) = targets.get(&expected.legacy_id) else {
            comparison.missing_rows += 1;
            if comparison.samples.len() < max_samples {
                comparison.samples.push(DifferenceSample {
                    legacy_row_id: expected.legacy_id,
                    target_row_id: None,
                    fields: vec!["missing_target".to_owned()],
                });
            }
            continue;
        };
        comparison.compared_rows += 1;
        let mut fields = Vec::new();
        compare_field(
            &mut fields,
            "status",
            Some(expected.status.clone()),
            text(actual, "status"),
        );
        compare_field(
            &mut fields,
            "occurred_at",
            Some(expected.occurred_at.clone()),
            text(actual, "occurred_at"),
        );
        compare_decimal_field(
            &mut fields,
            "signed_amount",
            Some(expected.signed_amount.clone()),
            text(actual, "__signed_amount_text"),
        );
        compare_field(
            &mut fields,
            "currency_code",
            Some(expected.currency_code.clone()),
            text(actual, "currency_code"),
        );
        compare_field(
            &mut fields,
            "firefly_type",
            expected.firefly_type.clone(),
            text(actual, "firefly_type"),
        );
        compare_field(
            &mut fields,
            "firefly_date",
            expected.firefly_date.clone(),
            text(actual, "firefly_date"),
        );
        compare_decimal_field(
            &mut fields,
            "firefly_amount",
            expected.firefly_amount.clone(),
            text(actual, "__firefly_amount_text"),
        );
        compare_field(
            &mut fields,
            "description",
            expected.firefly_description.clone(),
            text(actual, "firefly_description"),
        );
        compare_field(
            &mut fields,
            "source_name",
            expected.source_name.clone(),
            text(actual, "source_name"),
        );
        compare_field(
            &mut fields,
            "destination_name",
            expected.destination_name.clone(),
            text(actual, "destination_name"),
        );
        compare_field(
            &mut fields,
            "category_name",
            expected.category_name.clone(),
            text(actual, "category_name"),
        );
        compare_tags(
            &mut fields,
            expected.tags.as_ref(),
            tags(value(actual, "tags")).as_ref(),
        );
        compare_field(
            &mut fields,
            "provider_transaction_id",
            expected.provider_transaction_id.clone(),
            text(actual, "provider_transaction_id"),
        );
        compare_field(
            &mut fields,
            "merchant_order_id",
            expected.merchant_order_id.clone(),
            text(actual, "merchant_order_id"),
        );
        compare_field(
            &mut fields,
            "external_key",
            Some(expected.external_key.clone()),
            text(actual, "external_key"),
        );
        compare_field(
            &mut fields,
            "duplicate_state",
            Some(expected.duplicate_state.clone()),
            text(actual, "duplicate_state"),
        );
        if integer(actual, "transaction_group_id") != expected.transaction_group_id {
            fields.push("transaction_group_id".to_owned());
        }
        if fields.is_empty() {
            comparison.matched_rows += 1;
        } else {
            comparison.differing_rows += 1;
            for field in &fields {
                *comparison
                    .field_differences
                    .entry(field.clone())
                    .or_default() += 1;
            }
            if comparison.samples.len() < max_samples {
                comparison.samples.push(DifferenceSample {
                    legacy_row_id: expected.legacy_id,
                    target_row_id: integer(actual, "id"),
                    fields,
                });
            }
        }
    }
    Ok(comparison)
}

async fn target_counts<C>(client: &C) -> Result<BTreeMap<String, u64>, String>
where
    C: GenericClient + Sync,
{
    let queries = [
        (
            "mail_messages",
            "SELECT count(*)::bigint FROM abei_ai.mail_messages WHERE legacy_bill_mail_message_id IS NOT NULL OR legacy_bill_task_id IS NOT NULL",
        ),
        (
            "documents",
            "SELECT count(*)::bigint FROM abei_ai.bill_documents WHERE legacy_bill_task_id IS NOT NULL",
        ),
        (
            "artifacts",
            "SELECT count(*)::bigint FROM abei_ai.bill_artifacts WHERE legacy_bill_artifact_id IS NOT NULL",
        ),
        (
            "rows",
            "SELECT count(*)::bigint FROM abei_ai.bill_rows WHERE legacy_bill_statement_row_id IS NOT NULL",
        ),
        (
            "import_attempts",
            "SELECT count(*)::bigint FROM abei_ai.bill_import_attempts WHERE payload_snapshot->>'legacy_migration' = 'true'",
        ),
        (
            "audit_runs",
            "SELECT count(*)::bigint FROM abei_ai.legacy_bill_migration_runs",
        ),
    ];
    let mut counts = BTreeMap::new();
    for (name, sql) in queries {
        let count: i64 = client.query_one(sql, &[]).await.map_err(display)?.get(0);
        counts.insert(name.to_owned(), count.max(0) as u64);
    }
    Ok(counts)
}

fn indexed(values: &[Value]) -> HashMap<i64, &Value> {
    values
        .iter()
        .filter_map(|value| integer(value, "id").map(|id| (id, value)))
        .collect()
}

fn flow_slug<'a>(task: &'a Value, imports: &'a [Value], artifacts: &'a [Value]) -> Option<&'a str> {
    let profile = text_ref(task, "profile_id").or_else(|| {
        imports
            .iter()
            .find_map(|import| text_ref(import, "profile_id"))
    });
    if matches!(
        profile,
        Some(
            "alipay-statement"
                | "wechat-pay-statement"
                | "cmb-transaction-statement"
                | "cmb-credit-card-daily"
                | "boc-transaction-statement"
        )
    ) {
        return profile;
    }
    match text_ref(task, "source") {
        Some("alipay") => Some("alipay-statement"),
        Some("wechat") | Some("wechat-pay") => Some("wechat-pay-statement"),
        Some("boc") => Some("boc-transaction-statement"),
        Some("cmb") => {
            if artifacts.iter().any(|artifact| {
                text_ref(artifact, "kind") == Some("html")
                    && !artifacts
                        .iter()
                        .any(|candidate| text_ref(candidate, "kind") == Some("zip"))
            }) {
                Some("cmb-credit-card-daily")
            } else {
                Some("cmb-transaction-statement")
            }
        }
        _ => None,
    }
}

fn channel_for_flow(flow: &str) -> &'static str {
    match flow {
        "alipay-statement" => "alipay",
        "wechat-pay-statement" => "wechat",
        "cmb-transaction-statement" | "cmb-credit-card-daily" => "cmb",
        "boc-transaction-statement" => "boc",
        _ => "unknown",
    }
}

fn channel_for_task(task: &Value) -> &'static str {
    match text_ref(task, "source") {
        Some("alipay") => "alipay",
        Some("wechat") | Some("wechat-pay") => "wechat",
        Some("cmb") => "cmb",
        Some("boc") => "boc",
        _ => "unknown",
    }
}

fn import_period(imports: &[Value]) -> (Option<String>, Option<String>) {
    let mut starts = imports
        .iter()
        .filter_map(|row| text(row, "period_start"))
        .collect::<Vec<_>>();
    let mut ends = imports
        .iter()
        .filter_map(|row| text(row, "period_end"))
        .collect::<Vec<_>>();
    starts.sort();
    ends.sort();
    (starts.first().cloned(), ends.last().cloned())
}

fn normalized_type(kind: Option<String>, direction: Option<String>) -> Option<String> {
    match kind.as_deref() {
        Some("withdrawal" | "deposit" | "transfer") => kind,
        _ => match direction.as_deref() {
            Some(value) if is_outflow(value) => Some("withdrawal".to_owned()),
            Some(value) if is_inflow(value) => Some("deposit".to_owned()),
            _ => None,
        },
    }
}

fn signed_amount(amount: Decimal, kind: Option<&str>, direction: Option<&str>) -> Decimal {
    if amount.is_sign_negative() {
        return amount;
    }
    if kind == Some("withdrawal") || direction.is_some_and(is_outflow) {
        -amount.abs()
    } else {
        amount.abs()
    }
}

fn is_outflow(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "支出" | "out" | "outflow" | "debit" | "withdrawal"
    )
}

fn is_inflow(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "收入" | "in" | "inflow" | "credit" | "deposit"
    )
}

fn currency(row: &Value) -> (String, bool) {
    for source in [
        Some(row),
        value(row, "raw_data"),
        value(row, "editable_data"),
        value(row, "metadata"),
    ] {
        let Some(source) = source else { continue };
        for key in ["currency_code", "currency", "币种", "交易币种"] {
            if let Some(value) = text(source, key) {
                let upper = value.trim().to_ascii_uppercase();
                let normalized = match upper.as_str() {
                    "CNY" | "RMB" | "人民币" => "CNY".to_owned(),
                    "USD" | "美元" => "USD".to_owned(),
                    "HKD" | "港币" => "HKD".to_owned(),
                    "EUR" | "欧元" => "EUR".to_owned(),
                    other
                        if other.len() == 3
                            && other
                                .chars()
                                .all(|character| character.is_ascii_alphabetic()) =>
                    {
                        other.to_owned()
                    }
                    _ => continue,
                };
                return (normalized, false);
            }
        }
    }
    ("CNY".to_owned(), true)
}

fn mime_type(kind: &str, filename: &str) -> &'static str {
    let extension = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match (kind, extension.as_str()) {
        ("eml", _) => "message/rfc822",
        (_, "html" | "htm") => "text/html",
        (_, "txt") => "text/plain",
        (_, "csv") => "text/csv",
        (_, "pdf") => "application/pdf",
        (_, "zip") => "application/zip",
        (_, "xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        _ => "application/octet-stream",
    }
}

fn generation_stage(kind: &str) -> &'static str {
    match kind {
        "eml" | "raw" | "html" | "text" => "received",
        "download" | "remote" => "downloaded",
        "zip" | "pdf" | "csv" | "xlsx" => "extracted",
        _ => "derived",
    }
}

fn issue(code: &str, message: &str) -> Value {
    json!({ "severity": "warning", "code": code, "message": message })
}

fn finding(
    code: &str,
    entity: &str,
    legacy_id: Option<i64>,
    message: impl Into<String>,
) -> Finding {
    Finding {
        code: code.to_owned(),
        entity: entity.to_owned(),
        legacy_id,
        message: message.into(),
    }
}

fn compare_field(
    fields: &mut Vec<String>,
    name: &str,
    expected: Option<String>,
    actual: Option<String>,
) {
    if normalized_text(expected) != normalized_text(actual) {
        fields.push(name.to_owned());
    }
}

fn compare_decimal_field(
    fields: &mut Vec<String>,
    name: &str,
    expected: Option<String>,
    actual: Option<String>,
) {
    let expected = expected.as_deref().and_then(decimal);
    let actual = actual.as_deref().and_then(decimal);
    if expected != actual {
        fields.push(name.to_owned());
    }
}

fn compare_tags(
    fields: &mut Vec<String>,
    expected: Option<&Vec<String>>,
    actual: Option<&Vec<String>>,
) {
    let mut expected = expected.cloned().unwrap_or_default();
    let mut actual = actual.cloned().unwrap_or_default();
    expected.sort();
    actual.sort();
    if expected != actual {
        fields.push("tags".to_owned());
    }
}

fn normalized_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn normalize_hash(value: Option<&str>) -> Option<String> {
    let raw = value?.trim();
    let value = raw.strip_prefix("sha256:").unwrap_or(raw);
    if value.len() == 64 && value.chars().all(|character| character.is_ascii_hexdigit()) {
        Some(value.to_ascii_lowercase())
    } else {
        None
    }
}

fn tags(value: Option<&Value>) -> Option<Vec<String>> {
    let value = value?;
    let tags = match value {
        Value::Array(values) => values.iter().filter_map(json_text).collect::<Vec<_>>(),
        Value::String(text) => serde_json::from_str::<Vec<String>>(text).unwrap_or_else(|_| {
            text.split(',')
                .map(str::trim)
                .filter(|tag| !tag.is_empty())
                .map(str::to_owned)
                .collect()
        }),
        _ => Vec::new(),
    };
    if tags.is_empty() { None } else { Some(tags) }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(json_text)
}

fn text_ref<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn first_text(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| text(value, key).filter(|value| value != "0"))
}

fn json_text(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_owned())
        }
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn integer(value: &Value, key: &str) -> Option<i64> {
    let value = value.get(key)?;
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}

fn boolean(value: &Value, key: &str) -> Option<bool> {
    let value = value.get(key)?;
    value.as_bool().or_else(|| match value.as_str()? {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    })
}

fn value<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.get(key).filter(|value| !value.is_null())
}

fn decimal(value: &str) -> Option<Decimal> {
    Decimal::from_str(value.trim()).ok()
}

fn normalized_decimal(value: Decimal) -> String {
    value.normalize().to_string()
}

fn date_prefix(value: &str) -> Option<String> {
    let candidate = value.trim().get(..10)?;
    let bytes = candidate.as_bytes();
    (bytes.len() == 10 && bytes[4] == b'-' && bytes[7] == b'-').then(|| candidate.to_owned())
}

fn set_count(counts: &mut BTreeMap<String, u64>, name: &str, count: usize) {
    counts.insert(name.to_owned(), count as u64);
}

fn increment(counts: &mut BTreeMap<String, u64>, name: &str) {
    *counts.entry(name.to_owned()).or_default() += 1;
}

fn sha256(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn display(error: impl std::fmt::Debug) -> String {
    format!("{error:?}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_withdrawal_to_negative_signed_amount() {
        let row = json!({
            "id": 7,
            "user_id": 1,
            "bill_task_id": 3,
            "bill_statement_import_id": 4,
            "row_number": 1,
            "__firefly_amount_text": "12.340000000000000000",
            "firefly_type": "withdrawal",
            "occurred_at": "2026-08-10 12:30:00",
            "firefly_date": "2026-08-10 12:30:00",
            "firefly_description": "午餐",
            "source_name": "招商银行",
            "destination_name": "商户",
            "status": "pending",
            "raw_data": {"币种": "人民币"}
        });
        let task = json!({"id": 3, "user_id": 1, "source": "cmb"});
        let mut report = Report::default();
        let mapped = map_row(&row, &task, 1, &mut report).unwrap();
        assert_eq!(mapped.signed_amount, "-12.34");
        assert_eq!(mapped.currency_code, "CNY");
        assert_eq!(mapped.status, "pending");
        assert!(
            mapped
                .issues
                .as_array()
                .unwrap()
                .iter()
                .any(|issue| issue["code"] == "account_mapping_required")
        );
    }

    #[test]
    fn imported_without_group_is_not_treated_as_success() {
        let row = json!({
            "id": 8,
            "user_id": 1,
            "bill_task_id": 3,
            "row_number": 2,
            "__amount_text": "20",
            "direction": "收入",
            "occurred_at": "2026-08-10",
            "description": "退款",
            "status": "imported",
            "review_state": "booked"
        });
        let task = json!({"id": 3, "user_id": 1, "source": "alipay"});
        let mut report = Report::default();
        let mapped = map_row(&row, &task, 2, &mut report).unwrap();
        assert_eq!(mapped.status, "pending");
        assert!(
            mapped
                .issues
                .as_array()
                .unwrap()
                .iter()
                .any(|issue| issue["code"] == "legacy_import_result_missing")
        );
    }

    #[test]
    fn zero_amount_is_preserved_instead_of_marked_missing() {
        let row = json!({
            "id": 9,
            "user_id": 1,
            "bill_task_id": 3,
            "row_number": 3,
            "__amount_text": "0.000000000000000000",
            "direction": "支出",
            "occurred_at": "2026-08-10",
            "description": "零元验证",
            "status": "dismissed",
            "dismissed_reason": "zero_amount"
        });
        let task = json!({"id": 3, "user_id": 1, "source": "alipay"});
        let mut report = Report::default();
        let mapped = map_row(&row, &task, 3, &mut report).unwrap();
        assert_eq!(mapped.signed_amount, "0");
        assert_eq!(mapped.firefly_amount.as_deref(), Some("0"));
        assert!(
            !mapped
                .issues
                .as_array()
                .unwrap()
                .iter()
                .any(|issue| issue["code"] == "legacy_amount_missing")
        );
    }

    #[test]
    fn strips_legacy_sha256_prefix() {
        let hash = "a".repeat(64);
        assert_eq!(normalize_hash(Some(&format!("sha256:{hash}"))), Some(hash));
        assert_eq!(normalize_hash(Some("not-a-hash")), None);
    }

    #[test]
    fn infers_cmb_daily_flow_from_html_only_artifact() {
        let task = json!({"source": "cmb"});
        let artifacts = vec![json!({"kind": "html"})];
        assert_eq!(
            flow_slug(&task, &[], &artifacts),
            Some("cmb-credit-card-daily")
        );
    }
}
