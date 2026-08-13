//! 把响应摊平成「行」。
//!
//! 行的字段名就是 `--json` 的契约：人话表格的列、`--json 字段` 的可选项、
//! `--json`（不带值）列出来的清单，三者同一份，改名字算破坏性变更。
//!
//! 全量原始响应没有丢——`--jq` 直接作用在原始响应体上。

use serde_json::{Map, Value};

use crate::query::Candidate;

/// 摊平后的结果。`fields` 是声明顺序，决定列序与 `--json` 的可选字段。
#[derive(Debug, Clone)]
pub struct Rows {
    pub fields: Vec<String>,
    pub rows: Vec<Map<String, Value>>,
}

impl Rows {
    fn new(fields: &[&str], rows: Vec<Map<String, Value>>) -> Self {
        Self {
            fields: fields.iter().map(|f| (*f).to_owned()).collect(),
            rows,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// 按查询条件在客户端过滤。API 还没有对应参数的条件在这里生效。
    pub fn retain(&mut self, query: &crate::query::Query) {
        if query.filters.is_empty() {
            return;
        }
        self.rows.retain(|row| {
            let amount = text(row, "amount").and_then(|v| v.parse::<f64>().ok());
            let candidate = Candidate {
                description: text(row, "description"),
                account: text(row, "source").or_else(|| text(row, "name")),
                category: text(row, "category"),
                currency: text(row, "currency"),
                amount,
            };
            query.accepts(&candidate)
        });
    }

    /// 只保留指定字段，顺序按用户写的来。
    pub fn project(&self, fields: &[String]) -> Vec<Map<String, Value>> {
        self.rows
            .iter()
            .map(|row| {
                let mut out = Map::new();
                for field in fields {
                    out.insert(
                        field.clone(),
                        row.get(field).cloned().unwrap_or(Value::Null),
                    );
                }
                out
            })
            .collect()
    }

    /// 用户写的字段名是否都认得；不认得的返回出来好报错。
    pub fn unknown<'a>(&self, fields: &'a [String]) -> Vec<&'a String> {
        fields
            .iter()
            .filter(|field| !self.fields.contains(field))
            .collect()
    }
}

fn text<'a>(row: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    row.get(key).and_then(Value::as_str)
}

/// 按能力挑摊平方式。认不出来的走通用规则，将来新增能力不必改这里也能出表。
pub fn rows_for(capability_id: &str, body: &Value) -> Rows {
    match capability_id {
        "transactions.list" | "transactions.show" | "transactions.search" => transactions(body),
        "accounts.list" => accounts(body),
        "transactions.summary" => summary(body),
        "bills.list" => bills_list(body),
        "bills.show" => bills_show(body),
        "bills.unlock" => bills_show(body),
        "bills.review" => review(body),
        "bills.import" => bill_import(body),
        "feedback.create" | "feedback.confirm" => feedback_submission_result(body),
        "feedback.reply" => feedback_reply(body),
        "feedback.list" => feedback_list(body),
        "feedback.get" => feedback_detail(body),
        "profile-doc.list" | "profile-doc.get" | "profile-doc.create" | "profile-doc.update" => {
            profile_docs(body)
        }
        _ => generic(body),
    }
}

/// 解锁默认只保留能判断结果的几列；`--json`/`--jq` 仍分别使用规范化字段或原始响应。
pub fn unlock_summary_rows(body: &Value) -> Rows {
    const FIELDS: &[&str] = &["id", "source", "status", "pending", "imported", "message"];
    let full = bills_show(body);
    let rows = full
        .rows
        .into_iter()
        .map(|mut row| {
            let message = row
                .get("error_message")
                .filter(|value| !value.is_null())
                .cloned()
                .or_else(|| row.get("summary").cloned())
                .unwrap_or(Value::Null);
            row.insert("message".to_owned(), message);
            FIELDS
                .iter()
                .map(|field| {
                    (
                        (*field).to_owned(),
                        row.get(*field).cloned().unwrap_or(Value::Null),
                    )
                })
                .collect()
        })
        .collect();
    Rows::new(FIELDS, rows)
}

const BILL_IMPORT_FIELDS: &[&str] = &[
    "row_id",
    "status",
    "action",
    "amount",
    "description",
    "attempt_id",
    "transaction_group_id",
    "error",
];

fn bill_import(body: &Value) -> Rows {
    let rows = body["rows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|item| {
            BILL_IMPORT_FIELDS
                .iter()
                .map(|field| {
                    (
                        (*field).to_owned(),
                        item.get(*field).cloned().unwrap_or(Value::Null),
                    )
                })
                .collect()
        })
        .collect();
    Rows::new(BILL_IMPORT_FIELDS, rows)
}

