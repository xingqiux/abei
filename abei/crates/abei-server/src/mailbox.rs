use std::collections::BTreeMap;
use std::env;
use std::fmt;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use async_http_proxy::{http_connect_tokio, http_connect_tokio_with_basic_auth};
use async_imap::imap_proto::types::{BodyContentCommon, BodyStructure};
use async_imap::types::Mailbox as ImapMailbox;
use async_imap::{Authenticator, Client, Session};
use axum::Json;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
// std 的 Path 在这个文件里是文件路径，axum 的换个名字，免得两个 Path 打架。
use axum::extract::{Path as PathParam, Query, State};
use axum::http::{HeaderMap, StatusCode};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, Generate, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use deadpool_postgres::Pool;
use futures_util::TryStreamExt;
use mail_parser::{MessageParser, MimeHeaders};
use oauth2::basic::BasicClient;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, EndpointNotSet, EndpointSet,
    PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, RefreshToken, RevocationUrl, Scope,
    StandardRevocableToken, TokenResponse, TokenUrl,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{Date, OffsetDateTime};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};

use crate::states::SyncRunStatus;
use crate::{ApiError, AppState, WriteGate, authenticated_user_id};

const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL: &str = "https://openidconnect.googleapis.com/v1/userinfo";
const GOOGLE_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";

type GoogleClient =
    BasicClient<EndpointSet, EndpointNotSet, EndpointNotSet, EndpointSet, EndpointSet>;

#[derive(Clone)]
pub struct RuntimeConfig {
    storage_root: PathBuf,
    password_cipher: SecretCipher,
    oauth_refresh_cipher: SecretCipher,
    oauth_state_cipher: SecretCipher,
    job_secret_cipher: SecretCipher,
    google_oauth: Option<GoogleOAuth>,
    operation_timeout: Duration,
    pub sync_interval: Duration,
    reliability: crate::reliability::ReliabilityConfig,
}

impl RuntimeConfig {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let storage_root = env::var("ABEI_MAIL_STORAGE")
            .map(PathBuf::from)
            .map_err(|_| "ABEI_MAIL_STORAGE 没有配置")?;
        let app_key = env::var("APP_KEY").map_err(|_| "APP_KEY 没有配置，邮箱密码无法加密")?;
        if app_key.len() < 16 {
            return Err("APP_KEY 至少需要 16 个字符".into());
        }
        let operation_timeout = Duration::from_secs(env_u64("ABEI_MAIL_TIMEOUT_SECONDS", 60)?);
        let sync_interval = Duration::from_secs(env_u64("ABEI_MAIL_SYNC_INTERVAL", 300)?);
        if operation_timeout.is_zero() || sync_interval.is_zero() {
            return Err("邮箱超时和同步间隔必须大于 0".into());
        }
        let google_oauth = GoogleOAuth::from_env(operation_timeout)?;

        Ok(Self {
            storage_root,
            password_cipher: SecretCipher::new(&app_key, b"abei-server/mailbox-password/v1\0"),
            oauth_refresh_cipher: SecretCipher::new(
                &app_key,
                b"abei-server/google-refresh-token/v1\0",
            ),
            oauth_state_cipher: SecretCipher::new(&app_key, b"abei-server/google-oauth-state/v1\0"),
            job_secret_cipher: SecretCipher::new(&app_key, b"abei-server/parse-job-secret/v1\0"),
            google_oauth,
            operation_timeout,
            sync_interval,
            reliability: crate::reliability::ReliabilityConfig::from_env()?,
        })
    }

    pub(crate) fn reliability(&self) -> crate::reliability::ReliabilityConfig {
        self.reliability
    }

    pub(crate) fn storage_root(&self) -> &Path {
        &self.storage_root
    }

    pub(crate) fn job_secret_cipher(&self) -> SecretCipher {
        self.job_secret_cipher.clone()
    }

    #[cfg(test)]
    pub(crate) fn test() -> Self {
        Self {
            storage_root: std::env::temp_dir().join("abei-server-mailbox-tests"),
            password_cipher: SecretCipher::new(
                "test-app-key-that-is-long-enough",
                b"abei-server/mailbox-password/v1\0",
            ),
            oauth_refresh_cipher: SecretCipher::new(
                "test-app-key-that-is-long-enough",
                b"abei-server/google-refresh-token/v1\0",
            ),
            oauth_state_cipher: SecretCipher::new(
                "test-app-key-that-is-long-enough",
                b"abei-server/google-oauth-state/v1\0",
            ),
            job_secret_cipher: SecretCipher::new(
                "test-app-key-that-is-long-enough",
                b"abei-server/parse-job-secret/v1\0",
            ),
            google_oauth: None,
            operation_timeout: Duration::from_secs(2),
            sync_interval: Duration::from_secs(300),
            reliability: crate::reliability::ReliabilityConfig::test(),
        }
    }
}

fn env_u64(
    name: &'static str,
    default: u64,
) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
    Ok(env::var(name)
        .unwrap_or_else(|_| default.to_string())
        .parse::<u64>()?)
}

#[derive(Clone)]
struct GoogleOAuth {
    client: GoogleClient,
    http: reqwest::Client,
}

impl GoogleOAuth {
    fn from_env(duration: Duration) -> Result<Option<Self>, String> {
        let client_id = env::var("GOOGLE_OAUTH_CLIENT_ID").unwrap_or_default();
        let client_secret = env::var("GOOGLE_OAUTH_CLIENT_SECRET").unwrap_or_default();
        let redirect_url = env::var("GOOGLE_OAUTH_REDIRECT_URL").unwrap_or_default();
        if client_id.is_empty() && client_secret.is_empty() {
            return Ok(None);
        }
        if client_id.is_empty() || client_secret.is_empty() || redirect_url.is_empty() {
            return Err(
                "GOOGLE_OAUTH_CLIENT_ID、GOOGLE_OAUTH_CLIENT_SECRET、GOOGLE_OAUTH_REDIRECT_URL 必须一起配置"
                    .to_owned(),
            );
        }

        let client = BasicClient::new(ClientId::new(client_id))
            .set_client_secret(ClientSecret::new(client_secret))
            .set_auth_uri(AuthUrl::new(GOOGLE_AUTH_URL.to_owned()).map_err(display)?)
            .set_token_uri(TokenUrl::new(GOOGLE_TOKEN_URL.to_owned()).map_err(display)?)
            .set_revocation_url(RevocationUrl::new(GOOGLE_REVOKE_URL.to_owned()).map_err(display)?)
            .set_redirect_uri(RedirectUrl::new(redirect_url).map_err(display)?);
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(duration)
            .build()
            .map_err(display)?;
        Ok(Some(Self { client, http }))
    }

    fn authorization_url(&self, state: String, challenge: PkceCodeChallenge) -> String {
        self.client
            .authorize_url(|| CsrfToken::new(state))
            .add_scope(Scope::new("openid".to_owned()))
            .add_scope(Scope::new("email".to_owned()))
            .add_scope(Scope::new("https://mail.google.com/".to_owned()))
            .add_extra_param("access_type", "offline")
            .add_extra_param("prompt", "consent select_account")
            .set_pkce_challenge(challenge)
            .url()
            .0
            .to_string()
    }

    async fn exchange_code(
        &self,
        code: String,
        verifier: String,
    ) -> Result<(String, String), String> {
        let response = self
            .client
            .exchange_code(AuthorizationCode::new(code))
            .set_pkce_verifier(PkceCodeVerifier::new(verifier))
            .request_async(&self.http)
            .await
            .map_err(|error| format!("Google 授权码交换失败：{error}"))?;
        let refresh_token = response
            .refresh_token()
            .ok_or_else(|| "Google 没有返回 refresh token，请重新授权。".to_owned())?;
        Ok((
            response.access_token().secret().to_owned(),
            refresh_token.secret().to_owned(),
        ))
    }

    async fn refresh_access_token(&self, refresh_token: &str) -> Result<String, String> {
        let refresh_token = RefreshToken::new(refresh_token.to_owned());
        self.client
            .exchange_refresh_token(&refresh_token)
            .request_async(&self.http)
            .await
            .map(|response| response.access_token().secret().to_owned())
            .map_err(|error| format!("Google access token 刷新失败，请重新连接 Google：{error}"))
    }

    async fn email(&self, access_token: &str) -> Result<String, String> {
        let response = self
            .http
            .get(GOOGLE_USERINFO_URL)
            .bearer_auth(access_token)
            .send()
            .await
            .map_err(|error| format!("读取 Google 账号失败：{error}"))?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(format!(
                "读取 Google 账号失败（{status}）：{}",
                truncate(&body, 300)
            ));
        }
        let user = response
            .json::<GoogleUserInfo>()
            .await
            .map_err(|error| format!("Google 账号响应无法解析：{error}"))?;
        if !user.email_verified {
            return Err("Google 账号邮箱尚未验证。".to_owned());
        }
        Ok(user.email)
    }

    async fn revoke(&self, refresh_token: &str) -> Result<(), String> {
        let token = StandardRevocableToken::from(RefreshToken::new(refresh_token.to_owned()));
        self.client
            .revoke_token(token)
            .map_err(display)?
            .request_async(&self.http)
            .await
            .map_err(|error| format!("Google 授权撤销失败：{error}"))
    }
}

#[derive(Deserialize)]
struct GoogleUserInfo {
    email: String,
    #[serde(default)]
    email_verified: bool,
}

#[derive(Clone)]
pub(crate) struct SecretCipher([u8; 32]);

impl SecretCipher {
    fn new(app_key: &str, label: &[u8]) -> Self {
        let mut digest = Sha256::new();
        digest.update(label);
        digest.update(app_key.as_bytes());
        Self(digest.finalize().into())
    }

    pub(crate) fn encrypt(&self, user_id: i64, password: &str) -> Result<String, String> {
        let cipher = XChaCha20Poly1305::new_from_slice(&self.0)
            .map_err(|_| "邮箱密码加密密钥无效".to_owned())?;
        let nonce = XNonce::generate();
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: password.as_bytes(),
                    aad: user_id.to_string().as_bytes(),
                },
            )
            .map_err(|_| "邮箱密码加密失败".to_owned())?;
        let mut encoded = nonce.to_vec();
        encoded.extend(ciphertext);
        Ok(URL_SAFE_NO_PAD.encode(encoded))
    }

    pub(crate) fn decrypt(&self, user_id: i64, encoded: &str) -> Result<String, String> {
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "保存的邮箱密码格式不正确".to_owned())?;
        if bytes.len() <= 24 {
            return Err("保存的邮箱密码格式不正确".to_owned());
        }
        let (nonce, ciphertext) = bytes.split_at(24);
        let cipher = XChaCha20Poly1305::new_from_slice(&self.0)
            .map_err(|_| "邮箱密码加密密钥无效".to_owned())?;
        let nonce = XNonce::try_from(nonce).map_err(|_| "保存的邮箱密码格式不正确".to_owned())?;
        let plaintext = cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: ciphertext,
                    aad: user_id.to_string().as_bytes(),
                },
            )
            .map_err(|_| "保存的邮箱密码无法解密，请重新保存密码".to_owned())?;
        String::from_utf8(plaintext).map_err(|_| "保存的邮箱密码不是有效文本".to_owned())
    }
}

#[derive(Clone)]
pub struct Service {
    pool: Pool,
    config: RuntimeConfig,
    workbench: crate::mail::Service,
    billing: crate::billing::Service,
    /// 同步任务的并发闸门。每个在跑的同步占一个名额，关停时靠「把名额全收回来」等它们收尾。
    sync_slots: std::sync::Arc<tokio::sync::Semaphore>,
}

impl Service {
    pub(crate) fn new(
        pool: Pool,
        config: RuntimeConfig,
        workbench: crate::mail::Service,
        billing: crate::billing::Service,
    ) -> Self {
        let sync_slots = std::sync::Arc::new(tokio::sync::Semaphore::new(
            config.reliability().sync_concurrency,
        ));
        Self {
            pool,
            config,
            workbench,
            billing,
            sync_slots,
        }
    }

