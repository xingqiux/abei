//! 账单任务。过渡期委托 fork 里的 `/api/v1/bill-tasks`，剥离到阿贝自己时只换这一层。
//!
//! 写闸门在这里统一执行：CLI、web、agent 三条路都打到这几个函数，绕不过去。

use abei_core::{BillsBatchParams, BillsImportParams, BillsListParams, BillsUnlockParams, Risk};
use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::{Value, json};

use crate::auth::{AuthIdentity, AuthToken};
use crate::extract::{Gate, ValidJson, ValidQuery, check_id, check_limit, check_page, optional};
use crate::problem::Problem;
use crate::state::AppState;

const TASKS: &str = "/api/v1/bill-tasks";
const INBOX: &str = "/api/v1/bill-inbox";

pub async fn list(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    ValidQuery(params): ValidQuery<BillsListParams>,
) -> Result<Json<Value>, Problem> {
    check_page(params.page)?;
    check_limit(params.limit)?;

    let query = [
        ("source", params.source.unwrap_or_default()),
        ("status", params.status.unwrap_or_default()),
        ("page", optional(params.page)),
        ("limit", optional(params.limit)),
    ];

    state
        .firefly
        .get_json(&token, TASKS, &query)
        .await
        .map(Json)
        .map_err(|problem| problem.at("bills", "list"))
}

pub async fn show(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
) -> Result<Json<Value>, Problem> {
    let id = check_id(&id).map_err(|problem| problem.at("bills", "show"))?;

    state
        .firefly
        .get_json(&token, &format!("{TASKS}/{id}"), &[])
        .await
        .map(Json)
        .map_err(|problem| problem.at("bills", "show"))
}

/// 审阅视图。服务端已经分好桶、脱过敏，是改流水之前的主入口。
pub async fn review(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
) -> Result<Json<Value>, Problem> {
    let id = check_id(&id).map_err(|problem| problem.at("bills", "review"))?;

    state
        .firefly
        .get_json(&token, &format!("{TASKS}/{id}/review"), &[])
        .await
        .map(Json)
        .map_err(|problem| problem.at("bills", "review"))
}

/// 导入。
///
/// 上游那个 `confirm` 布尔本来就是「干跑还是真写」的开关，所以闸门直接落在它上面：
/// dry_run 时发 confirm:false 拿预览，确认后才发 confirm:true。
pub async fn import(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
    gate: Gate,
    ValidJson(params): ValidJson<BillsImportParams>,
) -> Result<Json<Value>, Problem> {
    let at = |problem: Problem| problem.at("bills", "import");
    let id = check_id(&id).map_err(at)?;
    gate.check(Risk::Confirm, "bills.import").map_err(at)?;

    let all = params.all.unwrap_or(false);
    let rows = params.row_ids.unwrap_or_default();
    // 两个都给、两个都不给，都说不清要导入什么。
    let picking_rows = !rows.is_empty();
    if all == picking_rows {
        return Err(at(Problem::invalid_params(
            "要么 all=true 导入整份，要么给 row_ids 挑几行，二选一。",
        )));
    }

    let mut body = json!({ "confirm": !gate.previewing() });
    if all {
        body["all"] = Value::Bool(true);
    } else {
        body["row_ids"] = json!(rows);
    }
    if params.include_payload.unwrap_or(false) {
        body["include_payload"] = Value::Bool(true);
    }

    state
        .firefly
        .send_json(&token, Method::POST, &format!("{TASKS}/{id}/import"), &body)
        .await
        .map(|value| Json(mark_preview(value, gate)))
        .map_err(at)
}

/// 提交账单密码。密码只经手不落日志，也不回显在错误里。
pub async fn unlock(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
    gate: Gate,
    ValidJson(params): ValidJson<BillsUnlockParams>,
) -> Result<Json<Value>, Problem> {
    let at = |problem: Problem| problem.at("bills", "unlock");
    let id = check_id(&id).map_err(at)?;
    gate.check(Risk::Confirm, "bills.unlock").map_err(at)?;

    if params.secret.is_empty() {
        return Err(at(Problem::invalid_params("密码不能是空的。")));
    }

    // 干跑只回「这条命令长什么样」，不把密码递给上游。
    if gate.previewing() {
        return Ok(Json(json!({
            "dry_run": true,
            "would": { "capability": "bills.unlock", "bill_task_id": id },
            "message": "会把密码提交给这份账单，然后重新解析。确认后再执行一次。",
        })));
    }

    state
        .firefly
        .send_json(
            &token,
            Method::POST,
            &format!("{TASKS}/{id}/secret"),
            &json!({ "value": params.secret }),
        )
        .await
        .map(Json)
        .map_err(at)
}

pub async fn ignore(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
    gate: Gate,
) -> Result<Json<Value>, Problem> {
    act(state, token, &id, gate, Risk::Confirm, "ignore").await
}

