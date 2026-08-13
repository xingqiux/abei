//! 账单流水建议。验证与风险闸门留在 API，持久化交给 abei-server。
//!
//! 这是机器写入账单的唯一通路：一律带 `as_suggestion`，服务端据此记成 AI 建议，
//! 由人在收件箱确认。别在别处再复制一份写入路径。

use abei_core::{Risk, RowsBatchUpdateParams, RowsSplitParams, RowsUpdateParams};
use axum::Extension;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::Method;
use serde_json::{Map, Value, json};

use crate::auth::AuthIdentity;
use crate::extract::{Gate, ValidJson, check_id};
use crate::problem::Problem;
use crate::state::AppState;

const FIREFLY_TYPES: &[&str] = &["withdrawal", "deposit", "transfer"];

pub async fn update(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
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
    if let Some(id) = params.source_account_id {
        validate_account_id(id).map_err(at)?;
        body.insert("source_account_id".to_owned(), json!(id));
    }
    put(&mut body, "destination_name", params.destination_name);
    if let Some(id) = params.destination_account_id {
        validate_account_id(id).map_err(at)?;
        body.insert("destination_account_id".to_owned(), json!(id));
    }
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

    validate_update_values(&body).map_err(at)?;

    body.insert("as_suggestion".to_owned(), Value::Bool(true));
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

    crate::routes::server::request_json(
        &state,
        &identity.0,
        Method::PATCH,
        &format!("/v1/bill-rows/{id}"),
        &Value::Object(body),
    )
    .await
    .map(|(_, value)| Json(value))
    .map_err(at)
}

pub async fn update_many(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    gate: Gate,
    ValidJson(params): ValidJson<RowsBatchUpdateParams>,
) -> Result<Json<Value>, Problem> {
    let at = |problem: Problem| problem.at("rows", "update-many");
    gate.check(Risk::Draft, "rows.update-many").map_err(at)?;
    let row_ids = normalize_row_ids(params.row_ids).map_err(at)?;
    if row_ids.is_empty() || row_ids.len() > 500 {
        return Err(at(Problem::invalid_params(
            "row_ids 必须包含 1 到 500 条流水。",
        )));
    }
    let mut body = Map::new();
    put(&mut body, "firefly_type", params.firefly_type);
    put(&mut body, "firefly_date", params.firefly_date);
    put(&mut body, "firefly_amount", params.firefly_amount);
    put(&mut body, "firefly_description", params.firefly_description);
    put(&mut body, "source_name", params.source_name);
    if let Some(id) = params.source_account_id {
        validate_account_id(id).map_err(at)?;
        body.insert("source_account_id".to_owned(), json!(id));
    }
    put(&mut body, "destination_name", params.destination_name);
    if let Some(id) = params.destination_account_id {
        validate_account_id(id).map_err(at)?;
        body.insert("destination_account_id".to_owned(), json!(id));
    }
    put(&mut body, "category_name", params.category_name);
    put(&mut body, "notes", params.notes);
    if let Some(tags) = params.tags {
        body.insert("tags".to_owned(), json!(tags));
    }
    if body.is_empty() {
        return Err(at(Problem::invalid_params("至少要更新一个账本字段。")));
    }
    validate_update_values(&body).map_err(at)?;
    body.insert("as_suggestion".to_owned(), Value::Bool(true));
    if gate.previewing() {
        let (_, value) = crate::routes::server::request_json(
            &state,
            &identity.0,
            Method::PATCH,
            "/v1/bill-rows/update-many?dry_run=true",
            &json!({ "row_ids": row_ids, "values": body }),
        )
        .await
        .map_err(at)?;
        return Ok(Json(value));
    }
    let (_, value) = crate::routes::server::request_json(
        &state,
        &identity.0,
        Method::PATCH,
        "/v1/bill-rows/update-many",
        &json!({ "row_ids": row_ids, "values": body }),
    )
    .await
    .map_err(at)?;
    Ok(Json(value))
}

pub async fn split(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
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

    crate::routes::server::request_json(
        &state,
        &identity.0,
        Method::POST,
        &format!("/v1/bill-rows/{id}/split"),
        &json!({ "splits": splits }),
    )
    .await
    .map(|(_, value)| Json(value))
    .map_err(at)
}

/// 没给的字段不进请求体：不填等于不动，跟「填空」区分开。
fn put(body: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if let Some(value) = value {
        body.insert(key.to_owned(), Value::String(value));
    }
}

fn normalize_row_ids(mut row_ids: Vec<u64>) -> Result<Vec<u64>, Problem> {
    if row_ids.iter().any(|id| *id == 0 || *id > i64::MAX as u64) {
        return Err(Problem::invalid_params(
            "row_ids 必须全部是服务端可表示的正整数。",
        ));
    }
    row_ids.sort_unstable();
    row_ids.dedup();
    Ok(row_ids)
}

fn validate_account_id(id: u64) -> Result<(), Problem> {
    if id == 0 || id > i64::MAX as u64 {
        Err(Problem::invalid_params("Firefly 账户 id 必须是正整数。"))
    } else {
        Ok(())
    }
}

fn validate_update_values(body: &Map<String, Value>) -> Result<(), Problem> {
    if let Some(kind) = body.get("firefly_type").and_then(Value::as_str)
        && !FIREFLY_TYPES.contains(&kind)
    {
        return Err(Problem::invalid_params(format!(
            "firefly_type 只能是 {}，收到的是 {kind}。",
            FIREFLY_TYPES.join(" / ")
        )));
    }
    if let Some(date) = body.get("firefly_date").and_then(Value::as_str)
        && !crate::extract::is_date(date)
    {
        return Err(Problem::invalid_date("firefly_date", date));
    }
    if let Some(amount) = body.get("firefly_amount").and_then(Value::as_str)
        && !is_amount(amount)
    {
        return Err(Problem::invalid_params(
            "firefly_amount 必须是大于 0、最多八位小数的金额。",
        ));
    }
    Ok(())
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