    /// 等在跑的同步任务收尾，最多等 `shutdown_grace`。
    ///
    /// 名额全部回到手里就说明没有同步在跑了。等不到就直说——调用方会照常退出进程，
    /// 留下的 `running` 记录由清扫器在下次启动后回收。
    pub async fn drain(&self) {
        let config = self.config.reliability();
        let permits = u32::try_from(config.sync_concurrency).unwrap_or(u32::MAX);
        match tokio::time::timeout(config.shutdown_grace, self.sync_slots.acquire_many(permits))
            .await
        {
            Ok(Ok(_)) => tracing::info!("在跑的邮箱同步都已收尾"),
            Ok(Err(error)) => tracing::warn!(%error, "同步闸门已关闭，不再等待"),
            Err(_) => tracing::warn!(
                grace_secs = config.shutdown_grace.as_secs(),
                "等邮箱同步收尾超时，剩下的交给下次启动时的清扫器"
            ),
        }
    }

    /// 起一个受并发闸门约束的同步任务。
    ///
    /// 以前这里是裸 `tokio::spawn`：N 个用户在同一拍被唤醒就是 N 条 IMAP 连接同时建立，
    /// 既没有上限也没人等它们收尾。
    fn spawn_sync<F>(&self, task: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let slots = self.sync_slots.clone();
        tokio::spawn(async move {
            let Ok(_permit) = slots.acquire_owned().await else {
                tracing::warn!("同步闸门已关闭，这次同步不再启动");
                return;
            };
            task.await;
        });
    }

    pub fn start_scheduler(&self) {
        let service = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(service.config.sync_interval);
            loop {
                interval.tick().await;
                if let Err(error) = service.enqueue_enabled().await {
                    tracing::error!(%error, "账单邮箱定时同步投递失败");
                }
            }
        });
    }

    async fn enqueue_enabled(&self) -> Result<(), String> {
        let client = self.pool.get().await.map_err(display)?;
        // 连着失败的邮箱要退避，不然一个连不上的服务器会被每一拍都重敲一次。
        // 失败次数从上一次成功之后算起，成功一次就自然归零。
        let rows = client
            .query(
                &format!(
                    "WITH last_success AS (
                   SELECT user_id, max(finished_at) AS at
                   FROM abei_ai.mail_sync_runs
                   WHERE status = '{succeeded}'
                   GROUP BY user_id
                 ),
                 streak AS (
                   SELECT r.user_id, count(*) AS failures, max(r.finished_at) AS last_failed_at
                   FROM abei_ai.mail_sync_runs r
                   LEFT JOIN last_success s ON s.user_id = r.user_id
                   WHERE r.status = '{failed}'
                     AND (s.at IS NULL OR r.finished_at > s.at)
                   GROUP BY r.user_id
                 )
                 SELECT m.user_id,
                        coalesce(streak.failures, 0) AS failures,
                        extract(epoch FROM now() - streak.last_failed_at)::float8 AS since_failure
                 FROM abei_ai.mailboxes m
                 LEFT JOIN streak ON streak.user_id = m.user_id
                 WHERE m.enabled = true
                 ORDER BY m.user_id",
                    succeeded = SyncRunStatus::Succeeded,
                    failed = SyncRunStatus::Failed,
                ),
                &[],
            )
            .await
            .map_err(display)?;
        drop(client);
        // 一个用户投递失败不能连累别人：这里原本是 `?`，于是排在故障用户后面的所有邮箱
        // 在这一轮里全被跳过，而且外面只看得到一行日志。现在逐个记账、逐个继续。
        let mut failed = 0usize;
        let mut backed_off = 0usize;
        for row in &rows {
            let user_id: i64 = row.get(0);
            let failures: i64 = row.get(1);
            let since_failure: Option<f64> = row.get(2);
            let waited = since_failure
                .filter(|value| value.is_finite() && *value >= 0.0)
                .map(Duration::from_secs_f64)
                .unwrap_or(Duration::ZERO);
            let wait_for = self.backoff_for(failures);
            if waited < wait_for {
                backed_off += 1;
                tracing::debug!(
                    user_id,
                    failures,
                    wait_secs = wait_for.as_secs(),
                    "这个邮箱还在退避窗口里，本轮先跳过"
                );
                continue;
            }
            if let Err(error) = self.enqueue(user_id, 100).await {
                failed += 1;
                tracing::error!(user_id, %error, "这个邮箱的定时同步没投递成功，跳过它继续下一个");
            }
        }
        if failed > 0 || backed_off > 0 {
            tracing::warn!(
                failed,
                backed_off,
                total = rows.len(),
                "本轮定时同步有邮箱没投递，其余已照常投递"
            );
        }
        Ok(())
    }

    fn backoff_for(&self, failures: i64) -> Duration {
        backoff_for(
            self.config.sync_interval,
            self.config.reliability().sync_backoff_max,
            failures,
        )
    }

    pub(crate) async fn enqueue(&self, user_id: i64, limit: i16) -> Result<Value, String> {
        let limit = limit.clamp(1, 100);
        let scope = serde_json::to_string(&json!({ "limit": limit })).map_err(display)?;
        let mut client = self.pool.get().await.map_err(display)?;
        let transaction = client.transaction().await.map_err(display)?;
        transaction
            .query_one("SELECT pg_advisory_xact_lock($1)", &[&user_id])
            .await
            .map_err(display)?;
        transaction
            .execute(
                &format!(
                    "UPDATE abei_ai.mail_sync_runs SET status = '{failed}', stage = 'finished',
                   error_summary = '同步进程失去心跳，已由下一轮同步回收。',
                   finished_at = now(), updated_at = now()
                 WHERE user_id = $1 AND status IN ({in_flight})
                   AND updated_at < now() - make_interval(secs => $2)",
                    failed = SyncRunStatus::Failed,
                    in_flight = SyncRunStatus::in_flight_sql(),
                ),
                &[
                    &user_id,
                    &self.config.reliability().sync_heartbeat_timeout_secs(),
                ],
            )
            .await
            .map_err(display)?;
        if let Some(row) = transaction
            .query_opt(
                &format!(
                    "SELECT id, status, requested_at::text, started_at::text, finished_at::text,
                        progress, error_summary
                 FROM abei_ai.mail_sync_runs
                 WHERE user_id = $1 AND status IN ({in_flight})
                 ORDER BY id DESC LIMIT 1",
                    in_flight = SyncRunStatus::in_flight_sql(),
                ),
                &[&user_id],
            )
            .await
            .map_err(display)?
        {
            transaction.commit().await.map_err(display)?;
            return Ok(sync_run_state(&row));
        }
        let row = transaction
            .query_one(
                "INSERT INTO abei_ai.mail_sync_runs
                   (user_id, mailbox_user_id, kind, scope, status, stage)
                 VALUES ($1, $1, 'incremental', $2::text::jsonb, $3, 'queued')
                 RETURNING id, status, requested_at::text, started_at::text, finished_at::text,
                           progress, error_summary",
                &[&user_id, &scope, &SyncRunStatus::Queued.as_str()],
            )
            .await
            .map_err(display)?;
        let run_id: i64 = row.get(0);
        let state = sync_run_state(&row);
        transaction.commit().await.map_err(display)?;
        let service = self.clone();
        self.spawn_sync(async move { service.run(user_id, limit, run_id).await });
        Ok(state)
    }

    async fn estimate_rescan(&self, user_id: i64, range: &RescanRange) -> Result<usize, String> {
        let mailbox = self.load_mailbox(user_id).await?;
        let (mut session, _) =
            connect_selected(&mailbox, self.config.operation_timeout, "估算历史扫描").await?;
        let uids = within(
            self.config.operation_timeout,
            "估算历史邮件数量",
            session.uid_search(range.search_query()?),
        )
        .await?;
        let _ = within(self.config.operation_timeout, "退出邮箱", session.logout()).await;
        Ok(uids.len())
    }

    async fn enqueue_rescan(&self, user_id: i64, range: RescanRange) -> Result<i64, String> {
        let scope = serde_json::to_string(&json!({
            "from": range.from.to_string(),
            "to": range.to.to_string(),
            "limit": range.limit,
        }))
        .map_err(display)?;
        let mut client = self.pool.get().await.map_err(display)?;
        let transaction = client.transaction().await.map_err(display)?;
        transaction
            .query_one("SELECT pg_advisory_xact_lock($1)", &[&user_id])
            .await
            .map_err(display)?;
        if transaction
            .query_opt(
                &format!(
                    "SELECT id FROM abei_ai.mail_sync_runs
                 WHERE user_id = $1 AND status IN ({in_flight})
                 ORDER BY id DESC LIMIT 1",
                    in_flight = SyncRunStatus::in_flight_sql(),
                ),
                &[&user_id],
            )
            .await
            .map_err(display)?
            .is_some()
        {
            return Err("已有邮箱同步正在运行，请等待完成后再扫描历史邮件。".to_owned());
        }
        let run_id: i64 = transaction
            .query_one(
                "INSERT INTO abei_ai.mail_sync_runs
                   (user_id, mailbox_user_id, kind, scope, status, stage)
                 VALUES ($1, $1, 'rescan', $2::text::jsonb, $3, 'queued')
                 RETURNING id",
                &[&user_id, &scope, &SyncRunStatus::Queued.as_str()],
            )
            .await
            .map_err(display)?
            .get(0);
        transaction.commit().await.map_err(display)?;

        let service = self.clone();
        self.spawn_sync(async move { service.run_rescan(user_id, range, run_id).await });
        Ok(run_id)
    }

    async fn run(&self, user_id: i64, limit: i16, run_id: i64) {
        match self.start_run(user_id, run_id).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                tracing::error!(user_id, run_id, %error, "邮箱同步运行无法更新为 running");
                return;
            }
        }

        let result = match self.sync_user(user_id, limit as usize, Some(run_id)).await {
            Ok(result) => result,
            Err(error) => SyncResult {
                failed: 1,
                errors: vec![error],
                ..SyncResult::default()
            },
        };
        if self
            .is_run_cancelled(user_id, run_id)
            .await
            .unwrap_or(false)
        {
            return;
        }
        if let Err(error) = self.finish(user_id, run_id, &result).await {
            tracing::error!(user_id, %error, "账单邮箱同步结果无法保存");
        }
    }

    async fn run_rescan(&self, user_id: i64, range: RescanRange, run_id: i64) {
        match self.start_run(user_id, run_id).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                tracing::error!(user_id, run_id, %error, "历史扫描无法更新为 running");
                return;
            }
        }
        let result = match self.sync_range(user_id, range, run_id).await {
            Ok(result) => result,
            Err(error) => SyncResult {
                failed: 1,
                errors: vec![error],
                ..SyncResult::default()
            },
        };
        if self
            .is_run_cancelled(user_id, run_id)
            .await
            .unwrap_or(false)
        {
            return;
        }
        if let Err(error) = self.finish(user_id, run_id, &result).await {
            tracing::error!(user_id, run_id, %error, "历史扫描结果无法保存");
        }
    }

    async fn finish(&self, user_id: i64, run_id: i64, result: &SyncResult) -> Result<(), String> {
        let status = if result.failed == 0 {
            SyncRunStatus::Succeeded
        } else {
            SyncRunStatus::Failed
        };
        let error = result.errors.first().map(|value| truncate(value, 2000));
        let encoded = serde_json::to_string(result).map_err(display)?;
        let client = self.pool.get().await.map_err(display)?;
        let updated = client
            .execute(
                "UPDATE abei_ai.mail_sync_runs SET status = $3, stage = 'finished',
                   scanned = $4, fetched = $5, matched = $6, unclassified = $7,
                   failed = $8, progress = $9::text::jsonb, error_summary = $10,
                   finished_at = now(), updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status = $11",
                &[
                    &user_id,
                    &run_id,
                    &status.as_str(),
                    &(result.scanned as i32),
                    &(result.fetched as i32),
                    &(result.matched as i32),
                    &(result.unclassified as i32),
                    &(result.failed as i32),
                    &encoded,
                    &error,
                    &SyncRunStatus::Running.as_str(),
                ],
            )
            .await
            .map_err(display)?;
        if updated == 0 {
            // 这一轮已经不是 running 了——多半是清扫器先一步把它判成失去心跳。
            // 结果确实丢了，但不能静默丢：日志里得能看出「跑完了却没人收」。
            tracing::warn!(
                user_id,
                run_id,
                scanned = result.scanned,
                created = result.created,
                "同步结果没能写回：这一轮已经不是运行中，多半已被清扫器回收"
            );
            return Ok(());
        }
        tracing::info!(
            user_id,
            status = status.as_str(),
            scanned = result.scanned,
            created = result.created,
            "账单邮箱同步完成"
        );
        Ok(())
    }

    async fn prepare_run_fetch(
        &self,
        user_id: i64,
        run_id: i64,
        available: usize,
        total: usize,
    ) -> Result<(), String> {
        let progress = serde_json::to_string(&json!({
            "stage": "fetch",
            "available": available,
            "total": total,
            "scanned": 0,
            "fetched": 0,
        }))
        .map_err(display)?;
        self.pool
            .get()
            .await
            .map_err(display)?
            .execute(
                "UPDATE abei_ai.mail_sync_runs SET stage = 'fetch',
                   progress = $3::text::jsonb, updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status = $4",
                &[
                    &user_id,
                    &run_id,
                    &progress,
                    &SyncRunStatus::Running.as_str(),
                ],
            )
            .await
            .map_err(display)?;
        Ok(())
    }

    async fn start_run(&self, user_id: i64, run_id: i64) -> Result<bool, String> {
        let updated = self
            .pool
            .get()
            .await
            .map_err(display)?
            .execute(
                "UPDATE abei_ai.mail_sync_runs SET status = $3, stage = 'connect',
                   started_at = now(), updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status = $4",
                &[
                    &user_id,
                    &run_id,
                    &SyncRunStatus::Running.as_str(),
                    &SyncRunStatus::Queued.as_str(),
                ],
            )
            .await
            .map_err(display)?;
        Ok(updated == 1)
    }

    async fn cancel_run(&self, user_id: i64, run_id: i64) -> Result<bool, String> {
        let updated = self
            .pool
            .get()
            .await
            .map_err(display)?
            .execute(
                &format!(
                    "UPDATE abei_ai.mail_sync_runs SET status = '{cancelled}', stage = 'finished',
                   finished_at = now(), updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status IN ({in_flight})",
                    cancelled = SyncRunStatus::Cancelled,
                    in_flight = SyncRunStatus::in_flight_sql(),
                ),
                &[&user_id, &run_id],
            )
            .await
            .map_err(display)?;
        Ok(updated == 1)
    }

    async fn is_run_cancelled(&self, user_id: i64, run_id: i64) -> Result<bool, String> {
        self.pool
            .get()
            .await
            .map_err(display)?
            .query_opt(
                "SELECT 1 FROM abei_ai.mail_sync_runs
                 WHERE user_id = $1 AND id = $2 AND status = $3",
                &[&user_id, &run_id, &SyncRunStatus::Cancelled.as_str()],
            )
            .await
            .map(|row| row.is_some())
            .map_err(display)
    }

    async fn update_run_progress(
        &self,
        user_id: i64,
        run_id: i64,
        result: &SyncResult,
    ) -> Result<(), String> {
        let progress = serde_json::to_string(&json!({
            "stage": "fetch",
            "scanned": result.scanned,
            "fetched": result.fetched,
            "matched": result.matched,
            "unclassified": result.unclassified,
            "failed": result.failed,
            "cancelled": result.cancelled,
        }))
        .map_err(display)?;
        self.pool
            .get()
            .await
            .map_err(display)?
            .execute(
                "UPDATE abei_ai.mail_sync_runs SET stage = 'fetch', scanned = $3, fetched = $4,
                   matched = $5, unclassified = $6, failed = $7,
                   progress = progress || $8::text::jsonb, updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status = $9",
                &[
                    &user_id,
                    &run_id,
                    &(result.scanned as i32),
                    &(result.fetched as i32),
                    &(result.matched as i32),
                    &(result.unclassified as i32),
                    &(result.failed as i32),
                    &progress,
                    &SyncRunStatus::Running.as_str(),
                ],
            )
            .await
            .map_err(display)?;
        Ok(())
    }
}

