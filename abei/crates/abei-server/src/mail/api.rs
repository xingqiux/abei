use axum::Json;
use axum::body::Body;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{MessageQuery, RollbackInput, RuleInput, RuleTestInput, SampleInput};
use crate::{ApiError, AppState, WriteGate, actor, authenticated_user_id};

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct SyncRunsQuery {
    limit: Option<u32>,
}

pub(crate) async fn list_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<MessageQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let Query(query) = query.map_err(query_error)?;
    Ok(Json(state.mail.list_messages(user_id, &query).await?))
}

pub(crate) async fn get_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "邮件")?;
    Ok(Json(state.mail.get_message(user_id, id).await?))
}

pub(crate) async fn raw_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Response, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "邮件")?;
    let raw = state.mail.raw_message(user_id, id).await?;
    let mut response = Response::new(Body::from(raw));
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("message/rfc822"));
    response.headers_mut().insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=mail-{id}.eml"))
            .map_err(|error| ApiError::internal(error.to_string()))?,
    );
    Ok(response)
}

pub(crate) async fn cache_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "邮件")?;
    Ok(Json(state.mailbox.cache_message(user_id, id).await?))
}

pub(crate) async fn reroute_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "邮件")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        let data = state.mail.get_message(user_id, id).await?;
        return Ok(Json(json!({ "dry_run": true, "current": data["data"] })));
    }
    Ok(Json(reroute_and_enqueue(&state, user_id, id).await?))
}

async fn reroute_and_enqueue(state: &AppState, user_id: i64, id: i64) -> Result<Value, ApiError> {
    let current = state.mail.get_message(user_id, id).await?;
    if current["data"]["attributes"]["content_state"] != "cached" {
        state.mailbox.cache_message(user_id, id).await?;
    }
    let result = state.mail.reroute(user_id, id).await?;
    state
        .billing
        .enqueue_message(user_id, id)
        .await
        .map_err(ApiError::database)?;
    Ok(result)
}

pub(crate) async fn list_rules(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    Ok(Json(state.mail.list_rules(user_id).await?))
}

pub(crate) async fn create_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<RuleInput>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    input.validate()?;
    if gate.dry_run {
        return Ok((
            StatusCode::OK,
            Json(json!({ "dry_run": true, "data": input })),
        ));
    }
    Ok((
        StatusCode::CREATED,
        Json(state.mail.create_rule(user_id, &input).await?),
    ))
}

pub(crate) async fn update_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<RuleInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "邮件规则")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    input.validate()?;
    if gate.dry_run {
        return Ok(Json(
            json!({ "dry_run": true, "id": id.to_string(), "data": input }),
        ));
    }
    Ok(Json(state.mail.update_rule(user_id, id, &input).await?))
}

pub(crate) async fn test_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<RuleTestInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let Json(input) = payload.map_err(json_error)?;
    if input.message_ids.iter().any(|id| *id <= 0) {
        return Err(ApiError::invalid_params("message_ids 必须是正整数。"));
    }
    Ok(Json(
        state
            .mail
            .test_condition(user_id, &input.conditions, &input.message_ids, input.limit)
            .await?,
    ))
}

pub(crate) async fn publish_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let actor = actor(&headers)?.name;
    let id = resource_id(path, "邮件规则")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        return Ok(Json(json!({
            "dry_run": true,
            "data": { "id": id.to_string(), "action": "publish" }
        })));
    }
    gate.require_confirmation("mail-rules.publish")?;
    Ok(Json(state.mail.publish_rule(user_id, id, &actor).await?))
}

pub(crate) async fn rollback_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<RollbackInput>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let actor = actor(&headers)?.name;
    let id = resource_id(path, "邮件规则")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if input.target_version < 1 {
        return Err(ApiError::invalid_params("target_version 必须是正整数。"));
    }
    if gate.dry_run {
        return Ok(Json(json!({
            "dry_run": true,
            "data": { "id": id.to_string(), "target_version": input.target_version }
        })));
    }
    gate.require_confirmation("mail-rules.rollback")?;
    Ok(Json(
        state
            .mail
            .rollback_rule(user_id, id, input.target_version, &actor)
            .await?,
    ))
}

