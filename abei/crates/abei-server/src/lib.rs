use std::env;
use std::net::SocketAddr;
use std::time::Duration;

pub mod mailbox;

use abei_core::FeedbackStatus;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header::CONTENT_TYPE};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_postgres::{NoTls, Row};

const FEEDBACK_COLUMNS: &str = "id, title, body, labels, kind, submitted_by, source, \
    status, response, responded_by, responded_at::text AS responded_at, duplicate_of, \
    github_issue_url, github_issue_number, sync_status, sync_error, \
    created_at::text AS created_at, updated_at::text AS updated_at";
const ACTOR_HEADER: &str = "x-abei-authenticated-user";
const ROLE_HEADER: &str = "x-abei-authenticated-role";
const GITHUB_TIMEOUT: Duration = Duration::from_secs(20);

pub struct ServerConfig {
    pub address: SocketAddr,
    pub database: tokio_postgres::Config,
    pub pool_size: usize,
    pub github: Option<Github>,
    pub mailbox: mailbox::RuntimeConfig,
}

impl ServerConfig {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let address = env::var("ABEI_SERVER_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:18005".to_owned())
            .parse()?;
        let database = database_config()?;
        let pool_size = env::var("ABEI_DB_POOL_SIZE")
            .unwrap_or_else(|_| "5".to_owned())
            .parse::<usize>()?;
        if pool_size == 0 {
            return Err("ABEI_DB_POOL_SIZE 必须大于 0".into());
        }

        Ok(Self {
            address,
            database,
            pool_size,
            github: Github::from_env()?,
            mailbox: mailbox::RuntimeConfig::from_env()?,
        })
    }
}

fn database_config() -> Result<tokio_postgres::Config, Box<dyn std::error::Error + Send + Sync>> {
    if let Ok(url) = env::var("DATABASE_URL") {
        return Ok(url.parse()?);
    }

    let mut config = tokio_postgres::Config::new();
    config.host(env_value(
        &["POSTGRES_HOST", "PGHOST", "DB_HOST"],
        "127.0.0.1",
    ));
    config.port(env_value(&["POSTGRES_PORT", "PGPORT", "DB_PORT"], "5432").parse::<u16>()?);
    config.dbname(env_value(
        &["POSTGRES_DB", "PGDATABASE", "DB_DATABASE"],
        "firefly",
    ));
    config.user(env_value(
        &["POSTGRES_USER", "PGUSER", "DB_USERNAME"],
        "firefly",
    ));
    config.password(env_value(
        &["POSTGRES_PASSWORD", "PGPASSWORD", "DB_PASSWORD"],
        "firefly-local-only",
    ));
    Ok(config)
}

fn env_value(names: &[&str], default: &str) -> String {
    names
        .iter()
        .find_map(|name| env::var(name).ok())
        .unwrap_or_else(|| default.to_owned())
}

pub fn create_pool(
    database: tokio_postgres::Config,
    max_size: usize,
) -> Result<Pool, deadpool_postgres::BuildError> {
    let manager = Manager::from_config(
        database,
        NoTls,
        ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        },
    );
    Pool::builder(manager).max_size(max_size).build()
}

#[derive(Clone)]
pub struct AppState {
    pool: Pool,
    github: Option<Github>,
    mailbox: mailbox::Service,
}

impl AppState {
    pub fn new(pool: Pool, github: Option<Github>, mailbox: mailbox::RuntimeConfig) -> Self {
        let mailbox = mailbox::Service::new(pool.clone(), mailbox);
        Self {
            pool,
            github,
            mailbox,
        }
    }

    pub fn start_mailbox_scheduler(&self) {
        self.mailbox.start_scheduler();
    }
}

pub fn build_app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route(
            "/v1/bills/mailbox",
            get(mailbox::get_settings).put(mailbox::update_settings),
        )
        .route(
            "/v1/bills/mailbox/google/connect",
            post(mailbox::start_google_oauth),
        )
        .route(
            "/v1/bills/mailbox/google/callback",
            post(mailbox::complete_google_oauth),
        )
        .route(
            "/v1/bills/mailbox/google",
            delete(mailbox::disconnect_google),
        )
        .route("/v1/bills/sync", post(mailbox::sync))
        .route("/v1/feedback", post(create_feedback).get(list_feedback))
        .route("/v1/feedback/{id}/retry", post(retry_feedback))
        .route(
            "/v1/feedback/{id}",
            get(get_feedback)
                .patch(update_feedback)
                .delete(delete_feedback),
        )
        .with_state(state)
}

