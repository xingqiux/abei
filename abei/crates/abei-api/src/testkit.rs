//! 测试用的假 Firefly 和进程内起服务。
//!
//! 放在库里而不是 tests/ 下，是为了让 abei-cli 的端到端测试能复用同一套假上游——
//! 两边测的是同一个 router，CLI 那边就不用再猜 API 的行为。
//!
//! 只在 `testkit` feature 下编译，正式二进制里没有这些东西。

use std::collections::HashMap;
use std::net::SocketAddr;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, delete, get, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use tokio::net::TcpListener;

use crate::config::Config;
use crate::state::AppState;

/// 假 Firefly 只认这一个令牌，别的都当作 401。
pub const GOOD_TOKEN: &str = "good-token";

/// 随便挑个端口起服务，返回实际地址。
pub async fn spawn(app: Router) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    address
}

/// 起一套完整的假上游 + 真 abei-api，返回 API 的 base url。
pub async fn start_api() -> String {
    start_api_recording(Recorder::default()).await
}

/// 同上，但假上游收到的写请求都记进 recorder，方便断言「到底发了什么给上游」。
pub async fn start_api_recording(recorder: Recorder) -> String {
    let firefly = spawn(mock_firefly_recording(recorder)).await;
    let server = spawn(mock_server()).await;
    let config = Config {
        firefly_url: format!("http://{firefly}"),
        server_url: format!("http://{server}"),
        ..Config::default()
    };
    let state = AppState::new(&config).unwrap();
    let api = spawn(crate::build_app(state)).await;
    format!("http://{api}")
}

