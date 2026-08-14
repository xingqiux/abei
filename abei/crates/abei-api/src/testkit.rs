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
use axum::routing::{any, delete, get, patch, post};
use axum::{Json, Router};
use serde_json::{Value, json};
use tokio::net::TcpListener;

use crate::config::Config;
use crate::state::AppState;

/// 假 Firefly 只认这一个令牌，别的都当作 401。
pub const GOOD_TOKEN: &str = "good-token";

/// 测试用的内部签名密钥。假 abei-server 不验签，但 API 侧照样会签，
/// 免得签名这条路径在测试里从来没被走过。
pub const TEST_INTERNAL_SECRET: &str = "abei-testkit-internal-secret-0123456789";

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
    let firefly = spawn(mock_firefly_recording(recorder.clone())).await;
    let server = spawn(mock_server_recording(recorder.clone())).await;
    let config = Config {
        firefly_url: format!("http://{firefly}"),
        server_url: format!("http://{server}"),
        internal_secret: TEST_INTERNAL_SECRET.to_owned(),
        ..Config::default()
    };
    let state = AppState::new(&config).unwrap();
    let api = spawn(crate::build_app(state)).await;
    format!("http://{api}")
}

type Feedback = std::sync::Arc<std::sync::Mutex<MockFeedback>>;

#[derive(Default)]
struct MockFeedback {
    submissions: Vec<MockSubmission>,
    items: Vec<MockItem>,
    messages: Vec<MockFeedbackMessage>,
}

#[derive(Clone)]
struct MockSubmission {
    id: usize,
    item_id: Option<usize>,
    kind: String,
    target: String,
    submitted_via: String,
    message: String,
    expected: Option<String>,
    actual: Option<String>,
    state: String,
    idempotency_key: String,
    candidates: Value,
}

#[derive(Clone)]
struct MockItem {
    id: usize,
    title: String,
    kind: String,
    target: String,
    status: String,
}

#[derive(Clone)]
struct MockFeedbackMessage {
    id: usize,
    submission_id: usize,
    author_kind: String,
    body: String,
}

fn mock_item_summary(feedback: &MockFeedback, item: &MockItem) -> Value {
    let submission_ids = feedback
        .submissions
        .iter()
        .filter(|submission| {
            submission.item_id == Some(item.id)
                && matches!(submission.state.as_str(), "linked" | "needs_information")
        })
        .map(|submission| submission.id)
        .collect::<Vec<_>>();
    json!({
        "feedback_id": item.id,
        "title": item.title,
        "kind": item.kind,
        "target": item.target,
        "status": item.status,
        "severity": null,
        "public_summary": item.title,
        "affected_users": usize::from(!submission_ids.is_empty()),
        "occurrences": submission_ids.len(),
        "first_seen": "2026-08-11 00:00:00+00",
        "last_seen": "2026-08-11 00:00:00+00",
        "my_submission_ids": submission_ids,
        "archived_at": null,
        "created_at": "2026-08-11 00:00:00+00",
        "updated_at": "2026-08-11 00:00:00+00"
    })
}

fn mock_submission_result(feedback: &MockFeedback, submission: &MockSubmission) -> Value {
    if submission.state == "pending_confirmation" {
        return json!({
            "submission_id": submission.id,
            "state": "needs_confirmation",
            "candidates": submission.candidates,
            "next_actions": ["confirm_same", "confirm_new"]
        });
    }
    let item = submission
        .item_id
        .and_then(|id| feedback.items.iter().find(|item| item.id == id));
    let occurrences = item.map_or(0, |item| {
        feedback
            .submissions
            .iter()
            .filter(|candidate| {
                candidate.item_id == Some(item.id)
                    && matches!(candidate.state.as_str(), "linked" | "needs_information")
            })
            .count()
    });
    json!({
        "submission_id": submission.id,
        "feedback_id": submission.item_id,
        "state": submission.state,
        "status": item.map(|item| item.status.as_str()),
        "affected_users": usize::from(occurrences > 0),
        "occurrences": occurrences
    })
}