pub async fn initialize(pool: &Pool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client = pool.get().await?;
    client
        .batch_execute(
            r#"
            CREATE SCHEMA IF NOT EXISTS abei_ai;
            CREATE TABLE IF NOT EXISTS abei_ai.feedback (
              id BIGSERIAL PRIMARY KEY,
              title TEXT NOT NULL,
              body TEXT NOT NULL,
              labels TEXT[] NOT NULL DEFAULT '{}',
              kind TEXT NOT NULL,
              submitted_by TEXT NOT NULL,
              source TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'open',
              response TEXT,
              responded_by TEXT,
              responded_at timestamptz,
              duplicate_of BIGINT,
              github_issue_url TEXT,
              github_issue_number INTEGER,
              sync_status TEXT NOT NULL DEFAULT 'local',
              sync_error TEXT,
              deleted_at timestamptz,
              deleted_by TEXT,
              delete_reason TEXT,
              created_at timestamptz NOT NULL DEFAULT now(),
              updated_at timestamptz NOT NULL DEFAULT now()
            );
            ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
            ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS response TEXT;
            ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS responded_by TEXT;
            ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS responded_at timestamptz;
            ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS duplicate_of BIGINT;
            ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
            ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS deleted_by TEXT;
            ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS delete_reason TEXT;
            DO $constraint$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'feedback_status_check'
                  AND conrelid = 'abei_ai.feedback'::regclass
              ) THEN
                ALTER TABLE abei_ai.feedback ADD CONSTRAINT feedback_status_check
                  CHECK (status IN ('open', 'planned', 'started', 'completed', 'declined', 'duplicate'));
              END IF;
            END
            $constraint$;
            CREATE TABLE IF NOT EXISTS abei_ai.feedback_events (
              id BIGSERIAL PRIMARY KEY,
              feedback_id BIGINT NOT NULL REFERENCES abei_ai.feedback(id),
              event_type TEXT NOT NULL,
              from_status TEXT,
              to_status TEXT,
              message TEXT,
              actor TEXT NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS feedback_events_feedback_id_idx
              ON abei_ai.feedback_events (feedback_id, created_at, id);
            CREATE TABLE IF NOT EXISTS abei_ai.mailboxes (
              user_id BIGINT PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
              enabled BOOLEAN NOT NULL DEFAULT false,
              provider TEXT NOT NULL CHECK (provider IN ('gmail', 'imap')),
              email TEXT NOT NULL DEFAULT '',
              host TEXT NOT NULL,
              port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
              encryption TEXT NOT NULL CHECK (encryption IN ('none', 'ssl', 'tls', 'starttls')),
              username TEXT NOT NULL DEFAULT '',
              password_ciphertext TEXT,
              auth_method TEXT NOT NULL DEFAULT 'password'
                CHECK (auth_method IN ('password', 'google_oauth')),
              oauth_refresh_token_ciphertext TEXT,
              folder TEXT NOT NULL DEFAULT 'INBOX',
              uid_validity BIGINT,
              last_uid BIGINT NOT NULL DEFAULT 0,
              created_at timestamptz NOT NULL DEFAULT now(),
              updated_at timestamptz NOT NULL DEFAULT now()
            );
            ALTER TABLE abei_ai.mailboxes
              ADD COLUMN IF NOT EXISTS auth_method TEXT NOT NULL DEFAULT 'password';
            ALTER TABLE abei_ai.mailboxes
              ADD COLUMN IF NOT EXISTS oauth_refresh_token_ciphertext TEXT;
            UPDATE abei_ai.mailboxes SET enabled = false, auth_method = 'google_oauth',
              password_ciphertext = NULL, oauth_refresh_token_ciphertext = NULL
              WHERE provider = 'gmail' AND auth_method <> 'google_oauth';
            UPDATE abei_ai.mailboxes SET auth_method = 'password',
              oauth_refresh_token_ciphertext = NULL
              WHERE provider = 'imap' AND auth_method <> 'password';
            DO $constraint$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'mailboxes_auth_method_check'
                  AND conrelid = 'abei_ai.mailboxes'::regclass
              ) THEN
                ALTER TABLE abei_ai.mailboxes ADD CONSTRAINT mailboxes_auth_method_check
                  CHECK (auth_method IN ('password', 'google_oauth'));
              END IF;
            END
            $constraint$;
            CREATE INDEX IF NOT EXISTS mailboxes_enabled_idx
              ON abei_ai.mailboxes (enabled) WHERE enabled = true;
            CREATE TABLE IF NOT EXISTS abei_ai.mailbox_oauth_states (
              state_hash TEXT PRIMARY KEY,
              user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
              verifier_ciphertext TEXT NOT NULL,
              expires_at timestamptz NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS mailbox_oauth_states_user_id_idx
              ON abei_ai.mailbox_oauth_states (user_id);
            "#,
        )
        .await?;
    Ok(())
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "abei-server",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateFeedback {
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub labels: Vec<String>,
    pub kind: String,
    pub submitted_by: String,
    pub source: String,
}

impl CreateFeedback {
    fn validate(&self) -> Result<(), ApiError> {
        if self.title.trim().is_empty() {
            return Err(ApiError::invalid_params("title 不能为空。"));
        }
        if self.title.chars().count() > 120 {
            return Err(ApiError::invalid_params("title 最多 120 字。"));
        }
        if self.body.trim().is_empty() {
            return Err(ApiError::invalid_params("body 不能为空。"));
        }
        validate_choice("kind", &self.kind, &["bug", "friction", "idea"])?;
        if self.submitted_by.trim().is_empty() {
            return Err(ApiError::invalid_params("submitted_by 不能为空。"));
        }
        validate_choice("source", &self.source, &["cli", "web"])
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct WriteGate {
    dry_run: bool,
    confirm: bool,
}

impl WriteGate {
    fn require_confirmation(&self, capability: &'static str) -> Result<(), ApiError> {
        if self.confirm {
            Ok(())
        } else {
            Err(ApiError::confirmation_required(capability))
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Feedback {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub kind: String,
    pub submitted_by: String,
    pub source: String,
    pub status: String,
    pub response: Option<String>,
    pub responded_by: Option<String>,
    pub responded_at: Option<String>,
    pub duplicate_of: Option<i64>,
    pub github_issue_url: Option<String>,
    pub github_issue_number: Option<i32>,
    pub sync_status: String,
    pub sync_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize)]
pub struct FeedbackEvent {
    pub id: i64,
    pub event_type: String,
    pub from_status: Option<String>,
    pub to_status: Option<String>,
    pub message: Option<String>,
    pub actor: String,
    pub created_at: String,
}

#[derive(Debug)]
struct Actor {
    name: String,
    role: String,
}

async fn create_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<CreateFeedback>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let gate = gate
        .map_err(|error| ApiError::invalid_params(format!("查询参数不对：{error}")))?
        .0;
    let input = payload
        .map_err(|error| {
            ApiError::invalid_params(format!("JSON 请求体不对：{}", error.body_text()))
        })?
        .0;
    input.validate()?;
    let actor = actor(&headers)?;

    if gate.dry_run {
        let mut preview =
            serde_json::to_value(&input).map_err(|error| ApiError::internal(error.to_string()))?;
        preview["status"] = json!("open");
        preview["sync_status"] = json!("local");
        return Ok((
            StatusCode::OK,
            Json(json!({ "dry_run": true, "data": preview })),
        ));
    }
    gate.require_confirmation("feedback.create")?;

    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let sql = format!(
        "INSERT INTO abei_ai.feedback (title, body, labels, kind, submitted_by, source) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING {FEEDBACK_COLUMNS}"
    );
    let row = transaction
        .query_one(
            &sql,
            &[
                &input.title,
                &input.body,
                &input.labels,
                &input.kind,
                &input.submitted_by,
                &input.source,
            ],
        )
        .await
        .map_err(ApiError::database)?;
    let mut feedback = feedback_from_row(&row);
    transaction
        .execute(
            "INSERT INTO abei_ai.feedback_events \
             (feedback_id, event_type, to_status, actor) VALUES ($1, 'created', 'open', $2)",
            &[&feedback.id, &actor.name],
        )
        .await
        .map_err(ApiError::database)?;
    transaction.commit().await.map_err(ApiError::database)?;
    sync_feedback(&state, &mut feedback).await?;

    Ok((StatusCode::CREATED, Json(json!({ "data": feedback }))))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ListQuery {
    kind: Option<String>,
    status: Option<String>,
    sync_status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

async fn list_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let query = query
        .map_err(|error| ApiError::invalid_params(format!("查询参数不对：{error}")))?
        .0;
    let actor = actor(&headers)?;
    if let Some(kind) = &query.kind {
        validate_choice("kind", kind, &["bug", "friction", "idea"])?;
    }
    if let Some(status) = &query.status {
        validate_feedback_status(status)?;
    }
    if let Some(status) = &query.sync_status {
        validate_choice("sync_status", status, &["local", "synced", "failed"])?;
    }
    let limit = query.limit.unwrap_or(50);
    let offset = query.offset.unwrap_or(0);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid_params("limit 必须在 1 到 100 之间。"));
    }
    if offset < 0 {
        return Err(ApiError::invalid_params("offset 不能小于 0。"));
    }

    let client = state.pool.get().await.map_err(ApiError::database)?;
    let sql = format!(
        "SELECT {FEEDBACK_COLUMNS} FROM abei_ai.feedback \
         WHERE ($1::text IS NULL OR kind = $1) \
           AND ($2::text IS NULL OR status = $2) \
           AND ($3::text IS NULL OR sync_status = $3) \
           AND deleted_at IS NULL \
         ORDER BY created_at DESC, id DESC LIMIT $4 OFFSET $5"
    );
    let rows = client
        .query(
            &sql,
            &[
                &query.kind,
                &query.status,
                &query.sync_status,
                &limit,
                &offset,
            ],
        )
        .await
        .map_err(ApiError::database)?;
    let feedback: Vec<Feedback> = rows.iter().map(feedback_from_row).collect();

    Ok(Json(json!({
        "data": feedback,
        "pagination": { "limit": limit, "offset": offset, "count": feedback.len() },
        "permissions": { "manage": actor.role == "owner" }
    })))
}

async fn get_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let id = feedback_id(path)?;
    let actor = actor(&headers)?;
    let client = state.pool.get().await.map_err(ApiError::database)?;
    let sql = format!(
        "SELECT {FEEDBACK_COLUMNS} FROM abei_ai.feedback \
         WHERE id = $1 AND deleted_at IS NULL"
    );
    let row = client
        .query_opt(&sql, &[&id])
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found(format!("feedback id={id} 不存在。")))?;
    let events = client
        .query(
            "SELECT id, event_type, from_status, to_status, message, actor, \
             created_at::text AS created_at FROM abei_ai.feedback_events \
             WHERE feedback_id = $1 ORDER BY created_at, id",
            &[&id],
        )
        .await
        .map_err(ApiError::database)?
        .iter()
        .map(feedback_event_from_row)
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "data": feedback_from_row(&row),
        "events": events,
        "permissions": { "manage": actor.role == "owner" }
    })))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UpdateFeedback {
    status: FeedbackStatus,
    response: Option<String>,
    duplicate_of: Option<i64>,
}