/// CLI e2e 用的假 abei-server，保留本进程内创建的反馈。
pub fn mock_server() -> Router {
    type Feedback = std::sync::Arc<std::sync::Mutex<Vec<Value>>>;
    let feedback: Feedback = Default::default();
    Router::new()
        .route(
            "/v1/feedback",
            post(
                |State(feedback): State<Feedback>,
                 Query(gate): Query<HashMap<String, String>>,
                 Json(mut body): Json<Value>| async move {
                    if gate.get("dry_run").is_some_and(|value| value == "true") {
                        body["status"] = json!("open");
                        return Json(json!({ "dry_run": true, "data": body })).into_response();
                    }
                    if gate.get("confirm").is_none_or(|value| value != "true") {
                        return (
                            StatusCode::CONFLICT,
                            Json(json!({
                                "reason": "ConfirmationRequired",
                                "title": "这一步要人确认",
                                "status": 409
                            })),
                        )
                            .into_response();
                    }
                    let mut rows = feedback.lock().unwrap();
                    body["id"] = Value::from(rows.len() + 1);
                    body["status"] = json!("open");
                    body["response"] = Value::Null;
                    body["responded_by"] = Value::Null;
                    body["responded_at"] = Value::Null;
                    body["duplicate_of"] = Value::Null;
                    body["sync_status"] = json!("local");
                    body["github_issue_url"] = Value::Null;
                    body["github_issue_number"] = Value::Null;
                    body["sync_error"] = Value::Null;
                    body["created_at"] = json!("2026-08-09 00:00:00+00");
                    body["updated_at"] = json!("2026-08-09 00:00:00+00");
                    rows.push(body.clone());
                    (StatusCode::CREATED, Json(json!({ "data": body }))).into_response()
                },
            )
            .get(|State(feedback): State<Feedback>| async move {
                let rows = feedback.lock().unwrap().clone();
                Json(json!({ "data": rows }))
            }),
        )
        .route(
            "/v1/feedback/{id}",
            get(
                |State(feedback): State<Feedback>, Path(id): Path<usize>| async move {
                    feedback
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|row| row["id"] == id)
                        .cloned()
                        .map(|row| Json(json!({ "data": row })).into_response())
                        .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
                },
            )
            .patch(
                |State(feedback): State<Feedback>,
                 Path(id): Path<usize>,
                 Query(gate): Query<HashMap<String, String>>,
                 Json(body): Json<Value>| async move {
                    if gate.get("dry_run").is_some_and(|value| value == "true") {
                        return Json(json!({ "dry_run": true, "data": {
                                "id": id, "to_status": body["status"]
                            } }))
                        .into_response();
                    }
                    if gate.get("confirm").is_none_or(|value| value != "true") {
                        return (
                            StatusCode::CONFLICT,
                            Json(json!({
                                "reason": "ConfirmationRequired", "title": "这一步要人确认",
                                "status": 409
                            })),
                        )
                            .into_response();
                    }
                    let mut rows = feedback.lock().unwrap();
                    let Some(row) = rows.iter_mut().find(|row| row["id"] == id) else {
                        return StatusCode::NOT_FOUND.into_response();
                    };
                    row["status"] = body["status"].clone();
                    row["response"] = body.get("response").cloned().unwrap_or(Value::Null);
                    row["duplicate_of"] = body.get("duplicate_of").cloned().unwrap_or(Value::Null);
                    Json(json!({ "data": row.clone() })).into_response()
                },
            )
            .delete(
                |State(feedback): State<Feedback>,
                 Path(id): Path<usize>,
                 Query(gate): Query<HashMap<String, String>>,
                 Json(body): Json<Value>| async move {
                    if gate.get("dry_run").is_some_and(|value| value == "true") {
                        return Json(json!({ "dry_run": true, "data": {
                                "id": id, "reason": body["reason"]
                            } }))
                        .into_response();
                    }
                    if gate.get("confirm").is_none_or(|value| value != "true") {
                        return (
                            StatusCode::CONFLICT,
                            Json(json!({
                                "reason": "ConfirmationRequired", "title": "这一步要人确认",
                                "status": 409
                            })),
                        )
                            .into_response();
                    }
                    let mut rows = feedback.lock().unwrap();
                    let before = rows.len();
                    rows.retain(|row| row["id"] != id);
                    if rows.len() == before {
                        return StatusCode::NOT_FOUND.into_response();
                    }
                    Json(json!({ "data": { "id": id, "deleted": true } })).into_response()
                },
            ),
        )
        .route(
            "/v1/feedback/{id}/retry",
            post(
                |State(feedback): State<Feedback>,
                 Path(id): Path<usize>,
                 Query(gate): Query<HashMap<String, String>>| async move {
                    if gate.get("dry_run").is_some_and(|value| value == "true") {
                        return Json(json!({ "dry_run": true, "data": { "id": id } }))
                            .into_response();
                    }
                    if gate.get("confirm").is_none_or(|value| value != "true") {
                        return (
                            StatusCode::CONFLICT,
                            Json(json!({
                                "reason": "ConfirmationRequired", "title": "这一步要人确认",
                                "status": 409
                            })),
                        )
                            .into_response();
                    }
                    feedback
                        .lock()
                        .unwrap()
                        .iter()
                        .find(|row| row["id"] == id)
                        .cloned()
                        .map(|row| Json(json!({ "data": row })).into_response())
                        .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
                },
            ),
        )
        .route(
            "/v1/bills/mailbox",
            get(|headers: HeaderMap| async move {
                Json(
                    json!({ "data": { "type": "bill-inbox-settings", "attributes": {
                    "enabled": false,
                    "provider": "gmail",
                    "auth_method": "google_oauth",
                    "email": "a@b.c",
                    "host": "imap.gmail.com",
                    "port": 993,
                    "encryption": "ssl",
                    "username": "a@b.c",
                    "folder": "INBOX",
                    "has_password": false,
                    "google_connected": false,
                    "google_oauth_available": true,
                    "built_in_channels": [],
                    "authenticated_user_id": headers
                        .get("x-abei-authenticated-user-id")
                        .and_then(|value| value.to_str().ok())
                } } }),
                )
            })
            .put(|headers: HeaderMap, Json(body): Json<Value>| async move {
                Json(
                    json!({ "data": { "type": "bill-inbox-settings", "attributes": {
                    "enabled": body.get("enabled").cloned().unwrap_or(Value::Bool(false)),
                    "provider": "gmail",
                    "auth_method": "google_oauth",
                    "email": body.get("email").cloned().unwrap_or(json!("a@b.c")),
                    "host": "imap.gmail.com",
                    "port": 993,
                    "encryption": "ssl",
                    "username": "a@b.c",
                    "folder": "INBOX",
                    "has_password": body.get("password").is_some(),
                    "google_connected": false,
                    "google_oauth_available": true,
                    "built_in_channels": [],
                    "authenticated_user_id": headers
                        .get("x-abei-authenticated-user-id")
                        .and_then(|value| value.to_str().ok())
                } } }),
                )
            }),
        )
        .route(
            "/v1/bills/mailbox/google/connect",
            post(|headers: HeaderMap| async move {
                Json(json!({ "data": { "type": "google-oauth", "attributes": {
                    "authorization_url": "https://accounts.google.test/authorize",
                    "authenticated_user_id": headers
                        .get("x-abei-authenticated-user-id")
                        .and_then(|value| value.to_str().ok())
                } } }))
            }),
        )
        .route(
            "/v1/bills/mailbox/google/callback",
            post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                Json(json!({ "data": { "attributes": {
                    "code": body["code"],
                    "state": body["state"],
                    "authenticated_user_id": headers
                        .get("x-abei-authenticated-user-id")
                        .and_then(|value| value.to_str().ok())
                } } }))
            }),
        )
        .route(
            "/v1/bills/mailbox/google",
            delete(|headers: HeaderMap| async move {
                Json(json!({ "data": { "attributes": {
                    "authenticated_user_id": headers
                        .get("x-abei-authenticated-user-id")
                        .and_then(|value| value.to_str().ok())
                } } }))
            }),
        )
        .route(
            "/v1/bills/sync",
            post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                (
                    StatusCode::ACCEPTED,
                    Json(
                        json!({ "data": { "type": "bill-inbox-sync-state", "attributes": {
                        "status": "queued",
                        "limit": body.get("limit").cloned().unwrap_or(json!(25)),
                        "authenticated_user_id": headers
                            .get("x-abei-authenticated-user-id")
                            .and_then(|value| value.to_str().ok())
                    } } }),
                    ),
                )
            }),
        )
        .with_state(feedback)
}

fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(|value| value == format!("Bearer {GOOD_TOKEN}"))
        .unwrap_or(false)
}

fn guard(headers: &HeaderMap) -> Option<Response> {
    (!authorized(headers)).then(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "message": "Unauthenticated." })),
        )
            .into_response()
    })
}

/// 两条交易：一条真消费，一条账户转账（用来验排除分类）。
pub fn transactions_payload() -> Value {
    json!({
        "data": [
            { "attributes": { "transactions": [
                { "type": "withdrawal", "date": "2026-08-01T12:00:00+08:00", "amount": "45.00",
                  "category_name": "餐饮", "source_name": "招行卡", "destination_name": "楼下面馆" },
                { "type": "withdrawal", "date": "2026-08-02T12:00:00+08:00", "amount": "3000.00",
                  "category_name": "账户转账", "source_name": "招行卡", "destination_name": "支付宝" }
            ]}}
        ],
        "meta": { "pagination": { "total_pages": 1, "count": 2 } }
    })
}

/// 搜索结果。把搜索词回显进摘要，测试据此确认词真的传到了上游而不是被吞掉。
pub fn search_payload(query: &str) -> Value {
    json!({
        "data": [
            { "id": "9", "attributes": { "transactions": [
                { "type": "withdrawal", "date": "2026-07-20T12:00:00+08:00", "amount": "38.00",
                  "category_name": "餐饮", "source_name": "招行卡", "destination_name": query,
                  "description": format!("在{query}消费") }
            ]}}
        ],
        "meta": { "pagination": { "total_pages": 1, "count": 1 } }
    })
}

