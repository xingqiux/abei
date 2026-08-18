use axum::Json;
use axum::body::Body;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{Value, json};

use super::{MessageQuery, RollbackInput, RuleInput, RuleTestInput, SampleInput, apply};
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
    Ok(Json(
        state.mailbox.cache_message(user_id, id).await?.message,
    ))
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
    let fetched = ensure_cached(state, user_id, id).await?;
    let mut result = state.mail.reroute(user_id, id).await?;
    let outcome = follow_up_parse(state, user_id, id, fetched).await?;
    result["reparse_job_id"] = outcome.reparse_job_id.into();
    Ok(result)
}

/// 正文还没缓存就去取一趟，并回答一个关键问题：这一趟顺带把账单文档建出来了吗。
///
/// [`crate::mailbox::Service::cache_message`] 不是一次被动的抓取：它内部会按当前规则
/// 重新索引这封邮件，命中了就直接建文档、排第一个解析任务。调用方不知道这件事，
/// 于是接着又排了一次重解析——同一封邮件连出 revision 1 和 revision 2，
/// 事件时间线上两条「解析完成」，纯浪费。
async fn ensure_cached(state: &AppState, user_id: i64, id: i64) -> Result<bool, ApiError> {
    let current = state.mail.get_message(user_id, id).await?;
    if current["data"]["attributes"]["content_state"] == "cached" {
        return Ok(false);
    }
    Ok(state.mailbox.cache_message(user_id, id).await?.enqueued)
}

/// 取正文那一趟已经把解析排上了，就别再排一次。
async fn follow_up_parse(
    state: &AppState,
    user_id: i64,
    id: i64,
    already_enqueued: bool,
) -> Result<RouteOutcome, ApiError> {
    if already_enqueued {
        return Ok(RouteOutcome {
            enqueued: true,
            reparse_job_id: None,
        });
    }
    enqueue_or_reparse(state, user_id, id).await
}

#[derive(Debug, Default)]
struct RouteOutcome {
    /// 这封邮件第一次建出账单文档。
    enqueued: bool,
    /// 已经解析过的邮件按新规则重解析，这是新排的那个解析任务。
    reparse_job_id: Option<String>,
}

/// 重新归类之后让解析跟上。
///
/// 邮件还没有账单文档时正常入队。已经有文档的，以前这里什么都没发生——
/// `enqueue_message` 见到已有文档就返回，接口回 200，用户以为改规则生效了，
/// 实际上文档还挂着旧流程。现在把文档的归类改过来，再排一次重解析。
async fn enqueue_or_reparse(
    state: &AppState,
    user_id: i64,
    id: i64,
) -> Result<RouteOutcome, ApiError> {
    if state
        .billing
        .enqueue_message(user_id, id)
        .await
        .map_err(ApiError::database)?
        .is_some()
    {
        return Ok(RouteOutcome {
            enqueued: true,
            reparse_job_id: None,
        });
    }
    let Some(document_id) = state.billing.resync_document_routing(user_id, id).await? else {
        return Ok(RouteOutcome::default());
    };
    let reparse = state
        .billing
        .reparse_document(user_id, document_id, None)
        .await?;
    Ok(RouteOutcome {
        enqueued: false,
        reparse_job_id: reparse["data"]["id"].as_str().map(str::to_owned),
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct ApplyRuleInput {
    /// `unclassified` 只动还没归类的邮件，`all` 连已经归给别的规则的一起重算。
    scope: Option<String>,
    limit: Option<u32>,
}

/// 按规则批量重新归类。
///
/// 规则改完只能一封一封点「重新归类」是没法用的：244 封未归类要点 243 次。
///
/// 这里只开一条任务记录就返回，真正的处理放到独立任务里跑。以前是在这个 handler 里
/// 同步循环处理 500 封：客户端等 20 秒超时断开，axum 就把整个 future 丢掉，循环在
/// 半路蒸发——252 封只处理了 5 封，而且没有任何记录说这件事发生过。现在断开只是没人
/// 接结果，处理照跑，进度逐封落库，用 apply-status 查。
pub(crate) async fn apply_rule(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<ApplyRuleInput>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let rule_id = resource_id(path, "邮件规则")?;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    let scope = input.scope.as_deref().unwrap_or("unclassified");
    if !["unclassified", "all"].contains(&scope) {
        return Err(ApiError::invalid_params(
            "scope 只能是 unclassified 或 all。",
        ));
    }
    let limit = input.limit.unwrap_or(500);
    if !(1..=2_000).contains(&limit) {
        return Err(ApiError::invalid_params("limit 必须在 1 到 2000 之间。"));
    }
    if gate.dry_run {
        let matched = state
            .mail
            .rule_candidates(user_id, rule_id, scope == "unclassified", limit)
            .await?;
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dry_run": true,
                "would": { "matched": matched.len(), "scope": scope, "limit": limit }
            })),
        ));
    }
    // 规则没发布这种事当场回 409。任务一旦开出去就是后台跑，让用户轮询半天才看到
    // 一条注定失败的任务，比立刻说清楚差得多。
    state.mail.require_published_rule(user_id, rule_id).await?;
    let run_id = apply::start_run(&state.pool, user_id, rule_id, scope).await?;

    let background = state.clone();
    let scope = scope.to_owned();
    tokio::spawn(async move {
        run_apply(background, user_id, rule_id, run_id, scope, limit).await;
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(apply::latest_run(&state.pool, user_id, rule_id).await?),
    ))
}