fn mock_pending_submission(submission: &MockSubmission) -> Value {
    json!({
        "submission_id": submission.id,
        "kind": submission.kind,
        "target": submission.target,
        "submitted_via": submission.submitted_via,
        "message": submission.message,
        "expected": submission.expected,
        "actual": submission.actual,
        "state": "needs_confirmation",
        "candidates": submission.candidates,
        "created_at": "2026-08-11 00:00:00+00",
        "last_seen_at": "2026-08-11 00:00:00+00"
    })
}

fn mock_submission_detail(submission: &MockSubmission) -> Value {
    json!({
        "submission_id": submission.id,
        "kind": submission.kind,
        "target": submission.target,
        "submitted_via": submission.submitted_via,
        "message": submission.message,
        "expected": submission.expected,
        "actual": submission.actual,
        "state": submission.state,
        "created_at": "2026-08-11 00:00:00+00",
        "linked_at": "2026-08-11 00:00:00+00",
        "last_seen_at": "2026-08-11 00:00:00+00"
    })
}

fn mock_feedback_detail(feedback: &MockFeedback, item_id: usize) -> Option<Value> {
    let item = feedback.items.iter().find(|item| item.id == item_id)?;
    let mut data = mock_item_summary(feedback, item);
    data["close_reason"] = Value::Null;
    data["merged_into_id"] = Value::Null;
    data["archived_by"] = Value::Null;
    data["completed_at"] = Value::Null;
    let submissions = feedback
        .submissions
        .iter()
        .filter(|submission| submission.item_id == Some(item_id))
        .map(mock_submission_detail)
        .collect::<Vec<_>>();
    let messages = feedback
        .messages
        .iter()
        .filter(|message| {
            feedback.submissions.iter().any(|submission| {
                submission.id == message.submission_id && submission.item_id == Some(item_id)
            })
        })
        .map(|message| {
            json!({
                "id": message.id,
                "submission_id": message.submission_id,
                "author_kind": message.author_kind,
                "body": message.body,
                "created_at": "2026-08-11 00:00:00+00"
            })
        })
        .collect::<Vec<_>>();
    Some(json!({
        "data": data,
        "updates": [],
        "submissions": submissions,
        "messages": messages,
        "audit": [],
        "permissions": { "manage": true }
    }))
}

/// CLI e2e 用的假 abei-server，保留本进程内创建的反馈。
pub fn mock_server() -> Router {
    mock_server_recording(Recorder::default())
}