/// 两份账单任务：一份等着人处理，一份等密码。
pub fn bill_tasks_payload() -> Value {
    json!({
        "data": [
            { "id": "42", "attributes": { "source": "alipay", "status": "pending",
              "subject": "支付宝对账单 2026-07", "received_at": "2026-08-01T09:00:00+08:00",
              "row_counts": { "pending": 3, "imported": 0 } } },
            { "id": "43", "attributes": { "source": "cmb", "status": "needs_secret",
              "subject": "招商银行交易流水", "received_at": "2026-08-02T09:00:00+08:00",
              "row_counts": { "pending": 0, "imported": 0 } } }
        ],
        "meta": { "pagination": { "total_pages": 1, "count": 2 } }
    })
}

/// 审阅视图：服务端分好桶的样子。
pub fn bill_review_payload() -> Value {
    json!({
        "data": {
            "bill_task_id": 42,
            "buckets": {
                "ready": [
                    { "id": 7, "occurred_at": "2026-07-15", "amount": "45.00",
                      "counterparty": "楼下面馆", "description": "午饭",
                      "firefly_type": "withdrawal", "category_name": "餐饮",
                      "duplicate_state": "unique", "suggested_by": null }
                ],
                "needs_attention": [
                    { "id": 8, "occurred_at": "2026-07-16", "amount": "128.50",
                      "counterparty": "山姆会员店", "description": "组合支付",
                      "firefly_type": null, "category_name": null,
                      "duplicate_state": "unique", "suggested_by": null }
                ],
                "duplicates": []
            }
        }
    })
}

/// 记下假上游收到的写请求，测试拿它断言「到底发出去了什么」。
pub type Recorder = std::sync::Arc<std::sync::Mutex<Vec<(String, Value)>>>;

/// 假的 Firefly。
pub fn mock_firefly() -> Router {
    mock_firefly_recording(Recorder::default())
}