/// 这条规则最近一次批量重归类跑到哪儿了。
pub(crate) async fn apply_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let rule_id = resource_id(path, "邮件规则")?;
    Ok(Json(
        apply::latest_run(&state.pool, user_id, rule_id).await?,
    ))
}

/// 后台跑的那一整批。
///
/// 不随连接取消，也不往上抛错：跑成什么样全部写进任务记录，客户端去查。
/// 单封失败只计数不打断——一封邮件正文坏了不该让整批停在半路。
async fn run_apply(
    state: AppState,
    user_id: i64,
    rule_id: i64,
    run_id: i64,
    scope: String,
    limit: u32,
) {
    let candidates = state
        .mail
        .rule_candidates_with_scan(user_id, rule_id, scope == "unclassified", limit)
        .await;
    let (matched, total_scanned) = match candidates {
        Ok(value) => value,
        Err(error) => {
            let detail = error.detail();
            tracing::warn!(user_id, rule_id, run_id, %error, "批量重归类没能取到候选邮件");
            let _ = apply::finish_run(&state.pool, run_id, Some(&detail)).await;
            return;
        }
    };
    if let Err(error) = apply::record_scan(
        &state.pool,
        run_id,
        total_scanned,
        i32::try_from(matched.len()).unwrap_or(i32::MAX),
    )
    .await
    {
        tracing::warn!(user_id, rule_id, run_id, %error, "批量重归类的候选数没记上");
    }

    let mut progress = apply::ApplyProgress::default();
    for id in &matched {
        match apply_one(&state, user_id, *id).await {
            Ok(outcome) => {
                progress.rerouted += 1;
                if outcome.enqueued || outcome.reparse_job_id.is_some() {
                    progress.reparse_jobs += 1;
                }
            }
            Err(error) => {
                progress.failed += 1;
                tracing::warn!(user_id, rule_id, mail_message_id = id, %error, "批量重归类跳过一封");
            }
        }
        // 每封写一次。进度是这条任务唯一的对外交代，攒着批量写就等于又回到了
        // 「跑到一半没人知道跑到哪」。
        if let Err(error) = apply::record_progress(&state.pool, run_id, progress).await {
            tracing::warn!(user_id, rule_id, run_id, %error, "批量重归类的进度没写上");
        }
    }
    if let Err(error) = apply::finish_run(&state.pool, run_id, None).await {
        tracing::warn!(user_id, rule_id, run_id, %error, "批量重归类的收尾没写上");
    }
}