pub async fn retry(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
    gate: Gate,
) -> Result<Json<Value>, Problem> {
    act(state, token, &id, gate, Risk::Draft, "retry").await
}

/// ignore / retry 形状一样：认一个 id，没有请求体。
async fn act(
    state: AppState,
    token: String,
    raw_id: &str,
    gate: Gate,
    risk: Risk,
    verb: &'static str,
) -> Result<Json<Value>, Problem> {
    let at = |problem: Problem| problem.at("bills", verb);
    let id = check_id(raw_id).map_err(at)?;
    gate.check(risk, &format!("bills.{verb}")).map_err(at)?;

    if gate.previewing() {
        return Ok(Json(json!({
            "dry_run": true,
            "would": { "capability": format!("bills.{verb}"), "bill_task_id": id },
        })));
    }

    state
        .firefly
        .send_json(
            &token,
            Method::POST,
            &format!("{TASKS}/{id}/{verb}"),
            &json!({}),
        )
        .await
        .map(Json)
        .map_err(at)
}

pub async fn sync(
    State(state): State<AppState>,
    Extension(AuthIdentity(identity)): Extension<AuthIdentity>,
    gate: Gate,
    ValidJson(params): ValidJson<BillsBatchParams>,
) -> Result<Response, Problem> {
    let at = |problem: Problem| problem.at("bills", "sync");
    gate.check(Risk::Draft, "bills.sync").map_err(at)?;
    check_limit(params.limit).map_err(at)?;

    if gate.previewing() {
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dry_run": true,
                "would": { "capability": "bills.sync", "limit": params.limit },
            })),
        )
            .into_response());
    }

    let body = match params.limit {
        Some(limit) => json!({ "limit": limit }),
        None => json!({}),
    };
    crate::routes::server::send_json(&state, &identity, Method::POST, "/v1/bills/sync", &body)
        .await
        .map_err(at)
}

pub async fn process(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    gate: Gate,
    ValidJson(params): ValidJson<BillsBatchParams>,
) -> Result<(StatusCode, Json<Value>), Problem> {
    let at = |problem: Problem| problem.at("bills", "process");
    gate.check(Risk::Draft, "bills.process").map_err(at)?;
    check_limit(params.limit).map_err(at)?;

    if gate.previewing() {
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dry_run": true,
                "would": { "capability": "bills.process", "limit": params.limit },
            })),
        ));
    }

    let body = match params.limit {
        Some(limit) => json!({ "limit": limit }),
        None => json!({}),
    };

    state
        .firefly
        .send_json_with_status(&token, Method::POST, &format!("{INBOX}/process"), &body)
        .await
        .map(|(status, value)| (status, Json(value)))
        .map_err(at)
}

/// 干跑的响应打上记号，免得调用方把预览当成已执行。
fn mark_preview(mut value: Value, gate: Gate) -> Value {
    if !gate.previewing() {
        return value;
    }
    match value.as_object_mut() {
        Some(object) => {
            object.insert("dry_run".to_owned(), Value::Bool(true));
            value
        }
        None => json!({ "dry_run": true, "data": value }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_is_marked_on_object_responses() {
        let marked = mark_preview(
            json!({ "rows": [] }),
            Gate {
                dry_run: true,
                confirm: false,
            },
        );
        assert_eq!(marked["dry_run"], json!(true));
        assert!(marked["rows"].is_array());
    }

    #[test]
    fn real_runs_are_untouched() {
        let value = mark_preview(
            json!({ "rows": [] }),
            Gate {
                dry_run: false,
                confirm: true,
            },
        );
        assert!(value.get("dry_run").is_none());
    }

    /// confirm 档没确认就该退 409，且是 ConfirmationRequired。
    #[test]
    fn confirm_capabilities_need_confirmation() {
        let bare = Gate::default();
        let problem = bare.check(Risk::Confirm, "bills.import").unwrap_err();
        assert_eq!(problem.reason, "ConfirmationRequired");
        assert_eq!(problem.status, axum::http::StatusCode::CONFLICT);

        // 预览和确认都能过闸。
        assert!(
            Gate {
                dry_run: true,
                confirm: false
            }
            .check(Risk::Confirm, "bills.import")
            .is_ok()
        );
        assert!(
            Gate {
                dry_run: false,
                confirm: true
            }
            .check(Risk::Confirm, "bills.import")
            .is_ok()
        );
    }

    /// draft 档不需要确认参数，服务端直接放行（CLI 那边仍要 --yes）。
    #[test]
    fn draft_capabilities_pass_without_confirmation() {
        assert!(Gate::default().check(Risk::Draft, "rows.update").is_ok());
        assert!(Gate::default().check(Risk::Read, "bills.list").is_ok());
    }
}