/// 带记录的假 Firefly。
pub fn mock_firefly_recording(recorder: Recorder) -> Router {
    let tasks = recorder.clone();
    let rows = recorder.clone();

    Router::new()
        .route(
            "/api/v1/bill-tasks",
            get(|headers: HeaderMap| async move {
                match guard(&headers) {
                    Some(response) => response,
                    None => Json(bill_tasks_payload()).into_response(),
                }
            }),
        )
        .route(
            "/api/v1/bill-tasks/{id}",
            get(|headers: HeaderMap, Path(id): Path<String>| async move {
                match guard(&headers) {
                    Some(response) => response,
                    None => Json(json!({ "data": { "id": id, "attributes": {
                        "source": "alipay", "status": "pending" } } }))
                    .into_response(),
                }
            }),
        )
        .route(
            "/api/v1/bill-tasks/{id}/review",
            get(|headers: HeaderMap| async move {
                match guard(&headers) {
                    Some(response) => response,
                    None => Json(bill_review_payload()).into_response(),
                }
            }),
        )
        // 导入、密码、忽略、重跑：形状一样，统一记下来再回一个假结果。
        .route(
            "/api/v1/bill-tasks/{id}/{action}",
            axum::routing::post(
                |headers: HeaderMap,
                 Path((id, action)): Path<(String, String)>,
                 Json(body): Json<Value>| async move {
                    if let Some(response) = guard(&headers) {
                        return response;
                    }
                    tasks
                        .lock()
                        .unwrap()
                        .push((format!("POST /bill-tasks/{id}/{action}"), body.clone()));

                    if action == "import" {
                        let confirmed = body.get("confirm") == Some(&Value::Bool(true));
                        return Json(json!({
                            "data": { "bill_task_id": id, "confirmed": confirmed,
                                      "created": if confirmed { 2 } else { 0 },
                                      "would_create": 2 }
                        }))
                        .into_response();
                    }
                    Json(json!({ "data": { "id": id, "attributes": { "status": "pending" } } }))
                        .into_response()
                },
            ),
        )
        .route(
            "/api/v1/bill-inbox/{action}",
            axum::routing::post(
                |headers: HeaderMap, Path(action): Path<String>, Json(body): Json<Value>| async move {
                    match guard(&headers) {
                        Some(response) => response,
                        None if action == "sync" => (
                            StatusCode::ACCEPTED,
                            Json(json!({ "data": {
                                "type": "bill-inbox-sync-state",
                                "attributes": {
                                    "status": "queued",
                                    "requested_at": "2026-08-10T01:02:03+00:00",
                                    "started_at": null,
                                    "finished_at": null,
                                    "result": null,
                                    "error_message": null
                                }
                            } })),
                        )
                            .into_response(),
                        None => Json(json!({ "data": { "action": action, "handled": 1,
                                                       "limit": body.get("limit") } }))
                            .into_response(),
                    }
                },
            ),
        )
        .route(
            "/api/v1/bill-statement-rows/{id}",
            axum::routing::patch(
                |headers: HeaderMap, Path(id): Path<String>, Json(body): Json<Value>| async move {
                    if let Some(response) = guard(&headers) {
                        return response;
                    }
                    rows.lock()
                        .unwrap()
                        .push((format!("PATCH /bill-statement-rows/{id}"), body.clone()));
                    let suggested = body.get("as_suggestion") == Some(&Value::Bool(true));
                    let by = if suggested { json!("ai") } else { Value::Null };
                    Json(json!({ "data": { "id": id, "suggested_by": by } })).into_response()
                },
            ),
        )
        .route(
            "/api/v1/bill-statement-rows/{id}/split",
            axum::routing::post(
                |headers: HeaderMap, Path(id): Path<String>, Json(body): Json<Value>| async move {
                    if let Some(response) = guard(&headers) {
                        return response;
                    }
                    recorder
                        .lock()
                        .unwrap()
                        .push((format!("POST /bill-statement-rows/{id}/split"), body.clone()));
                    Json(json!({ "data": { "id": id, "split_into":
                        body.get("splits").and_then(Value::as_array).map(Vec::len).unwrap_or(0) } }))
                    .into_response()
                },
            ),
        )
        .route(
            "/api/v1/about/user",
            get(|headers: HeaderMap| async move {
                match guard(&headers) {
                    Some(response) => response,
                    None => Json(json!({ "data": { "id": "1", "attributes": {
                        "email": "a@b.c", "role": "owner"
                    } } }))
                    .into_response(),
                }
            }),
        )
        .route(
            "/api/v1/about",
            any(|headers: HeaderMap| async move {
                match guard(&headers) {
                    Some(response) => response,
                    None => Json(json!({ "data": { "version": "6.0.0" } })).into_response(),
                }
            }),
        )
        .route(
            "/api/v1/transactions",
            get(|headers: HeaderMap| async move {
                match guard(&headers) {
                    Some(response) => response,
                    None => Json(transactions_payload()).into_response(),
                }
            }),
        )
        .route(
            "/api/v1/search/transactions",
            get(
                |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| async move {
                    match guard(&headers) {
                        Some(response) => response,
                        None => Json(search_payload(
                            query.get("query").map(String::as_str).unwrap_or_default(),
                        ))
                        .into_response(),
                    }
                },
            ),
        )
        .route(
            "/api/v1/transactions/{id}",
            get(|headers: HeaderMap, Path(id): Path<String>| async move {
                match guard(&headers) {
                    Some(response) => response,
                    None => Json(json!({ "data": { "id": id, "type": "transactions" } }))
                        .into_response(),
                }
            }),
        )
        .route(
            "/api/v1/accounts",
            get(|headers: HeaderMap| async move {
                match guard(&headers) {
                    Some(response) => response,
                    None => {
                        Json(json!({ "data": [{ "id": "1", "attributes": { "name": "招行卡" } }] }))
                            .into_response()
                    }
                }
            }),
        )
}
