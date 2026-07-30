use std::{collections::BTreeSet, sync::LazyLock};

use axum::{
    Extension, Json,
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use axum_extra::extract::{
    CookieJar,
    cookie::{Cookie, SameSite},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use email_address::EmailAddress;
use password_auth::{generate_hash, verify_password};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use time::{Duration, OffsetDateTime};

use crate::http::AppState;

const SESSION_DAYS: i64 = 30;
const PAT_SCOPES: [&str; 8] = [
    "profile:read",
    "organizations:read",
    "organizations:manage",
    "books:read",
    "books:write",
    "tokens:manage",
    "instance:manage",
    "*",
];
static DUMMY_PASSWORD_HASH: LazyLock<String> =
    LazyLock::new(|| generate_hash("granary-dummy-password-not-used"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthKind {
    Session,
    Pat,
}

#[derive(Clone, Debug)]
pub struct Principal {
    pub user_id: i64,
    pub auth_kind: AuthKind,
    pub credential_id: i64,
    pub scopes: Vec<String>,
}

impl Principal {
    pub fn has_scope(&self, scope: &str) -> bool {
        self.auth_kind == AuthKind::Session
            || self.scopes.iter().any(|value| {
                value == "*"
                    || value == scope
                    || (scope == "books:read" && value == "books:write")
                    || (scope == "organizations:read" && value == "organizations:manage")
            })
    }
}

#[derive(Deserialize)]
pub struct BootstrapRequest {
    email: String,
    display_name: String,
    password: String,
}

#[derive(Serialize)]
pub struct BootstrapResponse {
    user_id: i64,
    organization_id: i64,
    book_id: i64,
    personal_access_token: String,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
pub struct LoginResponse {
    user_id: i64,
    display_name: String,
    csrf_token: Option<String>,
    mfa_required: bool,
    mfa_challenge_token: Option<String>,
}

#[derive(Serialize)]
pub struct MeResponse {
    id: i64,
    email: String,
    display_name: String,
    instance_admin: bool,
}

#[derive(Serialize)]
pub struct CsrfResponse {
    csrf_token: String,
}

#[derive(Deserialize)]
pub struct CreatePatRequest {
    name: String,
    scopes: Vec<String>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    expires_at: Option<OffsetDateTime>,
}

#[derive(Serialize)]
pub struct CreatedPatResponse {
    id: i64,
    name: String,
    scopes: Vec<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    expires_at: Option<OffsetDateTime>,
    token: String,
}

#[derive(sqlx::FromRow)]
struct PatRow {
    id: i64,
    selector: String,
    name: String,
    scopes: Vec<String>,
    expires_at: Option<OffsetDateTime>,
    revoked_at: Option<OffsetDateTime>,
    last_used_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
}

#[derive(Serialize)]
pub struct PatResponse {
    id: i64,
    token_prefix: String,
    name: String,
    scopes: Vec<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    expires_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    revoked_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    last_used_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: i64,
    user_agent: Option<String>,
    expires_at: OffsetDateTime,
    last_seen_at: OffsetDateTime,
    revoked_at: Option<OffsetDateTime>,
    revoke_reason: Option<String>,
    created_at: OffsetDateTime,
}

#[derive(Serialize)]
pub struct SessionResponse {
    id: i64,
    current: bool,
    user_agent: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    last_seen_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    revoked_at: Option<OffsetDateTime>,
    revoke_reason: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

impl From<PatRow> for PatResponse {
    fn from(row: PatRow) -> Self {
        Self {
            id: row.id,
            token_prefix: format!("grn_pat_{}_", row.selector),
            name: row.name,
            scopes: row.scopes,
            expires_at: row.expires_at,
            revoked_at: row.revoked_at,
            last_used_at: row.last_used_at,
            created_at: row.created_at,
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: ErrorDetail,
}

#[derive(Serialize)]
struct ErrorDetail {
    code: &'static str,
    message: String,
}

pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    pub(crate) fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
        }
    }

    pub(crate) fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code,
            message: message.into(),
        }
    }

    pub(crate) fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
        }
    }

    pub(crate) fn database(error: sqlx::Error) -> Self {
        if let sqlx::Error::Database(database) = &error {
            return match database.code().as_deref() {
                Some("23505") => Self::conflict("duplicate", "名称或标识已经存在"),
                Some("23503" | "23514") => {
                    Self::bad_request("constraint_violation", "请求违反数据约束")
                }
                Some("55000") => Self::conflict("immutable", "已入账数据不能直接修改"),
                _ => Self::internal(error),
            };
        }
        Self::internal(error)
    }

    pub(crate) fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(error = %error, "request failed");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal_error",
            message: "服务器处理请求失败".to_owned(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ErrorBody {
                error: ErrorDetail {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

pub async fn bootstrap(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<BootstrapRequest>,
) -> Result<(StatusCode, Json<BootstrapResponse>), ApiError> {
    validate_origin(&state, &headers)?;
    let email = normalize_email(&request.email)?;
    let display_name = normalize_name(&request.display_name)?;
    validate_password(&request.password)?;
    if sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM users)")
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::internal)?
    {
        return Err(ApiError::conflict(
            "instance_already_initialized",
            "实例已经完成首次初始化",
        ));
    }
    let password_hash = hash_password(request.password).await?;
    let (selector, secret, token_hash) = new_pat();
    let token = format!("grn_pat_{selector}_{secret}");

    let mut tx = state.pool.begin().await.map_err(ApiError::internal)?;
    sqlx::query("LOCK TABLE users IN EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    let user_count = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM users")
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::internal)?;
    if user_count != 0 {
        return Err(ApiError::conflict(
            "instance_already_initialized",
            "实例已经完成首次初始化",
        ));
    }

    let user_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO users (email, display_name, password_hash, is_instance_admin)
        VALUES ($1, $2, $3, TRUE)
        RETURNING id
        "#,
    )
    .bind(email)
    .bind(&display_name)
    .bind(password_hash)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let organization_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO organizations (name, created_by_user_id) VALUES ($1, $2) RETURNING id",
    )
    .bind(format!("{display_name}的个人空间"))
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(organization_id)
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    let book_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO books (organization_id, name, created_by_user_id) VALUES ($1, '默认账本', $2) RETURNING id",
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query("INSERT INTO book_memberships (book_id, user_id, role) VALUES ($1, $2, 'manager')")
        .bind(book_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::internal)?;

    initialize_book_accounts(&mut tx, book_id, "CNY").await?;
    sqlx::query(
        r#"
        INSERT INTO personal_access_tokens (selector, token_hash, user_id, name, scopes)
        VALUES ($1, $2, $3, '首次初始化令牌', ARRAY['*'])
        "#,
    )
    .bind(&selector)
    .bind(token_hash)
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, book_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, after_data
        ) VALUES ($1, $2, 'system', $3, 'instance.bootstrapped', 'user', $3,
                  jsonb_build_object('display_name', $4))
        "#,
    )
    .bind(organization_id)
    .bind(book_id)
    .bind(user_id)
    .bind(&display_name)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    tx.commit().await.map_err(ApiError::internal)?;

    Ok((
        StatusCode::CREATED,
        Json(BootstrapResponse {
            user_id,
            organization_id,
            book_id,
            personal_access_token: token,
        }),
    ))
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> Result<(CookieJar, Json<LoginResponse>), ApiError> {
    validate_origin(&state, &headers)?;
    let email = normalize_email(&request.email)?;
    let user = sqlx::query_as::<_, (i64, String, String, i64, Option<OffsetDateTime>)>(
        "SELECT id, display_name, password_hash, auth_epoch, disabled_at FROM users WHERE lower(email) = $1",
    )
    .bind(email)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?;

    let hash = user
        .as_ref()
        .map(|(_, _, hash, _, _)| hash.clone())
        .unwrap_or_else(|| DUMMY_PASSWORD_HASH.clone());
    let valid = verify_password_async(request.password, hash).await?;
    let Some((user_id, display_name, _, auth_epoch, disabled_at)) = user else {
        return Err(ApiError::unauthorized("邮箱或密码错误"));
    };
    if !valid || disabled_at.is_some() {
        return Err(ApiError::unauthorized("邮箱或密码错误"));
    }

    if crate::mfa::is_enabled(&state.pool, user_id).await? {
        let challenge_token =
            crate::mfa::create_login_challenge(&state.pool, user_id, auth_epoch).await?;
        return Ok((
            jar,
            Json(LoginResponse {
                user_id,
                display_name,
                csrf_token: None,
                mfa_required: true,
                mfa_challenge_token: Some(challenge_token),
            }),
        ));
    }

    let (session_token, csrf_token, session_id) =
        issue_session(&state, user_id, auth_epoch, user_agent(&headers)).await?;
    sqlx::query(
        "INSERT INTO audit_events (actor_kind, actor_user_id, action, entity_type, entity_id) VALUES ('user', $1, 'auth.login', 'user_session', $2)",
    )
    .bind(user_id)
    .bind(session_id)
    .execute(&state.pool)
    .await
    .map_err(ApiError::internal)?;

    Ok((
        jar.add(session_cookie(&state, session_token)),
        Json(LoginResponse {
            user_id,
            display_name,
            csrf_token: Some(csrf_token),
            mfa_required: false,
            mfa_challenge_token: None,
        }),
    ))
}

