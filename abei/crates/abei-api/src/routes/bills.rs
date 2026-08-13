//! 账单文档公共能力。参数校验与风险闸门留在 API，数据由 abei-server 持有。

use abei_core::{BillsBatchParams, BillsListParams, BillsUnlockParams, Risk};
use axum::extract::{Path, State};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde_json::{Value, json};

use crate::auth::{AuthIdentity, AuthToken};
use crate::extract::{Gate, ValidJson, ValidQuery, check_id, check_limit, check_page};
use crate::problem::Problem;
use crate::state::AppState;

pub async fn list(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    ValidQuery(params): ValidQuery<BillsListParams>,
) -> Result<Json<Value>, Problem> {
    check_page(params.page)?;
    check_limit(params.limit)?;
    let mut url = reqwest::Url::parse("http://abei.local/v1/bills")
        .map_err(|error| Problem::internal(error.to_string()))?;
    {
        let mut query = url.query_pairs_mut();
        if let Some(source) = params.source {
            query.append_pair("source", &source);
        }
        if let Some(status) = params.status {
            query.append_pair("status", &status);
        }
        if let Some(page) = params.page {
            query.append_pair("page", &page.to_string());
        }
        if let Some(limit) = params.limit {
            query.append_pair("limit", &limit.to_string());
        }
    }
    let path = match url.query() {
        Some(query) => format!("{}?{query}", url.path()),
        None => url.path().to_owned(),
    };
    crate::routes::server::request_json(&state, &identity.0, Method::GET, &path, &Value::Null)
        .await
        .map(|(_, value)| Json(value))
        .map_err(|problem| problem.at("bills", "list"))
}

pub async fn show(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    Path(id): Path<String>,
) -> Result<Json<Value>, Problem> {
    get_document(&state, &identity, &id, "", "show").await
}

pub async fn review(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
) -> Result<Json<Value>, Problem> {
    let at = |problem: Problem| problem.at("bills", "review");
    let id = check_id(&id).map_err(at)?;
    let (_, mut value) = crate::routes::server::request_json(
        &state,
        &identity.0,
        Method::GET,
        &format!("/v1/bills/{id}/review"),
        &Value::Null,
    )
    .await
    .map_err(at)?;
    crate::existing_transactions::enrich_review(&state.firefly, &token, &mut value)
        .await
        .map_err(at)?;
    Ok(Json(value))
}

async fn get_document(
    state: &AppState,
    identity: &AuthIdentity,
    raw_id: &str,
    suffix: &str,
    verb: &'static str,
) -> Result<Json<Value>, Problem> {
    let at = |problem: Problem| problem.at("bills", verb);
    let id = check_id(raw_id).map_err(at)?;
    crate::routes::server::request_json(
        state,
        &identity.0,
        Method::GET,
        &format!("/v1/bills/{id}{suffix}"),
        &Value::Null,
    )
    .await
    .map(|(_, value)| Json(value))
    .map_err(at)
}

/// 提交账单密码。干跑不会把密码传给 Server。
pub async fn unlock(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
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
    if gate.previewing() {
        return Ok(Json(json!({
            "dry_run": true,
            "would": { "capability": "bills.unlock", "bill_task_id": id },
            "message": "会把密码提交给这份账单，然后重新解析。确认后再执行一次。",
        })));
    }
    crate::routes::server::request_json(
        &state,
        &identity.0,
        Method::POST,
        &format!("/v1/bills/{id}/unlock"),
        &json!({ "secret": params.secret }),
    )
    .await
    .map(|(_, value)| Json(value))
    .map_err(at)
}

pub async fn ignore(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    Path(id): Path<String>,
    gate: Gate,
) -> Result<Json<Value>, Problem> {
    act(state, identity, &id, gate, Risk::Confirm, "ignore").await
}

pub async fn retry(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    Path(id): Path<String>,
    gate: Gate,
) -> Result<Json<Value>, Problem> {
    act(state, identity, &id, gate, Risk::Draft, "retry").await
}

async fn act(
    state: AppState,
    identity: AuthIdentity,
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
    crate::routes::server::request_json(
        &state,
        &identity.0,
        Method::POST,
        &format!("/v1/bills/{id}/{verb}"),
        &json!({}),
    )
    .await
    .map(|(_, value)| Json(value))
    .map_err(at)
}

pub async fn sync(
    State(state): State<AppState>,
    Extension(identity): Extension<AuthIdentity>,
    gate: Gate,
    ValidJson(params): ValidJson<BillsBatchParams>,
) -> Result<Response, Problem> {
    let at = |problem: Problem| problem.at("bills", "sync");
    gate.check(Risk::Draft, "bills.sync").map_err(at)?;
    check_limit(params.limit).map_err(at)?;
    if let Some(timeout) = params.timeout_seconds
        && !(1..=600).contains(&timeout)
    {
        return Err(at(Problem::invalid_params(format!(
            "timeout_seconds 只能是 1 到 600，收到的是 {timeout}。"
        ))));
    }
    if gate.previewing() {
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dry_run": true,
                "would": { "capability": "bills.sync", "limit": params.limit,
                            "wait": params.wait, "timeout_seconds": params.timeout_seconds },
            })),
        )
            .into_response());
    }
    let body = params
        .limit
        .map_or_else(|| json!({}), |limit| json!({ "limit": limit }));
    let response = crate::routes::server::request_json(
        &state,
        &identity.0,
        Method::POST,
        "/v1/bills/sync",
        &body,
    )
    .await
    .map_err(at)?;
    if !params.wait.unwrap_or(false) {
        return Ok((response.0, Json(response.1)).into_response());
    }
    let timeout_seconds = params.timeout_seconds.unwrap_or(120);
    let initial = response.1;
    let run_id = initial
        .pointer("/data/attributes/run_id")
        .and_then(Value::as_str)
        .or_else(|| initial.pointer("/data/id").and_then(Value::as_str))
        .map(str::to_owned)
        .ok_or_else(|| at(Problem::internal("同步服务没有返回 run_id，无法等待。")))?;
    let deadline =
        tokio::time::Instant::now() + std::time::Duration::from_secs(u64::from(timeout_seconds));
    loop {
        let (_, latest) = crate::routes::server::request_json(
            &state,
            &identity.0,
            Method::GET,
            &format!("/v1/mail-sync-runs/{run_id}"),
            &Value::Null,
        )
        .await
        .map_err(at)?;
        let status = latest
            .pointer("/data/attributes/status")
            .and_then(Value::as_str)
            .or_else(|| latest.pointer("/data/status").and_then(Value::as_str))
            .unwrap_or("queued");
        if matches!(status, "succeeded" | "failed" | "cancelled") {
            if status != "succeeded" {
                return Err(at(Problem::new(
                    StatusCode::BAD_GATEWAY,
                    "SyncFailed",
                    "账单同步失败",
                )
                .detail("同步运行已结束但没有成功。")
                .upstream(latest)));
            }
            return Ok((StatusCode::OK, Json(latest)).into_response());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(at(Problem::new(
                StatusCode::GATEWAY_TIMEOUT,
                "SyncTimeout",
                "等待账单同步超时",
            )
            .detail(format!("已等待 {timeout_seconds} 秒；同步仍在后台运行。"))
            .upstream(latest)));
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
}