#[derive(Debug, Default, Serialize)]
struct SyncResult {
    scanned: usize,
    fetched: usize,
    created: usize,
    ignored: usize,
    duplicates: usize,
    matched: usize,
    unclassified: usize,
    failed: usize,
    processed: usize,
    process_failed: usize,
    cancelled: bool,
    errors: Vec<String>,
}

#[derive(Debug, Clone, Copy)]
struct RescanRange {
    from: Date,
    to: Date,
    limit: usize,
}

impl RescanRange {
    fn parse(request: &RescanRequest) -> Result<Self, ApiError> {
        let format = time::format_description::parse_borrowed::<2>("[year]-[month]-[day]")
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let from = Date::parse(&request.from, &format)
            .map_err(|_| ApiError::invalid_params("from 必须是 YYYY-MM-DD。"))?;
        let to = match request.to.as_deref() {
            Some(value) => Date::parse(value, &format)
                .map_err(|_| ApiError::invalid_params("to 必须是 YYYY-MM-DD。"))?,
            None => OffsetDateTime::now_utc().date(),
        };
        if to < from {
            return Err(ApiError::invalid_params("to 不能早于 from。"));
        }
        if (to - from).whole_days() > 180 {
            return Err(ApiError::invalid_params("历史扫描最长 180 天。"));
        }
        let limit = usize::from(request.limit.unwrap_or(500));
        if !(1..=500).contains(&limit) {
            return Err(ApiError::invalid_params("limit 必须在 1 到 500 之间。"));
        }
        Ok(Self { from, to, limit })
    }

    fn search_query(self) -> Result<String, String> {
        let before = self
            .to
            .next_day()
            .ok_or_else(|| "历史扫描结束日期超出支持范围。".to_owned())?;
        Ok(format!(
            "SINCE {} BEFORE {}",
            imap_date(self.from),
            imap_date(before)
        ))
    }
}

fn imap_date(date: Date) -> String {
    let month = match date.month() {
        time::Month::January => "Jan",
        time::Month::February => "Feb",
        time::Month::March => "Mar",
        time::Month::April => "Apr",
        time::Month::May => "May",
        time::Month::June => "Jun",
        time::Month::July => "Jul",
        time::Month::August => "Aug",
        time::Month::September => "Sep",
        time::Month::October => "Oct",
        time::Month::November => "Nov",
        time::Month::December => "Dec",
    };
    format!("{}-{month}-{}", date.day(), date.year())
}

fn sync_run_state(row: &tokio_postgres::Row) -> Value {
    let status = row.get::<_, String>(1);
    let state = SyncRunStatus::from_str(&status);
    let progress = row.get::<_, Value>(5);
    // 只有收尾了的同步才有最终结果；终态就是 succeeded / failed / cancelled 这三个。
    let result = state
        .is_some_and(SyncRunStatus::is_terminal)
        .then_some(progress);
    json!({
        "run_id": row.get::<_, i64>(0).to_string(),
        "status": if state == Some(SyncRunStatus::Cancelled) {
            SyncRunStatus::Failed.as_str()
        } else {
            status.as_str()
        },
        "requested_at": row.get::<_, String>(2),
        "started_at": row.get::<_, Option<String>>(3),
        "finished_at": row.get::<_, Option<String>>(4),
        "result": result,
        "error_message": row.get::<_, Option<String>>(6),
    })
}

#[derive(Debug, Clone, Serialize)]
struct Settings {
    enabled: bool,
    provider: String,
    auth_method: String,
    email: String,
    host: String,
    port: u16,
    encryption: String,
    username: String,
    folder: String,
    has_password: bool,
    google_connected: bool,
    google_oauth_available: bool,
    built_in_channels: Value,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "gmail".to_owned(),
            auth_method: "google_oauth".to_owned(),
            email: String::new(),
            host: "imap.gmail.com".to_owned(),
            port: 993,
            encryption: "ssl".to_owned(),
            username: String::new(),
            folder: "INBOX".to_owned(),
            has_password: false,
            google_connected: false,
            google_oauth_available: false,
            built_in_channels: built_in_channels(),
        }
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct SettingsUpdate {
    enabled: Option<bool>,
    provider: Option<String>,
    email: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    encryption: Option<String>,
    username: Option<String>,
    password: Option<String>,
    folder: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct SyncRequest {
    limit: Option<i16>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RescanRequest {
    from: String,
    #[serde(default)]
    to: Option<String>,
    #[serde(default)]
    limit: Option<u16>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GoogleCallback {
    code: String,
    state: String,
}

/// `/v1/mailboxes/{id}` 里的那个 id。
///
/// 数据模型里一个用户只有一个邮箱（`mailboxes` 按 user_id 唯一），所以只认两种写法：
/// `current`，或者调用方自己的 user_id。别的一律 404。以前这个 id 被所有 handler
/// 整个忽略：接口形状说「可以指定是哪个邮箱」，实现却永远操作当前用户那一个，
/// 调用方写错 id 也照样成功。
fn assert_mailbox_id(
    path: Result<PathParam<String>, PathRejection>,
    user_id: i64,
) -> Result<(), ApiError> {
    let Ok(PathParam(id)) = path else {
        // 这条路由本来就没有 id 段（/v1/mailboxes、/v1/bills/mailbox），不用比。
        return Ok(());
    };
    let id = id.trim();
    if id == "current" || id.parse::<i64>() == Ok(user_id) {
        Ok(())
    } else {
        Err(ApiError::not_found("这个邮箱不存在。"))
    }
}

pub(crate) async fn get_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<PathParam<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    assert_mailbox_id(path, user_id)?;
    let settings = state.mailbox.load_settings(user_id).await?;
    Ok(Json(settings_response(settings)))
}

pub(crate) async fn update_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<PathParam<String>, PathRejection>,
    payload: Result<Json<SettingsUpdate>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    assert_mailbox_id(path, user_id)?;
    let Json(update) = payload.map_err(|error| ApiError::invalid_params(error.body_text()))?;
    let settings = state.mailbox.save_settings(user_id, update).await?;
    Ok(Json(settings_response(settings)))
}

pub(crate) async fn sync(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<PathParam<String>, PathRejection>,
    payload: Result<Json<SyncRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    assert_mailbox_id(path, user_id)?;
    let Json(request) = payload.map_err(|error| ApiError::invalid_params(error.body_text()))?;
    let limit = request.limit.unwrap_or(25);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid_params("limit 必须在 1 到 100 之间。"));
    }
    if !state.mailbox.load_settings(user_id).await?.enabled {
        return Err(ApiError::invalid_params("请先配置并启用邮箱。"));
    }
    let sync = state
        .mailbox
        .enqueue(user_id, limit)
        .await
        .map_err(ApiError::database)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "data": { "type": "bill-inbox-sync-state", "attributes": sync }
        })),
    ))
}

pub(crate) async fn rescan(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<PathParam<String>, PathRejection>,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<RescanRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    assert_mailbox_id(path, user_id)?;
    let Query(gate) = gate.map_err(|error| ApiError::invalid_params(error.body_text()))?;
    let Json(request) = payload.map_err(|error| ApiError::invalid_params(error.body_text()))?;
    let range = RescanRange::parse(&request)?;
    if !state.mailbox.load_settings(user_id).await?.enabled {
        return Err(ApiError::invalid_params("请先配置并启用邮箱。"));
    }
    if gate.dry_run {
        let estimated = state
            .mailbox
            .estimate_rescan(user_id, &range)
            .await
            .map_err(ApiError::oauth)?;
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dry_run": true,
                "data": {
                    "from": request.from,
                    "to": request.to.unwrap_or_else(|| range.to.to_string()),
                    "limit": range.limit,
                    "estimated": estimated,
                }
            })),
        ));
    }
    gate.require_confirmation("mailboxes.rescan")?;
    let run_id = state
        .mailbox
        .enqueue_rescan(user_id, range)
        .await
        .map_err(ApiError::database)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "data": {
                "type": "mail-sync-run",
                "id": run_id.to_string(),
                "attributes": { "status": SyncRunStatus::Queued.as_str(), "kind": "rescan" }
            }
        })),
    ))
}

pub(crate) async fn start_google_oauth(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let authorization_url = state.mailbox.start_google_oauth(user_id).await?;
    Ok(Json(json!({
        "data": {
            "type": "google-oauth",
            "attributes": { "authorization_url": authorization_url }
        }
    })))
}

pub(crate) async fn complete_google_oauth(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<GoogleCallback>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let Json(callback) = payload.map_err(|error| ApiError::invalid_params(error.body_text()))?;
    validate_oauth_value("code", &callback.code)?;
    validate_oauth_value("state", &callback.state)?;
    let settings = state
        .mailbox
        .complete_google_oauth(user_id, callback)
        .await?;
    Ok(Json(settings_response(settings)))
}

pub(crate) async fn disconnect_google(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let settings = state.mailbox.disconnect_google(user_id).await?;
    Ok(Json(settings_response(settings)))
}

fn settings_response(settings: Settings) -> Value {
    json!({ "data": { "type": "bill-inbox-settings", "attributes": settings } })
}