impl UpdateFeedback {
    fn validate(&self, id: i64) -> Result<(), ApiError> {
        let response = self.response.as_deref().map(str::trim).unwrap_or("");
        if response.chars().count() > 5000 {
            return Err(ApiError::invalid_params("response 最多 5000 字。"));
        }
        if matches!(
            self.status,
            FeedbackStatus::Completed | FeedbackStatus::Declined
        ) && response.is_empty()
        {
            return Err(ApiError::invalid_params(
                "completed 或 declined 必须填写 response。",
            ));
        }
        match (self.status, self.duplicate_of) {
            (FeedbackStatus::Duplicate, Some(original)) if original > 0 && original != id => Ok(()),
            (FeedbackStatus::Duplicate, _) => Err(ApiError::invalid_params(
                "status=duplicate 时必须填写另一个正整数 duplicate_of。",
            )),
            (_, Some(_)) => Err(ApiError::invalid_params(
                "只有 status=duplicate 时才能填写 duplicate_of。",
            )),
            _ => Ok(()),
        }
    }
}

async fn update_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<UpdateFeedback>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let id = feedback_id(path)?;
    let gate = gate
        .map_err(|error| ApiError::invalid_params(format!("查询参数不对：{error}")))?
        .0;
    let input = payload
        .map_err(|error| {
            ApiError::invalid_params(format!("JSON 请求体不对：{}", error.body_text()))
        })?
        .0;
    input.validate(id)?;
    let actor = owner(&headers)?;
    if !gate.dry_run {
        gate.require_confirmation("feedback.update")?;
    }
    let current = load_feedback(&state, id).await?;

    if let Some(original) = input.duplicate_of {
        load_feedback(&state, original).await.map_err(|error| {
            if error.status == StatusCode::NOT_FOUND {
                ApiError::invalid_params(format!("duplicate_of={original} 不存在。"))
            } else {
                error
            }
        })?;
    }

    let response = input
        .response
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    if gate.dry_run {
        return Ok(Json(json!({
            "dry_run": true,
            "data": {
                "id": id,
                "from_status": current.status,
                "to_status": input.status,
                "response": response,
                "duplicate_of": input.duplicate_of,
            }
        })));
    }
    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let sql = format!(
        "SELECT {FEEDBACK_COLUMNS} FROM abei_ai.feedback \
         WHERE id = $1 AND deleted_at IS NULL FOR UPDATE"
    );
    let locked = transaction
        .query_opt(&sql, &[&id])
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found(format!("feedback id={id} 不存在。")))?;
    let old_status: String = locked.get("status");
    let status = input.status.as_str();
    let responded_by = response.as_ref().map(|_| actor.name.as_str());
    let sql = format!(
        "UPDATE abei_ai.feedback SET status = $2, response = $3, responded_by = $4, \
         responded_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, \
         duplicate_of = $5, sync_error = NULL, updated_at = now() \
         WHERE id = $1 RETURNING {FEEDBACK_COLUMNS}"
    );
    let row = transaction
        .query_one(
            &sql,
            &[&id, &status, &response, &responded_by, &input.duplicate_of],
        )
        .await
        .map_err(ApiError::database)?;
    let mut feedback = feedback_from_row(&row);
    transaction
        .execute(
            "INSERT INTO abei_ai.feedback_events \
             (feedback_id, event_type, from_status, to_status, message, actor) \
             VALUES ($1, 'status_changed', $2, $3, $4, $5)",
            &[&id, &old_status, &status, &response, &actor.name],
        )
        .await
        .map_err(ApiError::database)?;
    transaction.commit().await.map_err(ApiError::database)?;
    sync_feedback(&state, &mut feedback).await?;

    Ok(Json(json!({ "data": feedback })))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DeleteFeedback {
    reason: String,
}

