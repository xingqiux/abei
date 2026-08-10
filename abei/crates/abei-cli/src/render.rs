//! 人话输出。
//!
//! 终端里画表格，管道里出制表符分隔（带一行表头，脚本 `tail -n +2` 就能去掉）。
//! 机器要稳定结构应该用 `--json`，那才是契约；这里的排版随时可能变好看一点。

use comfy_table::{Attribute, Cell, CellAlignment, ContentArrangement, Table, presets};
use serde_json::Value;

use crate::normalize::Rows;

/// 字段名 -> 中文表头。没登记的字段直接用字段名当表头。
fn header(field: &str) -> &str {
    match field {
        "id" => "编号",
        "date" => "日期",
        "type" => "类型",
        "amount" => "金额",
        "currency" => "币种",
        "description" => "摘要",
        "category" => "分类",
        "source" => "付款账户",
        "destination" => "收款方",
        "name" => "名称",
        "balance" => "余额",
        "active" => "启用",
        "count" => "笔数",
        "total" => "合计",
        other => other,
    }
}

fn is_numeric(field: &str) -> bool {
    matches!(field, "amount" | "balance" | "total" | "count")
}

fn cell_text(value: &Value) -> String {
    match value {
        Value::Null => "—".to_owned(),
        Value::String(text) if text.is_empty() => "—".to_owned(),
        Value::String(text) => text.clone(),
        Value::Bool(true) => "是".to_owned(),
        Value::Bool(false) => "否".to_owned(),
        other => other.to_string(),
    }
}

/// 排版方式。宽度探不到或者小得离谱（pty 没设窗口大小时 crossterm 会返回 0）
/// 就别按宽度压缩——comfy-table 会把每个字拆成一行，比不折行难看得多。
fn arrangement(table: &Table) -> ContentArrangement {
    match table.width() {
        Some(width) if width >= 40 => ContentArrangement::Dynamic,
        _ => ContentArrangement::Disabled,
    }
}

/// 列表的人话形态。
pub fn table(rows: &Rows, tty: bool) -> String {
    if rows.is_empty() {
        return "没有符合条件的记录。".to_owned();
    }
    if !tty {
        return tsv(rows);
    }

    let mut table = Table::new();
    let arrangement = arrangement(&table);
    table
        .load_style(presets::UTF8_BORDERS_ONLY)
        .set_content_arrangement(arrangement)
        .set_header(
            rows.fields
                .iter()
                .map(|field| Cell::new(header(field)).add_attribute(Attribute::Bold))
                .collect::<Vec<_>>(),
        );

    for row in &rows.rows {
        table.add_row(
            rows.fields
                .iter()
                .map(|field| {
                    let cell = Cell::new(cell_text(row.get(field).unwrap_or(&Value::Null)));
                    if is_numeric(field) {
                        cell.set_alignment(CellAlignment::Right)
                    } else {
                        cell
                    }
                })
                .collect::<Vec<_>>(),
        );
    }

    table.to_string()
}

/// 管道里的形态：制表符分隔，第一行是字段名（不是中文表头，方便脚本对齐 --json）。
fn tsv(rows: &Rows) -> String {
    let mut lines = vec![rows.fields.join("\t")];
    for row in &rows.rows {
        lines.push(
            rows.fields
                .iter()
                .map(|field| {
                    let text = cell_text(row.get(field).unwrap_or(&Value::Null));
                    // 制表符和换行会破坏行结构，换成空格。
                    text.replace(['\t', '\n'], " ")
                })
                .collect::<Vec<_>>()
                .join("\t"),
        );
    }
    lines.join("\n")
}