fn validate_oauth_value(name: &str, value: &str) -> Result<(), ApiError> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(ApiError::invalid_params(format!(
            "Google OAuth {name} 格式不正确。"
        )));
    }
    Ok(())
}

impl Service {
    async fn load_settings(&self, user_id: i64) -> Result<Settings, ApiError> {
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let row = client
            .query_opt(
                "SELECT enabled, provider, email, host, port, encryption, username, folder,
                        password_ciphertext IS NOT NULL AND password_ciphertext <> '', auth_method,
                        oauth_refresh_token_ciphertext IS NOT NULL
                          AND oauth_refresh_token_ciphertext <> ''
                 FROM abei_ai.mailboxes WHERE user_id = $1",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        let mut settings = row
            .map(|row| settings_from_row(row, self.config.google_oauth.is_some()))
            .unwrap_or_default();
        settings.google_oauth_available = self.config.google_oauth.is_some();
        Ok(settings)
    }

    async fn start_google_oauth(&self, user_id: i64) -> Result<String, ApiError> {
        let google = self
            .config
            .google_oauth
            .as_ref()
            .ok_or_else(|| ApiError::conflict("服务器尚未配置 Google OAuth2。"))?;
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
        let state = CsrfToken::new_random().secret().to_owned();
        let verifier = self
            .config
            .oauth_state_cipher
            .encrypt(user_id, verifier.secret())
            .map_err(ApiError::internal)?;
        let authorization_url = google.authorization_url(state.clone(), challenge);
        let state_hash = sha256(state.as_bytes());

        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        transaction
            .execute(
                "DELETE FROM abei_ai.mailbox_oauth_states
                 WHERE user_id = $1 OR expires_at <= now()",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        transaction
            .execute(
                "INSERT INTO abei_ai.mailbox_oauth_states
                   (state_hash, user_id, verifier_ciphertext, expires_at, created_at)
                 VALUES ($1, $2, $3, now() + interval '10 minutes', now())",
                &[&state_hash, &user_id, &verifier],
            )
            .await
            .map_err(ApiError::database)?;
        transaction.commit().await.map_err(ApiError::database)?;
        Ok(authorization_url)
    }

    async fn complete_google_oauth(
        &self,
        user_id: i64,
        callback: GoogleCallback,
    ) -> Result<Settings, ApiError> {
        let google = self
            .config
            .google_oauth
            .as_ref()
            .ok_or_else(|| ApiError::conflict("服务器尚未配置 Google OAuth2。"))?;
        let state_hash = sha256(callback.state.as_bytes());
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let state = client
            .query_opt(
                "DELETE FROM abei_ai.mailbox_oauth_states
                 WHERE state_hash = $1 AND user_id = $2
                 RETURNING verifier_ciphertext, expires_at > now()",
                &[&state_hash, &user_id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::invalid_params("Google OAuth state 无效或已使用。"))?;
        if !state.get::<_, bool>(1) {
            return Err(ApiError::invalid_params("Google OAuth state 已过期。"));
        }
        let verifier = self
            .config
            .oauth_state_cipher
            .decrypt(user_id, state.get(0))
            .map_err(ApiError::internal)?;
        let (access_token, refresh_token) = google
            .exchange_code(callback.code, verifier)
            .await
            .map_err(ApiError::oauth)?;
        let email = google.email(&access_token).await.map_err(ApiError::oauth)?;
        if !email.contains('@') || email.len() > 255 || email.chars().any(char::is_control) {
            return Err(ApiError::oauth("Google 返回的邮箱地址不合法。"));
        }
        let refresh_token = self
            .config
            .oauth_refresh_cipher
            .encrypt(user_id, &refresh_token)
            .map_err(ApiError::internal)?;

        client
            .execute(
                "INSERT INTO abei_ai.mailboxes
                   (user_id, enabled, provider, email, host, port, encryption, username,
                    password_ciphertext, auth_method, oauth_refresh_token_ciphertext, folder,
                    uid_validity, last_uid, created_at, updated_at)
                 VALUES ($1, true, 'gmail', $2, 'imap.gmail.com', 993, 'ssl', $2,
                         NULL, 'google_oauth', $3, 'INBOX', NULL, 0, now(), now())
                 ON CONFLICT (user_id) DO UPDATE SET
                   enabled = true, provider = 'gmail', email = EXCLUDED.email,
                   host = 'imap.gmail.com', port = 993, encryption = 'ssl',
                   username = EXCLUDED.email, password_ciphertext = NULL,
                   auth_method = 'google_oauth',
                   oauth_refresh_token_ciphertext = EXCLUDED.oauth_refresh_token_ciphertext,
                   folder = 'INBOX',
                   uid_validity = CASE WHEN
                     (mailboxes.provider, mailboxes.email, mailboxes.auth_method) IS DISTINCT FROM
                     (EXCLUDED.provider, EXCLUDED.email, EXCLUDED.auth_method)
                     THEN NULL ELSE mailboxes.uid_validity END,
                   last_uid = CASE WHEN
                     (mailboxes.provider, mailboxes.email, mailboxes.auth_method) IS DISTINCT FROM
                     (EXCLUDED.provider, EXCLUDED.email, EXCLUDED.auth_method)
                     THEN 0 ELSE mailboxes.last_uid END,
                   updated_at = now()",
                &[&user_id, &email, &refresh_token],
            )
            .await
            .map_err(ApiError::database)?;
        self.load_settings(user_id).await
    }

    async fn disconnect_google(&self, user_id: i64) -> Result<Settings, ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let encrypted = transaction
            .query_opt(
                "SELECT oauth_refresh_token_ciphertext FROM abei_ai.mailboxes
                 WHERE user_id = $1 AND auth_method = 'google_oauth' FOR UPDATE",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?
            .and_then(|row| row.get::<_, Option<String>>(0));
        transaction
            .execute(
                "UPDATE abei_ai.mailboxes SET enabled = false,
                   oauth_refresh_token_ciphertext = NULL, updated_at = now()
                 WHERE user_id = $1 AND auth_method = 'google_oauth'",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        transaction
            .execute(
                "DELETE FROM abei_ai.mailbox_oauth_states WHERE user_id = $1",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        transaction.commit().await.map_err(ApiError::database)?;

        if let Some(encrypted) = encrypted {
            match self
                .config
                .oauth_refresh_cipher
                .decrypt(user_id, &encrypted)
            {
                Ok(refresh_token) => {
                    if let Some(google) = &self.config.google_oauth
                        && let Err(error) = google.revoke(&refresh_token).await
                    {
                        tracing::warn!(user_id, %error, "Google OAuth 上游撤销失败，本地凭据已删除");
                    }
                }
                Err(error) => {
                    tracing::warn!(user_id, %error, "Google refresh token 无法解密，本地凭据已删除");
                }
            }
        }
        self.load_settings(user_id).await
    }

    async fn save_settings(
        &self,
        user_id: i64,
        update: SettingsUpdate,
    ) -> Result<Settings, ApiError> {
        let current = self.load_settings(user_id).await?;
        if current.google_connected && update.provider.as_deref() == Some("imap") {
            return Err(ApiError::conflict("请先断开 Google，再切换到普通 IMAP。"));
        }
        let mut settings = Settings {
            enabled: update.enabled.unwrap_or(current.enabled),
            provider: update.provider.unwrap_or(current.provider),
            auth_method: current.auth_method,
            email: update
                .email
                .unwrap_or_else(|| current.email.clone())
                .trim()
                .to_owned(),
            host: update.host.unwrap_or(current.host).trim().to_owned(),
            port: update.port.unwrap_or(current.port),
            encryption: update.encryption.unwrap_or(current.encryption),
            username: update
                .username
                .unwrap_or(current.username)
                .trim()
                .to_owned(),
            folder: update.folder.unwrap_or(current.folder).trim().to_owned(),
            has_password: current.has_password,
            google_connected: current.google_connected,
            google_oauth_available: current.google_oauth_available,
            built_in_channels: built_in_channels(),
        };
        if settings.provider == "gmail" {
            settings.auth_method = "google_oauth".to_owned();
            settings.host = "imap.gmail.com".to_owned();
            settings.port = 993;
            settings.encryption = "ssl".to_owned();
            settings.folder = "INBOX".to_owned();
            if settings.google_connected {
                settings.email.clone_from(&current.email);
            }
            settings.username.clone_from(&settings.email);
        } else {
            settings.auth_method = "password".to_owned();
            settings.google_connected = false;
        }
        if settings.folder.is_empty() {
            settings.folder = "INBOX".to_owned();
        }

        let password = update.password.filter(|value| !value.is_empty());
        if settings.provider == "gmail" && password.is_some() {
            return Err(ApiError::invalid_params(
                "Gmail 只使用 Google OAuth2，不接受邮箱密码。",
            ));
        }
        if let Some(password) = password.as_deref() {
            validate_password(password)?;
        }
        settings.has_password |= password.is_some();
        validate_settings(&settings)?;
        let encrypted = password
            .as_deref()
            .map(|value| self.config.password_cipher.encrypt(user_id, value))
            .transpose()
            .map_err(ApiError::internal)?;

        let client = self.pool.get().await.map_err(ApiError::database)?;
        client
            .execute(
                "INSERT INTO abei_ai.mailboxes
                   (user_id, enabled, provider, email, host, port, encryption, username,
                    password_ciphertext, auth_method, oauth_refresh_token_ciphertext, folder,
                    uid_validity, last_uid, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,$11,NULL,0,now(),now())
                 ON CONFLICT (user_id) DO UPDATE SET
                   enabled=EXCLUDED.enabled, provider=EXCLUDED.provider, email=EXCLUDED.email,
                   host=EXCLUDED.host, port=EXCLUDED.port, encryption=EXCLUDED.encryption,
                   username=EXCLUDED.username,
                   password_ciphertext=CASE WHEN EXCLUDED.auth_method = 'google_oauth' THEN NULL
                     ELSE COALESCE(EXCLUDED.password_ciphertext, mailboxes.password_ciphertext) END,
                   auth_method=EXCLUDED.auth_method,
                   oauth_refresh_token_ciphertext=CASE WHEN EXCLUDED.auth_method = 'google_oauth'
                     THEN mailboxes.oauth_refresh_token_ciphertext ELSE NULL END,
                   folder=EXCLUDED.folder,
                   uid_validity=CASE WHEN
                     (mailboxes.provider, mailboxes.host, mailboxes.port, mailboxes.encryption,
                      mailboxes.username, mailboxes.folder) IS DISTINCT FROM
                     (EXCLUDED.provider, EXCLUDED.host, EXCLUDED.port, EXCLUDED.encryption,
                      EXCLUDED.username, EXCLUDED.folder)
                     THEN NULL ELSE mailboxes.uid_validity END,
                   last_uid=CASE WHEN
                     (mailboxes.provider, mailboxes.host, mailboxes.port, mailboxes.encryption,
                      mailboxes.username, mailboxes.folder) IS DISTINCT FROM
                     (EXCLUDED.provider, EXCLUDED.host, EXCLUDED.port, EXCLUDED.encryption,
                      EXCLUDED.username, EXCLUDED.folder)
                     THEN 0 ELSE mailboxes.last_uid END,
                   updated_at=now()",
                &[
                    &user_id,
                    &settings.enabled,
                    &settings.provider,
                    &settings.email,
                    &settings.host,
                    &(settings.port as i32),
                    &settings.encryption,
                    &settings.username,
                    &encrypted,
                    &settings.auth_method,
                    &settings.folder,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        self.load_settings(user_id).await
    }
}

fn settings_from_row(row: tokio_postgres::Row, google_oauth_available: bool) -> Settings {
    Settings {
        enabled: row.get(0),
        provider: row.get(1),
        auth_method: row.get(9),
        email: row.get(2),
        host: row.get(3),
        port: row.get::<_, i32>(4) as u16,
        encryption: row.get(5),
        username: row.get(6),
        folder: row.get(7),
        has_password: row.get(8),
        google_connected: row.get(10),
        google_oauth_available,
        built_in_channels: built_in_channels(),
    }
}

fn validate_settings(settings: &Settings) -> Result<(), ApiError> {
    if !matches!(settings.provider.as_str(), "gmail" | "imap") {
        return Err(ApiError::invalid_params("provider 只能是 gmail 或 imap。"));
    }
    if !matches!(
        settings.encryption.as_str(),
        "none" | "ssl" | "tls" | "starttls"
    ) {
        return Err(ApiError::invalid_params(
            "encryption 只能是 none、ssl、tls 或 starttls。",
        ));
    }
    for (name, value, limit) in [
        ("email", settings.email.as_str(), 255),
        ("host", settings.host.as_str(), 255),
        ("username", settings.username.as_str(), 255),
        ("folder", settings.folder.as_str(), 255),
    ] {
        if value.len() > limit || value.chars().any(char::is_control) {
            return Err(ApiError::invalid_params(format!("{name} 格式不正确。")));
        }
    }
    if settings.enabled {
        if !settings.email.contains('@') {
            return Err(ApiError::invalid_params("启用邮箱后必须填写有效邮箱地址。"));
        }
        if settings.host.is_empty() || settings.username.is_empty() || settings.folder.is_empty() {
            return Err(ApiError::invalid_params("启用邮箱后必须填完整登录信息。"));
        }
        if settings.provider == "gmail" && !settings.google_connected {
            return Err(ApiError::invalid_params("请先完成 Google OAuth2 授权。"));
        }
        if settings.provider == "imap" && !settings.has_password {
            return Err(ApiError::invalid_params("首次启用邮箱必须填写密码。"));
        }
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), ApiError> {
    if password.len() > 4096
        || password
            .chars()
            .any(|value| matches!(value, '\0' | '\r' | '\n'))
    {
        return Err(ApiError::invalid_params(
            "邮箱密码不能超过 4096 字节，也不能包含换行或空字符。",
        ));
    }
    Ok(())
}

fn built_in_channels() -> Value {
    json!([
        {"source":"alipay","name":"支付宝交易流水","description":"自动识别支付宝交易流水明细邮件。"},
        {"source":"wechat","name":"微信支付账单流水","description":"自动识别微信支付账单流水邮件。"},
        {"source":"cmb","name":"招商银行交易流水","description":"自动识别招商银行交易流水邮件。"},
        {"source":"cmb","name":"招商银行信用卡每日消费","description":"自动识别每日信用管家邮件。"},
        {"source":"boc","name":"中国银行交易流水","description":"自动识别中国银行交易流水邮件。"}
    ])
}

fn display(error: impl fmt::Display) -> String {
    error.to_string()
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[derive(Clone)]
struct MailboxRecord {
    enabled: bool,
    host: String,
    port: u16,
    encryption: String,
    username: String,
    auth: MailboxAuth,
    folder: String,
    uid_validity: Option<u32>,
    last_uid: u32,
}

#[derive(Clone)]
enum MailboxAuth {
    Password(String),
    GoogleAccessToken(String),
}

impl Service {
    pub(crate) async fn request_cancel(
        &self,
        user_id: i64,
        run_id: i64,
    ) -> Result<Value, ApiError> {
        self.cancel_run(user_id, run_id)
            .await
            .map_err(ApiError::database)?;
        self.workbench.get_sync_run(user_id, run_id).await
    }

    /// 抓一封邮件的正文，并把「这一趟做了什么」一起交出去。
    ///
    /// 调用方必须知道 `enqueued`：抓正文会顺带按当前规则重新索引这封邮件，命中了就
    /// 直接建账单文档、排第一个解析任务。不知道这件事的调用方接着又排一次重解析，
    /// 同一封邮件就连出两版 revision。
    pub(crate) async fn cache_message(
        &self,
        user_id: i64,
        id: i64,
    ) -> Result<CachedMessage, ApiError> {
        let locator = self.workbench.message_locator(user_id, id).await?;
        let mut mailbox = self.load_mailbox(user_id).await.map_err(ApiError::oauth)?;
        if !mailbox.enabled {
            return Err(ApiError::conflict("请先配置并启用邮箱。"));
        }
        mailbox.folder = locator.folder;
        let (mut session, selected) =
            connect_selected(&mailbox, self.config.operation_timeout, "缓存邮件")
                .await
                .map_err(ApiError::oauth)?;
        if selected.uid_validity != Some(locator.uid_validity) {
            let _ = within(self.config.operation_timeout, "退出邮箱", session.logout()).await;
            return Err(ApiError::conflict(
                "邮箱服务器已经重建该文件夹，原邮件 UID 已失效；请按日期执行历史扫描。",
            ));
        }
        let outcome = self
            .handle_uid(
                user_id,
                locator.uid_validity,
                locator.uid,
                &mailbox,
                &mut session,
                true,
            )
            .await
            .map_err(MessageError::into_api_error)?;
        let _ = within(self.config.operation_timeout, "退出邮箱", session.logout()).await;
        Ok(CachedMessage {
            message: self.workbench.get_message(user_id, id).await?,
            enqueued: outcome.delivery == MessageDelivery::Created,
        })
    }

    async fn load_mailbox(&self, user_id: i64) -> Result<MailboxRecord, String> {
        let client = self.pool.get().await.map_err(display)?;
        let row = client
            .query_opt(
                "SELECT enabled, host, port, encryption, username, password_ciphertext,
                        folder, uid_validity, last_uid, auth_method,
                        oauth_refresh_token_ciphertext
                 FROM abei_ai.mailboxes WHERE user_id = $1",
                &[&user_id],
            )
            .await
            .map_err(display)?
            .ok_or_else(|| "邮箱还没有配置。".to_owned())?;
        let enabled = row.get(0);
        let auth = match (enabled, row.get::<_, String>(9).as_str()) {
            (false, _) => MailboxAuth::Password(String::new()),
            (true, "password") => {
                let encrypted = row
                    .get::<_, Option<String>>(5)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "邮箱已启用，但没有保存密码，请重新保存邮箱设置。".to_owned())?;
                MailboxAuth::Password(self.config.password_cipher.decrypt(user_id, &encrypted)?)
            }
            (true, "google_oauth") => {
                let encrypted = row
                    .get::<_, Option<String>>(10)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "Google 邮箱尚未连接，请重新授权。".to_owned())?;
                let refresh_token = self
                    .config
                    .oauth_refresh_cipher
                    .decrypt(user_id, &encrypted)?;
                let google = self
                    .config
                    .google_oauth
                    .as_ref()
                    .ok_or_else(|| "服务器尚未配置 Google OAuth2。".to_owned())?;
                MailboxAuth::GoogleAccessToken(google.refresh_access_token(&refresh_token).await?)
            }
            (true, method) => return Err(format!("保存的邮箱认证方式不支持：{method}")),
        };
        Ok(MailboxRecord {
            enabled,
            host: row.get(1),
            port: u16::try_from(row.get::<_, i32>(2))
                .map_err(|_| "保存的 IMAP 端口不合法。".to_owned())?,
            encryption: row.get(3),
            username: row.get(4),
            auth,
            folder: row.get(6),
            uid_validity: row
                .get::<_, Option<i64>>(7)
                .map(u32::try_from)
                .transpose()
                .map_err(|_| "保存的 IMAP UIDVALIDITY 不合法。".to_owned())?,
            last_uid: u32::try_from(row.get::<_, i64>(8))
                .map_err(|_| "保存的 IMAP 游标不合法。".to_owned())?,
        })
    }

    async fn sync_user(
        &self,
        user_id: i64,
        limit: usize,
        run_id: Option<i64>,
    ) -> Result<SyncResult, String> {
        let mut result = SyncResult::default();
        let mut mailbox = self.load_mailbox(user_id).await?;
        if !mailbox.enabled {
            return Ok(result);
        }

        let (mut session, selected) =
            connect_selected(&mailbox, self.config.operation_timeout, "增量同步").await?;
        let uid_validity = selected
            .uid_validity
            .ok_or_else(|| "IMAP 服务器没有返回 UIDVALIDITY，无法可靠增量同步。".to_owned())?;
        if mailbox.uid_validity != Some(uid_validity) {
            mailbox.uid_validity = Some(uid_validity);
            mailbox.last_uid = 0;
            self.save_cursor(user_id, uid_validity, 0).await?;
        }

        let query = if mailbox.last_uid == 0 {
            "ALL".to_owned()
        } else if selected
            .uid_next
            .is_some_and(|next| next <= mailbox.last_uid.saturating_add(1))
        {
            String::new()
        } else {
            format!("UID {}:*", mailbox.last_uid.saturating_add(1))
        };
        let uids: Vec<u32> = if query.is_empty() {
            Vec::new()
        } else {
            within(
                self.config.operation_timeout,
                "搜索新邮件",
                session.uid_search(query),
            )
            .await?
            .into_iter()
            .collect()
        };
        let available = uids.len();
        let uids = select_uids(uids, mailbox.last_uid, limit);
        if let Some(run_id) = run_id {
            self.prepare_run_fetch(user_id, run_id, available, uids.len())
                .await?;
        }

        for uid in uids {
            if let Some(run_id) = run_id
                && self.is_run_cancelled(user_id, run_id).await?
            {
                result.cancelled = true;
                break;
            }
            result.scanned += 1;
            // 处理之前也打一拍心跳。只在处理完之后打的话，一封带大附件的邮件取上
            // 三分钟，清扫器就判这轮同步失去心跳、收成 failed，等它跑完 finish 一行
            // 都更不动，整轮结果静默丢掉。
            if let Some(run_id) = run_id
                && let Err(error) = self.update_run_progress(user_id, run_id, &result).await
            {
                tracing::warn!(user_id, run_id, %error, "邮箱同步心跳保存失败");
            }
            let handled = self
                .handle_uid(user_id, uid_validity, uid, &mailbox, &mut session, false)
                .await;
            match handled {
                Ok(outcome) => {
                    result.fetched += usize::from(outcome.content_fetched);
                    match outcome.delivery {
                        MessageDelivery::Created => result.created += 1,
                        MessageDelivery::Ignored => result.ignored += 1,
                        MessageDelivery::Duplicate => result.duplicates += 1,
                        MessageDelivery::Indexed => {}
                    }
                    count_classification(&mut result, outcome.classification);
                }
                Err(error) => {
                    // Permanent 是这封邮件本身没法用（编码坏了、超大），下一轮再取还是一样，
                    // 游标可以越过它。Retryable 和 Local 都是我们这边的问题——网络断了、
                    // 库写不进去——推游标就等于宣布这封邮件已处理，它从此脱离增量同步，
                    // 只能靠猜日期做历史扫描才找得回来。所以这两种中断本轮，下轮从原地重来。
                    let stop = stops_the_round(&error);
                    result.failed += 1;
                    result
                        .errors
                        .push(format!("邮件 UID {uid} 处理失败：{error}"));
                    if stop {
                        break;
                    }
                }
            }
            mailbox.last_uid = uid;
            if let Err(error) = self.save_cursor(user_id, uid_validity, uid).await {
                result.failed += 1;
                result.errors.push(format!("同步游标保存失败：{error}"));
                break;
            }
            if let Some(run_id) = run_id
                && let Err(error) = self.update_run_progress(user_id, run_id, &result).await
            {
                tracing::warn!(user_id, run_id, %error, "邮箱同步进度保存失败");
            }
        }

        let _ = within(self.config.operation_timeout, "退出邮箱", session.logout()).await;
        Ok(result)
    }

    async fn sync_range(
        &self,
        user_id: i64,
        range: RescanRange,
        run_id: i64,
    ) -> Result<SyncResult, String> {
        let mut result = SyncResult::default();
        let mailbox = self.load_mailbox(user_id).await?;
        if !mailbox.enabled {
            return Ok(result);
        }

        let (mut session, selected) =
            connect_selected(&mailbox, self.config.operation_timeout, "历史扫描").await?;
        let uid_validity = selected
            .uid_validity
            .ok_or_else(|| "IMAP 服务器没有返回 UIDVALIDITY，无法可靠索引历史邮件。".to_owned())?;
        let uids = within(
            self.config.operation_timeout,
            "搜索历史邮件",
            session.uid_search(range.search_query()?),
        )
        .await?
        .into_iter()
        .collect::<Vec<_>>();
        let available = uids.len();
        let uids = select_rescan_uids(uids, range.limit);
        self.prepare_run_fetch(user_id, run_id, available, uids.len())
            .await?;

        for uid in uids {
            if self.is_run_cancelled(user_id, run_id).await? {
                result.cancelled = true;
                break;
            }
            result.scanned += 1;
            // 同增量同步：处理前后各一拍，别让一封大附件把整轮扫描熬成「失去心跳」。
            if let Err(error) = self.update_run_progress(user_id, run_id, &result).await {
                tracing::warn!(user_id, run_id, %error, "历史扫描心跳保存失败");
            }
            match self
                .handle_uid(user_id, uid_validity, uid, &mailbox, &mut session, false)
                .await
            {
                Ok(outcome) => {
                    result.fetched += usize::from(outcome.content_fetched);
                    count_classification(&mut result, outcome.classification);
                }
                Err(error) => {
                    // 同增量同步：本地写失败也要停，接着扫下去只是把同一个故障重复几百遍。
                    let stop = stops_the_round(&error);
                    result.failed += 1;
                    result
                        .errors
                        .push(format!("邮件 UID {uid} 处理失败：{error}"));
                    if stop {
                        let _ = self.update_run_progress(user_id, run_id, &result).await;
                        break;
                    }
                }
            }
            if let Err(error) = self.update_run_progress(user_id, run_id, &result).await {
                tracing::warn!(user_id, run_id, %error, "历史扫描进度保存失败");
            }
        }

        let _ = within(self.config.operation_timeout, "退出邮箱", session.logout()).await;
        Ok(result)
    }

    async fn handle_uid(
        &self,
        user_id: i64,
        uid_validity: u32,
        uid: u32,
        mailbox: &MailboxRecord,
        session: &mut Session<MailStream>,
        force_content: bool,
    ) -> Result<MessageOutcome, MessageError> {
        let metadata_fetches = within(
            self.config.operation_timeout,
            "获取邮件索引",
            session.uid_fetch(
                uid.to_string(),
                "(UID RFC822.SIZE BODY.PEEK[HEADER] BODYSTRUCTURE)",
            ),
        )
        .await
        .map_err(MessageError::Retryable)?;
        let metadata_fetches = within(
            self.config.operation_timeout,
            "读取邮件索引",
            metadata_fetches.try_collect::<Vec<_>>(),
        )
        .await
        .map_err(MessageError::Retryable)?;
        let metadata_fetch = metadata_fetches
            .first()
            .ok_or_else(|| MessageError::Retryable("IMAP 没有返回邮件索引。".to_owned()))?;
        let raw_headers = metadata_fetch
            .header()
            .ok_or_else(|| MessageError::Retryable("IMAP 没有返回邮件 Header。".to_owned()))?;
        let message_size =
            usize::try_from(metadata_fetch.size.unwrap_or_default()).unwrap_or(usize::MAX);
        let ImapBodyMetadata {
            value: mut body_structure,
            attachments: metadata_attachments,
        } = ImapBodyMetadata::from_structure(metadata_fetch.bodystructure(), message_size);
        let metadata = ParsedMessage::parse_headers(raw_headers, metadata_attachments)
            .map_err(MessageError::Permanent)?;
        let metadata_to = metadata.to_address.clone().into_iter().collect::<Vec<_>>();
        let metadata_attachments = metadata
            .attachments
            .iter()
            .map(|attachment| crate::mail::rules::AttachmentFacts {
                filename: attachment.filename.clone(),
                mime: attachment.mime.clone(),
                size: attachment.size,
            })
            .collect::<Vec<_>>();
        let metadata_index = self
            .workbench
            .index_metadata(crate::mail::IndexMetadata {
                user_id,
                folder: &mailbox.folder,
                uid_validity,
                uid,
                message_id: metadata.message_id.as_deref(),
                from_address: metadata.from_address.as_deref(),
                to_addresses: &metadata_to,
                subject: metadata.subject.as_deref(),
                received_at: metadata.received_at,
                headers: &metadata.headers,
                raw_headers: &metadata.raw_headers,
                attachments: &metadata_attachments,
                body_structure: &body_structure,
            })
            .await
            .map_err(|error| MessageError::Local(format!("邮件工作台索引失败：{error}")))?;
        tracing::debug!(
            user_id,
            uid,
            mail_message_id = metadata_index.id,
            rule_matched = metadata_index.matched,
            needs_content = metadata_index.needs_content,
            "邮件工作台元数据索引完成"
        );
        let mut workbench_classification = Some(metadata_index.matched);
        if !force_content && !metadata_index.matched && !metadata_index.needs_content {
            return Ok(MessageOutcome {
                delivery: MessageDelivery::Indexed,
                classification: workbench_classification,
                content_fetched: false,
            });
        }
        if message_size > MAX_MESSAGE_BYTES {
            return Err(MessageError::Permanent(format!(
                "邮件超过 {} MiB 上限。",
                MAX_MESSAGE_BYTES / 1024 / 1024
            )));
        }

        let fetches = within(
            self.config.operation_timeout,
            "获取邮件内容",
            session.uid_fetch(uid.to_string(), "(UID BODY.PEEK[])"),
        )
        .await
        .map_err(MessageError::Retryable)?;
        let fetched = within(
            self.config.operation_timeout,
            "读取邮件内容",
            fetches.try_collect::<Vec<_>>(),
        )
        .await
        .map_err(MessageError::Retryable)?;
        let raw = fetched
            .first()
            .and_then(|fetch| fetch.body())
            .ok_or_else(|| MessageError::Retryable("IMAP 没有返回原始 EML。".to_owned()))?;
        if raw.len() > MAX_MESSAGE_BYTES {
            return Err(MessageError::Permanent(format!(
                "邮件超过 {} MiB 上限。",
                MAX_MESSAGE_BYTES / 1024 / 1024
            )));
        }
        let parsed = ParsedMessage::parse(raw).map_err(MessageError::Permanent)?;
        let to_addresses = parsed.to_address.clone().into_iter().collect::<Vec<_>>();
        let attachments = parsed
            .attachments
            .iter()
            .map(|attachment| crate::mail::rules::AttachmentFacts {
                filename: attachment.filename.clone(),
                mime: attachment.mime.clone(),
                size: attachment.size,
            })
            .collect::<Vec<_>>();
        body_structure["has_text"] = json!(parsed.body_text.is_some());
        body_structure["has_html"] = json!(parsed.body_html.is_some());
        body_structure["attachments"] = json!(attachments);
        let content_index = self
            .workbench
            .index(crate::mail::IndexMessage {
                user_id,
                folder: &mailbox.folder,
                uid_validity,
                uid,
                message_id: parsed.message_id.as_deref(),
                from_address: parsed.from_address.as_deref(),
                to_addresses: &to_addresses,
                subject: parsed.subject.as_deref(),
                received_at: parsed.received_at,
                headers: &parsed.headers,
                raw_headers: &parsed.raw_headers,
                body_text: parsed.body_text.as_deref(),
                body_html: parsed.body_html.as_deref(),
                attachments: &attachments,
                body_structure: &body_structure,
                raw,
                legacy_channel_key: None,
            })
            .await
            .map_err(|error| MessageError::Local(format!("邮件工作台索引失败：{error}")))?;
        workbench_classification = Some(content_index.matched);
        tracing::debug!(
            user_id,
            uid,
            mail_message_id = content_index.id,
            rule_matched = content_index.matched,
            "邮件工作台内容索引完成"
        );
        let delivery = if content_index.matched {
            match self
                .billing
                .enqueue_message(user_id, content_index.id)
                .await
                .map_err(MessageError::Retryable)?
            {
                Some((document_id, job_id)) => {
                    tracing::info!(
                        user_id,
                        mail_message_id = content_index.id,
                        document_id,
                        job_id,
                        "邮件已进入 Rust 账单解析链路"
                    );
                    MessageDelivery::Created
                }
                None => MessageDelivery::Duplicate,
            }
        } else {
            MessageDelivery::Ignored
        };
        Ok(MessageOutcome {
            delivery,
            classification: workbench_classification,
            content_fetched: true,
        })
    }

    async fn save_cursor(&self, user_id: i64, validity: u32, uid: u32) -> Result<(), String> {
        self.pool
            .get()
            .await
            .map_err(display)?
            .execute(
                "UPDATE abei_ai.mailboxes SET uid_validity = $2, last_uid = $3, updated_at = now()
                 WHERE user_id = $1",
                &[&user_id, &(validity as i64), &(uid as i64)],
            )
            .await
            .map_err(display)?;
        Ok(())
    }
}

fn select_uids(mut uids: Vec<u32>, last_uid: u32, limit: usize) -> Vec<u32> {
    uids.retain(|uid| *uid > last_uid);
    uids.sort_unstable();
    if last_uid == 0 && uids.len() > limit {
        uids.drain(..uids.len() - limit);
    } else {
        uids.truncate(limit);
    }
    uids
}

fn select_rescan_uids(mut uids: Vec<u32>, limit: usize) -> Vec<u32> {
    uids.sort_unstable();
    if uids.len() > limit {
        uids.drain(..uids.len() - limit);
    }
    uids
}

/// 抓一封邮件正文的结果。
#[derive(Debug, Clone)]
pub(crate) struct CachedMessage {
    /// 抓完之后这封邮件的样子，逐字就是 `GET /v1/mail-messages/{id}` 的响应。
    pub message: Value,
    /// 这一趟顺带建出了账单文档并排了第一个解析任务。调用方据此决定还要不要再排一次。
    pub enqueued: bool,
}

#[derive(Debug, Clone, Copy)]
struct MessageOutcome {
    delivery: MessageDelivery,
    classification: Option<bool>,
    content_fetched: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MessageDelivery {
    Created,
    Ignored,
    Duplicate,
    Indexed,
}

fn count_classification(result: &mut SyncResult, matched: Option<bool>) {
    match matched {
        Some(true) => result.matched += 1,
        Some(false) => result.unclassified += 1,
        None => {}
    }
}

#[derive(Debug)]
enum MessageError {
    Permanent(String),
    Retryable(String),
    Local(String),
}

impl MessageError {
    fn into_api_error(self) -> ApiError {
        match self {
            Self::Local(error) => ApiError::database(error),
            Self::Permanent(error) | Self::Retryable(error) => ApiError::oauth(error),
        }
    }
}

/// 这封邮件失败之后，本轮还能不能接着往下走。
///
/// 判据是「下一轮重来会不会不一样」：Permanent 是邮件本身的问题，重来还是一样，
/// 越过它；另外两种是我们这边的问题（连接断了、库写不进去），必须原地停住。
/// 增量同步里这个判断还额外决定游标推不推——越过一封没处理成的邮件，
/// 它就永远收不到了。
fn stops_the_round(error: &MessageError) -> bool {
    match error {
        MessageError::Permanent(_) => false,
        MessageError::Retryable(_) | MessageError::Local(_) => true,
    }
}

impl fmt::Display for MessageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Permanent(error) | Self::Retryable(error) | Self::Local(error) => {
                formatter.write_str(error)
            }
        }
    }
}

trait MailIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> MailIo for T {}

struct MailStream(Box<dyn MailIo>);

impl MailStream {
    fn new(stream: impl MailIo + 'static) -> Self {
        Self(Box::new(stream))
    }
}

impl fmt::Debug for MailStream {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("MailStream")
    }
}

impl AsyncRead for MailStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut *self.0).poll_read(context, buffer)
    }
}

impl AsyncWrite for MailStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        Pin::new(&mut *self.0).poll_write(context, buffer)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        Pin::new(&mut *self.0).poll_flush(context)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Result<(), io::Error>> {
        Pin::new(&mut *self.0).poll_shutdown(context)
    }
}

