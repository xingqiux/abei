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
use async_imap::{Authenticator, Client, Session};
use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::http::{HeaderMap, StatusCode};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use chacha20poly1305::aead::{Aead, Generate, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use deadpool_postgres::{Pool, Transaction};
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
use tokio::fs;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};

use crate::{ApiError, AppState};

const USER_ID_HEADER: &str = "x-abei-authenticated-user-id";
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
    google_oauth: Option<GoogleOAuth>,
    operation_timeout: Duration,
    pub sync_interval: Duration,
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
            google_oauth,
            operation_timeout,
            sync_interval,
        })
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
            google_oauth: None,
            operation_timeout: Duration::from_secs(2),
            sync_interval: Duration::from_secs(300),
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
struct SecretCipher([u8; 32]);

impl SecretCipher {
    fn new(app_key: &str, label: &[u8]) -> Self {
        let mut digest = Sha256::new();
        digest.update(label);
        digest.update(app_key.as_bytes());
        Self(digest.finalize().into())
    }

    fn encrypt(&self, user_id: i64, password: &str) -> Result<String, String> {
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

    fn decrypt(&self, user_id: i64, encoded: &str) -> Result<String, String> {
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
}

impl Service {
    pub fn new(pool: Pool, config: RuntimeConfig) -> Self {
        Self { pool, config }
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
        let rows = client
            .query(
                "SELECT user_id FROM abei_ai.mailboxes WHERE enabled = true ORDER BY user_id",
                &[],
            )
            .await
            .map_err(display)?;
        for row in rows {
            self.enqueue(row.get(0), 100).await?;
        }
        Ok(())
    }

    async fn enqueue(&self, user_id: i64, limit: i16) -> Result<Value, String> {
        let limit = limit.clamp(1, 100);
        let client = self.pool.get().await.map_err(display)?;
        let queued = client
            .query_opt(
                "INSERT INTO public.bill_mailbox_sync_states
                   (user_id, status, \"limit\", requested_at, started_at, finished_at, result,
                    error_message, created_at, updated_at)
                 VALUES ($1, 'queued', $2, now(), NULL, NULL, NULL, NULL, now(), now())
                 ON CONFLICT (user_id) DO UPDATE SET
                   status = 'queued', \"limit\" = EXCLUDED.\"limit\", requested_at = now(),
                   started_at = NULL, finished_at = NULL, result = NULL, error_message = NULL,
                   updated_at = now()
                 WHERE bill_mailbox_sync_states.status <> 'running'
                    OR bill_mailbox_sync_states.updated_at < now() - interval '3 minutes'
                 RETURNING status::text, requested_at::text, started_at::text, finished_at::text,
                           result::text, error_message",
                &[&user_id, &limit],
            )
            .await
            .map_err(display)?;

        if let Some(row) = queued {
            let state = sync_state(&row);
            let service = self.clone();
            tokio::spawn(async move { service.run(user_id, limit).await });
            return Ok(state);
        }

        self.load_sync_state(user_id).await
    }

    async fn load_sync_state(&self, user_id: i64) -> Result<Value, String> {
        let client = self.pool.get().await.map_err(display)?;
        let row = client
            .query_one(
                "SELECT status::text, requested_at::text, started_at::text, finished_at::text,
                        result::text, error_message
                 FROM public.bill_mailbox_sync_states WHERE user_id = $1",
                &[&user_id],
            )
            .await
            .map_err(display)?;
        Ok(sync_state(&row))
    }

    async fn run(&self, user_id: i64, limit: i16) {
        match self.set_running(user_id).await {
            Ok(true) => {}
            Ok(false) => return,
            Err(error) => {
                tracing::error!(user_id, %error, "账单邮箱同步状态无法更新为 running");
                return;
            }
        }

        let result = match self.sync_user(user_id, limit as usize).await {
            Ok(result) => result,
            Err(error) => SyncResult {
                failed: 1,
                errors: vec![error],
                ..SyncResult::default()
            },
        };
        if let Err(error) = self.finish(user_id, &result).await {
            tracing::error!(user_id, %error, "账单邮箱同步结果无法保存");
        }
    }

    async fn set_running(&self, user_id: i64) -> Result<bool, String> {
        let updated = self
            .pool
            .get()
            .await
            .map_err(display)?
            .execute(
                "UPDATE public.bill_mailbox_sync_states SET status = 'running', started_at = now(),
                   finished_at = NULL, result = NULL, error_message = NULL, updated_at = now()
                 WHERE user_id = $1 AND status = 'queued'",
                &[&user_id],
            )
            .await
            .map_err(display)?;
        Ok(updated == 1)
    }

    async fn finish(&self, user_id: i64, result: &SyncResult) -> Result<(), String> {
        let status = if result.failed == 0 {
            "succeeded"
        } else {
            "failed"
        };
        let error = result.errors.first().map(|value| truncate(value, 2000));
        let encoded = serde_json::to_string(result).map_err(display)?;
        self.pool
            .get()
            .await
            .map_err(display)?
            .execute(
                "UPDATE public.bill_mailbox_sync_states SET status = $2, finished_at = now(),
                   result = $3::text::json, error_message = $4, updated_at = now() WHERE user_id = $1",
                &[&user_id, &status, &encoded, &error],
            )
            .await
            .map_err(display)?;
        tracing::info!(
            user_id,
            status,
            scanned = result.scanned,
            created = result.created,
            "账单邮箱同步完成"
        );
        Ok(())
    }
}

#[derive(Debug, Default, Serialize)]
struct SyncResult {
    scanned: usize,
    created: usize,
    ignored: usize,
    duplicates: usize,
    failed: usize,
    processed: usize,
    process_failed: usize,
    errors: Vec<String>,
}

fn sync_state(row: &tokio_postgres::Row) -> Value {
    let result: Option<Value> = row
        .get::<_, Option<String>>(4)
        .and_then(|raw| serde_json::from_str(&raw).ok());
    json!({
        "status": row.get::<_, String>(0),
        "requested_at": row.get::<_, Option<String>>(1),
        "started_at": row.get::<_, Option<String>>(2),
        "finished_at": row.get::<_, Option<String>>(3),
        "result": result,
        "error_message": row.get::<_, Option<String>>(5),
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GoogleCallback {
    code: String,
    state: String,
}

pub(crate) async fn get_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let settings = state.mailbox.load_settings(user_id).await?;
    Ok(Json(settings_response(settings)))
}

pub(crate) async fn update_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<SettingsUpdate>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let Json(update) = payload.map_err(|error| ApiError::invalid_params(error.body_text()))?;
    let settings = state.mailbox.save_settings(user_id, update).await?;
    Ok(Json(settings_response(settings)))
}

pub(crate) async fn sync(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<SyncRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
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

fn authenticated_user_id(headers: &HeaderMap) -> Result<i64, ApiError> {
    headers
        .get(USER_ID_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .ok_or_else(|| ApiError::forbidden("缺少可信的 Firefly 用户 ID。"))
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

struct MailboxRecord {
    enabled: bool,
    email: String,
    host: String,
    port: u16,
    encryption: String,
    username: String,
    auth: MailboxAuth,
    folder: String,
    uid_validity: Option<u32>,
    last_uid: u32,
}

enum MailboxAuth {
    Password(String),
    GoogleAccessToken(String),
}

impl Service {
    async fn load_mailbox(&self, user_id: i64) -> Result<MailboxRecord, String> {
        let client = self.pool.get().await.map_err(display)?;
        let row = client
            .query_opt(
                "SELECT enabled, email, host, port, encryption, username, password_ciphertext,
                        folder, uid_validity, last_uid, auth_method,
                        oauth_refresh_token_ciphertext
                 FROM abei_ai.mailboxes WHERE user_id = $1",
                &[&user_id],
            )
            .await
            .map_err(display)?
            .ok_or_else(|| "邮箱还没有配置。".to_owned())?;
        let enabled = row.get(0);
        let auth = match (enabled, row.get::<_, String>(10).as_str()) {
            (false, _) => MailboxAuth::Password(String::new()),
            (true, "password") => {
                let encrypted = row
                    .get::<_, Option<String>>(6)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "邮箱已启用，但没有保存密码，请重新保存邮箱设置。".to_owned())?;
                MailboxAuth::Password(self.config.password_cipher.decrypt(user_id, &encrypted)?)
            }
            (true, "google_oauth") => {
                let encrypted = row
                    .get::<_, Option<String>>(11)
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
            email: row.get(1),
            host: row.get(2),
            port: u16::try_from(row.get::<_, i32>(3))
                .map_err(|_| "保存的 IMAP 端口不合法。".to_owned())?,
            encryption: row.get(4),
            username: row.get(5),
            auth,
            folder: row.get(7),
            uid_validity: row
                .get::<_, Option<i64>>(8)
                .map(u32::try_from)
                .transpose()
                .map_err(|_| "保存的 IMAP UIDVALIDITY 不合法。".to_owned())?,
            last_uid: u32::try_from(row.get::<_, i64>(9))
                .map_err(|_| "保存的 IMAP 游标不合法。".to_owned())?,
        })
    }

    async fn sync_user(&self, user_id: i64, limit: usize) -> Result<SyncResult, String> {
        let mut result = SyncResult::default();
        let mut mailbox = self.load_mailbox(user_id).await?;
        if !mailbox.enabled {
            return Ok(result);
        }

        let mut session = connect(&mailbox, self.config.operation_timeout).await?;
        let selected = within(
            self.config.operation_timeout,
            "打开邮箱文件夹",
            session.select(&mailbox.folder),
        )
        .await?;
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
        let uids = select_uids(uids, mailbox.last_uid, limit);

        for uid in uids {
            result.scanned += 1;
            let handled = self
                .handle_uid(user_id, uid_validity, uid, &mailbox, &mut session)
                .await;
            match handled {
                Ok(MessageOutcome::Created) => result.created += 1,
                Ok(MessageOutcome::Ignored) => result.ignored += 1,
                Ok(MessageOutcome::Duplicate) => result.duplicates += 1,
                Err(error) => {
                    let retryable = matches!(error, MessageError::Retryable(_));
                    result.failed += 1;
                    result
                        .errors
                        .push(format!("邮件 UID {uid} 处理失败：{error}"));
                    if retryable {
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
    ) -> Result<MessageOutcome, MessageError> {
        let fetches = within(
            self.config.operation_timeout,
            "获取邮件",
            session.uid_fetch(uid.to_string(), "(UID BODY.PEEK[])"),
        )
        .await
        .map_err(MessageError::Retryable)?;
        let fetched = within(
            self.config.operation_timeout,
            "读取邮件正文",
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
        let Some(channel) = Channel::detect(&parsed) else {
            return Ok(MessageOutcome::Ignored);
        };
        let checksum = sha256(raw);
        let cursor = format!("imap:{uid_validity}:{uid}");
        if self
            .is_duplicate(user_id, parsed.message_id.as_deref(), &checksum, &cursor)
            .await
            .map_err(MessageError::Retryable)?
        {
            return Ok(MessageOutcome::Duplicate);
        }
        let stored = self
            .store_files(user_id, raw, &parsed, &checksum)
            .await
            .map_err(MessageError::Retryable)?;
        self.insert_message(
            user_id, mailbox, channel, &parsed, &stored, &checksum, &cursor,
        )
        .await
        .map_err(MessageError::Retryable)?;
        Ok(MessageOutcome::Created)
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

    async fn is_duplicate(
        &self,
        user_id: i64,
        message_id: Option<&str>,
        checksum: &str,
        cursor: &str,
    ) -> Result<bool, String> {
        self.pool
            .get()
            .await
            .map_err(display)?
            .query_opt(
                "SELECT 1 FROM public.bill_mail_messages
                 WHERE user_id = $1 AND
                   (checksum = $2 OR sync_cursor = $3 OR ($4::text IS NOT NULL AND message_id = $4))
                 LIMIT 1",
                &[&user_id, &checksum, &cursor, &message_id],
            )
            .await
            .map(|row| row.is_some())
            .map_err(display)
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

#[derive(Debug, Clone, Copy)]
enum MessageOutcome {
    Created,
    Ignored,
    Duplicate,
}

#[derive(Debug)]
enum MessageError {
    Permanent(String),
    Retryable(String),
}

impl fmt::Display for MessageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Permanent(error) | Self::Retryable(error) => formatter.write_str(error),
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
    attachments: Vec<ParsedAttachment>,
}

#[derive(Debug)]
struct ParsedAttachment {
    filename: String,
    content: Vec<u8>,
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
                content: part.contents().to_vec(),
            })
            .collect();
        Ok(Self {
            message_id: message_id_value(message.message_id()),
            from_address: header_value(first_address(message.from()).as_deref(), 255),
            to_address: header_value(first_address(message.to()).as_deref(), 255),
            subject: header_value(message.subject(), 255),
            received_at: message.date().map(|date| date.to_timestamp()),
            body_text: message.body_text(0).map(|body| body.into_owned()),
            body_html: message.body_html(0).map(|body| body.into_owned()),
            attachments,
        })
    }

    fn body(&self) -> String {
        [self.body_html.as_deref(), self.body_text.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n")
    }
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

#[derive(Debug)]
struct StoredMessage {
    raw_path: String,
    body_text_path: Option<String>,
    body_html_path: Option<String>,
    attachments: Vec<StoredAttachment>,
}

#[derive(Debug)]
struct StoredAttachment {
    filename: String,
    path: String,
    checksum: String,
    size: i64,
}

impl Service {
    async fn store_files(
        &self,
        user_id: i64,
        raw: &[u8],
        parsed: &ParsedMessage,
        checksum: &str,
    ) -> Result<StoredMessage, String> {
        let base = PathBuf::from(format!("bill-inbox/{user_id}/{checksum}"));
        let raw_path = base.join("message.eml");
        self.write(&raw_path, raw).await?;
        let body_text_path = match parsed
            .body_text
            .as_deref()
            .filter(|body| !body.trim().is_empty())
        {
            Some(body) => {
                let path = base.join("body.txt");
                self.write(&path, body.as_bytes()).await?;
                Some(relative_path(&path))
            }
            None => None,
        };
        let body_html_path = match parsed
            .body_html
            .as_deref()
            .filter(|body| !body.trim().is_empty())
        {
            Some(body) => {
                let path = base.join("body.html");
                self.write(&path, body.as_bytes()).await?;
                Some(relative_path(&path))
            }
            None => None,
        };
        let mut attachments = Vec::with_capacity(parsed.attachments.len());
        for (index, attachment) in parsed.attachments.iter().enumerate() {
            let path =
                base.join("attachments")
                    .join(format!("{:02}-{}", index + 1, attachment.filename));
            self.write(&path, &attachment.content).await?;
            attachments.push(StoredAttachment {
                filename: attachment.filename.clone(),
                path: relative_path(&path),
                checksum: sha256(&attachment.content),
                size: attachment.content.len() as i64,
            });
        }
        Ok(StoredMessage {
            raw_path: relative_path(&raw_path),
            body_text_path,
            body_html_path,
            attachments,
        })
    }

    async fn write(&self, relative: &Path, content: &[u8]) -> Result<(), String> {
        let path = self.config.storage_root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.map_err(display)?;
        }
        fs::write(path, content).await.map_err(display)
    }

    #[allow(clippy::too_many_arguments)]
    async fn insert_message(
        &self,
        user_id: i64,
        mailbox: &MailboxRecord,
        channel: Channel,
        parsed: &ParsedMessage,
        stored: &StoredMessage,
        checksum: &str,
        cursor: &str,
    ) -> Result<(), String> {
        let mut client = self.pool.get().await.map_err(display)?;
        let transaction = client.transaction().await.map_err(display)?;
        let received_at = parsed.received_at.map(|value| value as f64);
        let mailbox_name = if mailbox.email.is_empty() {
            &mailbox.username
        } else {
            &mailbox.email
        };
        let row = transaction
            .query_one(
                "INSERT INTO public.bill_mail_messages
                   (user_id, message_id, mailbox, from_address, to_address, subject, received_at,
                    raw_path, body_text_path, body_html_path, checksum, sync_cursor, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5,$6,
                         CASE WHEN $7::double precision IS NULL THEN NULL ELSE to_timestamp($7) END,
                         $8,$9,$10,$11,$12,now(),now()) RETURNING id",
                &[
                    &user_id,
                    &parsed.message_id,
                    &mailbox_name,
                    &parsed.from_address,
                    &parsed.to_address,
                    &parsed.subject,
                    &received_at,
                    &stored.raw_path,
                    &stored.body_text_path,
                    &stored.body_html_path,
                    &checksum,
                    &cursor,
                ],
            )
            .await
            .map_err(display)?;
        let mail_id: i64 = row.get(0);
        channel
            .ingest(&transaction, user_id, mail_id, parsed, stored)
            .await?;
        transaction.commit().await.map_err(display)?;
        Ok(())
    }
}

fn relative_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
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

fn sha256(content: &[u8]) -> String {
    Sha256::digest(content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Channel {
    Alipay,
    Wechat,
    CmbTransaction,
    CmbCreditDaily,
    Boc,
}

impl Channel {
    fn detect(mail: &ParsedMessage) -> Option<Self> {
        let sender = mail
            .from_address
            .as_deref()
            .unwrap_or("")
            .to_ascii_lowercase();
        let subject = mail.subject.as_deref().unwrap_or("");
        let body = mail.body();
        let has_zip = mail
            .attachments
            .iter()
            .any(|attachment| extension(&attachment.filename) == "zip");
        let has_pdf = mail
            .attachments
            .iter()
            .any(|attachment| extension(&attachment.filename) == "pdf");

        if sender.contains("service@mail.alipay.com") && subject.contains("支付宝交易流水明细")
        {
            Some(Self::Alipay)
        } else if sender.contains("wechatpay@tencent.com")
            && (subject.contains("微信支付账单流水文件") || body.contains("微信支付账单流水文件"))
            && (subject.contains("账单流水文件") || body.contains("点击下载"))
            && has_wechat_download_url(&body)
        {
            Some(Self::Wechat)
        } else if sender.contains("95555@message.cmbchina.com")
            && (subject.contains("招商银行交易流水") || body.contains("电子版交易流水"))
            && (body.contains("招商银行App") || body.contains("流水打印") || has_zip)
        {
            Some(Self::CmbTransaction)
        } else if sender.contains("ccsvc@message.cmbchina.com")
            && subject.trim() == "每日信用管家"
            && mail
                .body_html
                .as_deref()
                .is_some_and(|html| html.contains("您的消费明细如下"))
        {
            Some(Self::CmbCreditDaily)
        } else if subject.contains("中国银行交易流水")
            && (body.contains("中国银行APP") || body.contains("交易流水打印"))
            && has_pdf
        {
            Some(Self::Boc)
        } else {
            None
        }
    }

    async fn ingest(
        self,
        transaction: &Transaction<'_>,
        user_id: i64,
        mail_id: i64,
        mail: &ParsedMessage,
        stored: &StoredMessage,
    ) -> Result<(), String> {
        let metadata = serde_json::to_string(&self.task_metadata(mail)).map_err(display)?;
        let received_at = mail.received_at.map(|value| value as f64);
        let row = transaction
            .query_one(
                "INSERT INTO public.bill_tasks
                   (user_id, bill_mail_message_id, source, profile_id, status, received_at,
                    summary, metadata, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,'received',
                         CASE WHEN $5::double precision IS NULL THEN NULL ELSE to_timestamp($5) END,
                         $6,$7::text::json,now(),now()) RETURNING id",
                &[
                    &user_id,
                    &mail_id,
                    &self.source(),
                    &self.profile_id(),
                    &received_at,
                    &self.summary(),
                    &metadata,
                ],
            )
            .await
            .map_err(display)?;
        let task_id: i64 = row.get(0);

        match self {
            Self::Alipay | Self::CmbTransaction => {
                for attachment in &stored.attachments {
                    self.insert_attachment(transaction, task_id, attachment)
                        .await?;
                }
            }
            Self::Boc => {
                for attachment in stored
                    .attachments
                    .iter()
                    .filter(|attachment| extension(&attachment.filename) == "pdf")
                {
                    self.insert_attachment(transaction, task_id, attachment)
                        .await?;
                }
            }
            Self::CmbCreditDaily => {
                let html = mail
                    .body_html
                    .as_deref()
                    .ok_or_else(|| "招商银行每日信用管家邮件缺少 HTML 正文。".to_owned())?;
                let path = stored
                    .body_html_path
                    .as_deref()
                    .ok_or_else(|| "招商银行每日信用管家 HTML 正文没有落盘。".to_owned())?;
                let artifact_metadata = json!({
                    "source": "mail_body",
                    "original_name": "body.html",
                    "content_type": "text/html",
                    "size": html.len(),
                });
                insert_artifact(
                    transaction,
                    task_id,
                    "html",
                    "cmb-credit-daily.html",
                    path,
                    &sha256(html.as_bytes()),
                    false,
                    &artifact_metadata,
                )
                .await?;
            }
            Self::Wechat => {}
        }

        transaction
            .execute(
                "INSERT INTO public.bill_task_events
                   (bill_task_id, event_type, message, metadata, created_at, updated_at)
                 VALUES ($1, 'task.created', $2, '{\"source\":\"mailbox\"}'::json, now(), now())",
                &[&task_id, &self.event_message()],
            )
            .await
            .map_err(display)?;
        Ok(())
    }

    async fn insert_attachment(
        self,
        transaction: &Transaction<'_>,
        task_id: i64,
        attachment: &StoredAttachment,
    ) -> Result<(), String> {
        let metadata = json!({
            "source": "mail_attachment",
            "password_source": self.password_source(),
            "size": attachment.size,
        });
        insert_artifact(
            transaction,
            task_id,
            &extension(&attachment.filename),
            &attachment.filename,
            &attachment.path,
            &attachment.checksum,
            true,
            &metadata,
        )
        .await
    }

    fn source(self) -> &'static str {
        match self {
            Self::Alipay => "alipay",
            Self::Wechat => "wechat",
            Self::CmbTransaction | Self::CmbCreditDaily => "cmb",
            Self::Boc => "boc",
        }
    }

    fn profile_id(self) -> &'static str {
        match self {
            Self::Alipay => "alipay-statement",
            Self::Wechat => "wechat-pay-statement",
            Self::CmbTransaction => "cmb-transaction-statement",
            Self::CmbCreditDaily => "cmb-credit-card-daily",
            Self::Boc => "boc-transaction-statement",
        }
    }

    fn summary(self) -> &'static str {
        match self {
            Self::Alipay => "支付宝交易流水明细",
            Self::Wechat => "微信支付账单流水",
            Self::CmbTransaction => "招商银行交易流水",
            Self::CmbCreditDaily => "招商银行信用卡每日消费",
            Self::Boc => "中国银行交易流水",
        }
    }

    fn password_source(self) -> Option<&'static str> {
        match self {
            Self::Alipay => Some("alipay_service_message"),
            Self::Wechat => Some("wechat_pay_official_account"),
            Self::CmbTransaction => Some("cmb_app_statement_record"),
            Self::Boc => Some("boc_app_statement_record"),
            Self::CmbCreditDaily => None,
        }
    }

    fn task_metadata(self, mail: &ParsedMessage) -> Value {
        let common = json!({
            "mail_subject": mail.subject,
            "sender": mail.from_address,
        });
        match self {
            Self::Alipay => merge_json(
                common,
                json!({
                    "password_source": "alipay_service_message",
                }),
            ),
            Self::Wechat => {
                let (start, end) = wechat_statement_period(&format!(
                    "{} {}",
                    mail.subject.as_deref().unwrap_or(""),
                    mail.body()
                ));
                merge_json(
                    common,
                    json!({
                        "password_source": "wechat_pay_official_account",
                        "statement_period": {"start": start, "end": end},
                        "remote_file": {
                            "source": "tenpay_download",
                            "status": "pending",
                            "host": "tenpay.wechatpay.cn",
                            "path": "/userroll/userbilldownload/downloadfilefromemail"
                        }
                    }),
                )
            }
            Self::CmbTransaction => merge_json(
                common,
                json!({
                    "password_source": "cmb_app_statement_record",
                    "applied_at": cmb_applied_at(&format!(
                        "{}\n{}",
                        mail.subject.as_deref().unwrap_or(""),
                        mail.body()
                    )),
                }),
            ),
            Self::CmbCreditDaily => common,
            Self::Boc => merge_json(
                common,
                json!({
                    "password_source": "boc_app_statement_record",
                }),
            ),
        }
    }

    fn event_message(self) -> &'static str {
        match self {
            Self::Alipay => "已识别支付宝交易流水邮件，等待解压密码",
            Self::Wechat => "已识别微信支付账单流水邮件，等待自动下载账单文件",
            Self::CmbTransaction => "已识别招商银行交易流水邮件，等待解压码",
            Self::CmbCreditDaily => "已识别招商银行每日信用管家邮件，等待解析消费明细",
            Self::Boc => "已识别中国银行交易流水邮件，等待打开密码",
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn insert_artifact(
    transaction: &Transaction<'_>,
    task_id: i64,
    kind: &str,
    filename: &str,
    path: &str,
    checksum: &str,
    encrypted: bool,
    metadata: &Value,
) -> Result<(), String> {
    let metadata = serde_json::to_string(metadata).map_err(display)?;
    transaction
        .execute(
            "INSERT INTO public.bill_artifacts
               (bill_task_id, kind, filename, path, checksum, encrypted, metadata, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7::text::json,now(),now())",
            &[&task_id, &kind, &filename, &path, &checksum, &encrypted, &metadata],
        )
        .await
        .map_err(display)?;
    Ok(())
}

fn extension(filename: &str) -> String {
    Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .filter(|extension| !extension.is_empty())
        .unwrap_or("attachment")
        .to_ascii_lowercase()
}

fn has_wechat_download_url(body: &str) -> bool {
    const PREFIX: &str =
        "https://tenpay.wechatpay.cn/userroll/userbilldownload/downloadfilefromemail?";

    body.match_indices(PREFIX).any(|(start, _)| {
        let query = &body[start + PREFIX.len()..];
        let query = query
            .split(|character: char| {
                character.is_whitespace() || matches!(character, '"' | '\'' | '<' | '>')
            })
            .next()
            .unwrap_or_default()
            .replace("&amp;", "&");
        query.split('&').any(|pair| {
            pair.split_once('=')
                .is_some_and(|(name, value)| name == "encrypted_file_data" && !value.is_empty())
        })
    })
}

fn wechat_statement_period(content: &str) -> (Option<String>, Option<String>) {
    const MARKER: &str = "账单流水文件(";

    for (start, _) in content.match_indices(MARKER) {
        let tail = &content[start + MARKER.len()..];
        let Some(period) = tail.get(..17) else {
            continue;
        };
        if period.as_bytes().get(8) != Some(&b'-') {
            continue;
        }
        let start = date8(&period[..8]);
        let end = date8(&period[9..]);
        if start.is_some() && end.is_some() {
            return (start, end);
        }
    }
    (None, None)
}

fn cmb_applied_at(content: &str) -> Option<String> {
    for (year_end, _) in content.match_indices('年') {
        let Some(year_start) = year_end.checked_sub(4) else {
            continue;
        };
        let Some(year) = content.get(year_start..year_end).and_then(number) else {
            continue;
        };
        let mut tail = &content[year_end + '年'.len_utf8()..];
        let Some((month, rest)) = take_number(tail, 2, "月") else {
            continue;
        };
        tail = rest;
        let Some((day, rest)) = take_number(tail, 2, "日") else {
            continue;
        };
        tail = rest;
        let Some((hour, rest)) = take_number(tail, 2, ":") else {
            continue;
        };
        tail = rest;
        let Some((minute, rest)) = take_number(tail, 2, ":") else {
            continue;
        };
        let Some(second) = rest.get(..2).and_then(number) else {
            continue;
        };
        if valid_date(year, month, day) && hour < 24 && minute < 60 && second < 60 {
            return Some(format!(
                "{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02}"
            ));
        }
    }
    None
}

fn take_number<'a>(value: &'a str, width: usize, suffix: &str) -> Option<(u32, &'a str)> {
    let number = value.get(..width).and_then(number)?;
    let rest = value.get(width..)?.strip_prefix(suffix)?;
    Some((number, rest))
}

fn number(value: &str) -> Option<u32> {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit())
        .then(|| value.parse().ok())
        .flatten()
}

fn date8(value: &str) -> Option<String> {
    if value.len() != 8 {
        return None;
    }
    let year = number(&value[..4])?;
    let month = number(&value[4..6])?;
    let day = number(&value[6..])?;
    valid_date(year, month, day).then(|| format!("{year:04}-{month:02}-{day:02}"))
}

fn valid_date(year: u32, month: u32, day: u32) -> bool {
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    year > 0 && (1..=days).contains(&day)
}

fn merge_json(mut left: Value, right: Value) -> Value {
    if let (Some(left), Some(right)) = (left.as_object_mut(), right.as_object()) {
        left.extend(right.clone());
    }
    left
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(
        sender: &str,
        subject: &str,
        body_text: Option<&str>,
        body_html: Option<&str>,
        attachment: Option<&str>,
    ) -> ParsedMessage {
        ParsedMessage {
            message_id: None,
            from_address: Some(sender.to_owned()),
            to_address: None,
            subject: Some(subject.to_owned()),
            received_at: None,
            body_text: body_text.map(str::to_owned),
            body_html: body_html.map(str::to_owned),
            attachments: attachment
                .map(|filename| {
                    vec![ParsedAttachment {
                        filename: filename.to_owned(),
                        content: Vec::new(),
                    }]
                })
                .unwrap_or_default(),
        }
    }

    #[test]
    fn initial_sync_prioritizes_the_latest_messages() {
        assert_eq!(select_uids((1..=30).collect(), 0, 3), vec![28, 29, 30]);
        assert_eq!(select_uids((1..=30).collect(), 10, 3), vec![11, 12, 13]);
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
    fn recognizes_all_supported_channels() {
        assert_eq!(
            Channel::detect(&message(
                "service@mail.alipay.com",
                "支付宝交易流水明细",
                None,
                None,
                Some("statement.zip")
            )),
            Some(Channel::Alipay)
        );
        assert_eq!(
            Channel::detect(&message(
                "wechatpay@tencent.com",
                "微信支付账单流水文件",
                Some(
                    "点击下载 https://tenpay.wechatpay.cn/userroll/userbilldownload/downloadfilefromemail?encrypted_file_data=token"
                ),
                None,
                None
            )),
            Some(Channel::Wechat)
        );
        assert_eq!(
            Channel::detect(&message(
                "95555@message.cmbchina.com",
                "招商银行交易流水",
                Some("电子版交易流水，请在招商银行App查看。"),
                None,
                Some("statement.zip")
            )),
            Some(Channel::CmbTransaction)
        );
        assert_eq!(
            Channel::detect(&message(
                "ccsvc@message.cmbchina.com",
                "每日信用管家",
                None,
                Some("<p>您的消费明细如下</p>"),
                None
            )),
            Some(Channel::CmbCreditDaily)
        );
        assert_eq!(
            Channel::detect(&message(
                "service@bankofchina.com",
                "中国银行交易流水",
                Some("请在中国银行APP查看交易流水打印记录。"),
                None,
                Some("statement.pdf")
            )),
            Some(Channel::Boc)
        );
    }

    #[test]
    fn mature_parser_feeds_channel_matching_and_passwords_round_trip() {
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
        assert_eq!(Channel::detect(&parsed), Some(Channel::CmbTransaction));
        assert_eq!(parsed.attachments[0].filename, "statement.zip");
        assert_eq!(parsed.attachments[0].content, b"PK\x03\x04\n");

        let cipher = RuntimeConfig::test().password_cipher;
        let encrypted = cipher.encrypt(7, "app-password").unwrap();
        assert_ne!(encrypted, "app-password");
        assert_eq!(cipher.decrypt(7, &encrypted).unwrap(), "app-password");
        assert!(cipher.decrypt(8, &encrypted).is_err());
        assert!(validate_password(&"x".repeat(4097)).is_err());
        assert!(validate_password("line\nbreak").is_err());

        assert_eq!(
            cmb_applied_at("申请时间：2026年06月16日17:44:37"),
            Some("2026-06-16 17:44:37".to_owned())
        );
        assert_eq!(
            wechat_statement_period("微信支付账单流水文件(20260515-20260615)"),
            (Some("2026-05-15".to_owned()), Some("2026-06-15".to_owned()))
        );
        assert!(has_wechat_download_url(
            "https://tenpay.wechatpay.cn/userroll/userbilldownload/downloadfilefromemail?foo=1&amp;encrypted_file_data=token"
        ));
        assert!(!has_wechat_download_url(
            "https://example.com/userroll/userbilldownload/downloadfilefromemail?encrypted_file_data=token"
        ));
    }
}