async fn delete_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<DeleteFeedback>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let id = feedback_id(path)?;
    let gate = gate
        .map_err(|error| ApiError::invalid_params(format!("查询参数不对：{error}")))?
        .0;
    let input = payload
        .map_err(|error| {
            ApiError::invalid_params(format!("JSON 请求体不对：{}", error.body_text()))
        })?
        .0;
    let reason = input.reason.trim();
    if reason.is_empty() || reason.chars().count() > 1000 {
        return Err(ApiError::invalid_params(
            "reason 不能为空，且最多 1000 字。",
        ));
    }
    let actor = owner(&headers)?;
    if !gate.dry_run {
        gate.require_confirmation("feedback.delete")?;
    }
    let current = load_feedback(&state, id).await?;
    if gate.dry_run {
        return Ok(Json(json!({
            "dry_run": true,
            "data": {
                "id": id,
                "title": current.title,
                "reason": reason,
                "github_issue_url": current.github_issue_url,
            }
        })));
    }
    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let sql = format!(
        "SELECT {FEEDBACK_COLUMNS} FROM abei_ai.feedback \
         WHERE id = $1 AND deleted_at IS NULL FOR UPDATE"
    );
    let row = transaction
        .query_opt(&sql, &[&id])
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found(format!("feedback id={id} 不存在。")))?;
    let current = feedback_from_row(&row);

    // ponytail: GitHub 与 PostgreSQL 无法组成一个事务；规模需要自动对账时再引入 outbox。
    if let Some(number) = current.github_issue_number {
        let github = state.github.as_ref().ok_or_else(|| {
            ApiError::conflict("这条反馈已同步 GitHub；恢复 GitHub 配置后才能一起删除。")
        })?;
        github
            .delete_issue(number)
            .await
            .map_err(ApiError::github)?;
    }

    let deleted_at: String = transaction
        .query_one(
            "UPDATE abei_ai.feedback SET deleted_at = now(), deleted_by = $2, \
             delete_reason = $3, updated_at = now() WHERE id = $1 \
             RETURNING deleted_at::text",
            &[&id, &actor.name, &reason],
        )
        .await
        .map_err(ApiError::database)?
        .get(0);
    transaction
        .execute(
            "INSERT INTO abei_ai.feedback_events \
             (feedback_id, event_type, from_status, message, actor) \
             VALUES ($1, 'deleted', $2, $3, $4)",
            &[&id, &current.status, &reason, &actor.name],
        )
        .await
        .map_err(ApiError::database)?;
    transaction.commit().await.map_err(ApiError::database)?;

    Ok(Json(json!({
        "data": {
            "id": id,
            "deleted": true,
            "deleted_by": actor.name,
            "delete_reason": reason,
            "deleted_at": deleted_at,
        }
    })))
}