async fn connect(
    mailbox: &MailboxRecord,
    duration: Duration,
) -> Result<Session<MailStream>, String> {
    let mut stream = open_tcp(&mailbox.host, mailbox.port, duration).await?;
    if matches!(mailbox.encryption.as_str(), "ssl" | "tls") {
        stream = tls(stream, &mailbox.host, duration).await?;
    }

    let mut client = Client::new(stream);
    within(duration, "读取 IMAP 欢迎消息", client.read_response())
        .await?
        .ok_or_else(|| "IMAP 服务器连接后立即关闭。".to_owned())?;

    if mailbox.encryption == "starttls" {
        within(
            duration,
            "启动 STARTTLS",
            client.run_command_and_check_ok("STARTTLS", None),
        )
        .await?;
        let upgraded = tls(client.into_inner(), &mailbox.host, duration).await?;
        client = Client::new(upgraded);
    }

    match &mailbox.auth {
        MailboxAuth::Password(password) => {
            match timeout(duration, client.login(&mailbox.username, password)).await {
                Ok(Ok(session)) => Ok(session),
                Ok(Err((error, _))) => Err(format!("IMAP 登录失败：{error}")),
                Err(_) => Err(format!("IMAP 登录超过 {} 秒。", duration.as_secs())),
            }
        }
        MailboxAuth::GoogleAccessToken(access_token) => {
            let auth = XOAuth2::new(&mailbox.username, access_token);
            match timeout(duration, client.authenticate("XOAUTH2", auth)).await {
                Ok(Ok(session)) => Ok(session),
                Ok(Err((error, _))) => Err(format!("Gmail OAuth2 登录失败：{error}")),
                Err(_) => Err(format!("Gmail OAuth2 登录超过 {} 秒。", duration.as_secs())),
            }
        }
    }
}

