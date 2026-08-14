use std::env;
use std::net::SocketAddr;

mod billing;
mod feedback;
mod firefly;
mod mail;
pub mod mailbox;
mod migrations;
mod parser;
mod profile_docs;
pub mod reliability;
mod states;
#[cfg(test)]
mod testdb;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header::CONTENT_TYPE};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_postgres::NoTls;

use abei_core::internal_auth::{
    ACTOR_HEADER, Identity, ROLE_HEADER, SIGNATURE_HEADER, USER_ID_HEADER,
};

pub struct ServerConfig {
    pub address: SocketAddr,
    pub database: tokio_postgres::Config,
    pub pool_size: usize,
    pub mailbox: mailbox::RuntimeConfig,
    /// 与 abei-api 之间的共享密钥，用来验可信身份头的签名。
    pub internal_secret: String,
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
        // 没有密钥就没有身份可言：这个进程里的每个接口都只认 abei-api 的签名，
        // 缺配置时宁可起不来，也不能退回到「谁发头就信谁」。
        let internal_secret = env::var("ABEI_INTERNAL_SECRET").unwrap_or_default();
        if internal_secret.trim().is_empty() {
            return Err("ABEI_INTERNAL_SECRET 没有配置，abei-server 无法验证 abei-api 的身份签名。两个服务必须配同一个值。".into());
        }
        abei_core::internal_auth::check_secret(&internal_secret)?;