async fn retry_feedback(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let id = feedback_id(path)?;
    let gate = gate
        .map_err(|error| ApiError::invalid_params(format!("查询参数不对：{error}")))?
        .0;
    let actor = owner(&headers)?;
    if !gate.dry_run {
        gate.require_confirmation("feedback.retry")?;
    }
    let mut feedback = load_feedback(&state, id).await?;
    if state.github.is_none() {
        return Err(ApiError::conflict(
            "没有配置 ABEI_GITHUB_REPO 与 ABEI_GITHUB_TOKEN，无法同步。",
        ));
    }
    if gate.dry_run {
        return Ok(Json(json!({
            "dry_run": true,
            "data": {
                "id": id,
                "action": if feedback.github_issue_number.is_some() { "update" } else { "create" },
                "status": feedback.status,
            }
        })));
    }
    let sync_error = sync_feedback(&state, &mut feedback).await?;
    let client = state.pool.get().await.map_err(ApiError::database)?;
    client
        .execute(
            "INSERT INTO abei_ai.feedback_events \
             (feedback_id, event_type, from_status, to_status, message, actor) \
             VALUES ($1, 'sync_retried', $2, $2, $3, $4)",
            &[&id, &feedback.status, &sync_error, &actor.name],
        )
        .await
        .map_err(ApiError::database)?;
    if let Some(error) = sync_error {
        return Err(ApiError::github(error));
    }
    Ok(Json(json!({ "data": feedback })))
}

async fn load_feedback(state: &AppState, id: i64) -> Result<Feedback, ApiError> {
    let client = state.pool.get().await.map_err(ApiError::database)?;
    let sql = format!(
        "SELECT {FEEDBACK_COLUMNS} FROM abei_ai.feedback \
         WHERE id = $1 AND deleted_at IS NULL"
    );
    client
        .query_opt(&sql, &[&id])
        .await
        .map_err(ApiError::database)?
        .map(|row| feedback_from_row(&row))
        .ok_or_else(|| ApiError::not_found(format!("feedback id={id} 不存在。")))
}

fn feedback_id(path: Result<Path<String>, PathRejection>) -> Result<i64, ApiError> {
    let raw = path
        .map_err(|error| ApiError::invalid_params(format!("id 不对：{error}")))?
        .0;
    if raw.starts_with('0') || raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ApiError::invalid_params(format!(
            "id 得是正整数，收到的是 {raw}。"
        )));
    }
    raw.parse()
        .map_err(|_| ApiError::invalid_params(format!("id 得是正整数，收到的是 {raw}。")))
}

fn actor(headers: &HeaderMap) -> Result<Actor, ApiError> {
    let name = headers
        .get(ACTOR_HEADER)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::forbidden("请求没有可信的认证身份。"))?;
    let role = headers
        .get(ROLE_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown");
    Ok(Actor {
        name: name.to_owned(),
        role: role.to_owned(),
    })
}

fn owner(headers: &HeaderMap) -> Result<Actor, ApiError> {
    let actor = actor(headers)?;
    if actor.role == "owner" {
        Ok(actor)
    } else {
        Err(ApiError::forbidden(
            "只有 Firefly owner 可以处理、重试或删除反馈。",
        ))
    }
}

fn validate_feedback_status(status: &str) -> Result<(), ApiError> {
    validate_choice(
        "status",
        status,
        &[
            "open",
            "planned",
            "started",
            "completed",
            "declined",
            "duplicate",
        ],
    )
}

/// 把本地反馈的当前快照同步到 GitHub，并把结果写回独立的 sync_status。
async fn sync_feedback(
    state: &AppState,
    feedback: &mut Feedback,
) -> Result<Option<String>, ApiError> {
    let result = match &state.github {
        Some(github) => github.sync_issue(feedback).await,
        None if feedback.github_issue_number.is_some() => {
            Err("GitHub 配置缺失，业务状态已更新但外部 issue 尚未同步。".to_owned())
        }
        None => return Ok(None),
    };
    let client = state.pool.get().await.map_err(ApiError::database)?;

    match result {
        Ok(issue) => {
            let row = client
                .query_one(
                    "UPDATE abei_ai.feedback SET github_issue_url = $2, \
                     github_issue_number = $3, sync_status = 'synced', sync_error = NULL, \
                     updated_at = now() WHERE id = $1 RETURNING updated_at::text",
                    &[&feedback.id, &issue.html_url, &issue.number],
                )
                .await
                .map_err(ApiError::database)?;
            feedback.github_issue_url = Some(issue.html_url);
            feedback.github_issue_number = Some(issue.number);
            feedback.sync_status = "synced".to_owned();
            feedback.sync_error = None;
            feedback.updated_at = row.get(0);
            Ok(None)
        }
        Err(error) => {
            let message: String = error.chars().take(1000).collect();
            let row = client
                .query_one(
                    "UPDATE abei_ai.feedback SET sync_status = 'failed', sync_error = $2, \
                     updated_at = now() WHERE id = $1 RETURNING updated_at::text",
                    &[&feedback.id, &message],
                )
                .await
                .map_err(ApiError::database)?;
            feedback.sync_status = "failed".to_owned();
            feedback.sync_error = Some(message.clone());
            feedback.updated_at = row.get(0);
            Ok(Some(message))
        }
    }
}