/// 与 `mock_server` 相同，同时记录 API 发给 Server 的写请求。
pub fn mock_server_recording(recorder: Recorder) -> Router {
    let feedback: Feedback = Default::default();
    let bill_actions = recorder.clone();
    let row_updates = recorder.clone();
    let row_splits = recorder.clone();
    let import_prepares = recorder.clone();
    let import_transitions = recorder.clone();
    let mapping_updates = recorder.clone();
    let mapping_deletes = recorder.clone();
    let row_updates_many = recorder.clone();
    let row_dismissals = recorder.clone();
    Router::new()
        .route(
            "/v1/feedback",
            post(
                |State(feedback): State<Feedback>,
                 Query(gate): Query<HashMap<String, String>>,
                 Json(body): Json<Value>| async move {
                    if gate.get("dry_run").is_some_and(|value| value == "true") {
                        return Json(json!({
                            "dry_run": true,
                            "data": {
                                "kind": body["kind"],
                                "target": body["target"],
                                "message": body["message"],
                                "expected": body.get("expected"),
                                "actual": body.get("actual"),
                                "submitted_via": body["submitted_via"],
                                "context": body["context"],
                                "fingerprint_version": 1,
                                "has_fingerprint": true
                            }
                        }))
                        .into_response();
                    }

                    let mut state = feedback.lock().unwrap();
                    let idempotency_key = body["idempotency_key"]
                        .as_str()
                        .unwrap_or("missing-idempotency-key")
                        .to_owned();
                    if let Some(existing) = state
                        .submissions
                        .iter()
                        .find(|submission| submission.idempotency_key == idempotency_key)
                    {
                        return Json(mock_submission_result(&state, existing)).into_response();
                    }

                    let kind = body["kind"].as_str().unwrap_or("bug").to_owned();
                    let target = body["target"].as_str().unwrap_or("cli").to_owned();
                    let message = body["message"].as_str().unwrap_or_default().to_owned();
                    let candidate = state
                        .items
                        .iter()
                        .find(|item| item.kind == kind && item.target == target)
                        .cloned();
                    let candidates = candidate.as_ref().map_or_else(
                        || json!([]),
                        |item| {
                            let summary = mock_item_summary(&state, item);
                            json!([{
                                "feedback_id": item.id,
                                "title": item.title,
                                "kind": item.kind,
                                "target": item.target,
                                "status": item.status,
                                "affected_users": summary["affected_users"],
                                "occurrences": summary["occurrences"],
                                "match": {
                                    "reason": "similar_text",
                                    "confidence": "high",
                                    "score": 0.95,
                                    "algorithm_version": 1
                                }
                            }])
                        },
                    );
                    let submission_id = state.submissions.len() + 1;
                    let item_id = if candidate.is_none() {
                        let item_id = state.items.len() + 1;
                        state.items.push(MockItem {
                            id: item_id,
                            title: message.chars().take(160).collect(),
                            kind: kind.clone(),
                            target: target.clone(),
                            status: "open".to_owned(),
                        });
                        Some(item_id)
                    } else {
                        None
                    };
                    let submission = MockSubmission {
                        id: submission_id,
                        item_id,
                        kind,
                        target,
                        submitted_via: body["submitted_via"].as_str().unwrap_or("cli").to_owned(),
                        message,
                        expected: body
                            .get("expected")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        actual: body
                            .get("actual")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        state: if candidate.is_some() {
                            "pending_confirmation".to_owned()
                        } else {
                            "linked".to_owned()
                        },
                        idempotency_key,
                        candidates,
                    };
                    state.submissions.push(submission.clone());
                    let status = if candidate.is_some() {
                        StatusCode::ACCEPTED
                    } else {
                        StatusCode::CREATED
                    };
                    (status, Json(mock_submission_result(&state, &submission))).into_response()
                },
            )
            .get(|State(feedback): State<Feedback>| async move {
                let state = feedback.lock().unwrap();
                let data = state
                    .items
                    .iter()
                    .map(|item| mock_item_summary(&state, item))
                    .collect::<Vec<_>>();
                let pending = state
                    .submissions
                    .iter()
                    .filter(|submission| submission.state == "pending_confirmation")
                    .map(mock_pending_submission)
                    .collect::<Vec<_>>();
                Json(json!({
                    "data": data,
                    "pending": pending,
                    "pagination": { "limit": 50, "offset": 0, "count": data.len() }
                }))
            }),
        )
        .route(
            "/v1/feedback/{id}",
            get(
                |State(feedback): State<Feedback>, Path(id): Path<usize>| async move {
                    mock_feedback_detail(&feedback.lock().unwrap(), id)
                        .map(|body| Json(body).into_response())
                        .unwrap_or_else(|| StatusCode::NOT_FOUND.into_response())
                },
            ),
        )
        .route(
            "/v1/feedback/submissions/{id}/confirm",
            post(
                |State(feedback): State<Feedback>,
                 Path(id): Path<usize>,
                 Json(body): Json<Value>| async move {
                    let mut state = feedback.lock().unwrap();
                    let Some(index) = state
                        .submissions
                        .iter()
                        .position(|submission| submission.id == id)
                    else {
                        return StatusCode::NOT_FOUND.into_response();
                    };
                    if state.submissions[index].state != "pending_confirmation" {
                        let result = mock_submission_result(&state, &state.submissions[index]);
                        return Json(result).into_response();
                    }
                    let item_id = if let Some(item_id) = body.get("same_as").and_then(Value::as_u64)
                    {
                        item_id as usize
                    } else if body.get("new").and_then(Value::as_bool) == Some(true) {
                        let item_id = state.items.len() + 1;
                        let submission = state.submissions[index].clone();
                        state.items.push(MockItem {
                            id: item_id,
                            title: submission.message.chars().take(160).collect(),
                            kind: submission.kind,
                            target: submission.target,
                            status: "open".to_owned(),
                        });
                        item_id
                    } else {
                        return StatusCode::BAD_REQUEST.into_response();
                    };
                    if !state.items.iter().any(|item| item.id == item_id) {
                        return StatusCode::BAD_REQUEST.into_response();
                    }
                    state.submissions[index].item_id = Some(item_id);
                    state.submissions[index].state = "linked".to_owned();
                    let result = mock_submission_result(&state, &state.submissions[index]);
                    Json(result).into_response()
                },
            ),
        )
        .route(
            "/v1/feedback/submissions/{id}/messages",
            post(
                |State(feedback): State<Feedback>,
                 Path(id): Path<usize>,
                 Json(body): Json<Value>| async move {
                    let mut state = feedback.lock().unwrap();
                    let Some(index) = state
                        .submissions
                        .iter()
                        .position(|submission| submission.id == id)
                    else {
                        return StatusCode::NOT_FOUND.into_response();
                    };
                    let message = body["message"].as_str().unwrap_or_default().to_owned();
                    let message_id = state.messages.len() + 1;
                    state.messages.push(MockFeedbackMessage {
                        id: message_id,
                        submission_id: id,
                        author_kind: "user".to_owned(),
                        body: message.clone(),
                    });
                    if state.submissions[index].state == "needs_information" {
                        state.submissions[index].state = "linked".to_owned();
                    }
                    (
                        StatusCode::CREATED,
                        Json(json!({ "data": {
                            "id": message_id,
                            "submission_id": id,
                            "author_kind": "user",
                            "body": message,
                            "created_at": "2026-08-11 00:00:00+00"
                        } })),
                    )
                        .into_response()
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
                let run_id = body
                    .get("limit")
                    .and_then(Value::as_u64)
                    .filter(|limit| matches!(limit, 98..=100))
                    .unwrap_or(77)
                    .to_string();
                (
                    StatusCode::ACCEPTED,
                    Json(
                        json!({ "data": { "type": "bill-inbox-sync-state", "attributes": {
                        "status": "queued",
                        "run_id": run_id,
                        "limit": body.get("limit").cloned().unwrap_or(json!(25)),
                        "authenticated_user_id": headers
                            .get("x-abei-authenticated-user-id")
                            .and_then(|value| value.to_str().ok())
                    } } }),
                    ),
                )
            }),
        )
        .route("/v1/bills", get(|| async { Json(bill_tasks_payload()) }))
        .route(
            "/v1/bills/{id}",
            get(|Path(id): Path<String>| async move {
                Json(json!({ "data": { "id": id, "attributes": {
                    "source": "alipay", "status": "pending"
                } } }))
            }),
        )
        .route(
            "/v1/bills/{id}/review",
            get(|Path(id): Path<String>| async move {
                Json(if id == "53" {
                    existing_transaction_bill_review_payload()
                } else {
                    bill_review_payload()
                })
            }),
        )
        .route(
            "/v1/mail-sync-runs/{id}",
            get(|Path(id): Path<String>| async move {
                let status = match id.as_str() {
                    "98" => "failed",
                    "99" => "cancelled",
                    "100" => "running",
                    _ => "succeeded",
                };
                Json(json!({ "data": { "id": id, "attributes": {
                    "status": status, "counts": {
                        "scanned": 4, "fetched": 3, "matched": 2,
                        "unclassified": 1, "failed": usize::from(status == "failed")
                    }
                } } }))
            }),
        )
        .route(
            "/v1/bills/{id}/{action}",
            post(
                move |Path((id, action)): Path<(String, String)>, Json(body): Json<Value>| {
                    let bill_actions = bill_actions.clone();
                    async move {
                        bill_actions
                            .lock()
                            .unwrap()
                            .push((format!("POST /v1/bills/{id}/{action}"), body));
                        Json(json!({ "data": { "id": id, "attributes": {
                            "status": if action == "ignore" { "archived" } else { "pending" }
                        } } }))
                    }
                },
            ),
        )
        .route(
            "/v1/bill-rows",
            get(|Query(query): Query<HashMap<String, String>>| async move {
                let data = if query.get("document_id").map(String::as_str) == Some("53") {
                    json!([{ "id": "802", "attributes": { "status": "pending" } }])
                } else {
                    json!([
                        { "id": "7", "attributes": { "status": "pending" } },
                        { "id": "8", "attributes": { "status": "pending" } }
                    ])
                };
                Json(json!({
                    "data": data,
                    "meta": { "pagination": {
                        "total": data.as_array().map_or(0, Vec::len),
                        "total_pages": 1
                    } }
                }))
            }),
        )
        .route(
            "/v1/bill-rows/dismiss",
            post(
                move |Query(query): Query<HashMap<String, String>>, Json(body): Json<Value>| {
                    let row_dismissals = row_dismissals.clone();
                    async move {
                        row_dismissals
                            .lock()
                            .unwrap()
                            .push(("POST /v1/bill-rows/dismiss".to_owned(), body.clone()));
                        let row_ids = body["row_ids"].as_array().cloned().unwrap_or_default();
                        if query.get("dry_run").is_some_and(|value| value == "true") {
                            Json(json!({ "dry_run": true, "would": {
                                "row_ids": row_ids,
                                "affected_count": row_ids.len(),
                                "machine_duplicates": false
                            } }))
                        } else {
                            Json(json!({
                                "processed": row_ids.len(),
                                "affected_count": row_ids.len(),
                                "reason": body.get("reason").and_then(Value::as_str).unwrap_or("user")
                            }))
                        }
                    }
                },
            ),
        )
        .route(
            "/v1/bill-rows/restore",
            post(|Json(body): Json<Value>| async move {
                Json(json!({ "processed": body["row_ids"].as_array().map_or(0, Vec::len) }))
            }),
        )
        .route(
            "/v1/bill-rows/update-many",
            patch(
                move |Query(query): Query<HashMap<String, String>>, Json(body): Json<Value>| {
                    let row_updates_many = row_updates_many.clone();
                    async move {
                        row_updates_many.lock().unwrap().push((
                            "PATCH /v1/bill-rows/update-many".to_owned(),
                            body.clone(),
                        ));
                        let row_ids = body["row_ids"].as_array().cloned().unwrap_or_default();
                        if query.get("dry_run").is_some_and(|value| value == "true") {
                            Json(json!({ "dry_run": true, "would": {
                                "row_ids": row_ids,
                                "affected_count": row_ids.len(),
                                "skipped": 0
                            } }))
                        } else {
                            let values = body["values"].clone();
                            Json(json!({
                                "data": row_ids.iter().map(|id| json!({
                                    "id": id.to_string(), "attributes": values
                                })).collect::<Vec<_>>(),
                                "affected_count": row_ids.len(),
                                "skipped": 0
                            }))
                        }
                    }
                },
            ),
        )
        .route(
            "/v1/bill-rows/{id}",
            axum::routing::patch(move |Path(id): Path<String>, Json(body): Json<Value>| {
                let row_updates = row_updates.clone();
                async move {
                    row_updates
                        .lock()
                        .unwrap()
                        .push((format!("PATCH /v1/bill-rows/{id}"), body.clone()));
                    Json(json!({ "data": { "id": id, "attributes": body } }))
                }
            }),
        )
        .route(
            "/v1/bill-rows/{id}/split",
            post(move |Path(id): Path<String>, Json(body): Json<Value>| {
                let row_splits = row_splits.clone();
                async move {
                    row_splits
                        .lock()
                        .unwrap()
                        .push((format!("POST /v1/bill-rows/{id}/split"), body.clone()));
                    Json(json!({ "data": { "id": id, "split_into":
                            body.get("splits").and_then(Value::as_array).map(Vec::len).unwrap_or(0)
                        } }))
                }
            }),
        )
        .route(
            "/internal/v1/bill-imports/prepare",
            post(move |Json(body): Json<Value>| {
                let import_prepares = import_prepares.clone();
                async move {
                    import_prepares.lock().unwrap().push((
                        "POST /internal/v1/bill-imports/prepare".to_owned(),
                        body.clone(),
                    ));
                    let row_id = body["row_id"].as_i64().unwrap_or(7);
                    let dry_run = body["dry_run"].as_bool().unwrap_or(false);
                    let attempt_id = format!("00000000-0000-0000-0000-{row_id:012x}");
                    let (amount, description, source_name, destination_name) = if row_id == 802 {
                        (
                            "2952.95",
                            "微信零钱提现".to_owned(),
                            "微信钱包",
                            "招商银行（8705）",
                        )
                    } else {
                        (
                            "45.00",
                            format!("测试流水 {row_id}"),
                            "招行卡",
                            "测试商户",
                        )
                    };
                    Json(json!({ "data": {
                        "attempt_id": if dry_run { Value::Null } else { json!(attempt_id) },
                        "account_ids": [],
                        "preview": {
                            "row_id": row_id.to_string(),
                            "amount": amount,
                            "description": description
                        },
                        "payload": {
                            "apply_rules": true,
                            "error_if_duplicate_hash": true,
                            "transactions": [{
                                "type": "withdrawal",
                                "date": "2026-07-15T12:00:00+08:00",
                                "currency_code": "CNY",
                                "amount": amount,
                                "description": description,
                                "source_name": source_name,
                                "destination_name": destination_name,
                                "external_id": format!("abei-bill-row-{row_id}")
                            }]
                        }
                    } }))
                }
            }),
        )
        .route(
            "/internal/v1/bill-imports/{id}/{action}",
            post(
                move |Path((id, action)): Path<(String, String)>, Json(body): Json<Value>| {
                    let import_transitions = import_transitions.clone();
                    async move {
                        import_transitions.lock().unwrap().push((
                            format!("POST /internal/v1/bill-imports/{id}/{action}"),
                            body,
                        ));
                        Json(json!({ "data": {
                            "id": id,
                            "status": if action == "complete" {
                                "succeeded".to_owned()
                            } else {
                                action
                            }
                        } }))
                    }
                },
            ),
        )
        .route(
            "/v1/bill-import-attempts/{id}",
            get(|Path(id): Path<String>| async move {
                let status = if id.ends_with("0002") {
                    "retryable"
                } else {
                    "uncertain"
                };
                Json(json!({ "data": {
                    "id": id,
                    "bill_row_id": "7",
                    "attempt_no": 1,
                    "status": status,
                    "external_id": "abei:bill-row:7",
                    "payload_hash": "0".repeat(64),
                    "payload": {},
                    "firefly_status": null,
                    "transaction_group_id": null,
                    "error_code": "test",
                    "error_message": "测试导入状态",
                    "retry_after": "2026-08-11 00:00:00+00",
                    "created_at": "2026-08-11 00:00:00+00",
                    "updated_at": "2026-08-11 00:00:00+00",
                    "finished_at": null
                } }))
            }),
        )
        .route(
            "/v1/bill-account-mappings",
            get(|| async {
                Json(json!({ "data": [{
                    "id": "1",
                    "type": "bill-account-mapping",
                    "attributes": {
                        "channel_key": "cmb",
                        "account_hint": "招商银行信用卡(5599)",
                        "firefly_account_id": "10",
                        "firefly_account_name": "招行卡",
                        "firefly_account_type": "asset",
                        "source": "user",
                        "last_verified_at": "2026-08-11 00:00:00+00",
                        "created_at": "2026-08-11 00:00:00+00",
                        "updated_at": "2026-08-11 00:00:00+00"
                    }
                }] }))
            })
            .put(move |Json(body): Json<Value>| {
                let mapping_updates = mapping_updates.clone();
                async move {
                    mapping_updates
                        .lock()
                        .unwrap()
                        .push(("PUT /v1/bill-account-mappings".to_owned(), body.clone()));
                    Json(json!({ "data": {
                        "id": "1", "type": "bill-account-mapping", "attributes": {
                            "channel_key": body["channel_key"],
                            "account_hint": body["account_hint"],
                            "firefly_account_id": body["firefly_account_id"].to_string(),
                            "firefly_account_name": body["firefly_account_name"],
                            "firefly_account_type": body["firefly_account_type"],
                            "source": "user",
                            "last_verified_at": "2026-08-11 00:00:00+00",
                            "created_at": "2026-08-11 00:00:00+00",
                            "updated_at": "2026-08-11 00:00:00+00"
                        }
                    } }))
                }
            }),
        )
        .route(
            "/v1/bill-account-mappings/{id}",
            delete(move |Path(id): Path<String>| {
                let mapping_deletes = mapping_deletes.clone();
                async move {
                    mapping_deletes.lock().unwrap().push((
                        format!("DELETE /v1/bill-account-mappings/{id}"),
                        Value::Null,
                    ));
                    Json(json!({ "deleted": true, "id": id }))
                }
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
            "groups": {
                "importable": [
                    { "id": "7", "attributes": { "occurred_at": "2026-07-15", "amount": "45.00",
                      "counterparty": "楼下面馆", "description": "午饭",
                      "firefly_type": "withdrawal", "category_name": "餐饮",
                      "duplicate_state": "unique", "suggested_by": null } }
                ],
                "attention": [
                    { "id": "8", "attributes": { "occurred_at": "2026-07-16", "amount": "128.50",
                      "counterparty": "山姆会员店", "description": "组合支付",
                      "firefly_type": null, "category_name": null,
                      "duplicate_state": "unique", "suggested_by": null } }
                ],
                "dismissed": [],
                "imported": []
            }
        }
    })
}