/// SELECT 偶发超时时重建会话并重试一次。IMAP session 在超时后不能可靠复用，
/// 所以每次重试都从全新的连接开始，并把文件夹和业务阶段写进错误。
async fn connect_selected(
    mailbox: &MailboxRecord,
    duration: Duration,
    stage: &str,
) -> Result<(Session<MailStream>, ImapMailbox), String> {
    let mut last_error = None;
    for attempt in 0..=1 {
        let mut session = connect(mailbox, duration).await.map_err(|error| {
            format!(
                "{stage}：连接 IMAP {}:{} 并打开文件夹 {} 失败：{error}",
                mailbox.host, mailbox.port, mailbox.folder
            )
        })?;
        match within(
            duration,
            &format!("{stage}：打开邮箱文件夹 {}", mailbox.folder),
            session.select(&mailbox.folder),
        )
        .await
        {
            Ok(selected) => return Ok((session, selected)),
            Err(error) => {
                last_error = Some(error);
                let _ = within(duration, "退出 IMAP 会话", session.logout()).await;
                if attempt == 0 {
                    tracing::warn!(folder = %mailbox.folder, %stage, "IMAP SELECT 失败，重建连接重试");
                }
            }
        }
    }
    Err(format!(
        "{stage}：无法打开邮箱文件夹 {}（已重试 1 次）：{}",
        mailbox.folder,
        last_error.unwrap_or_else(|| "未知 IMAP 错误".to_owned())
    ))
}

