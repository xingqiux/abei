//! 账单流水行。委托 fork 的 `/api/v1/bill-statement-rows`。
//!
//! 这是机器写入账单的唯一通路：一律带 `as_suggestion`，服务端据此记成 AI 建议，
//! 由人在收件箱确认。别在别处再复制一份写入路径。

use abei_core::{Risk, RowsSplitParams, RowsUpdateParams};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::Method;
use serde_json::{Map, Value, json};

use crate::auth::AuthToken;
use crate::extract::{Gate, ValidJson, check_id};
use crate::problem::Problem;
use crate::state::AppState;

const ROWS: &str = "/api/v1/bill-statement-rows";

const FIREFLY_TYPES: &[&str] = &["withdrawal", "deposit", "transfer"];

pub async fn update(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
    gate: Gate,
    ValidJson(params): ValidJson<RowsUpdateParams>,
) -> Result<Json<Value>, Problem> {
    let at = |problem: Problem| problem.at("rows", "update");
    let id = check_id(&id).map_err(at)?;
    gate.check(Risk::Draft, "rows.update").map_err(at)?;

    let mut body = Map::new();
    put(&mut body, "firefly_type", params.firefly_type);
    put(&mut body, "firefly_date", params.firefly_date);
    put(&mut body, "firefly_amount", params.firefly_amount);
    put(&mut body, "firefly_description", params.firefly_description);
    put(&mut body, "source_name", params.source_name);
    put(&mut body, "destination_name", params.destination_name);
    put(&mut body, "category_name", params.category_name);
    put(&mut body, "notes", params.notes);
    if let Some(tags) = params.tags {
        body.insert("tags".to_owned(), json!(tags));
    }

    if body.is_empty() {
        return Err(at(Problem::invalid_params(
            "至少要填一个字段，比如 --firefly-type 或 --category-name。",
        )));
    }

    if let Some(kind) = body.get("firefly_type").and_then(Value::as_str)
        && !FIREFLY_TYPES.contains(&kind)
    {
        return Err(at(Problem::invalid_params(format!(
            "firefly_type 只能是 {}，收到的是 {kind}。",
            FIREFLY_TYPES.join(" / ")
        ))));
    }

    if let Some(date) = body.get("firefly_date").and_then(Value::as_str)
        && !crate::extract::is_date(date)
    {
        return Err(at(Problem::invalid_date("firefly_date", date)));
    }

    if gate.previewing() {
        return Ok(Json(json!({
            "dry_run": true,
            "would": {
                "capability": "rows.update",
                "row_id": id,
                "values": Value::Object(body),
                "as_suggestion": true,
            },
        })));
    }

    // 机器写入永远是建议。这一条不给调用方选，否则「AI 猜的」和「人确认的」就混了。
    body.insert("as_suggestion".to_owned(), Value::Bool(true));

    state
        .firefly
        .send_json(
            &token,
            Method::PATCH,
            &format!("{ROWS}/{id}"),
            &Value::Object(body),
        )
        .await
        .map(Json)
        .map_err(at)
}

pub async fn split(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
    gate: Gate,
    ValidJson(params): ValidJson<RowsSplitParams>,
) -> Result<Json<Value>, Problem> {
    let at = |problem: Problem| problem.at("rows", "split");
    let id = check_id(&id).map_err(at)?;
    gate.check(Risk::Draft, "rows.split").map_err(at)?;

    if !(2..=20).contains(&params.splits.len()) {
        return Err(at(Problem::invalid_params(format!(
            "拆分要给 2 到 20 笔，收到的是 {} 笔。",
            params.splits.len()
        ))));
    }
    for (index, part) in params.splits.iter().enumerate() {
        if !is_amount(&part.amount) {
            return Err(at(Problem::invalid_params(format!(
                "第 {} 笔的金额得是正数，收到的是 {}。",
                index + 1,
                part.amount
            ))));
        }
    }

    let splits = json!(params.splits);

    if gate.previewing() {
        return Ok(Json(json!({
            "dry_run": true,
            "would": { "capability": "rows.split", "row_id": id, "splits": splits },
        })));
    }

    state
        .firefly
        .send_json(
            &token,
            Method::POST,
            &format!("{ROWS}/{id}/split"),
            &json!({ "splits": splits }),
        )
        .await
        .map(Json)
        .map_err(at)
}

/// 没给的字段不进请求体：不填等于不动，跟「填空」区分开。
fn put(body: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        body.insert(key.to_owned(), Value::String(value));
    }
}

/// 金额得是正数，最多八位小数（跟上游的校验对齐）。
fn is_amount(raw: &str) -> bool {
    let mut parts = raw.splitn(2, '.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next().unwrap_or("0");

    !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && !fraction.is_empty()
        && fraction.len() <= 8
        && fraction.bytes().all(|b| b.is_ascii_digit())
        && raw.chars().any(|c| ('1'..='9').contains(&c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn amounts_must_be_positive_decimals() {
        assert!(is_amount("45"));
        assert!(is_amount("45.00"));
        assert!(is_amount("0.01"));
        assert!(!is_amount("0"));
        assert!(!is_amount("0.00"));
        assert!(!is_amount("-1"));
        assert!(!is_amount("1.234567890"));
        assert!(!is_amount("abc"));
        assert!(!is_amount(""));
    }

    #[test]
    fn absent_fields_stay_out_of_the_body() {
        let mut body = Map::new();
        put(&mut body, "notes", None);
        put(&mut body, "category_name", Some("餐饮".to_owned()));
        assert!(body.get("notes").is_none());
        assert_eq!(body["category_name"], json!("餐饮"));
    }
}