/// 原反馈中的真实重复场景：一条 2952.95 元提现流水，对应 Firefly 中
/// 2950 元转账和 2.95 元手续费两个交易组。
pub fn existing_transaction_bill_review_payload() -> Value {
    json!({
        "summary": { "total": 1, "new": 1, "attention": 0, "dismissed": 0, "imported": 0 },
        "new_candidates": [{ "row_id": "802", "reason": "new" }],
        "data": {
            "bill_task_id": 53,
            "groups": {
                "importable": [{
                    "id": "802",
                    "attributes": {
                        "occurred_at": "2026-07-15",
                        "firefly_date": "2026-07-15",
                        "amount": "2952.95",
                        "firefly_amount": "2952.95",
                        "currency_code": "CNY",
                        "counterparty": "招商银行（8705）",
                        "description": "微信零钱提现",
                        "firefly_description": "微信零钱提现",
                        "firefly_type": "withdrawal",
                        "source_name": "微信钱包",
                        "source_account_id": "8",
                        "destination_name": "招商银行（8705）",
                        "category_name": "零钱提现",
                        "duplicate_state": "unique",
                        "group": "importable",
                        "issues": [],
                        "reasons": []
                    }
                }],
                "attention": [],
                "dismissed": [],
                "imported": []
            }
        }
    })
}