struct XOAuth2(Option<String>);

impl XOAuth2 {
    fn new(username: &str, access_token: &str) -> Self {
        Self(Some(format!(
            "user={username}\x01auth=Bearer {access_token}\x01\x01"
        )))
    }
}

impl Authenticator for XOAuth2 {
    type Response = String;

    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        self.0.take().unwrap_or_default()
    }
}

async fn open_tcp(host: &str, port: u16, duration: Duration) -> Result<MailStream, String> {
    let proxy = Proxy::from_env(host)?;
    let target = proxy
        .as_ref()
        .map(|proxy| (proxy.host.as_str(), proxy.port))
        .unwrap_or((host, port));
    let mut stream = timeout(duration, TcpStream::connect(target))
        .await
        .map_err(|_| {
            format!(
                "连接 {}:{} 超过 {} 秒。",
                target.0,
                target.1,
                duration.as_secs()
            )
        })?
        .map_err(display)?;
    if let Some(proxy) = proxy {
        let tunnel = timeout(duration, async {
            match (proxy.username.as_deref(), proxy.password.as_deref()) {
                (Some(username), Some(password)) => {
                    http_connect_tokio_with_basic_auth(&mut stream, host, port, username, password)
                        .await
                }
                _ => http_connect_tokio(&mut stream, host, port).await,
            }
        })
        .await
        .map_err(|_| format!("建立 IMAP 代理隧道超过 {} 秒。", duration.as_secs()))?;
        tunnel.map_err(|error| format!("IMAP 代理隧道建立失败：{error}"))?;
    }
    Ok(MailStream::new(stream))
}

async fn tls(stream: MailStream, host: &str, duration: Duration) -> Result<MailStream, String> {
    let certificates = rustls_native_certs::load_native_certs();
    for error in certificates.errors {
        tracing::warn!(%error, "系统 CA 证书加载失败");
    }
    let mut roots = RootCertStore::empty();
    let (loaded, _) = roots.add_parsable_certificates(certificates.certs);
    if loaded == 0 {
        return Err("没有可用的系统 CA 证书。".to_owned());
    }
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let server_name =
        ServerName::try_from(host.to_owned()).map_err(|_| format!("IMAP 主机名不合法：{host}"))?;
    let connected = timeout(
        duration,
        TlsConnector::from(Arc::new(config)).connect(server_name, stream),
    )
    .await
    .map_err(|_| format!("IMAP TLS 握手超过 {} 秒。", duration.as_secs()))?
    .map_err(|error| format!("IMAP TLS 握手失败：{error}"))?;
    Ok(MailStream::new(connected))
}

async fn within<T, E, F>(duration: Duration, operation: &str, future: F) -> Result<T, String>
where
    F: Future<Output = Result<T, E>>,
    E: fmt::Display,
{
    timeout(duration, future)
        .await
        .map_err(|_| format!("{operation}超过 {} 秒。", duration.as_secs()))?
        .map_err(|error| format!("{operation}失败：{error}"))
}

#[derive(Debug)]
struct Proxy {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
}

impl Proxy {
    fn from_env(target_host: &str) -> Result<Option<Self>, String> {
        if no_proxy_matches(target_host) {
            return Ok(None);
        }
        let raw = [
            "BILL_INBOX_IMAP_PROXY",
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
        ]
        .iter()
        .find_map(|name| env::var(name).ok().filter(|value| !value.trim().is_empty()));
        let Some(mut raw) = raw else {
            return Ok(None);
        };
        if !raw.contains("://") {
            raw.insert_str(0, "http://");
        }
        let url =
            reqwest::Url::parse(&raw).map_err(|error| format!("IMAP 代理地址不合法：{error}"))?;
        if url.scheme() != "http" {
            return Err("IMAP 代理只支持 HTTP CONNECT。".to_owned());
        }
        let host = url
            .host_str()
            .ok_or_else(|| "IMAP 代理没有主机名。".to_owned())?
            .to_owned();
        let username = (!url.username().is_empty()).then(|| url.username().to_owned());
        let password = username
            .as_ref()
            .map(|_| url.password().unwrap_or("").to_owned());
        Ok(Some(Self {
            host,
            port: url.port_or_known_default().unwrap_or(80),
            username,
            password,
        }))
    }
}

fn no_proxy_matches(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    env::var("NO_PROXY")
        .or_else(|_| env::var("no_proxy"))
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .any(|entry| {
            if entry == "*" {
                return true;
            }
            let entry = entry
                .split(':')
                .next()
                .unwrap_or(entry)
                .trim_start_matches('.')
                .to_ascii_lowercase();
            host == entry || host.ends_with(&format!(".{entry}"))
        })
}

#[derive(Debug)]
struct ParsedMessage {
    message_id: Option<String>,
    from_address: Option<String>,
    to_address: Option<String>,
    subject: Option<String>,
    received_at: Option<i64>,
    body_text: Option<String>,
    body_html: Option<String>,
    headers: BTreeMap<String, Vec<String>>,
    raw_headers: String,
    attachments: Vec<ParsedAttachment>,
}

#[derive(Debug)]
struct ParsedAttachment {
    filename: String,
    mime: String,
    size: usize,
}

impl ParsedMessage {
    fn parse(raw: &[u8]) -> Result<Self, String> {
        let message = MessageParser::default()
            .parse(raw)
            .ok_or_else(|| "EML/MIME 解析失败。".to_owned())?;
        let attachments = message
            .attachments()
            .enumerate()
            .map(|(index, part)| ParsedAttachment {
                filename: safe_filename(
                    part.attachment_name().unwrap_or({
                        if index == 0 {
                            "attachment.bin"
                        } else {
                            "attachment"
                        }
                    }),
                    index,
                ),
                mime: part
                    .content_type()
                    .map(|content_type| {
                        format!(
                            "{}/{}",
                            content_type.ctype(),
                            content_type.subtype().unwrap_or("octet-stream")
                        )
                    })
                    .unwrap_or_else(|| "application/octet-stream".to_owned()),
                size: part.contents().len(),
            })
            .collect();
        let mut headers = BTreeMap::<String, Vec<String>>::new();
        for header in message.headers().iter().take(200) {
            let name = header.name.to_string().to_ascii_lowercase();
            let value = raw
                .get(header.offset_start as usize..header.offset_end as usize)
                .map(String::from_utf8_lossy)
                .map(|value| header_value(Some(value.trim()), 4096).unwrap_or_default())
                .unwrap_or_default();
            if !value.is_empty() {
                headers.entry(name).or_default().push(value);
            }
        }
        Ok(Self {
            message_id: message_id_value(message.message_id()),
            from_address: header_value(first_address(message.from()).as_deref(), 255),
            to_address: header_value(first_address(message.to()).as_deref(), 255),
            subject: header_value(message.subject(), 255),
            received_at: message.date().map(|date| date.to_timestamp()),
            body_text: message.body_text(0).map(|body| body.into_owned()),
            body_html: message.body_html(0).map(|body| body.into_owned()),
            headers,
            raw_headers: raw_header_block(raw),
            attachments,
        })
    }

    fn parse_headers(raw: &[u8], attachments: Vec<ParsedAttachment>) -> Result<Self, String> {
        let message = MessageParser::default()
            .parse_headers(raw)
            .ok_or_else(|| "邮件 Header 解析失败。".to_owned())?;
        let mut headers = BTreeMap::<String, Vec<String>>::new();
        for header in message.headers().iter().take(200) {
            let name = header.name.to_string().to_ascii_lowercase();
            let value = raw
                .get(header.offset_start as usize..header.offset_end as usize)
                .map(String::from_utf8_lossy)
                .map(|value| header_value(Some(value.trim()), 4096).unwrap_or_default())
                .unwrap_or_default();
            if !value.is_empty() {
                headers.entry(name).or_default().push(value);
            }
        }
        Ok(Self {
            message_id: message_id_value(message.message_id()),
            from_address: header_value(first_address(message.from()).as_deref(), 255),
            to_address: header_value(first_address(message.to()).as_deref(), 255),
            subject: header_value(message.subject(), 255),
            received_at: message.date().map(|date| date.to_timestamp()),
            body_text: None,
            body_html: None,
            headers,
            raw_headers: String::from_utf8_lossy(raw).into_owned(),
            attachments,
        })
    }
}

struct ImapBodyMetadata {
    value: Value,
    attachments: Vec<ParsedAttachment>,
}

impl ImapBodyMetadata {
    fn from_structure(structure: Option<&BodyStructure<'_>>, message_size: usize) -> Self {
        let mut attachments = Vec::new();
        let tree = structure.map(|body| body_structure_json(body, &mut attachments));
        let has_text = structure.is_some_and(|body| body_structure_has_mime(body, "text/plain"));
        let has_html = structure.is_some_and(|body| body_structure_has_mime(body, "text/html"));
        Self {
            value: json!({
                "message_size": message_size,
                "has_text": has_text,
                "has_html": has_html,
                "attachments": attachments.iter().map(|attachment| json!({
                    "filename": attachment.filename,
                    "mime": attachment.mime,
                    "size": attachment.size,
                })).collect::<Vec<_>>(),
                "tree": tree,
            }),
            attachments,
        }
    }
}

fn body_structure_json(body: &BodyStructure<'_>, attachments: &mut Vec<ParsedAttachment>) -> Value {
    match body {
        BodyStructure::Basic { common, other, .. } | BodyStructure::Text { common, other, .. } => {
            body_part_json(
                common,
                usize::try_from(other.octets).unwrap_or(usize::MAX),
                attachments,
            )
        }
        BodyStructure::Message {
            common,
            other,
            body,
            ..
        } => {
            let mut value = body_part_json(
                common,
                usize::try_from(other.octets).unwrap_or(usize::MAX),
                attachments,
            );
            value["children"] = json!([body_structure_json(body, attachments)]);
            value
        }
        BodyStructure::Multipart { common, bodies, .. } => json!({
            "mime": body_mime(common),
            "disposition": common.disposition.as_ref().map(|value| value.ty.as_ref()),
            "children": bodies
                .iter()
                .map(|body| body_structure_json(body, attachments))
                .collect::<Vec<_>>(),
        }),
    }
}

fn body_part_json(
    common: &BodyContentCommon<'_>,
    size: usize,
    attachments: &mut Vec<ParsedAttachment>,
) -> Value {
    let mime = body_mime(common);
    let filename = body_param(
        common
            .disposition
            .as_ref()
            .and_then(|value| value.params.as_ref()),
        "filename",
    )
    .or_else(|| body_param(common.ty.params.as_ref(), "name"));
    let disposition = common
        .disposition
        .as_ref()
        .map(|value| value.ty.as_ref().to_ascii_lowercase());
    if disposition.as_deref() == Some("attachment") || filename.is_some() {
        let index = attachments.len();
        attachments.push(ParsedAttachment {
            filename: safe_filename(filename.as_deref().unwrap_or("attachment.bin"), index),
            mime: mime.clone(),
            size,
        });
    }
    json!({
        "mime": mime,
        "filename": filename,
        "disposition": disposition,
        "size": size,
    })
}