fn feedback_from_row(row: &Row) -> Feedback {
    Feedback {
        id: row.get("id"),
        title: row.get("title"),
        body: row.get("body"),
        labels: row.get("labels"),
        kind: row.get("kind"),
        submitted_by: row.get("submitted_by"),
        source: row.get("source"),
        status: row.get("status"),
        response: row.get("response"),
        responded_by: row.get("responded_by"),
        responded_at: row.get("responded_at"),
        duplicate_of: row.get("duplicate_of"),
        github_issue_url: row.get("github_issue_url"),
        github_issue_number: row.get("github_issue_number"),
        sync_status: row.get("sync_status"),
        sync_error: row.get("sync_error"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn feedback_event_from_row(row: &Row) -> FeedbackEvent {
    FeedbackEvent {
        id: row.get("id"),
        event_type: row.get("event_type"),
        from_status: row.get("from_status"),
        to_status: row.get("to_status"),
        message: row.get("message"),
        actor: row.get("actor"),
        created_at: row.get("created_at"),
    }
}

fn validate_choice(field: &str, value: &str, choices: &[&str]) -> Result<(), ApiError> {
    if choices.contains(&value) {
        Ok(())
    } else {
        Err(ApiError::invalid_params(format!(
            "{field} 只能是 {}，收到的是 {value}。",
            choices.join("、")
        )))
    }
}

#[derive(Clone)]
pub struct Github {
    client: reqwest::Client,
    base: String,
    repo: String,
    token: String,
}

impl Github {
    pub fn new(base: &str, repo: &str, token: &str) -> Result<Self, String> {
        let valid_repo = repo.split_once('/').is_some_and(|(owner, name)| {
            !owner.is_empty() && !name.is_empty() && !name.contains('/')
        });
        if !valid_repo {
            return Err("ABEI_GITHUB_REPO 要写成 owner/repo。".to_owned());
        }
        let base = base.trim_end_matches('/');
        if base.is_empty() {
            return Err("ABEI_GITHUB_API_URL 不能为空。".to_owned());
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(GITHUB_TIMEOUT)
                .build()
                .map_err(|error| format!("GitHub HTTP 客户端初始化失败：{error}"))?,
            base: base.to_owned(),
            repo: repo.to_owned(),
            token: token.to_owned(),
        })
    }

    fn from_env() -> Result<Option<Self>, String> {
        let repo = env::var("ABEI_GITHUB_REPO").unwrap_or_default();
        let token = env::var("ABEI_GITHUB_TOKEN").unwrap_or_default();
        if repo.is_empty() && token.is_empty() {
            return Ok(None);
        }
        if repo.is_empty() || token.is_empty() {
            return Err("ABEI_GITHUB_REPO 与 ABEI_GITHUB_TOKEN 必须一起配置。".to_owned());
        }
        let base =
            env::var("ABEI_GITHUB_API_URL").unwrap_or_else(|_| "https://api.github.com".to_owned());
        Self::new(&base, &repo, &token).map(Some)
    }

    async fn sync_issue(&self, feedback: &Feedback) -> Result<GithubIssue, String> {
        let body = github_issue_body(feedback);
        match feedback.github_issue_number {
            Some(number) => {
                self.update_issue(
                    number,
                    &feedback.title,
                    &body,
                    &feedback.labels,
                    &feedback.status,
                )
                .await
            }
            None => {
                self.create_issue(&feedback.title, &body, &feedback.labels)
                    .await
            }
        }
    }

    async fn create_issue(
        &self,
        title: &str,
        body: &str,
        labels: &[String],
    ) -> Result<GithubIssue, String> {
        let response = self
            .client
            .post(format!("{}/repos/{}/issues", self.base, self.repo))
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header(
                "User-Agent",
                concat!("abei-server/", env!("CARGO_PKG_VERSION")),
            )
            .json(&json!({ "title": title, "body": body, "labels": labels }))
            .send()
            .await
            .map_err(|error| format!("GitHub 请求失败：{error}"))?;
        let status = response.status();
        if status != StatusCode::CREATED {
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "GitHub 返回 {status}：{}",
                body.chars().take(300).collect::<String>()
            ));
        }
        response
            .json::<GithubIssue>()
            .await
            .map_err(|error| format!("GitHub 响应不是预期 JSON：{error}"))
    }

    async fn update_issue(
        &self,
        number: i32,
        title: &str,
        body: &str,
        labels: &[String],
        status: &str,
    ) -> Result<GithubIssue, String> {
        let mut payload = json!({
            "title": title,
            "body": body,
            "labels": labels,
            "state": if matches!(status, "completed" | "declined" | "duplicate") {
                "closed"
            } else {
                "open"
            }
        });
        if status == "completed" {
            payload["state_reason"] = json!("completed");
        } else if matches!(status, "declined" | "duplicate") {
            payload["state_reason"] = json!("not_planned");
        }
        let response = self
            .client
            .patch(format!("{}/repos/{}/issues/{number}", self.base, self.repo))
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header(
                "User-Agent",
                concat!("abei-server/", env!("CARGO_PKG_VERSION")),
            )
            .json(&payload)
            .send()
            .await
            .map_err(|error| format!("GitHub 请求失败：{error}"))?;
        let response_status = response.status();
        if response_status != StatusCode::OK {
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "GitHub 返回 {response_status}：{}",
                body.chars().take(300).collect::<String>()
            ));
        }
        response
            .json::<GithubIssue>()
            .await
            .map_err(|error| format!("GitHub 响应不是预期 JSON：{error}"))
    }

    async fn delete_issue(&self, number: i32) -> Result<(), String> {
        let response = self
            .client
            .get(format!("{}/repos/{}/issues/{number}", self.base, self.repo))
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .header(
                "User-Agent",
                concat!("abei-server/", env!("CARGO_PKG_VERSION")),
            )
            .send()
            .await
            .map_err(|error| format!("GitHub 请求失败：{error}"))?;
        let status = response.status();
        if status != StatusCode::OK {
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "GitHub 返回 {status}：{}",
                body.chars().take(300).collect::<String>()
            ));
        }
        let issue = response
            .json::<Value>()
            .await
            .map_err(|error| format!("GitHub issue 响应不是预期 JSON：{error}"))?;
        let node_id = issue
            .get("node_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "GitHub issue 响应缺少 node_id。".to_owned())?;
        let graphql_url = self.base.strip_suffix("/api/v3").map_or_else(
            || format!("{}/graphql", self.base),
            |base| format!("{base}/api/graphql"),
        );
        let response = self
            .client
            .post(graphql_url)
            .bearer_auth(&self.token)
            .header("Accept", "application/vnd.github+json")
            .header(
                "User-Agent",
                concat!("abei-server/", env!("CARGO_PKG_VERSION")),
            )
            .json(&json!({
                "query": "mutation DeleteIssue($issueId: ID!) { deleteIssue(input: { issueId: $issueId }) { clientMutationId } }",
                "variables": { "issueId": node_id }
            }))
            .send()
            .await
            .map_err(|error| format!("GitHub GraphQL 请求失败：{error}"))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status != StatusCode::OK {
            return Err(format!(
                "GitHub GraphQL 返回 {status}：{}",
                text.chars().take(300).collect::<String>()
            ));
        }
        let body: Value = serde_json::from_str(&text)
            .map_err(|error| format!("GitHub GraphQL 响应不是预期 JSON：{error}"))?;
        if body
            .get("errors")
            .and_then(Value::as_array)
            .is_some_and(|errors| !errors.is_empty())
        {
            return Err(format!(
                "GitHub GraphQL 删除失败：{}",
                text.chars().take(300).collect::<String>()
            ));
        }
        body.pointer("/data/deleteIssue")
            .ok_or_else(|| "GitHub GraphQL 删除响应缺少 data.deleteIssue。".to_owned())?;
        Ok(())
    }
}