pub fn existing_transactions_payload() -> Value {
    json!({
        "data": [
            {
                "type": "transactions",
                "id": "397",
                "attributes": { "transactions": [{
                    "transaction_journal_id": "397",
                    "type": "transfer",
                    "date": "2026-07-15T12:03:31+08:00",
                    "currency_code": "CNY",
                    "amount": "2950.000000000000",
                    "description": "微信零钱提现至招商银行（8705）",
                    "source_id": "8",
                    "source_name": "微信钱包",
                    "destination_id": "12",
                    "destination_name": "招商银行"
                }] }
            },
            {
                "type": "transactions",
                "id": "398",
                "attributes": { "transactions": [{
                    "transaction_journal_id": "398",
                    "type": "withdrawal",
                    "date": "2026-07-15T12:03:31+08:00",
                    "currency_code": "CNY",
                    "amount": "2.950000000000",
                    "description": "微信零钱提现手续费",
                    "source_id": "8",
                    "source_name": "微信钱包",
                    "destination_id": "200",
                    "destination_name": "财付通提现手续费"
                }] }
            }
        ],
        "meta": { "pagination": { "total_pages": 1, "count": 2 } }
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
    let transactions = recorder.clone();

    Router::new()
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
            get(
                |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| async move {
                    match guard(&headers) {
                        Some(response) => response,
                        None => {
                            let start = query.get("start").map(String::as_str);
                            let end = query.get("end").map(String::as_str);
                            if start == Some("2026-07-15") && end == Some("2026-07-15") {
                                Json(existing_transactions_payload()).into_response()
                            } else {
                                Json(transactions_payload()).into_response()
                            }
                        }
                    }
                },
            )
            .post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let transactions = transactions.clone();
                async move {
                    if let Some(response) = guard(&headers) {
                        return response;
                    }
                    transactions
                        .lock()
                        .unwrap()
                        .push(("POST /api/v1/transactions".to_owned(), body));
                    (
                        StatusCode::CREATED,
                        Json(json!({ "data": { "id": "101", "type": "transactions" } })),
                    )
                        .into_response()
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
        .route(
            "/api/v1/accounts/{id}",
            get(|headers: HeaderMap, Path(id): Path<String>| async move {
                match guard(&headers) {
                    Some(response) => response,
                    None => Json(json!({ "data": { "id": id, "attributes": {
                        "name": "招行卡", "type": "asset"
                    } } }))
                    .into_response(),
                }
            }),
        )
}
