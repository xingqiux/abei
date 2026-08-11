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
        "bills.list" | "bills.show" => bills(body),
        "bills.review" => review(body),
        "feedback.create" | "feedback.update" | "feedback.retry" | "feedback.list"
        | "feedback.get" => feedback(body),
        _ => generic(body),
    }
}

const FEEDBACK_FIELDS: &[&str] = &[
    "id",
    "title",
    "body",
    "labels",
    "kind",
    "submitted_by",
    "source",
    "status",
    "response",
    "responded_by",
    "responded_at",
    "duplicate_of",
    "github_issue_url",
    "github_issue_number",
    "sync_status",
    "sync_error",
    "created_at",
    "updated_at",
];

fn feedback(body: &Value) -> Rows {
    let rows = array(body, "data")
        .into_iter()
        .filter_map(|item| item.as_object().cloned())
        .map(|item| {
            FEEDBACK_FIELDS
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
    Rows::new(FEEDBACK_FIELDS, rows)
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

const BILL_FIELDS: &[&str] = &[
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
fn bills(body: &Value) -> Rows {
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
        rows.push(row);
    }
    Rows::new(BILL_FIELDS, rows)
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
    let buckets = body
        .pointer("/data/buckets")
        .or_else(|| body.get("buckets"))
        .cloned()
        .unwrap_or(Value::Null);

    let mut rows = Vec::new();
    for bucket in ["needs_attention", "ready", "duplicates"] {
        let items = buckets
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
            row.insert(
                "date".into(),
                Value::String(day(
                    str_of(&item, "firefly_date").or_else(|| str_of(&item, "occurred_at"))
                )),
            );
            row.insert("amount".into(), string(str_of(&item, "amount")));
            row.insert("counterparty".into(), string(str_of(&item, "counterparty")));
            row.insert("description".into(), string(str_of(&item, "description")));
            row.insert("type".into(), string(str_of(&item, "firefly_type")));
            row.insert("category".into(), string(str_of(&item, "category_name")));
            row.insert("duplicate".into(), string(str_of(&item, "duplicate_state")));
            row.insert("suggested_by".into(), string(str_of(&item, "suggested_by")));
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

    /// 三个桶摊成一张表，要处理的排在最前面。
    #[test]
    fn review_buckets_flatten_with_attention_first() {
        let body = json!({ "data": { "buckets": {
            "ready": [{ "id": 7, "occurred_at": "2026-07-15", "amount": "45.00",
                        "counterparty": "面馆", "firefly_type": "withdrawal",
                        "category_name": "餐饮", "duplicate_state": "unique" }],
            "needs_attention": [{ "id": 8, "occurred_at": "2026-07-16", "amount": "128.50",
                                  "counterparty": "山姆", "duplicate_state": "unique" }],
            "duplicates": []
        }}});
        let rows = rows_for("bills.review", &body);
        assert_eq!(rows.rows.len(), 2);
        assert_eq!(rows.rows[0]["bucket"], "needs_attention");
        // id 是数字也要能当字符串用（后面要拼进 abei rows update <id>）。
        assert_eq!(rows.rows[0]["id"], "8");
        assert_eq!(rows.rows[0]["type"], Value::Null);
        assert_eq!(rows.rows[1]["bucket"], "ready");
        assert_eq!(rows.rows[1]["category"], "餐饮");
    }

    /// 已经填过 firefly_date 的行按填的日期显示，没填的退回银行原始日期。
    #[test]
    fn review_prefers_the_booked_date_over_the_bank_date() {
        let body = json!({ "buckets": { "ready": [
            { "id": 1, "occurred_at": "2026-07-15", "firefly_date": "2026-07-16" }
        ]}});
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
    fn empty_body_yields_no_rows() {
        assert!(rows_for("transactions.list", &json!({})).is_empty());
        assert!(rows_for("accounts.list", &json!({ "data": [] })).is_empty());
    }
}