pub(crate) async fn list_samples(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    Ok(Json(state.mail.list_samples(user_id).await?))
}

pub(crate) async fn create_sample(
    State(state): State<AppState>,
    headers: HeaderMap,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<SampleInput>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    if gate.dry_run {
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dry_run": true,
                "data": {
                    "mail_message_id": input.mail_message_id.to_string(),
                    "name": input.name,
                    "purpose": input.purpose,
                }
            })),
        ));
    }
    Ok((
        StatusCode::CREATED,
        Json(state.mail.create_sample(user_id, &input).await?),
    ))
}

pub(crate) async fn delete_sample(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "邮件样本")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        return Ok(StatusCode::NO_CONTENT);
    }
    gate.require_confirmation("mail-samples.delete")?;
    state.mail.delete_sample(user_id, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn get_sync_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "邮箱同步运行")?;
    Ok(Json(state.mail.get_sync_run(user_id, id).await?))
}

pub(crate) async fn cancel_sync_run(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let id = resource_id(path, "邮箱同步运行")?;
    let gate = parse_gate(gate)?;
    if gate.dry_run {
        let current = state.mail.get_sync_run(user_id, id).await?;
        return Ok(Json(json!({ "dry_run": true, "current": current["data"] })));
    }
    Ok(Json(state.mailbox.request_cancel(user_id, id).await?))
}

pub(crate) async fn list_sync_runs(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<SyncRunsQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let Query(query) = query.map_err(query_error)?;
    Ok(Json(
        state
            .mail
            .list_sync_runs(user_id, query.limit.unwrap_or(30))
            .await?,
    ))
}

fn resource_id(path: Result<Path<String>, PathRejection>, label: &str) -> Result<i64, ApiError> {
    let value = path
        .map_err(|error| ApiError::invalid_params(format!("{label} id 不对：{error}")))?
        .0;
    value
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0)
        .ok_or_else(|| ApiError::invalid_params(format!("{label} id 必须是正整数。")))
}

fn parse_gate(gate: Result<Query<WriteGate>, QueryRejection>) -> Result<WriteGate, ApiError> {
    gate.map(|Query(gate)| gate).map_err(query_error)
}

fn query_error(error: QueryRejection) -> ApiError {
    ApiError::invalid_params(error.body_text())
}