const PROFILE_DOC_FIELDS: &[&str] = &[
    "slug",
    "title",
    "version",
    "updated_by",
    "updated_source",
    "updated_at",
];

fn profile_docs(body: &Value) -> Rows {
    let rows = array(body, "data")
        .into_iter()
        .filter_map(|item| item.as_object().cloned())
        .map(|item| {
            PROFILE_DOC_FIELDS
                .iter()
                .map(|field| {
                    (
                        (*field).to_owned(),
                        item.get(*field).cloned().unwrap_or(Value::Null),
                    )
                })
                .collect()
        })
        .collect();
    Rows::new(PROFILE_DOC_FIELDS, rows)
}

const FEEDBACK_SUBMISSION_FIELDS: &[&str] = &[
    "submission_id",
    "state",
    "feedback_id",
    "status",
    "affected_users",
    "occurrences",
    "candidates",
    "next_actions",
];

fn feedback_submission_result(body: &Value) -> Rows {
    if body.get("dry_run").and_then(Value::as_bool) == Some(true) {
        let mut row = body
            .get("data")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        row.insert("state".to_owned(), Value::String("dry_run".to_owned()));
        return Rows::new(
            &["state", "kind", "target", "message", "submitted_via"],
            vec![row],
        );
    }

    let Some(source) = body.as_object() else {
        return Rows::new(FEEDBACK_SUBMISSION_FIELDS, Vec::new());
    };
    let mut row = pick(source, FEEDBACK_SUBMISSION_FIELDS);
    row.insert(
        "candidates".to_owned(),
        Value::String(candidate_summary(source.get("candidates"))),
    );
    row.insert(
        "next_actions".to_owned(),
        Value::String(confirmation_commands(source)),
    );
    Rows::new(FEEDBACK_SUBMISSION_FIELDS, vec![row])
}

const FEEDBACK_LIST_FIELDS: &[&str] = &[
    "record",
    "feedback_id",
    "submission_id",
    "title",
    "message",
    "request",
    "kind",
    "target",
    "state",
    "status",
    "severity",
    "affected_users",
    "occurrences",
    "candidates",
    "next_actions",
    "my_submission_ids",
    "updated_at",
];

fn feedback_list(body: &Value) -> Rows {
    let mut rows = Vec::new();
    if let Some(pending) = body.get("pending").and_then(Value::as_array) {
        for item in pending.iter().filter_map(Value::as_object) {
            let mut row = pick(item, FEEDBACK_LIST_FIELDS);
            row.insert("record".to_owned(), Value::String("pending".to_owned()));
            row.insert(
                "candidates".to_owned(),
                Value::String(candidate_summary(item.get("candidates"))),
            );
            let request = latest_admin_message(item.get("messages"));
            row.insert("request".to_owned(), Value::String(request));
            let next_actions =
                if item.get("state").and_then(Value::as_str) == Some("needs_information") {
                    item.get("submission_id")
                        .and_then(Value::as_i64)
                        .map(|id| format!("abei feedback reply {id} --message '<补充信息>'"))
                        .unwrap_or_default()
                } else {
                    confirmation_commands(item)
                };
            row.insert("next_actions".to_owned(), Value::String(next_actions));
            rows.push(row);
        }
    }
    if let Some(items) = body.get("data").and_then(Value::as_array) {
        for item in items.iter().filter_map(Value::as_object) {
            let mut row = pick(item, FEEDBACK_LIST_FIELDS);
            row.insert("record".to_owned(), Value::String("feedback".to_owned()));
            row.insert(
                "my_submission_ids".to_owned(),
                Value::String(number_list(item.get("my_submission_ids"))),
            );
            rows.push(row);
        }
    }
    Rows::new(FEEDBACK_LIST_FIELDS, rows)
}

const FEEDBACK_DETAIL_FIELDS: &[&str] = &[
    "record",
    "id",
    "feedback_id",
    "submission_id",
    "title",
    "kind",
    "target",
    "state",
    "status",
    "severity",
    "content",
    "author",
    "affected_users",
    "occurrences",
    "created_at",
    "updated_at",
];

fn feedback_detail(body: &Value) -> Rows {
    let mut rows = Vec::new();
    if let Some(item) = body.get("data").and_then(Value::as_object) {
        let mut row = pick(item, FEEDBACK_DETAIL_FIELDS);
        row.insert("record".to_owned(), Value::String("feedback".to_owned()));
        row.insert(
            "content".to_owned(),
            item.get("public_summary").cloned().unwrap_or(Value::Null),
        );
        rows.push(row);
    }
    append_timeline_rows(&mut rows, body, "updates", "update", Some("body"), None);
    append_timeline_rows(
        &mut rows,
        body,
        "submissions",
        "submission",
        Some("message"),
        None,
    );
    append_timeline_rows(
        &mut rows,
        body,
        "messages",
        "message",
        Some("body"),
        Some("author_kind"),
    );
    Rows::new(FEEDBACK_DETAIL_FIELDS, rows)
}