        Ok(Self {
            address,
            database,
            pool_size,
            mailbox: mailbox::RuntimeConfig::from_env()?,
            internal_secret: internal_secret.trim().to_owned(),
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
    mail: mail::Service,
    mailbox: mailbox::Service,
    parser: parser::Service,
    billing: billing::Service,
    internal_secret: std::sync::Arc<String>,
}

impl AppState {
    pub fn new(pool: Pool, mailbox: mailbox::RuntimeConfig, internal_secret: String) -> Self {
        let mail = mail::Service::new(pool.clone(), mailbox.storage_root().to_path_buf());
        let parser = parser::Service::new(pool.clone(), mail.clone());
        let billing = billing::Service::new(
            pool.clone(),
            mail.clone(),
            parser.clone(),
            mailbox.job_secret_cipher(),
            mailbox.reliability(),
            firefly::Firefly::from_env(),
        );
        let mailbox = mailbox::Service::new(pool.clone(), mailbox, mail.clone(), billing.clone());
        Self {
            pool,
            mail,
            mailbox,
            parser,
            billing,
            internal_secret: std::sync::Arc::new(internal_secret),
        }
    }

    pub fn start_mailbox_scheduler(&self) {
        self.mail.start_cleanup_scheduler();
        self.mailbox.start_scheduler();
        self.billing.start_workers();
    }

    /// 关停时等后台的邮箱同步收尾。见 [`mailbox::Service::drain`]。
    pub async fn drain(&self) {
        self.mailbox.drain().await;
    }
}

pub fn build_app(state: AppState) -> Router {
    Router::new()
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
        .route("/v1/mailboxes", get(mailbox::get_settings))
        .route(
            "/v1/mailboxes/{id}",
            get(mailbox::get_settings).put(mailbox::update_settings),
        )
        .route("/v1/mailboxes/{id}/sync", post(mailbox::sync))
        .route("/v1/mailboxes/{id}/rescan", post(mailbox::rescan))
        .route("/v1/mail-messages", get(mail::api::list_messages))
        .route("/v1/mail-messages/{id}", get(mail::api::get_message))
        .route("/v1/mail-messages/{id}/raw", get(mail::api::raw_message))
        .route(
            "/v1/mail-messages/{id}/cache",
            post(mail::api::cache_message),
        )
        .route(
            "/v1/mail-messages/{id}/reroute",
            post(mail::api::reroute_message),
        )
        .route(
            "/v1/mail-rules",
            get(mail::api::list_rules).post(mail::api::create_rule),
        )
        .route("/v1/mail-rules/test", post(mail::api::test_rule))
        .route(
            "/v1/mail-rules/{id}",
            axum::routing::patch(mail::api::update_rule),
        )
        .route("/v1/mail-rules/{id}/publish", post(mail::api::publish_rule))
        .route(
            "/v1/mail-rules/{id}/rollback",
            post(mail::api::rollback_rule),
        )
        .route(
            "/v1/mail-samples",
            get(mail::api::list_samples).post(mail::api::create_sample),
        )
        .route("/v1/mail-samples/{id}", delete(mail::api::delete_sample))
        .route("/v1/mail-sync-runs", get(mail::api::list_sync_runs))
        .route("/v1/mail-sync-runs/{id}", get(mail::api::get_sync_run))
        .route(
            "/v1/mail-sync-runs/{id}/cancel",
            post(mail::api::cancel_sync_run),
        )
        .route("/v1/bill-documents", get(billing::api::list_documents))
        .route("/v1/bill-documents/{id}", get(billing::api::get_document))
        .route(
            "/v1/bill-documents/{id}/revisions",
            get(billing::api::document_revisions),
        )
        .route(
            "/v1/bill-documents/{id}/artifacts",
            get(billing::api::document_artifacts),
        )
        .route(
            "/v1/bill-documents/{id}/events",
            get(billing::api::document_events),
        )
        .route(
            "/v1/bill-artifacts/{id}/download",
            get(billing::api::download_artifact),
        )
        .route(
            "/v1/bill-documents/{id}/review",
            get(billing::api::document_review),
        )
        .route(
            "/v1/bill-documents/{id}/reparse",
            post(billing::api::reparse_document),
        )
        .route(
            "/v1/bill-documents/{id}/archive",
            post(billing::api::archive_document),
        )
        .route(
            "/v1/bill-documents/{id}/restore",
            post(billing::api::restore_document),
        )
        .route("/v1/parse-jobs/{id}", get(billing::api::get_parse_job))
        .route(
            "/v1/parse-jobs/{id}/retry",
            post(billing::api::retry_parse_job),
        )
        .route(
            "/v1/parse-jobs/{id}/cancel",
            post(billing::api::cancel_parse_job),
        )
        .route(
            "/v1/parse-jobs/{id}/secret",
            post(billing::api::submit_job_secret),
        )
        .route("/v1/bill-rows", get(billing::api::list_rows))
        .route("/v1/bill-rows/dismiss", post(billing::api::dismiss_rows))
        .route("/v1/bill-rows/restore", post(billing::api::restore_rows))
        .route(
            "/v1/bill-rows/{id}",
            get(billing::api::get_row).patch(billing::api::update_row),
        )
        .route(
            "/v1/bill-rows/update-many",
            axum::routing::patch(billing::api::update_rows_many),
        )
        .route("/v1/bill-rows/{id}/split", post(billing::api::split_row))
        .route(
            "/v1/bill-rows/{id}/mark-unique",
            post(billing::api::mark_row_unique),
        )
        .route("/v1/bill-inbox/summary", get(billing::api::inbox_summary))
        .route(
            "/v1/bill-import-attempts/{id}",
            get(billing::api::get_import_attempt),
        )
        .route(
            "/internal/v1/bill-imports/run",
            post(billing::api::run_import),
        )
        .route(
            "/internal/v1/bill-imports/prepare",
            post(billing::api::prepare_import),
        )
        .route(
            "/internal/v1/bill-imports/{id}/mark-sending",
            post(billing::api::mark_import_sending),
        )
        .route(
            "/internal/v1/bill-imports/{id}/complete",
            post(billing::api::complete_import),
        )
        .route(
            "/internal/v1/bill-imports/{id}/reject",
            post(billing::api::fail_import),
        )
        .route(
            "/internal/v1/bill-imports/{id}/uncertain",
            post(billing::api::mark_import_uncertain),
        )
        .route(
            "/internal/v1/bill-imports/{id}/release",
            post(billing::api::release_uncertain_import),
        )
        .route(
            "/v1/bill-account-mappings",
            get(billing::api::list_account_mappings).put(billing::api::upsert_account_mapping),
        )
        .route(
            "/v1/bill-account-mappings/{id}",
            delete(billing::api::delete_account_mapping),
        )
        .route("/v1/bills", get(billing::api::list_documents))
        .route("/v1/bills/{id}", get(billing::api::get_document))
        .route("/v1/bills/{id}/review", get(billing::api::document_review))
        .route("/v1/bills/{id}/rows", get(billing::api::document_rows))
        .route(
            "/v1/bills/{id}/artifacts",
            get(billing::api::document_artifacts),
        )
        .route("/v1/bills/{id}/events", get(billing::api::document_events))
        .route(
            "/v1/bills/{id}/retry",
            post(billing::api::retry_document_job),
        )
        .route(
            "/v1/bills/{id}/unlock",
            post(billing::api::submit_document_secret),
        )
        .route(
            "/v1/bills/{id}/ignore",
            post(billing::api::archive_document),
        )
        .route(
            "/v1/bills/{id}/archive",
            post(billing::api::archive_document),
        )
        .route("/v1/parser-flows/validate", post(parser::api::validate))
        .route(
            "/v1/parser-flows/test-eml",
            post(parser::api::test_eml_source).layer(DefaultBodyLimit::max(26 * 1024 * 1024)),
        )
        .route(
            "/v1/parser-flows",
            get(parser::api::list).post(parser::api::create),
        )
        .route(
            "/v1/parser-flows/{id}",
            get(parser::api::get).patch(parser::api::update),
        )
        .route("/v1/parser-flows/{id}/clone", post(parser::api::clone_flow))
        .route("/v1/parser-flows/{id}/test", post(parser::api::test))
        .route(
            "/v1/parser-flows/{id}/test-eml",
            post(parser::api::test_eml).layer(DefaultBodyLimit::max(26 * 1024 * 1024)),
        )
        .route("/v1/parser-flows/{id}/publish", post(parser::api::publish))
        .route(
            "/v1/parser-flows/{id}/rollback",
            post(parser::api::rollback),
        )
        .route("/v1/parser-flows/{id}/retire", post(parser::api::retire))
        .route("/v1/parser-flows/{id}/versions", get(parser::api::versions))
        .route(
            "/v1/parser-flows/{id}/versions/{version}",
            get(parser::api::version),
        )
        .route(
            "/v1/parser-flows/{id}/test-cases",
            post(parser::api::create_test_case),
        )
        .route(
            "/v1/parser-test-cases/{id}",
            axum::routing::patch(parser::api::update_test_case)
                .delete(parser::api::delete_test_case),
        )
        .route("/v1/parser-test-runs/{id}", get(parser::api::test_run))
        .route(
            "/v1/profile-doc",
            get(profile_docs::list).post(profile_docs::create),
        )
        .route(
            "/v1/profile-doc/{slug}",
            get(profile_docs::get)
                .patch(profile_docs::update)
                .delete(profile_docs::delete),
        )
        .route("/v1/feedback", post(feedback::create).get(feedback::list))
        .route("/v1/feedback/{id}", get(feedback::get))
        .route(
            "/v1/feedback/submissions/{id}/confirm",
            post(feedback::confirm),
        )
        .route(
            "/v1/feedback/submissions/{id}/messages",
            post(feedback::reply),
        )
        .route(
            "/v1/admin/feedback/submissions",
            get(feedback::admin_list_submissions),
        )
        .route(
            "/v1/admin/feedback/submissions/{id}",
            get(feedback::admin_get_submission).patch(feedback::admin_update_submission),
        )
        .route(
            "/v1/admin/feedback/submissions/{id}/link",
            post(feedback::admin_link_submission),
        )
        .route(
            "/v1/admin/feedback/submissions/{id}/messages",
            post(feedback::admin_message_submission),
        )
        .route("/v1/admin/feedback/items", get(feedback::admin_list_items))
        .route(
            "/v1/admin/feedback/items/{id}",
            get(feedback::admin_get_item).patch(feedback::admin_update_item),
        )
        .route(
            "/v1/admin/feedback/items/{id}/updates",
            post(feedback::admin_publish_update),
        )
        .route(
            "/v1/admin/feedback/items/{id}/merge",
            post(feedback::admin_merge_item),
        )
        .route(
            "/v1/admin/feedback/items/{id}/archive",
            post(feedback::admin_archive_item),
        )
        .route(
            "/v1/admin/feedback/items/{id}/restore",
            post(feedback::admin_restore_item),
        )
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .route_layer(axum::middleware::from_fn_with_state(
            state.clone(),
            verify_internal_signature,
        ))
        // /health 挂在验签之后，运维探活不需要身份。它不碰数据库也不返回任何用户数据。
        .route("/health", get(health))
        .with_state(state)
}

/// 验 abei-api 的身份签名。没有它，任何能连上本进程端口的东西都可以自称任意用户。
///
/// 验过之后把三个身份头按签名内容重写一遍：请求里可能带着同名的第二个值，
/// 留着的话后面 `headers.get()` 读到哪个就说不准了。
async fn verify_internal_signature(
    State(state): State<AppState>,
    mut request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    let headers = request.headers();
    let text = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    let identity = Identity::new(
        text(ACTOR_HEADER),
        text(ROLE_HEADER),
        text(USER_ID_HEADER).parse::<i64>().unwrap_or_default(),
    );
    let signature = headers
        .get(SIGNATURE_HEADER)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();

    if signature.is_empty() {
        return unauthenticated(abei_core::internal_auth::VerifyError::Missing);
    }
    if let Err(error) =
        abei_core::internal_auth::verify(state.internal_secret.as_bytes(), &identity, &signature)
    {
        return unauthenticated(error);
    }

    let headers = request.headers_mut();
    headers.remove(SIGNATURE_HEADER);
    if let (Ok(actor), Ok(role), Ok(user_id)) = (
        HeaderValue::from_str(&identity.actor),
        HeaderValue::from_str(&identity.role),
        HeaderValue::from_str(&identity.user_id.to_string()),
    ) {
        headers.insert(ACTOR_HEADER, actor);
        headers.insert(ROLE_HEADER, role);
        headers.insert(USER_ID_HEADER, user_id);
    } else {
        return unauthenticated(abei_core::internal_auth::VerifyError::Malformed);
    }
    request.extensions_mut().insert(identity);
    next.run(request).await
}

/// 测试用的内部签名密钥。各测试模块共用一份，别在别处再造一个。
#[cfg(test)]
pub(crate) const TEST_SECRET: &str = "abei-server-test-internal-secret-0123456789";

/// 按测试实际发出的那几个身份头算签名——签名覆盖三个值，少发一个就得跟着少签一个。
#[cfg(test)]
pub(crate) fn test_signature(actor: &str, role: &str, user_id: i64) -> String {
    abei_core::internal_auth::sign(TEST_SECRET.as_bytes(), &Identity::new(actor, role, user_id))
}

/// 建一个只属于测试的 Firefly 用户。
///
/// `public.users` 是 Firefly 建的表：`id` 是 int4，`email` 和 `password` 都非空且没有默认值，
/// 所以既要把 i64 显式降到 bigint 再交给 Postgres 做赋值转换，也得把两个必填列填上。
/// 各测试模块以前各自抄了一份只写 `id` 的插入语句，从来没插进去过，统一收到这里。
#[cfg(test)]
pub(crate) async fn ensure_test_user(client: &deadpool_postgres::Client, user_id: i64) {
    client
        .execute(
            "DELETE FROM public.users WHERE id = $1::bigint",
            &[&user_id],
        )
        .await
        .unwrap();
    client
        .execute(
            "INSERT INTO public.users (id, email, password)
             VALUES ($1::bigint, 'abei-test-' || $1::text || '@example.invalid', '')",
            &[&user_id],
        )
        .await
        .unwrap();
}

/// 收掉 [`ensure_test_user`] 建的用户；`abei_ai` 里挂在它名下的行会跟着级联删掉。
#[cfg(test)]
pub(crate) async fn remove_test_user(client: &deadpool_postgres::Client, user_id: i64) {
    client
        .execute(
            "DELETE FROM public.users WHERE id = $1::bigint",
            &[&user_id],
        )
        .await
        .unwrap();
}

fn unauthenticated(error: abei_core::internal_auth::VerifyError) -> Response {
    tracing::warn!(reason = %error, "拒绝了一个没有可信签名的请求");
    ApiError::unauthenticated(format!("{error}。abei-server 只接受 abei-api 转发的请求。"))
        .into_response()
}

pub async fn initialize(pool: &Pool) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let client = pool.get().await?;
    client
        .batch_execute(
            r#"
            CREATE SCHEMA IF NOT EXISTS abei_ai;
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
            CREATE TABLE IF NOT EXISTS abei_ai.profile_docs (
              user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
              slug VARCHAR(64) NOT NULL,
              title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
              content_md TEXT NOT NULL CHECK (octet_length(content_md) <= 1048576),
              version INTEGER NOT NULL CHECK (version > 0),
              content_sha256 CHAR(64) NOT NULL,
              updated_by TEXT NOT NULL,
              updated_source TEXT NOT NULL CHECK (updated_source IN ('cli', 'web')),
              created_at timestamptz NOT NULL DEFAULT now(),
              updated_at timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (user_id, slug),
              CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$')
            );
            CREATE TABLE IF NOT EXISTS abei_ai.profile_doc_revisions (
              user_id BIGINT NOT NULL,
              slug VARCHAR(64) NOT NULL,
              version INTEGER NOT NULL CHECK (version > 0),
              title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
              content_md TEXT NOT NULL CHECK (octet_length(content_md) <= 1048576),
              content_sha256 CHAR(64) NOT NULL,
              updated_by TEXT NOT NULL,
              updated_source TEXT NOT NULL CHECK (updated_source IN ('cli', 'web')),
              created_at timestamptz NOT NULL DEFAULT now(),
              PRIMARY KEY (user_id, slug, version),
              FOREIGN KEY (user_id, slug) REFERENCES abei_ai.profile_docs (user_id, slug)
            );
            "#,
        )
        .await?;
    feedback::initialize(&client).await?;
    drop(client);
    migrations::run(pool).await?;
    parser::install_builtins(pool).await?;
    Ok(())
}

async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "abei-server",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct WriteGate {
    dry_run: bool,
    confirm: bool,
}

impl WriteGate {
    pub(crate) fn require_confirmation(&self, capability: &'static str) -> Result<(), ApiError> {
        if self.confirm {
            Ok(())
        } else {
            Err(ApiError::confirmation_required(capability))
        }
    }
}

#[derive(Debug)]
pub(crate) struct Actor {
    pub(crate) name: String,
    pub(crate) role: String,
}

pub(crate) fn actor(headers: &HeaderMap) -> Result<Actor, ApiError> {
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

pub(crate) fn authenticated_user_id(headers: &HeaderMap) -> Result<i64, ApiError> {
    headers
        .get(USER_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| ApiError::forbidden("缺少可信的 Firefly 用户 ID。"))
}

/// 只放 Firefly 站点属主进来。
///
/// 目前只有 `/v1/admin/feedback/*` 用它，这不是漏加：本服务其余资源都是按用户隔离的，
/// 不存在「一个人改了、所有人受影响」的东西。邮件规则带 `user_id`，解析流程带
/// `owner_user_id`，写路径一律 `WHERE ... = $1`；内置流程（`owner_user_id IS NULL`）
/// 谁都能看能克隆，但没有任何接口能改它，用户新建的流程也只会挂在自己名下。
///
/// 所以给邮件规则或解析流程加 owner 是错的——那会把用户自己的解析配置锁死。
/// 将来真出现全局配置（比如所有人共享的渠道规则），才是这个函数的用武之地。
pub(crate) fn owner(headers: &HeaderMap) -> Result<Actor, ApiError> {
    let actor = actor(headers)?;
    if actor.role == "owner" {
        Ok(actor)
    } else {
        Err(ApiError::forbidden("只有 Firefly owner 可以管理反馈。"))
    }
}

#[derive(Debug)]
pub(crate) struct ApiError {
    status: StatusCode,
    problem_type: &'static str,
    reason: &'static str,
    title: &'static str,
    message: String,
}

impl ApiError {
    pub(crate) fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            problem_type: "https://abei.local/problems/invalid-params",
            reason: "InvalidParams",
            title: "参数不对",
            message: message.into(),
        }
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            problem_type: "https://abei.local/problems/not-found",
            reason: "NotFound",
            title: "没找到",
            message: message.into(),
        }
    }

    pub(crate) fn confirmation_required(capability: &'static str) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            problem_type: "https://abei.local/problems/confirmation-required",
            reason: "ConfirmationRequired",
            title: "这一步要人确认",
            message: format!(
                "{capability} 会产生持久化副作用；先带 dry_run=true 预览，再带 confirm=true 执行。"
            ),
        }
    }

    pub(crate) fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            problem_type: "https://abei.local/problems/forbidden",
            reason: "Forbidden",
            title: "没有权限",
            message: message.into(),
        }
    }

    /// 请求没有通过内部签名校验。和 403 分开：403 是身份可信但权限不够。
    pub(crate) fn unauthenticated(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            problem_type: "https://abei.local/problems/unauthenticated",
            reason: "Unauthenticated",
            title: "身份不可信",
            message: message.into(),
        }
    }

    pub(crate) fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            problem_type: "https://abei.local/problems/conflict",
            reason: "Conflict",
            title: "当前状态不允许这一步",
            message: message.into(),
        }
    }

    pub(crate) fn oauth(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            problem_type: "https://abei.local/problems/upstream-error",
            reason: "UpstreamError",
            title: "Google OAuth2 失败",
            message: message.into(),
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            problem_type: "https://abei.local/problems/internal",
            reason: "Internal",
            title: "服务内部出错",
            message: message.into(),
        }
    }

    pub(crate) fn database(error: impl std::fmt::Display) -> Self {
        tracing::error!(%error, "数据库操作失败");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            problem_type: "https://abei.local/problems/internal",
            reason: "Internal",
            title: "服务内部出错",
            message: "数据库操作失败。".to_owned(),
        }
    }

    /// 上游（目前只有 Firefly）没给出可用结果。502 而不是 500：错不在我们这边。
    pub(crate) fn upstream(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            problem_type: "https://abei.local/problems/upstream-error",
            reason: "UpstreamError",
            title: "上游服务出错",
            message: message.into(),
        }
    }

    /// 把 `reason` 换成更具体的机器码。
    ///
    /// `reason` 原先只有八个值，全由构造函数决定——前端想区分「账户没映射」和「金额非法」
    /// 只能去匹配中文 detail 文案。这里允许调用方在保持 HTTP 状态码和文案不变的前提下，
    /// 换上一个具体的码（`account_unmapped`、`import_in_flight`……）。
    /// detail 一个字都不动，老前端的字符串匹配照旧能跑。
    pub(crate) fn with_reason(mut self, reason: &'static str) -> Self {
        self.reason = reason;
        self
    }

    /// 给人看的那句话。入账 saga 要把单条流水的失败原因塞进结果行里，而不是让
    /// 整批请求以这个错误收场。
    pub(crate) fn detail(&self) -> String {
        self.message.clone()
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

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    fn offline_state() -> AppState {
        let mut database = tokio_postgres::Config::new();
        database.host("127.0.0.1").port(1).user("nobody");
        let pool = create_pool(database, 1).unwrap();
        AppState::new(pool, mailbox::RuntimeConfig::test(), TEST_SECRET.to_owned())
    }

    async fn spawn_app(app: Router) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn profile_dry_run_accepts_the_full_markdown_limit_without_a_database_write() {
        let base = spawn_app(build_app(offline_state())).await;
        let content = "\n".repeat(1024 * 1024);
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/profile-doc?dry_run=true"))
            .header(ACTOR_HEADER, "owner@example.com")
            .header(ROLE_HEADER, "owner")
            .header(USER_ID_HEADER, "1")
            .header(
                SIGNATURE_HEADER,
                test_signature("owner@example.com", "owner", 1),
            )
            .json(&json!({
                "slug": "personal-accounting-rules",
                "title": "个人记账规则",
                "content_md": content,
                "source": "web"
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["dry_run"], true);
        assert_eq!(body["data"]["content_bytes"], 1024 * 1024);
    }

    #[tokio::test]
    async fn profile_delete_requires_confirmation_before_database_access() {
        let base = spawn_app(build_app(offline_state())).await;
        let response = reqwest::Client::new()
            .delete(format!("{base}/v1/profile-doc/personal-accounting-rules"))
            .header(USER_ID_HEADER, "1")
            .header(SIGNATURE_HEADER, test_signature("", "", 1))
            .json(&json!({ "expected_version": 3 }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "ConfirmationRequired");
    }

    #[tokio::test]
    async fn mail_rule_dry_run_validates_without_a_database_write() {
        let base = spawn_app(build_app(offline_state())).await;
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/mail-rules?dry_run=true"))
            .header(USER_ID_HEADER, "1")
            .header(SIGNATURE_HEADER, test_signature("", "", 1))
            .json(&json!({
                "name": "中信银行账单",
                "enabled": true,
                "position": 10,
                "channel_key": "citic",
                "parser_flow_id": null,
                "conditions": {
                    "type": "all",
                    "conditions": [{
                        "type": "text",
                        "field": "from",
                        "operator": "domain",
                        "value": "citicbank.com",
                    }]
                }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["dry_run"], true);
        assert_eq!(body["data"]["channel_key"], "citic");
    }

    #[tokio::test]
    async fn mail_rule_publish_requires_confirmation_before_database_access() {
        let base = spawn_app(build_app(offline_state())).await;
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/mail-rules/42/publish"))
            .header(ACTOR_HEADER, "owner@example.com")
            .header(USER_ID_HEADER, "1")
            .header(SIGNATURE_HEADER, test_signature("owner@example.com", "", 1))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "ConfirmationRequired");
    }

    #[tokio::test]
    async fn pending_account_mapping_ids_cannot_be_deleted() {
        let base = spawn_app(build_app(offline_state())).await;
        let response = reqwest::Client::new()
            .delete(format!(
                "{base}/v1/bill-account-mappings/pending:cmb:card?confirm=true"
            ))
            .header(USER_ID_HEADER, "1")
            .header(SIGNATURE_HEADER, test_signature("", "", 1))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "InvalidParams");
        assert_eq!(body["detail"], "资源 id 必须是正整数。");
    }

    #[tokio::test]
    async fn requests_without_a_signature_are_rejected() {
        let base = spawn_app(build_app(offline_state())).await;
        let response = reqwest::Client::new()
            .get(format!("{base}/v1/mail-messages"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "Unauthenticated");
    }

    /// 每个模块挑一条，外加 `/internal` 和 `/admin`：验签是挂在整个 router 上的，
    /// 将来谁新增一条路由忘了鉴权，这里会连带塌掉一片。
    #[tokio::test]
    async fn every_module_is_behind_the_signature_check() {
        let base = spawn_app(build_app(offline_state())).await;
        let client = reqwest::Client::new();
        let cases: [(&str, &str); 10] = [
            ("GET", "/v1/mailboxes"),
            ("GET", "/v1/mail-messages"),
            ("GET", "/v1/mail-rules"),
            ("GET", "/v1/parser-flows"),
            ("GET", "/v1/bill-documents"),
            ("GET", "/v1/bill-rows"),
            ("GET", "/v1/profile-doc"),
            ("GET", "/v1/feedback"),
            ("GET", "/v1/admin/feedback/items"),
            ("POST", "/internal/v1/bill-imports/prepare"),
        ];
        for (method, path) in cases {
            let request = match method {
                "POST" => client.post(format!("{base}{path}")).json(&json!({})),
                _ => client.get(format!("{base}{path}")),
            };
            let response = request.send().await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{method} {path} 没有被验签挡住"
            );
        }
    }

    #[tokio::test]
    async fn forged_identity_headers_without_a_signature_are_rejected() {
        let base = spawn_app(build_app(offline_state())).await;
        // 这正是这层中间件要挡的事：直接连上端口，自称是 1 号用户。
        let response = reqwest::Client::new()
            .get(format!("{base}/v1/mail-messages"))
            .header(ACTOR_HEADER, "attacker@example.com")
            .header(ROLE_HEADER, "owner")
            .header(USER_ID_HEADER, "1")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_signature_does_not_carry_over_to_a_different_user() {
        let base = spawn_app(build_app(offline_state())).await;
        // 拿 1 号用户的合法签名去冒充 2 号用户：签名覆盖 user_id，所以对不上。
        let response = reqwest::Client::new()
            .get(format!("{base}/v1/mail-messages"))
            .header(ACTOR_HEADER, "owner@example.com")
            .header(ROLE_HEADER, "owner")
            .header(USER_ID_HEADER, "2")
            .header(
                SIGNATURE_HEADER,
                test_signature("owner@example.com", "owner", 1),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn a_correctly_signed_request_reaches_the_handler() {
        let base = spawn_app(build_app(offline_state())).await;
        let response = reqwest::Client::new()
            .get(format!("{base}/v1/mail-messages"))
            .header(ACTOR_HEADER, "owner@example.com")
            .header(ROLE_HEADER, "owner")
            .header(USER_ID_HEADER, "1")
            .header(
                SIGNATURE_HEADER,
                test_signature("owner@example.com", "owner", 1),
            )
            .send()
            .await
            .unwrap();
        // 过了验签就轮到 handler，这个 state 连不上库，所以是 5xx 而不是 401。
        assert_ne!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(response.status().is_server_error());
    }

    #[tokio::test]
    async fn health_needs_no_signature() {
        let base = spawn_app(build_app(offline_state())).await;
        let response = reqwest::Client::new()
            .get(format!("{base}/health"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn raw_mail_requires_a_trusted_user_identity() {
        let base = spawn_app(build_app(offline_state())).await;
        let response = reqwest::Client::new()
            .get(format!("{base}/v1/mail-messages/42/raw"))
            .send()
            .await
            .unwrap();
        // 裸请求现在被验签中间件挡在更前面，连不上身份就是 401 而不是 403。
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn one_time_eml_upload_runs_without_a_database_record() {
        let base = spawn_app(build_app(offline_state())).await;
        let flow = r#"schema_version: 1
channel_key: demo
nodes:
  - id: select
    type: select_text_body
  - id: lines
    type: text_lines
    field: description
  - id: facts
    type: set_constant
    values:
      occurred_at: "2026-08-11 10:00:00"
      signed_amount: "-12.50"
      currency_code: CNY
  - id: normalize
    type: normalize_bill_rows
"#;
        let eml = "From: bank@example.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCoffee";
        let boundary = "abei-test-eml";
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"source_yaml\"\r\n\r\n{flow}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"eml\"; filename=\"sample.eml\"\r\nContent-Type: message/rfc822\r\n\r\n{eml}\r\n--{boundary}--\r\n"
        );
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/parser-flows/test-eml"))
            .header(USER_ID_HEADER, "1")
            .header(SIGNATURE_HEADER, test_signature("", "", 1))
            .header(
                CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["data"]["run_id"], Value::Null);
        assert_eq!(body["data"]["output"]["metrics"]["valid_rows"], 1);
    }

    #[tokio::test]
    async fn eml_upload_route_overrides_the_global_eight_mib_limit() {
        let base = spawn_app(build_app(offline_state())).await;
        let boundary = "abei-large-eml";
        let oversized_yaml = "x".repeat(9 * 1024 * 1024);
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"source_yaml\"\r\n\r\n{oversized_yaml}\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"eml\"; filename=\"sample.eml\"\r\n\r\nFrom: bank@example.com\r\n\r\nhello\r\n--{boundary}--\r\n"
        );
        let response = reqwest::Client::new()
            .post(format!("{base}/v1/parser-flows/test-eml"))
            .header(USER_ID_HEADER, "1")
            .header(SIGNATURE_HEADER, test_signature("", "", 1))
            .header(
                CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: Value = response.json().await.unwrap();
        assert_eq!(body["reason"], "InvalidParams");
        assert!(body["detail"].as_str().unwrap().contains("256 KiB"));
    }

    #[test]
    fn only_owner_can_enter_feedback_admin() {
        let mut headers = HeaderMap::new();
        headers.insert(ACTOR_HEADER, HeaderValue::from_static("demo@example.com"));
        headers.insert(ROLE_HEADER, HeaderValue::from_static("demo"));
        assert_eq!(owner(&headers).unwrap_err().status, StatusCode::FORBIDDEN);
    }
}