fn body_structure_has_mime(body: &BodyStructure<'_>, expected: &str) -> bool {
    match body {
        BodyStructure::Basic { common, .. } | BodyStructure::Text { common, .. } => {
            body_mime(common) == expected
        }
        BodyStructure::Message { common, body, .. } => {
            body_mime(common) == expected || body_structure_has_mime(body, expected)
        }
        BodyStructure::Multipart { bodies, .. } => bodies
            .iter()
            .any(|body| body_structure_has_mime(body, expected)),
    }
}

fn body_mime(common: &BodyContentCommon<'_>) -> String {
    format!(
        "{}/{}",
        common.ty.ty.to_ascii_lowercase(),
        common.ty.subtype.to_ascii_lowercase()
    )
}

fn body_param(
    params: Option<&Vec<(std::borrow::Cow<'_, str>, std::borrow::Cow<'_, str>)>>,
    expected: &str,
) -> Option<String> {
    params?
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(expected))
        .map(|(_, value)| value.to_string())
}

fn raw_header_block(raw: &[u8]) -> String {
    let end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| index + 2)
        .or_else(|| {
            raw.windows(2)
                .position(|window| window == b"\n\n")
                .map(|index| index + 1)
        })
        .unwrap_or(raw.len())
        .min(64 * 1024);
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

fn first_address(address: Option<&mail_parser::Address<'_>>) -> Option<String> {
    address?.first()?.address.as_deref().map(str::to_owned)
}

fn message_id_value(value: Option<&str>) -> Option<String> {
    let value = value?;
    if value.chars().count() > 255 || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.to_owned())
}

fn header_value(value: Option<&str>, max: usize) -> Option<String> {
    let value = value?
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(max)
        .collect::<String>();
    (!value.is_empty()).then_some(value)
}

fn safe_filename(value: &str, index: usize) -> String {
    let basename = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let cleaned: String = basename
        .chars()
        .filter(|character| !character.is_control())
        .map(|character| {
            if matches!(character, '/' | '\\') {
                '_'
            } else {
                character
            }
        })
        .take(140)
        .collect();
    if cleaned.trim().is_empty() {
        format!("attachment-{}.bin", index + 1)
    } else {
        cleaned
    }
}

/// 连续失败 n 次之后要等多久才再试：每多失败一次翻一倍，封顶在 `backoff_max`。
/// 没失败过就是 0；成功一次失败计数归零，退避也跟着消失。
fn backoff_for(sync_interval: Duration, backoff_max: Duration, failures: i64) -> Duration {
    if failures <= 0 {
        return Duration::ZERO;
    }
    // 指数先夹到 16：再大也早就撞上封顶了，夹一下顺便躲开 2^n 溢出。
    let exponent = u32::try_from(failures - 1).unwrap_or(u32::MAX).min(16);
    sync_interval
        .saturating_mul(2u32.saturating_pow(exponent))
        .min(backoff_max)
}

fn sha256(content: &[u8]) -> String {
    Sha256::digest(content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpListener;

    #[test]
    fn a_mailbox_that_keeps_failing_gets_retried_less_and_less() {
        let interval = Duration::from_secs(600);
        let max = Duration::from_secs(3600);

        // 一直成功的邮箱不欠任何等待，照常按 sync_interval 排。
        assert_eq!(backoff_for(interval, max, 0), Duration::ZERO);
        // 第一次失败等一个间隔，之后每失败一次翻倍。
        assert_eq!(backoff_for(interval, max, 1), interval);
        assert_eq!(backoff_for(interval, max, 2), interval * 2);
        assert_eq!(backoff_for(interval, max, 3), interval * 4);
        // 涨到封顶就不再涨，密码改了的邮箱不会退避到几天后。
        assert_eq!(backoff_for(interval, max, 4), max);
        assert_eq!(backoff_for(interval, max, 99), max);
        // 失败次数再离谱也只是封顶，不会溢出成 0 而把邮箱变成死循环重试。
        assert_eq!(backoff_for(interval, max, i64::MAX), max);
    }

    #[tokio::test]
    async fn select_timeout_reconnects_once_and_reports_the_folder() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut handlers = Vec::new();
            for attempt in 0..2 {
                let (socket, _) = listener.accept().await.unwrap();
                handlers.push(tokio::spawn(async move {
                    let (reader, mut writer) = socket.into_split();
                    let mut reader = BufReader::new(reader);
                    writer.write_all(b"* OK fake IMAP ready\r\n").await.unwrap();
                    let mut line = String::new();
                    loop {
                        line.clear();
                        if reader.read_line(&mut line).await.unwrap() == 0 {
                            break;
                        }
                        let tag = line.split_whitespace().next().unwrap_or("A1");
                        let command = line.to_ascii_uppercase();
                        if command.contains(" LOGIN ") {
                            writer
                                .write_all(format!("{tag} OK LOGIN completed\r\n").as_bytes())
                                .await
                                .unwrap();
                        } else if command.contains(" SELECT ") && attempt == 0 {
                            tokio::time::sleep(Duration::from_millis(300)).await;
                            break;
                        } else if command.contains(" SELECT ") {
                            writer
                                .write_all(
                                    format!(
                                        "* FLAGS (\\Seen)\r\n* 0 EXISTS\r\n* 0 RECENT\r\n\
                                         * OK [UIDVALIDITY 42] valid\r\n* OK [UIDNEXT 1] next\r\n\
                                         {tag} OK [READ-WRITE] SELECT completed\r\n"
                                    )
                                    .as_bytes(),
                                )
                                .await
                                .unwrap();
                        } else if command.contains(" LOGOUT") {
                            writer
                                .write_all(
                                    format!("* BYE logout\r\n{tag} OK LOGOUT completed\r\n")
                                        .as_bytes(),
                                )
                                .await
                                .unwrap();
                            break;
                        }
                    }
                }));
            }
            for handler in handlers {
                handler.await.unwrap();
            }
        });
        let mailbox = MailboxRecord {
            enabled: true,
            host: address.ip().to_string(),
            port: address.port(),
            encryption: "none".to_owned(),
            username: "user@example.com".to_owned(),
            auth: MailboxAuth::Password("app-password".to_owned()),
            folder: "INBOX".to_owned(),
            uid_validity: None,
            last_uid: 0,
        };

        let (mut session, selected) =
            connect_selected(&mailbox, Duration::from_millis(100), "增量同步")
                .await
                .unwrap();
        assert_eq!(selected.uid_validity, Some(42));
        within(Duration::from_secs(1), "退出测试邮箱", session.logout())
            .await
            .unwrap();
        server.await.unwrap();

        let unavailable = MailboxRecord {
            port: address.port().saturating_add(1),
            ..mailbox
        };
        let error = connect_selected(&unavailable, Duration::from_millis(20), "增量同步")
            .await
            .unwrap_err();
        assert!(error.contains("增量同步"), "{error}");
    }

    #[test]
    fn initial_sync_prioritizes_the_latest_messages() {
        assert_eq!(select_uids((1..=30).collect(), 0, 3), vec![28, 29, 30]);
        assert_eq!(select_uids((1..=30).collect(), 10, 3), vec![11, 12, 13]);
    }

    #[test]
    fn historical_scan_uses_an_inclusive_date_range_and_latest_limit() {
        let range = RescanRange::parse(&RescanRequest {
            from: "2026-08-01".to_owned(),
            to: Some("2026-08-11".to_owned()),
            limit: Some(3),
        })
        .unwrap();
        assert_eq!(
            range.search_query().unwrap(),
            "SINCE 1-Aug-2026 BEFORE 12-Aug-2026"
        );
        assert_eq!(select_rescan_uids(vec![5, 2, 4, 1, 3], 3), vec![3, 4, 5]);
    }

    #[test]
    fn historical_scan_rejects_invalid_ranges() {
        for request in [
            RescanRequest {
                from: "2026-08-12".to_owned(),
                to: Some("2026-08-11".to_owned()),
                limit: Some(100),
            },
            RescanRequest {
                from: "2026-01-01".to_owned(),
                to: Some("2026-08-11".to_owned()),
                limit: Some(100),
            },
            RescanRequest {
                from: "2026-08-01".to_owned(),
                to: Some("2026-08-11".to_owned()),
                limit: Some(0),
            },
        ] {
            assert!(RescanRange::parse(&request).is_err());
        }
    }

    #[test]
    fn xoauth2_sends_the_bearer_response_once() {
        let mut auth = XOAuth2::new("owner@gmail.com", "access-token");
        assert_eq!(
            auth.process(&[]),
            "user=owner@gmail.com\u{1}auth=Bearer access-token\u{1}\u{1}"
        );
        assert_eq!(auth.process(b"gmail-error"), "");
    }

    #[test]
    fn google_authorization_uses_pkce_offline_access_and_mail_scope() {
        let client = BasicClient::new(ClientId::new("client-id".to_owned()))
            .set_client_secret(ClientSecret::new("client-secret".to_owned()))
            .set_auth_uri(AuthUrl::new(GOOGLE_AUTH_URL.to_owned()).unwrap())
            .set_token_uri(TokenUrl::new(GOOGLE_TOKEN_URL.to_owned()).unwrap())
            .set_revocation_url(RevocationUrl::new(GOOGLE_REVOKE_URL.to_owned()).unwrap())
            .set_redirect_uri(
                RedirectUrl::new("http://127.0.0.1/oauth/google/callback".to_owned()).unwrap(),
            );
        let google = GoogleOAuth {
            client,
            http: reqwest::Client::new(),
        };
        let (challenge, _) = PkceCodeChallenge::new_random_sha256();
        let url =
            reqwest::Url::parse(&google.authorization_url("state-value".to_owned(), challenge))
                .unwrap();
        let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();

        assert_eq!(
            query.get("access_type").map(String::as_str),
            Some("offline")
        );
        assert_eq!(query.get("state").map(String::as_str), Some("state-value"));
        assert_eq!(
            query.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert!(
            query["scope"]
                .split(' ')
                .any(|scope| scope == "https://mail.google.com/")
        );
    }

    #[test]
    fn mime_parser_and_password_cipher_round_trip() {
        let raw = concat!(
            "Message-ID: <cmb-1@example.test>\r\n",
            "From: CMB <95555@message.cmbchina.com>\r\n",
            "To: bills@example.test\r\n",
            "Subject: 招商银行交易流水\r\n",
            "Date: Sun, 10 Aug 2026 12:00:00 +0800\r\n",
            "MIME-Version: 1.0\r\n",
            "Content-Type: multipart/mixed; boundary=abei\r\n\r\n",
            "--abei\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n",
            "电子版交易流水，请在招商银行App查看。\r\n",
            "--abei\r\nContent-Type: application/zip; name=statement.zip\r\n",
            "Content-Disposition: attachment; filename=statement.zip\r\n",
            "Content-Transfer-Encoding: base64\r\n\r\nUEsDBAo=\r\n",
            "--abei--\r\n"
        );
        let parsed = ParsedMessage::parse(raw.as_bytes()).unwrap();
        assert_eq!(parsed.attachments[0].filename, "statement.zip");
        assert_eq!(parsed.attachments[0].size, 5);

        let cipher = RuntimeConfig::test().password_cipher;
        let encrypted = cipher.encrypt(7, "app-password").unwrap();
        assert_ne!(encrypted, "app-password");
        assert_eq!(cipher.decrypt(7, &encrypted).unwrap(), "app-password");
        assert!(cipher.decrypt(8, &encrypted).is_err());
        assert!(validate_password(&"x".repeat(4097)).is_err());
        assert!(validate_password("line\nbreak").is_err());
    }

    #[test]
    fn only_a_broken_message_lets_the_cursor_move_past_it() {
        // 本地写失败推游标 = 这封邮件从此脱离增量同步，只能靠猜日期做历史扫描才找得回来。
        assert!(stops_the_round(&MessageError::Local(
            "邮件工作台索引失败".to_owned()
        )));
        assert!(stops_the_round(&MessageError::Retryable(
            "IMAP 连接断开".to_owned()
        )));
        // 邮件本身用不了，重来一次还是一样，越过它才走得下去。
        assert!(!stops_the_round(&MessageError::Permanent(
            "邮件超过大小上限".to_owned()
        )));
    }
}