pub async fn logout(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    jar: CookieJar,
) -> Result<(CookieJar, StatusCode), ApiError> {
    if principal.auth_kind != AuthKind::Session {
        return Err(ApiError::bad_request(
            "session_required",
            "PAT 请求不能执行浏览器登出",
        ));
    }
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    sqlx::query(
        r#"
        UPDATE user_sessions
        SET revoked_at = now(), revoked_by_user_id = $2, revoke_reason = '用户退出登录'
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
        "#,
    )
    .bind(principal.credential_id)
    .bind(principal.user_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::internal)?;
    audit_auth_event(
        &mut tx,
        &principal,
        "auth.logout",
        "user_session",
        principal.credential_id,
        serde_json::json!({ "revoked": true }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;

    Ok((
        jar.remove(expired_session_cookie(&state)),
        StatusCode::NO_CONTENT,
    ))
}

pub async fn list_sessions(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<Vec<SessionResponse>>, ApiError> {
    require_scope(&principal, "tokens:manage")?;
    let rows = sqlx::query_as::<_, SessionRow>(
        r#"
        SELECT id, user_agent, expires_at, last_seen_at, revoked_at, revoke_reason, created_at
        FROM user_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        "#,
    )
    .bind(principal.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(
        rows.into_iter()
            .map(|row| SessionResponse {
                current: principal.auth_kind == AuthKind::Session
                    && principal.credential_id == row.id,
                id: row.id,
                user_agent: row.user_agent,
                expires_at: row.expires_at,
                last_seen_at: row.last_seen_at,
                revoked_at: row.revoked_at,
                revoke_reason: row.revoke_reason,
                created_at: row.created_at,
            })
            .collect(),
    ))
}

pub async fn revoke_session(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    axum::extract::Path(session_id): axum::extract::Path<i64>,
    jar: CookieJar,
) -> Result<(CookieJar, StatusCode), ApiError> {
    require_scope(&principal, "tokens:manage")?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let revoked_at = sqlx::query_scalar::<_, Option<OffsetDateTime>>(
        "SELECT revoked_at FROM user_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(session_id)
    .bind(principal.user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("Session 不存在"))?;
    if revoked_at.is_some() {
        return Err(ApiError::conflict(
            "session_already_revoked",
            "Session 已经撤销",
        ));
    }
    sqlx::query(
        r#"
        UPDATE user_sessions
        SET revoked_at = now(), revoked_by_user_id = $2, revoke_reason = '用户撤销'
        WHERE id = $1
        "#,
    )
    .bind(session_id)
    .bind(principal.user_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_auth_event(
        &mut tx,
        &principal,
        "session.revoked",
        "user_session",
        session_id,
        serde_json::json!({ "revoked": true }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    let jar = if principal.auth_kind == AuthKind::Session && principal.credential_id == session_id {
        jar.remove(expired_session_cookie(&state))
    } else {
        jar
    };
    Ok((jar, StatusCode::NO_CONTENT))
}

pub async fn me(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<MeResponse>, ApiError> {
    if !principal.has_scope("profile:read") {
        return Err(ApiError::forbidden(
            "scope_required",
            "PAT 缺少 profile:read 权限范围",
        ));
    }
    let user = sqlx::query_as::<_, (i64, String, String, bool)>(
        "SELECT id, email, display_name, is_instance_admin FROM users WHERE id = $1 AND disabled_at IS NULL",
    )
    .bind(principal.user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?
    .ok_or_else(|| ApiError::unauthorized("用户不存在或已停用"))?;

    Ok(Json(MeResponse {
        id: user.0,
        email: user.1,
        display_name: user.2,
        instance_admin: user.3,
    }))
}

pub async fn csrf(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<CsrfResponse>, ApiError> {
    if principal.auth_kind != AuthKind::Session {
        return Err(ApiError::bad_request(
            "session_required",
            "PAT 请求不需要 CSRF Token",
        ));
    }
    let csrf_token = random_token();
    let updated = sqlx::query(
        "UPDATE user_sessions SET csrf_hash = $3 WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(principal.credential_id)
    .bind(principal.user_id)
    .bind(digest(&csrf_token))
    .execute(&state.pool)
    .await
    .map_err(ApiError::database)?;
    if updated.rows_affected() != 1 {
        return Err(ApiError::unauthorized("登录会话无效或已过期"));
    }
    Ok(Json(CsrfResponse { csrf_token }))
}

pub async fn create_pat(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<CreatePatRequest>,
) -> Result<(StatusCode, Json<CreatedPatResponse>), ApiError> {
    require_scope(&principal, "tokens:manage")?;
    let name = normalize_name(&request.name)?;
    let scopes = validate_pat_scopes(&principal, request.scopes)?;
    if request
        .expires_at
        .is_some_and(|expires_at| expires_at <= OffsetDateTime::now_utc())
    {
        return Err(ApiError::bad_request(
            "pat_expiry_invalid",
            "PAT 过期时间必须晚于当前时间",
        ));
    }
    let (selector, secret, token_hash) = new_pat();
    let token = format!("grn_pat_{selector}_{secret}");
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO personal_access_tokens (selector, token_hash, user_id, name, scopes, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(&selector)
    .bind(token_hash)
    .bind(principal.user_id)
    .bind(&name)
    .bind(&scopes)
    .bind(request.expires_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_auth_event(
        &mut tx,
        &principal,
        "pat.created",
        "personal_access_token",
        id,
        serde_json::json!({ "name": name, "scopes": scopes, "expires_at": request.expires_at }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(CreatedPatResponse {
            id,
            name,
            scopes,
            expires_at: request.expires_at,
            token,
        }),
    ))
}

pub async fn list_pats(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<Vec<PatResponse>>, ApiError> {
    require_scope(&principal, "tokens:manage")?;
    let rows = sqlx::query_as::<_, PatRow>(
        r#"
        SELECT id, selector, name, scopes, expires_at, revoked_at, last_used_at, created_at
        FROM personal_access_tokens
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        "#,
    )
    .bind(principal.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows.into_iter().map(PatResponse::from).collect()))
}

pub async fn revoke_pat(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    axum::extract::Path(pat_id): axum::extract::Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_scope(&principal, "tokens:manage")?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let revoked_at = sqlx::query_scalar::<_, Option<OffsetDateTime>>(
        "SELECT revoked_at FROM personal_access_tokens WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(pat_id)
    .bind(principal.user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("PAT 不存在"))?;
    if revoked_at.is_some() {
        return Err(ApiError::conflict("pat_already_revoked", "PAT 已经撤销"));
    }
    sqlx::query("UPDATE personal_access_tokens SET revoked_at = now() WHERE id = $1")
        .bind(pat_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    audit_auth_event(
        &mut tx,
        &principal,
        "pat.revoked",
        "personal_access_token",
        pat_id,
        serde_json::json!({ "revoked": true }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn require_auth(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::to_owned);
    let principal = if let Some(value) = bearer {
        authenticate_pat(&state, &value).await?
    } else {
        authenticate_session(&state, request.headers().clone(), request.method().clone()).await?
    };

    request.extensions_mut().insert(principal);
    Ok(next.run(request).await)
}

async fn authenticate_pat(state: &AppState, token: &str) -> Result<Principal, ApiError> {
    let rest = token
        .strip_prefix("grn_pat_")
        .ok_or_else(|| ApiError::unauthorized("PAT 格式无效"))?;
    let (selector, secret) = rest
        .split_once('_')
        .ok_or_else(|| ApiError::unauthorized("PAT 格式无效"))?;
    let row = sqlx::query_as::<_, (i64, i64, Vec<u8>, Vec<String>)>(
        r#"
        SELECT p.id, p.user_id, p.token_hash, p.scopes
        FROM personal_access_tokens p
        JOIN users u ON u.id = p.user_id
        WHERE p.selector = $1 AND p.revoked_at IS NULL
          AND (p.expires_at IS NULL OR p.expires_at > now())
          AND u.disabled_at IS NULL
        "#,
    )
    .bind(selector)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?
    .ok_or_else(|| ApiError::unauthorized("PAT 无效或已过期"))?;

    if !constant_time_equal(&row.2, &digest(secret)) {
        return Err(ApiError::unauthorized("PAT 无效或已过期"));
    }
    sqlx::query(
        "UPDATE personal_access_tokens SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')",
    )
    .bind(row.0)
    .execute(&state.pool)
    .await
    .map_err(ApiError::internal)?;

    Ok(Principal {
        user_id: row.1,
        auth_kind: AuthKind::Pat,
        credential_id: row.0,
        scopes: row.3,
    })
}

async fn authenticate_session(
    state: &AppState,
    headers: HeaderMap,
    method: Method,
) -> Result<Principal, ApiError> {
    let jar = CookieJar::from_headers(&headers);
    let token = jar
        .get(state.session_cookie_name())
        .map(|cookie| cookie.value().to_owned())
        .ok_or_else(|| ApiError::unauthorized("需要登录"))?;
    let row = sqlx::query_as::<_, (i64, i64, Vec<u8>, i64, i64)>(
        r#"
        SELECT s.id, s.user_id, s.csrf_hash, s.auth_epoch, u.auth_epoch
        FROM user_sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now() AND s.revoked_at IS NULL
          AND u.disabled_at IS NULL
        "#,
    )
    .bind(digest(&token))
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::internal)?
    .ok_or_else(|| ApiError::unauthorized("登录会话无效或已过期"))?;
    if row.3 != row.4 {
        return Err(ApiError::unauthorized("登录会话已失效"));
    }

    if !matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) {
        validate_origin(state, &headers)?;
        let csrf = headers
            .get("x-csrf-token")
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| ApiError::forbidden("csrf_required", "缺少 CSRF Token"))?;
        if !constant_time_equal(&row.2, &digest(csrf)) {
            return Err(ApiError::forbidden("csrf_invalid", "CSRF Token 无效"));
        }
    }

    sqlx::query(
        "UPDATE user_sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'",
    )
    .bind(row.0)
    .execute(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    Ok(Principal {
        user_id: row.1,
        auth_kind: AuthKind::Session,
        credential_id: row.0,
        scopes: vec!["*".to_owned()],
    })
}

fn validate_origin(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    if let Some(origin) = headers.get(header::ORIGIN) {
        let origin = origin
            .to_str()
            .map_err(|_| ApiError::forbidden("origin_invalid", "Origin 无效"))?;
        if origin != state.allowed_origin {
            return Err(ApiError::forbidden(
                "origin_not_allowed",
                "请求来源不被允许",
            ));
        }
    }
    Ok(())
}

fn require_scope(principal: &Principal, scope: &'static str) -> Result<(), ApiError> {
    if !principal.has_scope(scope) {
        return Err(ApiError::forbidden(
            "scope_required",
            format!("PAT 缺少 {scope} 权限范围"),
        ));
    }
    Ok(())
}

fn validate_pat_scopes(
    principal: &Principal,
    values: Vec<String>,
) -> Result<Vec<String>, ApiError> {
    let scopes: BTreeSet<String> = values
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect();
    if scopes.is_empty() {
        return Err(ApiError::bad_request(
            "pat_scopes_required",
            "PAT 至少需要一个权限范围",
        ));
    }
    for scope in &scopes {
        if !PAT_SCOPES.contains(&scope.as_str()) {
            return Err(ApiError::bad_request(
                "pat_scope_invalid",
                format!("不支持的 PAT 权限范围：{scope}"),
            ));
        }
        if !principal.has_scope(scope) {
            return Err(ApiError::forbidden(
                "scope_escalation",
                format!("不能签发超出当前凭据权限的范围：{scope}"),
            ));
        }
    }
    if scopes.contains("*") {
        return Ok(vec!["*".to_owned()]);
    }
    Ok(scopes.into_iter().collect())
}

async fn audit_auth_event(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    action: &'static str,
    entity_type: &'static str,
    entity_id: i64,
    after_data: serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            actor_kind, actor_user_id, action, entity_type, entity_id, after_data
        ) VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(match principal.auth_kind {
        AuthKind::Session => "user",
        AuthKind::Pat => "pat",
    })
    .bind(principal.user_id)
    .bind(action)
    .bind(entity_type)
    .bind(entity_id)
    .bind(after_data)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(())
}

pub(crate) fn normalize_email(value: &str) -> Result<String, ApiError> {
    let email = value.trim().to_lowercase();
    if email.len() > 254 || !EmailAddress::is_valid(&email) {
        return Err(ApiError::bad_request("email_invalid", "邮箱格式无效"));
    }
    Ok(email)
}

fn normalize_name(value: &str) -> Result<String, ApiError> {
    let name = value.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(ApiError::bad_request(
            "display_name_invalid",
            "显示名称长度必须为 1 到 100 个字符",
        ));
    }
    Ok(name.to_owned())
}

pub(crate) fn validate_password(value: &str) -> Result<(), ApiError> {
    let length = value.chars().count();
    if !(12..=128).contains(&length) {
        return Err(ApiError::bad_request(
            "password_invalid",
            "密码长度必须为 12 到 128 个字符",
        ));
    }
    Ok(())
}

pub(crate) async fn hash_password(password: String) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || generate_hash(password))
        .await
        .map_err(ApiError::internal)
}

pub(crate) async fn verify_password_async(
    password: String,
    hash: String,
) -> Result<bool, ApiError> {
    tokio::task::spawn_blocking(move || verify_password(password, &hash).is_ok())
        .await
        .map_err(ApiError::internal)
}

pub(crate) fn random_token() -> String {
    URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>())
}

fn new_pat() -> (String, String, Vec<u8>) {
    let selector = hex::encode(rand::random::<[u8; 8]>());
    let secret = random_token();
    let hash = digest(&secret);
    (selector, secret, hash)
}

pub(crate) fn digest(value: &str) -> Vec<u8> {
    Sha256::digest(value.as_bytes()).to_vec()
}

pub(crate) fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
}

pub(crate) fn session_cookie(state: &AppState, value: String) -> Cookie<'static> {
    Cookie::build((state.session_cookie_name().to_owned(), value))
        .path("/")
        .http_only(true)
        .secure(state.cookie_secure)
        .same_site(SameSite::Lax)
        .max_age(Duration::days(SESSION_DAYS))
        .build()
}

pub(crate) async fn issue_session(
    state: &AppState,
    user_id: i64,
    auth_epoch: i64,
    user_agent: Option<String>,
) -> Result<(String, String, i64), ApiError> {
    let session_token = random_token();
    let csrf_token = random_token();
    let session_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO user_sessions (
            user_id, token_hash, csrf_hash, auth_epoch, user_agent, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
        RETURNING id
        "#,
    )
    .bind(user_id)
    .bind(digest(&session_token))
    .bind(digest(&csrf_token))
    .bind(auth_epoch)
    .bind(user_agent)
    .bind(SESSION_DAYS as i32)
    .fetch_one(&state.pool)
    .await
    .map_err(ApiError::internal)?;
    Ok((session_token, csrf_token, session_id))
}

pub(crate) fn user_agent(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::USER_AGENT)?.to_str().ok()?;
    let mut end = value.len().min(1024);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    Some(value[..end].to_owned())
}

pub(crate) fn expired_session_cookie(state: &AppState) -> Cookie<'static> {
    Cookie::build((state.session_cookie_name().to_owned(), ""))
        .path("/")
        .http_only(true)
        .secure(state.cookie_secure)
        .same_site(SameSite::Lax)
        .max_age(Duration::ZERO)
        .build()
}

pub(crate) async fn initialize_book_accounts(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    book_id: i64,
    currency_code: &str,
) -> Result<(), ApiError> {
    for (name, class, role, system_key) in [
        ("期初余额", "equity", "opening_balance", None),
        ("对账调整", "equity", "reconciliation", None),
        ("汇兑收益", "income", "fx_gain_loss", None),
        ("汇兑损失", "expense", "fx_gain_loss", None),
        ("系统默认收入", "income", "category", Some("default_income")),
        (
            "系统默认费用",
            "expense",
            "category",
            Some("default_expense"),
        ),
    ] {
        sqlx::query(
            "INSERT INTO ledger_accounts (book_id, name, class, role, currency_code, hidden, system_key) VALUES ($1, $2, $3, $4, $5, TRUE, $6)",
        )
        .bind(book_id)
        .bind(name)
        .bind(class)
        .bind(role)
        .bind(currency_code)
        .bind(system_key)
        .execute(&mut **tx)
        .await
        .map_err(ApiError::internal)?;
    }

    sqlx::query("INSERT INTO categories (book_id, name) VALUES ($1, '未分类')")
        .bind(book_id)
        .execute(&mut **tx)
        .await
        .map_err(ApiError::internal)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pat_round_trip_uses_a_stable_prefix() {
        let (selector, secret, stored) = new_pat();
        let token = format!("grn_pat_{selector}_{secret}");
        let rest = token.strip_prefix("grn_pat_").unwrap();
        let (parsed_selector, parsed_secret) = rest.split_once('_').unwrap();

        assert_eq!(selector, parsed_selector);
        assert!(constant_time_equal(&stored, &digest(parsed_secret)));
    }

    #[test]
    fn password_policy_has_explicit_bounds() {
        assert!(validate_password("short").is_err());
        assert!(validate_password("long-enough-password").is_ok());
        assert!(validate_password(&"x".repeat(129)).is_err());
    }
}
