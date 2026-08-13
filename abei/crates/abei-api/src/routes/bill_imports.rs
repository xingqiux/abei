use abei_core::{BillsImportParams, Risk};
use axum::Json;
use axum::extract::{Extension, Path, State};
use axum::http::Method;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{AuthIdentity, AuthToken};
use crate::existing_transactions;
use crate::extract::{Gate, ValidJson, check_id};
use crate::firefly::{FireflyWriteError, VerifiedUser};
use crate::problem::Problem;
use crate::state::AppState;

const MAX_IMPORT_SELECTION: usize = 5_000;

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ResourceId {
    String(String),
    Number(u64),
}

impl ResourceId {
    fn parse(&self) -> Result<i64, Problem> {
        let value = match self {
            Self::String(value) => value.parse::<i64>().ok().filter(|value| *value > 0),
            Self::Number(value) => i64::try_from(*value).ok().filter(|value| *value > 0),
        };
        value.ok_or_else(|| Problem::invalid_params("row_ids 必须全部是正整数。"))
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RowsImportInput {
    row_ids: Vec<ResourceId>,
    #[serde(default)]
    include_payload: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MappingInput {
    channel_key: String,
    account_hint: String,
    firefly_account_id: ResourceId,
}

pub async fn import_rows(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    gate: Gate,
    ValidJson(input): ValidJson<RowsImportInput>,
) -> Result<Json<Value>, Problem> {
    gate.check(Risk::Confirm, "bill-rows.import")?;
    let row_ids = parse_row_ids(&input.row_ids)?;
    Ok(Json(
        run_imports(
            &state,
            &identity.0,
            &token,
            &row_ids,
            gate,
            input.include_payload,
        )
        .await,
    ))
}

pub async fn import_document(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    Path(path_id): Path<String>,
    gate: Gate,
    ValidJson(input): ValidJson<BillsImportParams>,
) -> Result<Json<Value>, Problem> {
    let at = |problem: Problem| problem.at("bills", "import");
    gate.check(Risk::Confirm, "bills.import").map_err(at)?;
    let document_id = check_id(&path_id)
        .map_err(at)?
        .parse::<i64>()
        .map_err(|_| at(Problem::invalid_params("账单文档 id 必须是正整数。")))?;
    let picking_all = input.all.unwrap_or(false);
    let selected = input.row_ids.unwrap_or_default();
    if picking_all != selected.is_empty() {
        return Err(at(Problem::invalid_params(
            "要么 all=true 导入整份，要么给 row_ids 挑几行，二选一。",
        )));
    }
    let row_ids = if picking_all {
        document_row_ids(&state, &identity.0, document_id)
            .await
            .map_err(at)?
    } else {
        let ids = selected
            .into_iter()
            .map(|value| {
                i64::try_from(value)
                    .ok()
                    .filter(|value| *value > 0)
                    .ok_or_else(|| Problem::invalid_params("row_ids 必须全部是正整数。"))
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(at)?;
        validate_selection_count(ids.len()).map_err(at)?;
        ids
    };
    Ok(Json(
        run_imports(
            &state,
            &identity.0,
            &token,
            &row_ids,
            gate,
            input.include_payload.unwrap_or(false),
        )
        .await,
    ))
}

pub async fn get_attempt(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Problem> {
    validate_attempt_id(&id)?;
    let (_, value) = server_json(
        &state,
        &identity.0,
        Method::GET,
        &format!("/v1/bill-import-attempts/{id}"),
        &Value::Null,
    )
    .await?;
    Ok(Json(value))
}

pub async fn reconcile_attempt(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
) -> Result<Json<Value>, Problem> {
    validate_attempt_id(&id)?;
    let (_, attempt) = server_json(
        &state,
        &identity.0,
        Method::GET,
        &format!("/v1/bill-import-attempts/{id}"),
        &Value::Null,
    )
    .await?;
    if attempt["data"]["status"] != "uncertain" {
        return Err(Problem::new(
            axum::http::StatusCode::CONFLICT,
            "Conflict",
            "当前状态不允许这一步",
        )
        .detail("只有 uncertain 导入尝试需要对账。"));
    }
    let external_id = attempt["data"]["external_id"]
        .as_str()
        .ok_or_else(|| Problem::internal("导入尝试缺少 external_id。"))?;
    let query = format!("external_id_is:\"{external_id}\"");
    let found = state
        .firefly
        .get_json(
            &token,
            "/api/v1/search/transactions",
            &[("query", query), ("limit", "10".to_owned())],
        )
        .await?;
    let mut group_ids = found["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| parse_positive_id(&item["id"]))
        .collect::<Vec<_>>();
    group_ids.sort_unstable();
    group_ids.dedup();
    match group_ids.as_slice() {
        [group_id] => {
            let (_, completed) = server_json(
                &state,
                &identity.0,
                Method::POST,
                &format!("/internal/v1/bill-imports/{id}/complete"),
                &json!({ "transaction_group_id": group_id, "reconciled": true }),
            )
            .await?;
            Ok(Json(json!({ "data": completed["data"], "match_count": 1 })))
        }
        [] => {
            let released = server_json(
                &state,
                &identity.0,
                Method::POST,
                &format!("/internal/v1/bill-imports/{id}/release"),
                &json!({}),
            )
            .await;
            let value = match released {
                Ok((_, value)) => value,
                Err(problem) if problem.status == axum::http::StatusCode::CONFLICT => attempt,
                Err(problem) => return Err(problem),
            };
            Ok(Json(json!({ "data": value["data"], "match_count": 0 })))
        }
        _ => Err(Problem::new(
            axum::http::StatusCode::CONFLICT,
            "MultipleMatches",
            "对账找到多条交易",
        )
        .detail("同一个 external_id 在 Firefly 中出现多次，需要人工处理，系统不会自动选择。")
        .upstream(json!({ "transaction_group_ids": group_ids }))),
    }
}

pub async fn retry_attempt(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
    gate: Gate,
) -> Result<Json<Value>, Problem> {
    gate.check(Risk::Confirm, "bill-import-attempts.retry")?;
    validate_attempt_id(&id)?;
    let (_, attempt) = server_json(
        &state,
        &identity.0,
        Method::GET,
        &format!("/v1/bill-import-attempts/{id}"),
        &Value::Null,
    )
    .await?;
    if attempt["data"]["status"] != "retryable" {
        return Err(Problem::new(
            axum::http::StatusCode::CONFLICT,
            "Conflict",
            "当前状态不允许这一步",
        )
        .detail("只有 retryable 导入尝试可以重试。"));
    }
    let row_id = parse_positive_id(&attempt["data"]["bill_row_id"])
        .ok_or_else(|| Problem::internal("导入尝试缺少 bill_row_id。"))?;
    Ok(Json(
        run_imports(&state, &identity.0, &token, &[row_id], gate, false).await,
    ))
}

pub async fn upsert_mapping(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    gate: Gate,
    ValidJson(input): ValidJson<MappingInput>,
) -> Result<Json<Value>, Problem> {
    gate.check(Risk::Draft, "bill-account-mappings.update")?;
    let account_id = input.firefly_account_id.parse()?;
    let account = verified_account(&state, &token, account_id).await?;
    let body = json!({
        "channel_key": input.channel_key,
        "account_hint": input.account_hint,
        "firefly_account_id": account_id,
        "firefly_account_name": account.name,
        "firefly_account_type": account.kind,
    });
    if gate.previewing() {
        return Ok(Json(json!({ "dry_run": true, "would": body })));
    }
    let (_, value) = server_json(
        &state,
        &identity.0,
        Method::PUT,
        "/v1/bill-account-mappings",
        &body,
    )
    .await?;
    Ok(Json(value))
}

pub async fn delete_mapping(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    Path(id): Path<String>,
    gate: Gate,
) -> Result<Json<Value>, Problem> {
    gate.check(Risk::Confirm, "bill-account-mappings.delete")?;
    check_id(&id)?;
    if gate.previewing() {
        return Ok(Json(json!({ "dry_run": true, "would": {
            "account_mapping_id": id, "action": "delete"
        }})));
    }
    let (_, value) = server_json(
        &state,
        &identity.0,
        Method::DELETE,
        &format!("/v1/bill-account-mappings/{id}?confirm=true"),
        &Value::Null,
    )
    .await?;
    Ok(Json(value))
}

async fn run_imports(
    state: &AppState,
    identity: &VerifiedUser,
    token: &str,
    row_ids: &[i64],
    gate: Gate,
    include_payload: bool,
) -> Value {
    let dry_run = gate.previewing();
    if row_ids.is_empty() {
        let mut response = import_response(Vec::new());
        if dry_run {
            response["dry_run"] = Value::Bool(true);
        }
        return response;
    }
    let mut rows = Vec::with_capacity(row_ids.len());
    for row_id in row_ids {
        rows.push(import_one(state, identity, token, *row_id, dry_run, include_payload).await);
    }
    let mut response = import_response(rows);
    if dry_run {
        response["dry_run"] = Value::Bool(true);
    }
    response
}

async fn import_one(
    state: &AppState,
    identity: &VerifiedUser,
    token: &str,
    row_id: i64,
    dry_run: bool,
    include_payload: bool,
) -> Value {
    let prepared = match server_json(
        state,
        identity,
        Method::POST,
        "/internal/v1/bill-imports/prepare",
        &json!({ "row_id": row_id, "dry_run": dry_run }),
    )
    .await
    {
        Ok((_, value)) => value,
        Err(problem) => return failed_row(row_id, "skip", problem_detail(&problem), None),
    };
    let data = &prepared["data"];
    let preview = data["preview"].clone();
    let payload = data["payload"].clone();
    let attempt_id = data["attempt_id"].as_str().map(str::to_owned);

    for account_id in data["account_ids"].as_array().into_iter().flatten() {
        let Some(account_id) = parse_positive_id(account_id) else {
            return failed_row(
                row_id,
                "failed",
                "账户映射包含无效 ID。".to_owned(),
                attempt_id,
            );
        };
        if let Err(problem) = verified_account(state, token, account_id).await {
            if let Some(attempt_id) = &attempt_id {
                let _ = reject_attempt(
                    state,
                    identity,
                    attempt_id,
                    false,
                    None,
                    "account_validation_failed",
                    &problem_detail(&problem),
                )
                .await;
            }
            return failed_row(row_id, "failed", problem_detail(&problem), attempt_id);
        }
    }

    // Re-check immediately before sending. Review is advisory and Firefly may have
    // received the same transaction since the preview was generated.
    let existing_candidates = match existing_transactions::candidates_for_payload(
        &state.firefly,
        token,
        &payload,
    )
    .await
    {
        Ok(candidates) => candidates,
        Err(problem) => {
            let reason = problem_detail(&problem);
            if dry_run {
                return excluded_row(
                    preview,
                    "existing_transaction_lookup_failed",
                    reason,
                    None,
                    include_payload.then_some(payload),
                );
            }
            if let Some(attempt_id) = &attempt_id {
                let _ = reject_attempt(
                    state,
                    identity,
                    attempt_id,
                    true,
                    None,
                    "existing_transaction_lookup_failed",
                    &reason,
                )
                .await;
            }
            return failed_row_with_reason(
                row_id,
                "retryable",
                reason,
                attempt_id,
                "existing_transaction_lookup_failed",
                None,
            );
        }
    };
    if existing_transactions::has_high_confidence(&existing_candidates) {
        let reason = "Firefly 中已有高置信匹配交易，必须人工确认后再处理。".to_owned();
        if let Some(attempt_id) = &attempt_id {
            let _ = reject_attempt(
                state,
                identity,
                attempt_id,
                false,
                None,
                "existing_firefly_transaction",
                &reason,
            )
            .await;
        }
        let mut result = excluded_row(
            preview,
            "existing_firefly_transaction",
            reason,
            attempt_id,
            include_payload.then_some(payload),
        );
        result["existing_transaction_candidates"] = Value::Array(existing_candidates);
        return result;
    }

    if dry_run {
        let mut result = preview;
        result["status"] = Value::String("pending".to_owned());
        result["action"] = Value::String("would_import".to_owned());
        result["attempt_id"] = Value::Null;
        result["existing_transaction_candidates"] = Value::Array(existing_candidates);
        if include_payload {
            result["payload"] = payload;
        }
        return result;
    }

    let Some(attempt_id) = attempt_id else {
        return failed_row(
            row_id,
            "failed",
            "Server 没有创建导入尝试。".to_owned(),
            None,
        );
    };
    if let Err(problem) = server_json(
        state,
        identity,
        Method::POST,
        &format!("/internal/v1/bill-imports/{attempt_id}/mark-sending"),
        &json!({}),
    )
    .await
    {
        return failed_row(row_id, "failed", problem_detail(&problem), Some(attempt_id));
    }

    match state
        .firefly
        .send_json_raw(token, Method::POST, "/api/v1/transactions", &payload)
        .await
    {
        Ok((status, response)) => {
            let Some(group_id) = parse_positive_id(&response["data"]["id"]) else {
                let message = "Firefly 已接受请求，但响应没有交易组 ID，正在按 external_id 对账。";
                let _ = uncertain_attempt(state, identity, &attempt_id, message).await;
                return failed_row(row_id, "uncertain", message.to_owned(), Some(attempt_id));
            };
            match server_json(
                state,
                identity,
                Method::POST,
                &format!("/internal/v1/bill-imports/{attempt_id}/complete"),
                &json!({ "transaction_group_id": group_id, "reconciled": false }),
            )
            .await
            {
                Ok(_) => {
                    let mut result = preview;
                    result["status"] = Value::String("imported".to_owned());
                    result["action"] = Value::String("imported".to_owned());
                    result["attempt_id"] = Value::String(attempt_id);
                    result["transaction_group_id"] = Value::String(group_id.to_string());
                    result["firefly_status"] = Value::from(status.as_u16());
                    if include_payload {
                        result["payload"] = payload;
                    }
                    result
                }
                Err(problem) => {
                    let message = format!(
                        "Firefly 已返回交易组 {group_id}，但本地完成状态保存失败：{}",
                        problem_detail(&problem)
                    );
                    let _ = uncertain_attempt(state, identity, &attempt_id, &message).await;
                    failed_row(row_id, "uncertain", message, Some(attempt_id))
                }
            }
        }
        Err(FireflyWriteError::Http { status, body }) => {
            let retryable = status.is_server_error();
            let message = firefly_error_message(&body, status.as_u16());
            let _ = reject_attempt(
                state,
                identity,
                &attempt_id,
                retryable,
                Some(i32::from(status.as_u16())),
                if retryable {
                    "firefly_5xx"
                } else {
                    "firefly_rejected"
                },
                &message,
            )
            .await;
            failed_row(
                row_id,
                if retryable { "retryable" } else { "failed" },
                message,
                Some(attempt_id),
            )
        }
        Err(FireflyWriteError::Transport(error)) => {
            let message = format!("Firefly 请求结果不确定：{error}");
            let _ = uncertain_attempt(state, identity, &attempt_id, &message).await;
            failed_row(row_id, "uncertain", message, Some(attempt_id))
        }
        Err(FireflyWriteError::InvalidResponse(error)) => {
            let message = format!("Firefly 响应无法确认：{error}");
            let _ = uncertain_attempt(state, identity, &attempt_id, &message).await;
            failed_row(row_id, "uncertain", message, Some(attempt_id))
        }
    }
}

async fn reject_attempt(
    state: &AppState,
    identity: &VerifiedUser,
    attempt_id: &str,
    retryable: bool,
    firefly_status: Option<i32>,
    error_code: &str,
    error_message: &str,
) -> Result<(), Problem> {
    server_json(
        state,
        identity,
        Method::POST,
        &format!("/internal/v1/bill-imports/{attempt_id}/reject"),
        &json!({
            "retryable": retryable,
            "firefly_status": firefly_status,
            "error_code": error_code,
            "error_message": error_message,
        }),
    )
    .await
    .map(|_| ())
}

async fn uncertain_attempt(
    state: &AppState,
    identity: &VerifiedUser,
    attempt_id: &str,
    error_message: &str,
) -> Result<(), Problem> {
    server_json(
        state,
        identity,
        Method::POST,
        &format!("/internal/v1/bill-imports/{attempt_id}/uncertain"),
        &json!({ "error_message": error_message }),
    )
    .await
    .map(|_| ())
}

async fn document_row_ids(
    state: &AppState,
    identity: &VerifiedUser,
    document_id: i64,
) -> Result<Vec<i64>, Problem> {
    let mut page = 1_u32;
    let mut ids = Vec::new();
    loop {
        let (_, value) = server_json(
            state,
            identity,
            Method::GET,
            &format!("/v1/bill-rows?document_id={document_id}&page={page}&limit=500"),
            &Value::Null,
        )
        .await?;
        ids.extend(
            value["data"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|row| {
                    (row["attributes"]["status"] == "pending")
                        .then(|| parse_positive_id(&row["id"]))
                        .flatten()
                }),
        );
        let total_pages = value["meta"]["pagination"]["total_pages"]
            .as_u64()
            .unwrap_or(page as u64);
        if page as u64 >= total_pages {
            break;
        }
        page = page.saturating_add(1);
        if ids.len() > MAX_IMPORT_SELECTION {
            return Err(Problem::invalid_params(format!(
                "整份账单最多支持 {MAX_IMPORT_SELECTION} 条待处理流水。"
            )));
        }
    }
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

fn parse_row_ids(values: &[ResourceId]) -> Result<Vec<i64>, Problem> {
    let mut ids = values
        .iter()
        .map(ResourceId::parse)
        .collect::<Result<Vec<_>, _>>()?;
    ids.sort_unstable();
    ids.dedup();
    validate_selection_count(ids.len())?;
    Ok(ids)
}

fn validate_selection_count(count: usize) -> Result<(), Problem> {
    if count <= MAX_IMPORT_SELECTION {
        Ok(())
    } else {
        Err(Problem::invalid_params(format!(
            "每次最多选择 {MAX_IMPORT_SELECTION} 条流水，收到 {count} 条。"
        )))
    }
}

#[derive(Debug)]
struct AccountIdentity {
    name: String,
    kind: Option<String>,
}

async fn verified_account(
    state: &AppState,
    token: &str,
    account_id: i64,
) -> Result<AccountIdentity, Problem> {
    let account = state
        .firefly
        .get_json(token, &format!("/api/v1/accounts/{account_id}"), &[])
        .await?;
    let attributes = &account["data"]["attributes"];
    let name = attributes["name"]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            Problem::upstream_error(axum::http::StatusCode::OK, "Firefly 账户响应缺少名称。")
        })?;
    let kind = attributes["type"].as_str().map(str::to_owned);
    if kind.as_deref().is_some_and(|value| {
        let normalized = value.to_ascii_lowercase();
        normalized.contains("expense") || normalized.contains("revenue")
    }) {
        return Err(Problem::invalid_params(
            "账单账户映射必须指向资产、现金或负债账户，不能指向收入/支出科目。",
        ));
    }
    Ok(AccountIdentity {
        name: name.to_owned(),
        kind,
    })
}

async fn server_json(
    state: &AppState,
    identity: &VerifiedUser,
    method: Method,
    path: &str,
    body: &Value,
) -> Result<(axum::http::StatusCode, Value), Problem> {
    super::server::request_json(state, identity, method, path, body).await
}

fn import_response(rows: Vec<Value>) -> Value {
    let imported = rows
        .iter()
        .filter(|row| row["action"] == "imported")
        .count();
    let skipped = rows.iter().filter(|row| row["action"] == "skip").count();
    let uncertain = rows
        .iter()
        .filter(|row| row["action"] == "uncertain")
        .count();
    let failed = rows.iter().filter(|row| row["action"] == "failed").count();
    let retryable = rows
        .iter()
        .filter(|row| row["action"] == "retryable")
        .count();
    let would_import = rows
        .iter()
        .filter(|row| row["action"] == "would_import")
        .count();
    json!({
        "summary": {
            "total": rows.len(),
            "imported": imported,
            "skipped": skipped,
            "failed": failed,
            "retryable": retryable,
            "uncertain": uncertain,
            "would_import": would_import,
        },
        "rows": rows,
        "empty_reason": if rows.is_empty() {
            Some("没有可处理的待处理流水；请查看 bills review 或按 row_ids 预览具体排除原因。")
        } else {
            None
        },
        "balance_chain": [],
    })
}

fn failed_row(row_id: i64, action: &str, error: String, attempt_id: Option<String>) -> Value {
    let reason_code = match action {
        "skip" => "import_excluded",
        "retryable" => "import_retryable",
        "uncertain" => "import_uncertain",
        _ => "import_failed",
    };
    let exclusion_reason = (action == "skip").then(|| error.clone());
    failed_row_with_reason(
        row_id,
        action,
        error,
        attempt_id,
        reason_code,
        exclusion_reason,
    )
}

fn failed_row_with_reason(
    row_id: i64,
    action: &str,
    error: String,
    attempt_id: Option<String>,
    reason_code: &str,
    exclusion_reason: Option<String>,
) -> Value {
    json!({
        "row_id": row_id.to_string(),
        "status": action,
        "action": action,
        "attempt_id": attempt_id,
        "error": error,
        "reason_code": reason_code,
        "exclusion_reason": exclusion_reason,
    })
}

fn excluded_row(
    mut preview: Value,
    reason_code: &str,
    reason: String,
    attempt_id: Option<String>,
    payload: Option<Value>,
) -> Value {
    preview["status"] = Value::String("attention".to_owned());
    preview["action"] = Value::String("skip".to_owned());
    preview["attempt_id"] = attempt_id.map(Value::String).unwrap_or(Value::Null);
    preview["reason_code"] = Value::String(reason_code.to_owned());
    preview["exclusion_reason"] = Value::String(reason.clone());
    preview["error"] = Value::String(reason);
    if let Some(payload) = payload {
        preview["payload"] = payload;
    }
    preview
}

fn parse_positive_id(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str()?.parse::<i64>().ok())
        .filter(|value| *value > 0)
}

fn validate_attempt_id(value: &str) -> Result<(), Problem> {
    if value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        Ok(())
    } else {
        Err(Problem::invalid_params("导入尝试 id 不对。"))
    }
}

fn firefly_error_message(body: &Value, status: u16) -> String {
    body.get("message")
        .and_then(Value::as_str)
        .or_else(|| body.get("detail").and_then(Value::as_str))
        .map(|value| value.chars().take(2_000).collect())
        .unwrap_or_else(|| format!("Firefly 返回 HTTP {status}。"))
}

fn problem_detail(problem: &Problem) -> String {
    problem
        .detail
        .clone()
        .unwrap_or_else(|| problem.title.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_summary_keeps_uncertain_separate_from_failed() {
        let value = import_response(vec![
            failed_row(1, "uncertain", "timeout".to_owned(), Some("a".repeat(36))),
            failed_row(2, "failed", "422".to_owned(), None),
            failed_row(4, "retryable", "503".to_owned(), Some("b".repeat(36))),
            json!({ "row_id": "3", "action": "imported" }),
        ]);
        assert_eq!(value["summary"]["imported"], 1);
        assert_eq!(value["summary"]["failed"], 1);
        assert_eq!(value["summary"]["uncertain"], 1);
        assert_eq!(value["summary"]["retryable"], 1);
    }

    #[test]
    fn duplicate_row_ids_are_sent_once() {
        let ids = parse_row_ids(&[
            ResourceId::Number(2),
            ResourceId::String("2".to_owned()),
            ResourceId::Number(1),
        ])
        .unwrap();
        assert_eq!(ids, vec![1, 2]);
    }
}