fn append_timeline_rows(
    rows: &mut Vec<Map<String, Value>>,
    body: &Value,
    key: &str,
    record: &str,
    content_field: Option<&str>,
    author_field: Option<&str>,
) {
    let Some(items) = body.get(key).and_then(Value::as_array) else {
        return;
    };
    for item in items.iter().filter_map(Value::as_object) {
        let mut row = pick(item, FEEDBACK_DETAIL_FIELDS);
        row.insert("record".to_owned(), Value::String(record.to_owned()));
        if let Some(field) = content_field {
            row.insert(
                "content".to_owned(),
                item.get(field).cloned().unwrap_or(Value::Null),
            );
        }
        if let Some(field) = author_field {
            row.insert(
                "author".to_owned(),
                item.get(field).cloned().unwrap_or(Value::Null),
            );
        }
        rows.push(row);
    }
}

const FEEDBACK_REPLY_FIELDS: &[&str] = &[
    "submission_id",
    "message_id",
    "author",
    "message",
    "created_at",
];

fn feedback_reply(body: &Value) -> Rows {
    let Some(item) = body.get("data").and_then(Value::as_object) else {
        return Rows::new(FEEDBACK_REPLY_FIELDS, Vec::new());
    };
    let mut row = pick(item, FEEDBACK_REPLY_FIELDS);
    row.insert(
        "message_id".to_owned(),
        item.get("id").cloned().unwrap_or(Value::Null),
    );
    row.insert(
        "author".to_owned(),
        item.get("author_kind").cloned().unwrap_or(Value::Null),
    );
    row.insert(
        "message".to_owned(),
        item.get("body").cloned().unwrap_or(Value::Null),
    );
    Rows::new(FEEDBACK_REPLY_FIELDS, vec![row])
}

fn pick(source: &Map<String, Value>, fields: &[&str]) -> Map<String, Value> {
    fields
        .iter()
        .map(|field| {
            (
                (*field).to_owned(),
                source.get(*field).cloned().unwrap_or(Value::Null),
            )
        })
        .collect()
}

