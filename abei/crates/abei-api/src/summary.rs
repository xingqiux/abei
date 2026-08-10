//! 消费汇总。翻页拉全区间交易，然后纯函数聚合。
//!
//! 聚合部分不碰 IO，直接对着夹具数据测。

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::firefly::Firefly;
use crate::problem::Problem;

/// 按这套账的习惯，这些分类的支出不算日常消费：内部转账、取现、余额校正、退款、信用借还。
pub const DEFAULT_EXCLUDE_CATEGORIES: &[&str] =
    &["账户转账", "提现", "余额调整", "退钱", "信用借还"];

const PAGE_LIMIT: u32 = 500;
const MAX_PAGES: u32 = 1000;
const TOP_LIMIT: usize = 10;

#[derive(Debug, Clone)]
pub struct Row {
    pub kind: String,
    pub date: String,
    pub amount: f64,
    pub category: Option<String>,
    pub source: Option<String>,
    pub destination: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Range {
    pub start: Option<String>,
    pub end: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Bucket {
    pub count: usize,
    pub total: String,
}

/// 排行项。四张排行表共用一个 `name` 字段，客户端渲染时套自己的表头。
#[derive(Debug, Clone, Serialize)]
pub struct NamedBucket {
    pub name: String,
    pub count: usize,
    pub total: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Totals {
    pub count: usize,
    pub by_type: BTreeMap<String, Bucket>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SummaryReport {
    pub range: Range,
    pub excluded_categories: Vec<String>,
    pub totals: Totals,
    /// 日常消费口径：支出减去被排除的分类。
    pub daily_consumption: Bucket,
    pub top_categories: Vec<NamedBucket>,
    pub top_merchants: Vec<NamedBucket>,
    pub payment_accounts: Vec<NamedBucket>,
    pub daily: Vec<NamedBucket>,
}

/// 翻页拉完区间内的交易。
pub async fn fetch_rows(
    firefly: &Firefly,
    token: &str,
    range: &Range,
) -> Result<Vec<Row>, Problem> {
    let mut rows = Vec::new();
    let mut page = 1u32;

    while page <= MAX_PAGES {
        let query = [
            ("start", range.start.clone().unwrap_or_default()),
            ("end", range.end.clone().unwrap_or_default()),
            ("limit", PAGE_LIMIT.to_string()),
            ("page", page.to_string()),
        ];
        let body = firefly
            .get_json(token, "/api/v1/transactions", &query)
            .await?;

        let page_rows = extract_rows(&body);
        if page_rows.is_empty() {
            break;
        }
        rows.extend(page_rows);

        if page >= total_pages(&body) {
            break;
        }
        page += 1;
    }

    Ok(rows)
}

/// 把 Firefly 的交易组列表摊平成行。
pub fn extract_rows(body: &Value) -> Vec<Row> {
    let Some(groups) = body.get("data").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut rows = Vec::new();
    for group in groups {
        let Some(attributes) = group.get("attributes") else {
            continue;
        };
        let items: Vec<&Value> = match attributes.get("transactions").and_then(Value::as_array) {
            Some(nested) => nested.iter().collect(),
            None => vec![attributes],
        };

        for item in items {
            let (Some(kind), Some(date), Some(amount)) =
                (text(item, "type"), text(item, "date"), text(item, "amount"))
            else {
                continue;
            };
            rows.push(Row {
                kind: kind.to_lowercase(),
                date,
                amount: amount.parse::<f64>().unwrap_or(0.0),
                category: text(item, "category_name"),
                source: text(item, "source_name").or_else(|| text(item, "source_id")),
                destination: text(item, "destination_name")
                    .or_else(|| text(item, "destination_id")),
            });
        }
    }
    rows
}

/// 聚合。纯函数，不碰 IO。
pub fn summarize(rows: &[Row], extra_excludes: &[String], range: Range) -> SummaryReport {
    let excluded_categories = merge_excludes(extra_excludes);
    let excluded: Vec<String> = excluded_categories.iter().map(|c| normalize(c)).collect();

    let mut by_type: BTreeMap<String, (usize, f64)> = BTreeMap::new();
    for row in rows {
        let entry = by_type.entry(row.kind.clone()).or_insert((0, 0.0));
        entry.0 += 1;
        entry.1 += row.amount;
    }

    let consumption: Vec<&Row> = rows
        .iter()
        .filter(|row| {
            row.kind == "withdrawal"
                && !excluded.contains(&normalize(row.category.as_deref().unwrap_or_default()))
        })
        .collect();

    let mut categories: BTreeMap<String, (usize, f64)> = BTreeMap::new();
    let mut merchants: BTreeMap<String, (usize, f64)> = BTreeMap::new();
    let mut accounts: BTreeMap<String, (usize, f64)> = BTreeMap::new();
    let mut daily: BTreeMap<String, (usize, f64)> = BTreeMap::new();

    for row in &consumption {
        add(
            &mut categories,
            row.category
                .clone()
                .unwrap_or_else(|| "(未分类)".to_owned()),
            row.amount,
        );
        add(
            &mut merchants,
            row.destination
                .clone()
                .unwrap_or_else(|| "(未知)".to_owned()),
            row.amount,
        );
        add(
            &mut accounts,
            row.source.clone().unwrap_or_else(|| "(未知)".to_owned()),
            row.amount,
        );
        add(&mut daily, row.date.chars().take(10).collect(), row.amount);
    }

    let consumption_total: f64 = consumption.iter().map(|row| row.amount).sum();

    SummaryReport {
        range,
        excluded_categories,
        totals: Totals {
            count: rows.len(),
            by_type: by_type
                .into_iter()
                .map(|(key, (count, total))| {
                    (
                        key,
                        Bucket {
                            count,
                            total: money(total),
                        },
                    )
                })
                .collect(),
        },
        daily_consumption: Bucket {
            count: consumption.len(),
            total: money(consumption_total),
        },
        top_categories: top(categories),
        top_merchants: top(merchants),
        payment_accounts: top(accounts),
        daily: by_key(daily),
    }
}

fn add(buckets: &mut BTreeMap<String, (usize, f64)>, key: String, amount: f64) {
    let entry = buckets.entry(key).or_insert((0, 0.0));
    entry.0 += 1;
    entry.1 += amount;
}

/// 金额高的在前，同额按名字排，保证输出稳定。
fn top(buckets: BTreeMap<String, (usize, f64)>) -> Vec<NamedBucket> {
    let mut list = to_list(buckets);
    list.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    list.into_iter().take(TOP_LIMIT).map(named).collect()
}

/// 按名字升序，日期桶用。
fn by_key(buckets: BTreeMap<String, (usize, f64)>) -> Vec<NamedBucket> {
    to_list(buckets).into_iter().map(named).collect()
}

fn to_list(buckets: BTreeMap<String, (usize, f64)>) -> Vec<(String, f64, usize)> {
    buckets
        .into_iter()
        .map(|(name, (count, total))| (name, total, count))
        .collect()
}

fn named(entry: (String, f64, usize)) -> NamedBucket {
    NamedBucket {
        name: entry.0,
        count: entry.2,
        total: money(entry.1),
    }
}

fn merge_excludes(extra: &[String]) -> Vec<String> {
    let mut merged: Vec<String> = DEFAULT_EXCLUDE_CATEGORIES
        .iter()
        .map(|c| (*c).to_owned())
        .collect();
    for candidate in extra {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            continue;
        }
        if merged
            .iter()
            .any(|existing| normalize(existing) == normalize(trimmed))
        {
            continue;
        }
        merged.push(trimmed.to_owned());
    }
    merged
}

fn total_pages(body: &Value) -> u32 {
    body.get("meta")
        .and_then(|meta| meta.get("pagination"))
        .and_then(|pagination| pagination.get("total_pages"))
        .and_then(Value::as_u64)
        .map(|pages| pages.max(1) as u32)
        .unwrap_or(1)
}

fn text(value: &Value, key: &str) -> Option<String> {
    let found = value.get(key)?;
    let text = match found {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn normalize(value: &str) -> String {
    value.trim().to_lowercase()
}

fn money(value: f64) -> String {
    format!("{value:.2}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn body() -> Value {
        json!({
            "data": [
                { "attributes": { "transactions": [
                    { "type": "withdrawal", "date": "2026-08-01T12:00:00+08:00", "amount": "45.00",
                      "category_name": "餐饮", "source_name": "招行卡", "destination_name": "楼下面馆" },
                    { "type": "withdrawal", "date": "2026-08-01T19:00:00+08:00", "amount": "12.50",
                      "category_name": "餐饮", "source_name": "招行卡", "destination_name": "便利店" }
                ]}},
                { "attributes": { "transactions": [
                    { "type": "withdrawal", "date": "2026-08-02T09:00:00+08:00", "amount": "3000.00",
                      "category_name": "账户转账", "source_name": "招行卡", "destination_name": "支付宝" }
                ]}},
                { "attributes": { "transactions": [
                    { "type": "deposit", "date": "2026-08-03T09:00:00+08:00", "amount": "20000.00",
                      "category_name": "工资", "source_name": "公司", "destination_name": "招行卡" }
                ]}}
            ],
            "meta": { "pagination": { "total_pages": 1 } }
        })
    }

    #[test]
    fn flattens_transaction_groups() {
        let rows = extract_rows(&body());
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].kind, "withdrawal");
        assert_eq!(rows[0].amount, 45.0);
        assert_eq!(rows[0].category.as_deref(), Some("餐饮"));
    }

    #[test]
    fn rows_missing_required_fields_are_skipped() {
        let rows = extract_rows(&json!({ "data": [
            { "attributes": { "transactions": [ { "type": "withdrawal", "amount": "1.00" } ] } }
        ]}));
        assert!(rows.is_empty());
    }

    /// 排除的分类不进日常消费，但仍算进总数。
    #[test]
    fn excluded_categories_stay_out_of_consumption() {
        let report = summarize(
            &extract_rows(&body()),
            &[],
            Range {
                start: None,
                end: None,
            },
        );
        assert_eq!(report.totals.count, 4);
        assert_eq!(report.daily_consumption.count, 2);
        assert_eq!(report.daily_consumption.total, "57.50");
        assert_eq!(report.totals.by_type["withdrawal"].count, 3);
        assert_eq!(report.totals.by_type["deposit"].total, "20000.00");
    }

    #[test]
    fn extra_excludes_are_merged_without_duplicates() {
        let report = summarize(
            &extract_rows(&body()),
            &["餐饮".to_owned(), " 提现 ".to_owned(), String::new()],
            Range {
                start: None,
                end: None,
            },
        );
        assert_eq!(report.daily_consumption.count, 0);
        assert_eq!(
            report.excluded_categories.len(),
            DEFAULT_EXCLUDE_CATEGORIES.len() + 1,
            "提现 已在默认表里，不该重复追加"
        );
    }

    #[test]
    fn rankings_sort_by_total_desc_and_days_ascend() {
        let report = summarize(
            &extract_rows(&body()),
            &[],
            Range {
                start: None,
                end: None,
            },
        );
        assert_eq!(report.top_categories[0].name, "餐饮");
        assert_eq!(report.top_merchants[0].name, "楼下面馆");
        assert_eq!(report.payment_accounts[0].name, "招行卡");
        assert_eq!(report.daily.len(), 1);
        assert_eq!(report.daily[0].name, "2026-08-01");
        assert_eq!(report.daily[0].total, "57.50");
    }

    #[test]
    fn pagination_defaults_to_one_page() {
        assert_eq!(total_pages(&json!({})), 1);
        assert_eq!(
            total_pages(&json!({ "meta": { "pagination": { "total_pages": 7 } } })),
            7
        );
    }
}