fn github_issue_body(feedback: &Feedback) -> String {
    let mut body = format!(
        "{}\n\n---\nSubmitted by: `{}`\nSource: `{}`\nStatus: `{}`",
        feedback.body, feedback.submitted_by, feedback.source, feedback.status
    );
    if let Some(response) = &feedback.response {
        body.push_str("\n\nResponse:\n");
        body.push_str(response);
    }
    if let Some(original) = feedback.duplicate_of {
        body.push_str(&format!("\n\nDuplicate of feedback ID `{original}`."));
    }
    body
}

#[derive(Debug, Deserialize)]
struct GithubIssue {
    html_url: String,
    number: i32,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    problem_type: &'static str,
    reason: &'static str,
    title: &'static str,
    message: String,
}

impl ApiError {
    fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            problem_type: "https://abei.local/problems/invalid-params",
            reason: "InvalidParams",
            title: "参数不对",
            message: message.into(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            problem_type: "https://abei.local/problems/not-found",
            reason: "NotFound",
            title: "没找到",
            message: message.into(),
        }
    }

    fn confirmation_required(capability: &'static str) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            problem_type: "https://abei.local/problems/confirmation-required",
            reason: "ConfirmationRequired",
            title: "这一步要人确认",
            message: format!(
                "{capability} 会产生外部或持久化副作用；先带 dry_run=true 预览，再带 confirm=true 执行。"
            ),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            problem_type: "https://abei.local/problems/forbidden",
            reason: "Forbidden",
            title: "没有权限",
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            problem_type: "https://abei.local/problems/conflict",
            reason: "Conflict",
            title: "当前状态不允许这一步",
            message: message.into(),
        }
    }

    fn github(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            problem_type: "https://abei.local/problems/upstream-error",
            reason: "UpstreamError",
            title: "GitHub 同步失败",
            message: message.into(),
        }
    }

    fn oauth(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            problem_type: "https://abei.local/problems/upstream-error",
            reason: "UpstreamError",
            title: "Google OAuth2 失败",
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            problem_type: "https://abei.local/problems/internal",
            reason: "Internal",
            title: "服务内部出错",
            message: message.into(),
        }
    }

    fn database(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "反馈数据库操作失败");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            problem_type: "https://abei.local/problems/internal",
            reason: "Internal",
            title: "服务内部出错",
            message: "数据库操作失败。".to_owned(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(json!({
                "type": self.problem_type,
                "title": self.title,
                "status": self.status.as_u16(),
                "reason": self.reason,
                "detail": self.message,
            })),
        )
            .into_response();
        response.headers_mut().insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/problem+json"),
        );
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, patch, post};
    use tokio::net::TcpListener;

    fn offline_state() -> AppState {
        let mut database = tokio_postgres::Config::new();
        database.host("127.0.0.1").port(1).user("nobody");
        let pool = create_pool(database, 1).unwrap();
        let github = Github::new("http://127.0.0.1:1", "acme/abei", "test-token").unwrap();
        AppState::new(pool, Some(github), mailbox::RuntimeConfig::test())
    }

    async fn spawn_app(app: Router) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    fn valid_feedback() -> Value {
        json!({
            "title": "错误信息不够明确",
            "body": "## 现象\n失败\n## 期望\n指出字段",
            "labels": ["friction"],
            "kind": "friction",
            "submitted_by": "codex",
            "source": "cli"
        })
    }

    #[test]
    fn feedback_validation_names_the_bad_field() {
        let input = CreateFeedback {
            title: " ".to_owned(),
            body: "x".to_owned(),
            labels: vec![],
            kind: "bug".to_owned(),
            submitted_by: "codex".to_owned(),
            source: "cli".to_owned(),
        };
        assert!(input.validate().unwrap_err().message.contains("title"));
    }

    #[tokio::test]
    async fn dry_run_skips_all_side_effects_and_rejections_are_problem_json() {
        let base = spawn_app(build_app(offline_state())).await;
        let client = reqwest::Client::new();
        let response = client
            .post(format!("{base}/v1/feedback?dry_run=true&confirm=true"))
            .header(ACTOR_HEADER, "owner@example.com")
            .header(ROLE_HEADER, "owner")
            .json(&valid_feedback())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["dry_run"], true);
        assert_eq!(body["data"]["source"], "cli");
        assert_eq!(body["data"]["status"], "open");
        assert!(body["data"].get("id").is_none());

        let response = client
            .post(format!("{base}/v1/feedback"))
            .header(ACTOR_HEADER, "owner@example.com")
            .header(ROLE_HEADER, "owner")
            .json(&valid_feedback())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "ConfirmationRequired");

        let response = client
            .post(format!("{base}/v1/feedback?dry_run=maybe"))
            .json(&valid_feedback())
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(response.headers()[CONTENT_TYPE], "application/problem+json");
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "InvalidParams");
        assert_eq!(body["type"], "https://abei.local/problems/invalid-params");

        let response = client
            .get(format!("{base}/v1/feedback/not-an-id"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "InvalidParams");
        assert!(body["type"].as_str().unwrap().ends_with("invalid-params"));
    }

    #[test]
    fn lifecycle_validation_requires_resolution_and_duplicate_context() {
        let completed = UpdateFeedback {
            status: FeedbackStatus::Completed,
            response: None,
            duplicate_of: None,
        };
        assert!(
            completed
                .validate(1)
                .unwrap_err()
                .message
                .contains("response")
        );

        let duplicate = UpdateFeedback {
            status: FeedbackStatus::Duplicate,
            response: None,
            duplicate_of: Some(1),
        };
        assert!(
            duplicate
                .validate(1)
                .unwrap_err()
                .message
                .contains("duplicate_of")
        );
    }

    #[test]
    fn only_owner_may_manage_feedback() {
        let mut headers = HeaderMap::new();
        headers.insert(ACTOR_HEADER, HeaderValue::from_static("demo@example.com"));
        headers.insert(ROLE_HEADER, HeaderValue::from_static("demo"));
        assert_eq!(owner(&headers).unwrap_err().status, StatusCode::FORBIDDEN);
    }

    #[test]
    fn feedback_ids_are_strictly_positive() {
        assert_eq!(feedback_id(Ok(Path("42".to_owned()))).unwrap(), 42);
        for invalid in ["0", "01", "-1", "+1", "abc"] {
            assert!(
                feedback_id(Ok(Path(invalid.to_owned()))).is_err(),
                "{invalid}"
            );
        }
    }

    async fn fake_github(status: StatusCode, body: Value) -> String {
        let app = Router::new().route(
            "/repos/acme/abei/issues",
            post(move || {
                let body = body.clone();
                async move { (status, Json(body)) }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn github_base_is_injectable_for_success_and_failure() {
        let base = fake_github(
            StatusCode::CREATED,
            json!({ "html_url": "https://github.test/acme/abei/issues/7", "number": 7 }),
        )
        .await;
        let github = Github::new(&base, "acme/abei", "test-token").unwrap();
        let issue = github
            .create_issue("title", "body", &["bug".to_owned()])
            .await
            .unwrap();
        assert_eq!(issue.number, 7);

        let base = fake_github(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": "boom" }),
        )
        .await;
        let github = Github::new(&base, "acme/abei", "test-token").unwrap();
        let error = github.create_issue("title", "body", &[]).await.unwrap_err();
        assert!(error.contains("500"), "{error}");
    }

    #[tokio::test]
    async fn github_status_and_delete_calls_use_supported_issue_routes() {
        let app = Router::new()
            .route(
                "/repos/acme/abei/issues/7",
                get(|| async { Json(json!({ "node_id": "I_7" })) }).patch(|| async {
                    Json(json!({
                        "html_url": "https://github.test/acme/abei/issues/7",
                        "number": 7
                    }))
                }),
            )
            .route(
                "/graphql",
                post(|Json(body): Json<Value>| async move {
                    assert_eq!(body["variables"]["issueId"], "I_7");
                    Json(json!({
                        "data": { "deleteIssue": { "clientMutationId": null } }
                    }))
                }),
            );
        let base = spawn_app(app).await;
        let github = Github::new(&base, "acme/abei", "test-token").unwrap();

        let issue = github
            .update_issue(7, "title", "body", &[], "completed")
            .await
            .unwrap();
        assert_eq!(issue.number, 7);
        github.delete_issue(7).await.unwrap();
    }
}