fn json_error(error: JsonRejection) -> ApiError {
    ApiError::invalid_params(error.body_text())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::mail::rules::{Condition, TextField, TextOperator};

    #[tokio::test]
    async fn rerouting_a_cached_match_enqueues_and_parses_it() {
        let _ = tracing_subscriber::fmt().with_test_writer().try_init();
        let Ok(url) = std::env::var("ABEI_TEST_DATABASE_URL") else {
            return;
        };
        let pool = crate::create_pool(url.parse().unwrap(), 4).unwrap();
        crate::initialize(&pool).await.unwrap();
        let user_id = 8_110_001_i64;
        let client = pool.get().await.unwrap();
        client
            .execute("DELETE FROM public.users WHERE id = $1", &[&user_id])
            .await
            .unwrap();
        client
            .execute("INSERT INTO public.users (id) VALUES ($1)", &[&user_id])
            .await
            .unwrap();
        let flow_id: i64 = client
            .query_one(
                "SELECT id FROM abei_ai.parser_flows
                 WHERE owner_user_id IS NULL AND slug = 'cmb-credit-card-daily'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        drop(client);

        let config = crate::mailbox::RuntimeConfig::test();
        let storage_root = config.storage_root().to_path_buf();
        let state = AppState::new(pool.clone(), config, crate::TEST_SECRET.to_owned());
        state.billing.start_workers();
        let rule = state
            .mail
            .create_rule(
                user_id,
                &crate::mail::RuleInput {
                    name: "reroute-parser-regression".to_owned(),
                    enabled: true,
                    position: 99,
                    channel_key: "cmb".to_owned(),
                    parser_flow_id: Some(flow_id),
                    conditions: Condition::Text {
                        field: TextField::From,
                        operator: TextOperator::Equals,
                        value: "cmb-notification@example.com".to_owned(),
                        header_name: None,
                    },
                },
            )
            .await
            .unwrap();
        let rule_id = rule["data"]["id"].as_str().unwrap().parse::<i64>().unwrap();
        state
            .mail
            .publish_rule(user_id, rule_id, "test")
            .await
            .unwrap();

        let raw_path = format!("users/{user_id}/mail/reroute-parser-regression.eml");
        state
            .mail
            .write_generated(
                std::path::Path::new(&raw_path),
                include_bytes!("../../../../testdata/parser-workbench/cmb-credit-daily-sample.eml"),
            )
            .await
            .unwrap();
        pool.get()
            .await
            .unwrap()
            .execute(
                "INSERT INTO abei_ai.mailboxes (user_id, provider, host, port, encryption)
                 VALUES ($1, 'imap', 'imap.example.com', 993, 'ssl')
                 ON CONFLICT (user_id) DO NOTHING",
                &[&user_id],
            )
            .await
            .unwrap();
        let message_id: i64 = pool
            .get()
            .await
            .unwrap()
            .query_one(
                "INSERT INTO abei_ai.mail_messages
                   (user_id, mailbox_user_id, folder, uid_validity, uid, message_id,
                    from_address, to_addresses, subject, received_at, headers, body_structure,
                    content_state, raw_path, raw_checksum, classification)
                 VALUES ($1, $1, 'INBOX', 1, 1, $2,
                         'cmb-notification@example.com', ARRAY['user@example.com'],
                         'CMB parser regression', now(), '{}'::jsonb,
                         '{\"has_html\":true}'::jsonb, 'cached', $3, $4,
                         'unclassified')
                 RETURNING id",
                &[
                    &user_id,
                    &format!("reroute-parser-{user_id}@example.com"),
                    &raw_path,
                    &"a".repeat(64),
                ],
            )
            .await
            .unwrap()
            .get(0);

        let rerouted = reroute_and_enqueue(&state, user_id, message_id)
            .await
            .unwrap();
        assert_eq!(rerouted["data"]["attributes"]["classification"], "matched");

        let mut status = String::new();
        for _ in 0..100 {
            let row = pool
                .get()
                .await
                .unwrap()
                .query_one(
                    "SELECT status, COALESCE(error_message, '')
                     FROM abei_ai.parse_jobs WHERE user_id = $1 ORDER BY id DESC LIMIT 1",
                    &[&user_id],
                )
                .await
                .unwrap();
            status = row.get(0);
            if matches!(status.as_str(), "succeeded" | "failed" | "waiting_input") {
                assert_eq!(status, "succeeded", "{}", row.get::<_, String>(1));
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(status, "succeeded");

        let row = pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT occurred_at, signed_amount::text, description, account_hint
                 FROM abei_ai.bill_rows WHERE user_id = $1",
                &[&user_id],
            )
            .await
            .unwrap();
        assert_eq!(row.get::<_, String>(0), "2026-08-11 08:30:00");
        assert_eq!(row.get::<_, String>(1), "-12.34000000");
        assert_eq!(row.get::<_, String>(2), "测试商户");
        assert_eq!(
            row.get::<_, Option<String>>(3).as_deref(),
            Some("招商银行信用卡(1234)")
        );

        pool.get()
            .await
            .unwrap()
            .execute("DELETE FROM public.users WHERE id = $1", &[&user_id])
            .await
            .unwrap();
        let _ = tokio::fs::remove_file(storage_root.join(raw_path)).await;
    }
}