/// 汇总的人话形态：几段小表，而不是一行标量。
pub fn summary(body: &Value, tty: bool) -> String {
    let mut out = Vec::new();

    let start = body.pointer("/range/start").and_then(Value::as_str);
    let end = body.pointer("/range/end").and_then(Value::as_str);
    if let (Some(start), Some(end)) = (start, end) {
        out.push(format!("区间 {start} 到 {end}"));
    }

    let count = body
        .pointer("/totals/count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let consumption = body
        .pointer("/daily_consumption/total")
        .and_then(Value::as_str)
        .unwrap_or("0");
    out.push(format!("共 {count} 笔，日常消费合计 {consumption}"));

    let excluded: Vec<&str> = body
        .get("excluded_categories")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if !excluded.is_empty() {
        out.push(format!("已排除分类：{}", excluded.join("、")));
    }

    if let Some(by_type) = body.pointer("/totals/by_type").and_then(Value::as_object) {
        let mut lines = Vec::new();
        for (kind, bucket) in by_type {
            let label = match kind.as_str() {
                "withdrawal" => "支出",
                "deposit" => "收入",
                "transfer" => "转账",
                other => other,
            };
            let total = bucket.get("total").and_then(Value::as_str).unwrap_or("0");
            let count = bucket.get("count").and_then(Value::as_u64).unwrap_or(0);
            lines.push(format!("  {label} {total}（{count} 笔）"));
        }
        if !lines.is_empty() {
            out.push(String::new());
            out.push("按类型".to_owned());
            out.extend(lines);
        }
    }

    for (key, title) in [
        ("top_categories", "花得最多的分类"),
        ("top_merchants", "花得最多的去处"),
        ("payment_accounts", "从哪些账户付的"),
    ] {
        if let Some(section) = named_table(body, key, tty) {
            out.push(String::new());
            out.push(title.to_owned());
            out.push(section);
        }
    }

    out.join("\n")
}

/// 排行表：三张表共用 name/count/total 形状。
fn named_table(body: &Value, key: &str, tty: bool) -> Option<String> {
    let items = body.get(key)?.as_array()?;
    if items.is_empty() {
        return None;
    }

    let rows = Rows {
        fields: vec!["name".to_owned(), "total".to_owned(), "count".to_owned()],
        rows: items
            .iter()
            .filter_map(|item| item.as_object().cloned())
            .collect(),
    };
    Some(table(&rows, tty))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rows() -> Rows {
        Rows {
            fields: vec![
                "date".to_owned(),
                "amount".to_owned(),
                "category".to_owned(),
            ],
            rows: vec![
                json!({ "date": "2026-08-01", "amount": "45.00", "category": "餐饮" })
                    .as_object()
                    .unwrap()
                    .clone(),
            ],
        }
    }

    #[test]
    fn pipes_get_tab_separated_values_with_a_header_line() {
        let text = table(&rows(), false);
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines[0], "date\tamount\tcategory");
        assert_eq!(lines[1], "2026-08-01\t45.00\t餐饮");
    }

    /// 管道里的表头用字段名，跟 --json 的字段对得上。
    #[test]
    fn tsv_header_matches_json_field_names() {
        let rows = rows();
        let text = table(&rows, false);
        assert_eq!(text.lines().next().unwrap(), rows.fields.join("\t"));
    }

    #[test]
    fn terminals_get_a_bordered_table_with_chinese_headers() {
        let text = table(&rows(), true);
        assert!(text.contains("日期"));
        assert!(text.contains("金额"));
        assert!(text.contains("餐饮"));
    }

    #[test]
    fn empty_result_says_so_in_words() {
        let empty = Rows {
            fields: vec!["id".to_owned()],
            rows: vec![],
        };
        assert_eq!(table(&empty, true), "没有符合条件的记录。");
        assert_eq!(table(&empty, false), "没有符合条件的记录。");
    }

    /// 单元格里的制表符会破坏 TSV 的列，必须替掉。
    #[test]
    fn embedded_tabs_do_not_break_columns() {
        let rows = Rows {
            fields: vec!["description".to_owned()],
            rows: vec![
                json!({ "description": "a\tb\nc" })
                    .as_object()
                    .unwrap()
                    .clone(),
            ],
        };
        let text = table(&rows, false);
        assert_eq!(text.lines().count(), 2);
        assert_eq!(text.lines().nth(1).unwrap(), "a b c");
    }

    #[test]
    fn missing_values_render_as_a_dash() {
        assert_eq!(cell_text(&Value::Null), "—");
        assert_eq!(cell_text(&json!("")), "—");
        assert_eq!(cell_text(&json!(true)), "是");
    }

    #[test]
    fn summary_reads_like_a_sentence() {
        let body = json!({
            "range": { "start": "2026-08-01", "end": "2026-08-31" },
            "excluded_categories": ["房租"],
            "totals": { "count": 12, "by_type": {
                "withdrawal": { "count": 10, "total": "900.00" } } },
            "daily_consumption": { "count": 8, "total": "700.00" },
            "top_categories": [{ "name": "餐饮", "count": 5, "total": "300.00" }]
        });
        let text = summary(&body, true);
        assert!(text.contains("区间 2026-08-01 到 2026-08-31"));
        assert!(text.contains("共 12 笔，日常消费合计 700.00"));
        assert!(text.contains("已排除分类：房租"));
        assert!(text.contains("支出 900.00（10 笔）"));
        assert!(text.contains("花得最多的分类"));
        assert!(text.contains("餐饮"));
    }

    /// 空排行不该留下一个只有标题的空段落。
    #[test]
    fn empty_rankings_are_skipped() {
        let body = json!({
            "totals": { "count": 0, "by_type": {} },
            "daily_consumption": { "count": 0, "total": "0" },
            "top_categories": []
        });
        let text = summary(&body, true);
        assert!(!text.contains("花得最多的分类"));
    }
}