async fn apply_one(state: &AppState, user_id: i64, id: i64) -> Result<RouteOutcome, ApiError> {
    let fetched = ensure_cached(state, user_id, id).await?;
    state.mail.reroute(user_id, id).await?;
    follow_up_parse(state, user_id, id, fetched).await
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
        crate::ensure_test_user(&client, user_id).await;
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

        crate::remove_test_user(&pool.get().await.unwrap(), user_id).await;
        let _ = tokio::fs::remove_file(storage_root.join(raw_path)).await;
    }

    /// 规则改完再套一遍，已经解析过的邮件不能就这么算了。
    ///
    /// 以前这里 `enqueue_message` 见到已有账单文档就直接返回，接口回 200，
    /// 用户以为改的规则生效了，文档其实还挂着旧流程。现在要求：文档的归类跟着改，
    /// 并且真的排出一个新的解析任务。
    #[tokio::test]
    async fn applying_a_rule_to_an_already_parsed_mail_reparses_it() {
        let _ = tracing_subscriber::fmt().with_test_writer().try_init();
        let Ok(url) = std::env::var("ABEI_TEST_DATABASE_URL") else {
            return;
        };
        let pool = crate::create_pool(url.parse().unwrap(), 4).unwrap();
        crate::initialize(&pool).await.unwrap();
        let user_id = 8_110_031_i64;
        let client = pool.get().await.unwrap();
        let fixture = crate::testdb::seed(&client, user_id).await;
        let flow_id: i64 = client
            .query_one(
                "SELECT id FROM abei_ai.parser_flows
                 WHERE owner_user_id IS NULL AND slug = 'cmb-credit-card-daily'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        // 夹具那封邮件已经有账单文档了，但还没归给任何规则。
        let message_id: i64 = client
            .query_one(
                "SELECT mail_message_id FROM abei_ai.bill_documents WHERE id = $1",
                &[&fixture.document_id],
            )
            .await
            .unwrap()
            .get(0);
        client
            .execute(
                "UPDATE abei_ai.mail_messages
                 SET from_address = 'cmb-notification@example.com',
                     classification = 'unclassified', matched_rule_id = NULL
                 WHERE id = $1",
                &[&message_id],
            )
            .await
            .unwrap();
        drop(client);

        let config = crate::mailbox::RuntimeConfig::test();
        let state = AppState::new(pool.clone(), config, crate::TEST_SECRET.to_owned());
        let rule = state
            .mail
            .create_rule(
                user_id,
                &crate::mail::RuleInput {
                    name: "apply-reparse-regression".to_owned(),
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

        // 批量套用要能把这封捞出来。
        let matched = state
            .mail
            .rule_candidates(user_id, rule_id, true, 500)
            .await
            .unwrap();
        assert_eq!(matched, vec![message_id]);

        let jobs_before: i64 = pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT count(*)::bigint FROM abei_ai.parse_jobs WHERE user_id = $1",
                &[&user_id],
            )
            .await
            .unwrap()
            .get(0);

        // 走批量套用的那条路：先重新归类，再让解析跟上。
        let outcome = apply_one(&state, user_id, message_id).await.unwrap();
        assert!(!outcome.enqueued, "已经有文档了，不该再建一份");
        assert!(
            outcome.reparse_job_id.is_some(),
            "改了规则就得真的重新解析一遍"
        );

        let client = pool.get().await.unwrap();
        let jobs_after: i64 = client
            .query_one(
                "SELECT count(*)::bigint FROM abei_ai.parse_jobs WHERE user_id = $1",
                &[&user_id],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(jobs_after, jobs_before + 1, "要多出一个解析任务");

        let routed: Option<i64> = client
            .query_one(
                "SELECT mail_rule_id FROM abei_ai.bill_documents WHERE id = $1",
                &[&fixture.document_id],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(routed, Some(rule_id), "文档的归类要跟着规则走");

        crate::testdb::cleanup(&client, user_id).await;
    }

    /// 一封邮件跑一次 apply，只能产出一个解析任务。
    ///
    /// 以前抓正文那一趟已经按当前规则建好文档、排了第一个任务，调用方不知道，
    /// 接着又排一次重解析——同一封邮件连出 revision 1 和 revision 2，事件时间线上
    /// 两条「解析完成」。这里钉住那条接缝：取正文时已经排过，后面就不许再排。
    #[tokio::test]
    async fn applying_a_rule_to_one_mail_only_ever_queues_one_parse_job() {
        let Ok(url) = std::env::var("ABEI_TEST_DATABASE_URL") else {
            return;
        };
        let pool = crate::create_pool(url.parse().unwrap(), 4).unwrap();
        crate::initialize(&pool).await.unwrap();
        let user_id = 8_110_032_i64;
        let client = pool.get().await.unwrap();
        let fixture = crate::testdb::seed(&client, user_id).await;
        let message_id: i64 = client
            .query_one(
                "SELECT mail_message_id FROM abei_ai.bill_documents WHERE id = $1",
                &[&fixture.document_id],
            )
            .await
            .unwrap()
            .get(0);
        drop(client);

        let config = crate::mailbox::RuntimeConfig::test();
        let state = AppState::new(pool.clone(), config, crate::TEST_SECRET.to_owned());

        let jobs = async || -> i64 {
            pool.get()
                .await
                .unwrap()
                .query_one(
                    "SELECT count(*)::bigint FROM abei_ai.parse_jobs WHERE user_id = $1",
                    &[&user_id],
                )
                .await
                .unwrap()
                .get(0)
        };
        let before = jobs().await;

        // 取正文那一趟已经排过任务：这里一个字都不该再动。
        let outcome = follow_up_parse(&state, user_id, message_id, true)
            .await
            .unwrap();
        assert!(outcome.enqueued);
        assert!(
            outcome.reparse_job_id.is_none(),
            "取正文时已经排过解析，不能再排一次"
        );
        assert_eq!(
            jobs().await,
            before,
            "同一封邮件一次 apply 只能有一个解析任务"
        );

        // 反过来：没排过就必须排一次，否则改了规则等于没改。
        let outcome = follow_up_parse(&state, user_id, message_id, false)
            .await
            .unwrap();
        assert!(outcome.reparse_job_id.is_some());
        assert_eq!(jobs().await, before + 1);

        let client = pool.get().await.unwrap();
        crate::testdb::cleanup(&client, user_id).await;
    }

    /// 批量重归类跑完之后，跑成什么样查得到。
    ///
    /// 以前这件事只存在于那一个 HTTP 响应里：客户端超时断开，结果连同进度一起蒸发。
    #[tokio::test]
    async fn a_finished_apply_run_can_still_be_looked_up_afterwards() {
        let Ok(url) = std::env::var("ABEI_TEST_DATABASE_URL") else {
            return;
        };
        let pool = crate::create_pool(url.parse().unwrap(), 4).unwrap();
        crate::initialize(&pool).await.unwrap();
        let user_id = 8_110_033_i64;
        let client = pool.get().await.unwrap();
        let fixture = crate::testdb::seed(&client, user_id).await;
        let flow_id: i64 = client
            .query_one(
                "SELECT id FROM abei_ai.parser_flows
                 WHERE owner_user_id IS NULL AND slug = 'cmb-credit-card-daily'",
                &[],
            )
            .await
            .unwrap()
            .get(0);
        let message_id: i64 = client
            .query_one(
                "SELECT mail_message_id FROM abei_ai.bill_documents WHERE id = $1",
                &[&fixture.document_id],
            )
            .await
            .unwrap()
            .get(0);
        client
            .execute(
                "UPDATE abei_ai.mail_messages
                 SET from_address = 'cmb-notification@example.com',
                     classification = 'unclassified', matched_rule_id = NULL
                 WHERE id = $1",
                &[&message_id],
            )
            .await
            .unwrap();
        drop(client);

        let config = crate::mailbox::RuntimeConfig::test();
        let state = AppState::new(pool.clone(), config, crate::TEST_SECRET.to_owned());
        let rule_id = publish_apply_rule(&state, user_id, flow_id, "apply-run-regression").await;

        let run_id = apply::start_run(&pool, user_id, rule_id, "unclassified")
            .await
            .unwrap();
        // 同一条规则第二次发起必须被挡住，否则两批人同时改同一批邮件的归类。
        let refused = apply::start_run(&pool, user_id, rule_id, "unclassified")
            .await
            .expect_err("同一条规则同时只能有一个 apply 在跑");
        assert_eq!(refused.reason(), apply::APPLY_IN_FLIGHT);

        run_apply(
            state.clone(),
            user_id,
            rule_id,
            run_id,
            "unclassified".to_owned(),
            500,
        )
        .await;

        let status = apply::latest_run(&pool, user_id, rule_id).await.unwrap();
        let data = &status["data"];
        assert_eq!(data["run_id"], run_id.to_string());
        assert_eq!(data["state"], "succeeded");
        assert_eq!(data["matched"], 1);
        assert_eq!(data["rerouted"], 1);
        assert_eq!(data["failed"], 0);
        assert!(data["total_scanned"].as_i64().unwrap() >= 1);

        // 跑完了，下一次发起就该放行。
        apply::start_run(&pool, user_id, rule_id, "all")
            .await
            .expect("上一批已经收尾，新的一批要能开起来");

        let client = pool.get().await.unwrap();
        crate::testdb::cleanup(&client, user_id).await;
    }

    /// 建一条命中夹具那封邮件的规则并发布，返回规则 id。
    async fn publish_apply_rule(state: &AppState, user_id: i64, flow_id: i64, name: &str) -> i64 {
        let rule = state
            .mail
            .create_rule(
                user_id,
                &crate::mail::RuleInput {
                    name: name.to_owned(),
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
        rule_id
    }
}