fn candidate_summary(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .map(|candidate| {
            let id = candidate
                .get("feedback_id")
                .and_then(Value::as_i64)
                .map(|id| format!("#{id}"))
                .unwrap_or_else(|| "#?".to_owned());
            let title = candidate
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("未命名反馈");
            let status = candidate
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("{id} {title} [{status}]")
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

fn latest_admin_message(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .rev()
        .filter_map(Value::as_object)
        .find(|message| message.get("author_kind").and_then(Value::as_str) == Some("admin"))
        .and_then(|message| message.get("body"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn confirmation_commands(source: &Map<String, Value>) -> String {
    if source.get("state").and_then(Value::as_str) != Some("needs_confirmation") {
        return String::new();
    }
    let Some(submission_id) = source.get("submission_id").and_then(Value::as_i64) else {
        return String::new();
    };
    let mut commands = source
        .get("candidates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|candidate| candidate.get("feedback_id").and_then(Value::as_i64))
        .map(|feedback_id| format!("abei feedback confirm {submission_id} --same-as {feedback_id}"))
        .collect::<Vec<_>>();
    commands.push(format!("abei feedback confirm {submission_id} --new"));
    commands.join(" | ")
}

fn number_list(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_i64)
        .map(|number| number.to_string())
        .collect::<Vec<_>>()
        .join(",")
}

const TRANSACTION_FIELDS: &[&str] = &[
    "id",
    "date",
    "type",
    "amount",
    "currency",
    "description",
    "category",
    "source",
    "destination",
];

/// Firefly 的交易是「组 + 拆分行」两层，摊成一行一笔。
fn transactions(body: &Value) -> Rows {
    let mut rows = Vec::new();
    for group in array(body, "data") {
        let group_id = group.get("id").and_then(Value::as_str).unwrap_or_default();
        let splits = group
            .get("attributes")
            .and_then(|a| a.get("transactions"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        for split in splits {
            let mut row = Map::new();
            row.insert("id".into(), Value::String(group_id.to_owned()));
            row.insert("date".into(), Value::String(day(str_of(&split, "date"))));
            row.insert("type".into(), string(str_of(&split, "type")));
            row.insert("amount".into(), string(str_of(&split, "amount")));
            row.insert("currency".into(), string(str_of(&split, "currency_code")));
            row.insert("description".into(), string(str_of(&split, "description")));
            row.insert("category".into(), string(str_of(&split, "category_name")));
            row.insert("source".into(), string(str_of(&split, "source_name")));
            row.insert(
                "destination".into(),
                string(str_of(&split, "destination_name")),
            );
            rows.push(row);
        }
    }
    Rows::new(TRANSACTION_FIELDS, rows)
}

const ACCOUNT_FIELDS: &[&str] = &["id", "name", "type", "currency", "balance", "active"];

fn accounts(body: &Value) -> Rows {
    let mut rows = Vec::new();
    for item in array(body, "data") {
        let attributes = item.get("attributes").cloned().unwrap_or(Value::Null);
        let mut row = Map::new();
        row.insert("id".into(), string(item.get("id").and_then(Value::as_str)));
        row.insert("name".into(), string(str_of(&attributes, "name")));
        row.insert("type".into(), string(str_of(&attributes, "type")));
        row.insert(
            "currency".into(),
            string(str_of(&attributes, "currency_code")),
        );
        row.insert(
            "balance".into(),
            string(str_of(&attributes, "current_balance")),
        );
        row.insert(
            "active".into(),
            attributes
                .get("active")
                .cloned()
                .unwrap_or(Value::Bool(true)),
        );
        rows.push(row);
    }
    Rows::new(ACCOUNT_FIELDS, rows)
}

const BILL_LIST_FIELDS: &[&str] = &[
    "id",
    "source",
    "status",
    "subject",
    "received_at",
    "pending",
    "imported",
];

/// 账单任务。`pending` / `imported` 从嵌套的 row_counts 里提上来——
/// 「这份还剩几行要处理」是看收件箱时最先要问的，不该埋在 --jq 里。
fn bills_list(body: &Value) -> Rows {
    bills_with_fields(body, BILL_LIST_FIELDS)
}

const BILL_SHOW_FIELDS: &[&str] = &[
    "id",
    "source",
    "status",
    "subject",
    "parse_stage",
    "waiting_reason",
    "current_secret_challenge_id",
    "error_code",
    "error_message",
    "summary",
    "period_start",
    "period_end",
    "received_at",
    "pending",
    "imported",
];

fn bills_show(body: &Value) -> Rows {
    bills_with_fields(body, BILL_SHOW_FIELDS)
}

fn bills_with_fields(body: &Value, fields: &[&str]) -> Rows {
    let mut rows = Vec::new();
    for item in array(body, "data") {
        let attributes = item.get("attributes").cloned().unwrap_or(Value::Null);
        let count = |key: &str| {
            attributes
                .pointer(&format!("/row_counts/{key}"))
                .cloned()
                .unwrap_or(Value::from(0))
        };

        let mut row = Map::new();
        row.insert("id".into(), string(item.get("id").and_then(Value::as_str)));
        row.insert("source".into(), string(str_of(&attributes, "source")));
        row.insert("status".into(), string(str_of(&attributes, "status")));
        row.insert("subject".into(), string(str_of(&attributes, "subject")));
        row.insert(
            "received_at".into(),
            Value::String(day(str_of(&attributes, "received_at"))),
        );
        row.insert("pending".into(), count("pending"));
        row.insert("imported".into(), count("imported"));
        row.insert("summary".into(), string(str_of(&attributes, "summary")));
        row.insert(
            "period_start".into(),
            string(str_of(&attributes, "period_start")),
        );
        row.insert(
            "period_end".into(),
            string(str_of(&attributes, "period_end")),
        );
        row.insert(
            "current_secret_challenge_id".into(),
            string(str_of(&attributes, "current_secret_challenge_id")),
        );
        row.insert(
            "error_code".into(),
            string(str_of(&attributes, "error_code")),
        );
        row.insert(
            "error_message".into(),
            string(str_of(&attributes, "error_message")),
        );
        row.insert(
            "parse_stage".into(),
            string(
                attributes
                    .pointer("/metadata/parse_stage")
                    .and_then(Value::as_str),
            ),
        );
        row.insert(
            "waiting_reason".into(),
            string(
                attributes
                    .pointer("/metadata/waiting_reason")
                    .and_then(Value::as_str),
            ),
        );
        rows.push(row);
    }
    Rows::new(fields, rows)
}

const REVIEW_FIELDS: &[&str] = &[
    "bucket",
    "id",
    "date",
    "amount",
    "counterparty",
    "description",
    "type",
    "category",
    "duplicate",
    "suggested_by",
];

/// 审阅视图是三个桶，摊平时把桶名留成第一列：一眼看出哪几行卡着。
/// 桶的顺序是固定的（要处理的排在前面），不跟着 JSON 的键序走。
fn review(body: &Value) -> Rows {
    let groups = body.pointer("/data/groups").cloned().unwrap_or(Value::Null);

    let mut rows = Vec::new();
    for bucket in ["attention", "importable", "dismissed", "imported"] {
        let items = groups
            .get(bucket)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        for item in items {
            let mut row = Map::new();
            row.insert("bucket".into(), Value::String(bucket.to_owned()));
            row.insert(
                "id".into(),
                match item.get("id") {
                    Some(Value::Number(number)) => Value::String(number.to_string()),
                    other => string(other.and_then(Value::as_str)),
                },
            );
            let attributes = item
                .get("attributes")
                .filter(|value| value.is_object())
                .unwrap_or(&item);
            row.insert(
                "date".into(),
                Value::String(day(str_of(attributes, "firefly_date")
                    .or_else(|| str_of(attributes, "occurred_at")))),
            );
            row.insert("amount".into(), string(str_of(attributes, "amount")));
            row.insert(
                "counterparty".into(),
                string(str_of(attributes, "counterparty")),
            );
            row.insert(
                "description".into(),
                string(str_of(attributes, "description")),
            );
            row.insert("type".into(), string(str_of(attributes, "firefly_type")));
            row.insert(
                "category".into(),
                string(str_of(attributes, "category_name")),
            );
            row.insert(
                "duplicate".into(),
                string(str_of(attributes, "duplicate_state")),
            );
            row.insert(
                "suggested_by".into(),
                string(str_of(attributes, "suggested_by")),
            );
            rows.push(row);
        }
    }
    Rows::new(REVIEW_FIELDS, rows)
}

const SUMMARY_FIELDS: &[&str] = &[
    "range_start",
    "range_end",
    "count",
    "withdrawal_total",
    "deposit_total",
    "transfer_total",
    "daily_consumption_total",
    "daily_consumption_count",
];

/// 汇总是一份报表不是列表，摊成一行标量：`--json` 拿它做脚本判断，
/// 人话渲染另走多段表格。
fn summary(body: &Value) -> Rows {
    let by_type = |kind: &str| {
        body.get("totals")
            .and_then(|t| t.get("by_type"))
            .and_then(|t| t.get(kind))
            .and_then(|bucket| bucket.get("total"))
            .cloned()
            .unwrap_or(Value::String("0".into()))
    };

    let mut row = Map::new();
    row.insert(
        "range_start".into(),
        body.pointer("/range/start").cloned().unwrap_or(Value::Null),
    );
    row.insert(
        "range_end".into(),
        body.pointer("/range/end").cloned().unwrap_or(Value::Null),
    );
    row.insert(
        "count".into(),
        body.pointer("/totals/count")
            .cloned()
            .unwrap_or(Value::from(0)),
    );
    row.insert("withdrawal_total".into(), by_type("withdrawal"));
    row.insert("deposit_total".into(), by_type("deposit"));
    row.insert("transfer_total".into(), by_type("transfer"));
    row.insert(
        "daily_consumption_total".into(),
        body.pointer("/daily_consumption/total")
            .cloned()
            .unwrap_or(Value::String("0".into())),
    );
    row.insert(
        "daily_consumption_count".into(),
        body.pointer("/daily_consumption/count")
            .cloned()
            .unwrap_or(Value::from(0)),
    );

    Rows::new(SUMMARY_FIELDS, vec![row])
}

/// 通用规则：`{data:[{id, attributes:{...}}]}` 摊成 id + 各标量属性。
/// 将来新增的 Firefly 系资源不写专门的摊平也能出表。
fn generic(body: &Value) -> Rows {
    let items = array(body, "data");
    let mut fields: Vec<String> = Vec::new();
    let mut rows = Vec::new();

    for item in &items {
        let mut row = Map::new();
        if let Some(id) = item.get("id").and_then(Value::as_str) {
            row.insert("id".into(), Value::String(id.to_owned()));
        }
        let attributes = match item.get("attributes") {
            Some(Value::Object(map)) => map.clone(),
            _ => match item {
                Value::Object(map) => map.clone(),
                _ => Map::new(),
            },
        };
        for (key, value) in attributes {
            // 嵌套结构不进表格，留给 --jq。
            if value.is_object() || value.is_array() {
                continue;
            }
            row.insert(key, value);
        }
        for key in row.keys() {
            if !fields.contains(key) {
                fields.push(key.clone());
            }
        }
        rows.push(row);
    }

    Rows { fields, rows }
}

fn array(body: &Value, key: &str) -> Vec<Value> {
    match body.get(key) {
        Some(Value::Array(items)) => items.clone(),
        // show 类接口返回单个对象。
        Some(Value::Object(map)) => vec![Value::Object(map.clone())],
        _ => Vec::new(),
    }
}

fn str_of<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn string(value: Option<&str>) -> Value {
    match value {
        Some(text) => Value::String(text.to_owned()),
        None => Value::Null,
    }
}

/// `2026-08-01T12:00:00+08:00` -> `2026-08-01`
fn day(value: Option<&str>) -> String {
    value
        .map(|text| text.split('T').next().unwrap_or(text).to_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn firefly_transactions() -> Value {
        json!({
            "data": [{
                "id": "42",
                "attributes": { "transactions": [
                    { "type": "withdrawal", "date": "2026-08-01T12:00:00+08:00", "amount": "45.00",
                      "currency_code": "CNY", "description": "午饭", "category_name": "餐饮",
                      "source_name": "招行卡", "destination_name": "面馆" }
                ]}
            }]
        })
    }

    #[test]
    fn transaction_splits_become_one_row_each() {
        let rows = rows_for("transactions.list", &firefly_transactions());
        assert_eq!(rows.rows.len(), 1);
        let row = &rows.rows[0];
        assert_eq!(row["id"], "42");
        assert_eq!(row["amount"], "45.00");
        assert_eq!(row["category"], "餐饮");
        assert_eq!(rows.fields, TRANSACTION_FIELDS);
    }

    /// 日期只留天，时区尾巴不进表也不进 --json。
    #[test]
    fn dates_are_trimmed_to_the_day() {
        let rows = rows_for("transactions.list", &firefly_transactions());
        assert_eq!(rows.rows[0]["date"], "2026-08-01");
    }

    /// 一组多笔拆分要摊成多行，共用组 id。
    #[test]
    fn split_groups_expand_to_multiple_rows() {
        let body = json!({ "data": [{ "id": "7", "attributes": { "transactions": [
            { "amount": "10.00", "description": "a" },
            { "amount": "20.00", "description": "b" }
        ]}}]});
        let rows = rows_for("transactions.list", &body);
        assert_eq!(rows.rows.len(), 2);
        assert_eq!(rows.rows[0]["id"], "7");
        assert_eq!(rows.rows[1]["id"], "7");
        assert_eq!(rows.rows[1]["description"], "b");
    }

    #[test]
    fn accounts_flatten_attributes() {
        let body = json!({ "data": [{ "id": "1", "attributes": {
            "name": "招行卡", "type": "asset", "currency_code": "CNY",
            "current_balance": "1234.56", "active": true } }]});
        let rows = rows_for("accounts.list", &body);
        assert_eq!(rows.rows[0]["name"], "招行卡");
        assert_eq!(rows.rows[0]["balance"], "1234.56");
        assert_eq!(rows.rows[0]["active"], true);
    }

    #[test]
    fn summary_becomes_one_scalar_row() {
        let body = json!({
            "range": { "start": "2026-08-01", "end": "2026-08-31" },
            "totals": { "count": 12, "by_type": {
                "withdrawal": { "count": 10, "total": "900.00" },
                "deposit": { "count": 2, "total": "100.00" } } },
            "daily_consumption": { "count": 8, "total": "700.00" }
        });
        let rows = rows_for("transactions.summary", &body);
        assert_eq!(rows.rows.len(), 1);
        assert_eq!(rows.rows[0]["withdrawal_total"], "900.00");
        assert_eq!(rows.rows[0]["daily_consumption_total"], "700.00");
        // 没出现的类型补零，脚本不用做存在性判断。
        assert_eq!(rows.rows[0]["transfer_total"], "0");
    }

    /// 没写专门摊平的能力也要能出表。
    #[test]
    fn unknown_capabilities_fall_back_to_the_generic_rule() {
        let body = json!({ "data": [{ "id": "9", "attributes": {
            "name": "水电", "nested": { "x": 1 } } }]});
        let rows = rows_for("budgets.list", &body);
        assert_eq!(rows.rows[0]["name"], "水电");
        // 嵌套字段不进表格。
        assert!(!rows.fields.contains(&"nested".to_owned()));
    }

    /// 「还剩几行要处理」得在表里，不能只埋在 row_counts 里。
    #[test]
    fn bill_rows_lift_the_pending_count_out_of_row_counts() {
        let body = json!({ "data": [{ "id": "42", "attributes": {
            "source": "alipay", "status": "pending", "subject": "支付宝对账单",
            "received_at": "2026-08-01T09:00:00+08:00",
            "row_counts": { "pending": 3, "imported": 0 } } }]});
        let rows = rows_for("bills.list", &body);
        assert_eq!(rows.rows[0]["pending"], 3);
        assert_eq!(rows.rows[0]["imported"], 0);
        assert_eq!(rows.rows[0]["received_at"], "2026-08-01");
    }

    /// 没有 row_counts 的响应补零，脚本不用做存在性判断。
    #[test]
    fn bills_without_counts_show_zero() {
        let body = json!({ "data": { "id": "43", "attributes": { "status": "needs_secret" } } });
        let rows = rows_for("bills.show", &body);
        assert_eq!(rows.rows.len(), 1);
        assert_eq!(rows.rows[0]["pending"], 0);
        assert_eq!(rows.rows[0]["subject"], Value::Null);
    }

    #[test]
    fn bills_show_surfaces_subject_stage_errors_and_unlock_state() {
        let body = json!({ "data": { "id": "43", "attributes": {
            "source": "cmb", "status": "needs_secret", "subject": "招商银行交易流水",
            "summary": "2026 年 7 月流水", "period_start": "2026-07-01",
            "period_end": "2026-07-31", "received_at": "2026-08-01T09:00:00+08:00",
            "current_secret_challenge_id": "91", "error_code": "bad_password",
            "error_message": "密码不正确", "metadata": {
                "parse_stage": "unlock", "waiting_reason": "secret_rejected"
            }, "row_counts": { "pending": 12, "imported": 3 }
        } } });
        let rows = rows_for("bills.show", &body);
        assert_eq!(rows.fields, BILL_SHOW_FIELDS);
        let row = &rows.rows[0];
        assert_eq!(row["subject"], "招商银行交易流水");
        assert_eq!(row["parse_stage"], "unlock");
        assert_eq!(row["waiting_reason"], "secret_rejected");
        assert_eq!(row["current_secret_challenge_id"], "91");
        assert_eq!(row["error_code"], "bad_password");
        assert_eq!(row["error_message"], "密码不正确");
        assert_eq!(row["period_start"], "2026-07-01");
        assert_eq!(row["pending"], 12);
    }

    #[test]
    fn bill_import_exposes_each_rows_result() {
        let body = json!({
            "summary": { "total": 2, "would_import": 1, "failed": 1 },
            "rows": [
                {
                    "row_id": "7", "status": "pending", "action": "would_import",
                    "amount": "45.00", "description": "面馆"
                },
                {
                    "row_id": "8", "status": "failed", "action": "failed",
                    "error": "缺少账户映射"
                }
            ]
        });
        let rows = rows_for("bills.import", &body);
        assert_eq!(rows.rows.len(), 2);
        assert_eq!(rows.rows[0]["action"], "would_import");
        assert_eq!(rows.rows[1]["error"], "缺少账户映射");
    }

    /// 三个桶摊成一张表，要处理的排在最前面。
    #[test]
    fn review_buckets_flatten_with_attention_first() {
        let body = json!({ "data": { "groups": {
            "importable": [{ "id": "7", "attributes": { "occurred_at": "2026-07-15", "amount": "45.00",
                        "counterparty": "面馆", "firefly_type": "withdrawal",
                        "category_name": "餐饮", "duplicate_state": "unique" } }],
            "attention": [{ "id": "8", "attributes": { "occurred_at": "2026-07-16", "amount": "128.50",
                                  "counterparty": "山姆", "duplicate_state": "unique" } }],
            "dismissed": [], "imported": []
        }}});
        let rows = rows_for("bills.review", &body);
        assert_eq!(rows.rows.len(), 2);
        assert_eq!(rows.rows[0]["bucket"], "attention");
        // id 是数字也要能当字符串用（后面要拼进 abei rows update <id>）。
        assert_eq!(rows.rows[0]["id"], "8");
        assert_eq!(rows.rows[0]["type"], Value::Null);
        assert_eq!(rows.rows[1]["bucket"], "importable");
        assert_eq!(rows.rows[1]["category"], "餐饮");
    }

    /// 已经填过 firefly_date 的行按填的日期显示，没填的退回银行原始日期。
    #[test]
    fn review_prefers_the_booked_date_over_the_bank_date() {
        let body = json!({ "data": { "groups": { "importable": [
            { "id": "1", "attributes": { "occurred_at": "2026-07-15", "firefly_date": "2026-07-16" } }
        ], "attention": [], "dismissed": [], "imported": [] }}});
        let rows = rows_for("bills.review", &body);
        assert_eq!(rows.rows[0]["date"], "2026-07-16");
    }

    #[test]
    fn projection_keeps_requested_order_and_fills_gaps() {
        let rows = rows_for("transactions.list", &firefly_transactions());
        let picked = rows.project(&["amount".to_owned(), "nope".to_owned()]);
        let keys: Vec<&String> = picked[0].keys().collect();
        assert_eq!(keys, vec!["amount", "nope"]);
        assert_eq!(picked[0]["nope"], Value::Null);
    }

    #[test]
    fn unknown_field_names_are_reported() {
        let rows = rows_for("transactions.list", &firefly_transactions());
        let asked = ["amount".to_owned(), "amonut".to_owned()];
        assert_eq!(rows.unknown(&asked), vec![&"amonut".to_owned()]);
    }

    #[test]
    fn client_side_filters_apply_to_rows() {
        let mut rows = rows_for("transactions.list", &firefly_transactions());
        let query = crate::query::parse(&["amt:>100".to_owned()]).unwrap();
        rows.retain(&query);
        assert!(rows.is_empty());

        let mut rows = rows_for("transactions.list", &firefly_transactions());
        let query = crate::query::parse(&["餐饮".to_owned()]).unwrap();
        rows.retain(&query);
        assert_eq!(rows.rows.len(), 1);
    }

    #[test]
    fn feedback_create_shows_candidates_and_copyable_confirmation_commands() {
        let body = json!({
            "submission_id": 91,
            "state": "needs_confirmation",
            "candidates": [{
                "feedback_id": 42,
                "title": "账单导入后没有结果",
                "status": "reviewing"
            }],
            "next_actions": ["confirm_same", "confirm_new"]
        });
        let rows = rows_for("feedback.create", &body);
        assert_eq!(rows.rows.len(), 1);
        assert_eq!(rows.rows[0]["submission_id"], 91);
        assert_eq!(
            rows.rows[0]["candidates"],
            "#42 账单导入后没有结果 [reviewing]"
        );
        let actions = rows.rows[0]["next_actions"].as_str().unwrap();
        assert!(actions.contains("abei feedback confirm 91 --same-as 42"));
        assert!(actions.contains("abei feedback confirm 91 --new"));
    }

    #[test]
    fn feedback_list_keeps_pending_submissions_separate_from_items() {
        let body = json!({
            "pending": [{
                "submission_id": 91,
                "kind": "bug",
                "target": "cli",
                "state": "needs_confirmation",
                "message": "没有结果",
                "candidates": [],
                "messages": []
            }],
            "data": [{
                "feedback_id": 42,
                "title": "账单导入后没有结果",
                "kind": "bug",
                "target": "cli",
                "status": "reviewing",
                "my_submission_ids": [88, 89]
            }]
        });
        let rows = rows_for("feedback.list", &body);
        assert_eq!(rows.rows.len(), 2);
        assert_eq!(rows.rows[0]["record"], "pending");
        assert_eq!(rows.rows[0]["submission_id"], 91);
        assert_eq!(
            rows.rows[0]["next_actions"],
            "abei feedback confirm 91 --new"
        );
        assert_eq!(rows.rows[1]["record"], "feedback");
        assert_eq!(rows.rows[1]["feedback_id"], 42);
        assert_eq!(rows.rows[1]["my_submission_ids"], "88,89");
    }

    #[test]
    fn feedback_list_surfaces_admin_questions_and_reply_command() {
        let body = json!({
            "pending": [{
                "submission_id": 91,
                "kind": "bug",
                "target": "cli",
                "state": "needs_information",
                "message": "没有结果",
                "candidates": [],
                "messages": [{
                    "id": 8,
                    "submission_id": 91,
                    "author_kind": "admin",
                    "body": "请补充版本",
                    "created_at": "later"
                }]
            }],
            "data": []
        });
        let rows = rows_for("feedback.list", &body);
        assert_eq!(rows.rows[0]["request"], "请补充版本");
        assert_eq!(
            rows.rows[0]["next_actions"],
            "abei feedback reply 91 --message '<补充信息>'"
        );
    }

    #[test]
    fn feedback_get_includes_public_updates_and_private_messages() {
        let body = json!({
            "data": {
                "feedback_id": 42,
                "title": "账单导入后没有结果",
                "status": "in_progress",
                "public_summary": "正在修复"
            },
            "updates": [{ "id": 7, "body": "已定位", "status": "in_progress", "created_at": "now" }],
            "submissions": [{ "submission_id": 91, "message": "没有结果", "state": "linked" }],
            "messages": [{ "id": 8, "submission_id": 91, "author_kind": "admin", "body": "请补充版本", "created_at": "later" }]
        });
        let rows = rows_for("feedback.get", &body);
        assert_eq!(rows.rows.len(), 4);
        assert_eq!(rows.rows[0]["record"], "feedback");
        assert_eq!(rows.rows[0]["content"], "正在修复");
        assert_eq!(rows.rows[1]["record"], "update");
        assert_eq!(rows.rows[1]["content"], "已定位");
        assert_eq!(rows.rows[3]["record"], "message");
        assert_eq!(rows.rows[3]["author"], "admin");
        assert_eq!(rows.rows[3]["content"], "请补充版本");
    }

    #[test]
    fn empty_body_yields_no_rows() {
        assert!(rows_for("transactions.list", &json!({})).is_empty());
        assert!(rows_for("accounts.list", &json!({ "data": [] })).is_empty());
    }
}
