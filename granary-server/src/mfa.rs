use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use axum::{
    Extension, Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use time::OffsetDateTime;
use totp_rs::{Algorithm, Secret, TOTP};

use crate::{
    auth::{
        ApiError, AuthKind, Principal, digest, expired_session_cookie, issue_session, random_token,
        session_cookie, user_agent, verify_password_async,
    },
    http::AppState,
};

const RECOVERY_CODE_COUNT: usize = 10;

#[derive(Deserialize)]
pub struct SetupRequest {
    password: String,
}

#[derive(Serialize)]
pub struct SetupResponse {
    secret: String,
    otpauth_url: String,
}

#[derive(Deserialize)]
pub struct CodeRequest {
    code: String,
}

#[derive(Serialize)]
pub struct RecoveryCodesResponse {
    recovery_codes: Vec<String>,
}

#[derive(Deserialize)]
pub struct VerifyLoginRequest {
    challenge_token: String,
    code: String,
}

#[derive(Serialize)]
pub struct VerifyLoginResponse {
    user_id: i64,
    display_name: String,
    csrf_token: String,
    mfa_required: bool,
}

#[derive(Deserialize)]
pub struct DisableRequest {
    password: String,
    code: String,
}

#[derive(Serialize)]
pub struct StatusResponse {
    enabled: bool,
    recovery_codes_remaining: i64,
}

pub async fn is_enabled(pool: &PgPool, user_id: i64) -> Result<bool, ApiError> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL)",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .map_err(ApiError::database)
}

pub async fn create_login_challenge(
    pool: &PgPool,
    user_id: i64,
    auth_epoch: i64,
) -> Result<String, ApiError> {
    let token = random_token();
    sqlx::query(
        r#"
        INSERT INTO mfa_login_challenges (user_id, token_hash, auth_epoch, expires_at)
        VALUES ($1, $2, $3, now() + interval '5 minutes')
        "#,
    )
    .bind(user_id)
    .bind(digest(&token))
    .bind(auth_epoch)
    .execute(pool)
    .await
    .map_err(ApiError::database)?;
    Ok(token)
}

pub async fn status(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<StatusResponse>, ApiError> {
    let row = sqlx::query_as::<_, (bool, i64)>(
        r#"
        SELECT EXISTS (
                   SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL
               ),
               (SELECT count(*) FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL)
        "#,
    )
    .bind(principal.user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(StatusResponse {
        enabled: row.0,
        recovery_codes_remaining: row.1,
    }))
}

pub async fn setup(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<SetupRequest>,
) -> Result<Json<SetupResponse>, ApiError> {
    require_session(&principal)?;
    verify_current_password(&state.pool, principal.user_id, request.password).await?;
    if is_enabled(&state.pool, principal.user_id).await? {
        return Err(ApiError::conflict("mfa_already_enabled", "MFA 已经启用"));
    }
    let email = sqlx::query_scalar::<_, String>("SELECT email FROM users WHERE id = $1")
        .bind(principal.user_id)
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::database)?;
    let secret = Secret::generate_secret();
    let secret_bytes = secret.to_bytes().map_err(ApiError::internal)?;
    let secret_encoded = secret.to_encoded().to_string();
    let totp = totp(&secret_bytes, &email)?;
    let (encrypted_secret, nonce) = encrypt_secret(&state, principal.user_id, &secret_bytes)?;
    sqlx::query(
        r#"
        INSERT INTO user_mfa (user_id, encrypted_secret, nonce)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE
        SET encrypted_secret = EXCLUDED.encrypted_secret, nonce = EXCLUDED.nonce,
            enabled_at = NULL, updated_at = now()
        "#,
    )
    .bind(principal.user_id)
    .bind(encrypted_secret)
    .bind(nonce)
    .execute(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(SetupResponse {
        secret: secret_encoded,
        otpauth_url: totp.get_url(),
    }))
}

pub async fn confirm(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    jar: CookieJar,
    Json(request): Json<CodeRequest>,
) -> Result<(CookieJar, Json<RecoveryCodesResponse>), ApiError> {
    require_session(&principal)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let secret = pending_secret(&state, &mut tx, principal.user_id).await?;
    if !check_totp(&secret, "granary", &request.code)? {
        return Err(ApiError::unauthorized("MFA 验证码错误"));
    }
    let recovery_codes = replace_recovery_codes(&mut tx, principal.user_id).await?;
    sqlx::query("UPDATE user_mfa SET enabled_at = now(), updated_at = now() WHERE user_id = $1")
        .bind(principal.user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    invalidate_credentials(&mut tx, principal.user_id).await?;
    audit(
        &mut tx,
        principal.user_id,
        "mfa.enabled",
        serde_json::json!({ "recovery_code_count": RECOVERY_CODE_COUNT }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        jar.remove(expired_session_cookie(&state)),
        Json(RecoveryCodesResponse { recovery_codes }),
    ))
}

pub async fn verify_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<VerifyLoginRequest>,
) -> Result<(CookieJar, Json<VerifyLoginResponse>), ApiError> {
    validate_origin(&state, &headers)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let challenge = sqlx::query_as::<_, (i64, i64, i64, i16, String, Vec<u8>, Vec<u8>)>(
        r#"
        SELECT c.id, c.user_id, c.auth_epoch, c.attempts, u.display_name,
               m.encrypted_secret, m.nonce
        FROM mfa_login_challenges c
        JOIN users u ON u.id = c.user_id
        JOIN user_mfa m ON m.user_id = c.user_id AND m.enabled_at IS NOT NULL
        WHERE c.token_hash = $1 AND c.expires_at > now() AND c.consumed_at IS NULL
          AND c.attempts < 5 AND u.disabled_at IS NULL AND u.auth_epoch = c.auth_epoch
        FOR UPDATE OF c
        "#,
    )
    .bind(digest(&request.challenge_token))
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::unauthorized("MFA 登录挑战无效或已过期"))?;
    let secret = decrypt_secret(&state, challenge.1, &challenge.5, &challenge.6)?;
    if !verify_code(&mut tx, challenge.1, &secret, &request.code).await? {
        sqlx::query(
            "UPDATE mfa_login_challenges SET attempts = attempts + 1, consumed_at = CASE WHEN attempts + 1 >= 5 THEN now() ELSE NULL END WHERE id = $1",
        )
        .bind(challenge.0)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
        tx.commit().await.map_err(ApiError::database)?;
        return Err(ApiError::unauthorized("MFA 验证码或恢复码错误"));
    }
    sqlx::query("UPDATE mfa_login_challenges SET consumed_at = now() WHERE id = $1")
        .bind(challenge.0)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    tx.commit().await.map_err(ApiError::database)?;

    let (session_token, csrf_token, session_id) =
        issue_session(&state, challenge.1, challenge.2, user_agent(&headers)).await?;
    sqlx::query(
        "INSERT INTO audit_events (actor_kind, actor_user_id, action, entity_type, entity_id) VALUES ('user', $1, 'auth.login_mfa', 'user_session', $2)",
    )
    .bind(challenge.1)
    .bind(session_id)
    .execute(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok((
        jar.add(session_cookie(&state, session_token)),
        Json(VerifyLoginResponse {
            user_id: challenge.1,
            display_name: challenge.4,
            csrf_token,
            mfa_required: false,
        }),
    ))
}

pub async fn regenerate_recovery_codes(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<DisableRequest>,
) -> Result<Json<RecoveryCodesResponse>, ApiError> {
    require_session(&principal)?;
    verify_current_password(&state.pool, principal.user_id, request.password).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let secret = enabled_secret(&state, &mut tx, principal.user_id).await?;
    if !verify_code(&mut tx, principal.user_id, &secret, &request.code).await? {
        return Err(ApiError::unauthorized("MFA 验证码或恢复码错误"));
    }
    let recovery_codes = replace_recovery_codes(&mut tx, principal.user_id).await?;
    audit(
        &mut tx,
        principal.user_id,
        "mfa.recovery_codes_regenerated",
        serde_json::json!({ "recovery_code_count": RECOVERY_CODE_COUNT }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(Json(RecoveryCodesResponse { recovery_codes }))
}

pub async fn disable(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    jar: CookieJar,
    Json(request): Json<DisableRequest>,
) -> Result<(CookieJar, StatusCode), ApiError> {
    require_session(&principal)?;
    verify_current_password(&state.pool, principal.user_id, request.password).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let secret = enabled_secret(&state, &mut tx, principal.user_id).await?;
    if !verify_code(&mut tx, principal.user_id, &secret, &request.code).await? {
        return Err(ApiError::unauthorized("MFA 验证码或恢复码错误"));
    }
    sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id = $1")
        .bind(principal.user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    sqlx::query("DELETE FROM user_mfa WHERE user_id = $1")
        .bind(principal.user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    invalidate_credentials(&mut tx, principal.user_id).await?;
    audit(
        &mut tx,
        principal.user_id,
        "mfa.disabled",
        serde_json::json!({ "enabled": false }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        jar.remove(expired_session_cookie(&state)),
        StatusCode::NO_CONTENT,
    ))
}

fn require_session(principal: &Principal) -> Result<(), ApiError> {
    if principal.auth_kind != AuthKind::Session {
        return Err(ApiError::bad_request(
            "session_required",
            "MFA 设置需要浏览器登录会话",
        ));
    }
    Ok(())
}

async fn verify_current_password(
    pool: &PgPool,
    user_id: i64,
    password: String,
) -> Result<(), ApiError> {
    let hash = sqlx::query_scalar::<_, String>(
        "SELECT password_hash FROM users WHERE id = $1 AND disabled_at IS NULL",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::unauthorized("用户不存在或已停用"))?;
    if !verify_password_async(password, hash).await? {
        return Err(ApiError::unauthorized("密码错误"));
    }
    Ok(())
}

async fn pending_secret(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    user_id: i64,
) -> Result<Vec<u8>, ApiError> {
    let row = sqlx::query_as::<_, (Vec<u8>, Vec<u8>, Option<OffsetDateTime>)>(
        "SELECT encrypted_secret, nonce, enabled_at FROM user_mfa WHERE user_id = $1 FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("MFA 设置不存在"))?;
    if row.2.is_some() {
        return Err(ApiError::conflict("mfa_already_enabled", "MFA 已经启用"));
    }
    decrypt_secret(state, user_id, &row.0, &row.1)
}

async fn enabled_secret(
    state: &AppState,
    tx: &mut Transaction<'_, Postgres>,
    user_id: i64,
) -> Result<Vec<u8>, ApiError> {
    let row = sqlx::query_as::<_, (Vec<u8>, Vec<u8>)>(
        "SELECT encrypted_secret, nonce FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("MFA 尚未启用"))?;
    decrypt_secret(state, user_id, &row.0, &row.1)
}

async fn verify_code(
    tx: &mut Transaction<'_, Postgres>,
    user_id: i64,
    secret: &[u8],
    code: &str,
) -> Result<bool, ApiError> {
    if check_totp(secret, "granary", code)? {
        return Ok(true);
    }
    let normalized = code.trim().to_lowercase();
    let used = sqlx::query(
        "UPDATE mfa_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL",
    )
    .bind(user_id)
    .bind(digest(&normalized))
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(used.rows_affected() == 1)
}

async fn replace_recovery_codes(
    tx: &mut Transaction<'_, Postgres>,
    user_id: i64,
) -> Result<Vec<String>, ApiError> {
    sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(ApiError::database)?;
    let mut codes = Vec::with_capacity(RECOVERY_CODE_COUNT);
    for _ in 0..RECOVERY_CODE_COUNT {
        let raw = hex::encode(rand::random::<[u8; 8]>());
        let code = format!(
            "{}-{}-{}-{}",
            &raw[0..4],
            &raw[4..8],
            &raw[8..12],
            &raw[12..16]
        );
        sqlx::query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)")
            .bind(user_id)
            .bind(digest(&code))
            .execute(&mut **tx)
            .await
            .map_err(ApiError::database)?;
        codes.push(code);
    }
    Ok(codes)
}

async fn invalidate_credentials(
    tx: &mut Transaction<'_, Postgres>,
    user_id: i64,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE users SET auth_epoch = auth_epoch + 1, updated_at = now() WHERE id = $1")
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(ApiError::database)?;
    sqlx::query(
        r#"
        UPDATE user_sessions
        SET revoked_at = now(), revoked_by_user_id = $1, revoke_reason = 'MFA 配置已变更'
        WHERE user_id = $1 AND revoked_at IS NULL
        "#,
    )
    .bind(user_id)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query("UPDATE personal_access_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL")
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(ApiError::database)?;
    Ok(())
}

async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    user_id: i64,
    action: &'static str,
    after_data: serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query(
        "INSERT INTO audit_events (actor_kind, actor_user_id, action, entity_type, entity_id, after_data) VALUES ('user', $1, $2, 'user_mfa', $1, $3)",
    )
    .bind(user_id)
    .bind(action)
    .bind(after_data)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(())
}

fn totp(secret: &[u8], account_name: &str) -> Result<TOTP, ApiError> {
    TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        secret.to_vec(),
        Some("Granary".to_owned()),
        account_name.to_owned(),
    )
    .map_err(ApiError::internal)
}

fn check_totp(secret: &[u8], account_name: &str, code: &str) -> Result<bool, ApiError> {
    totp(secret, account_name)?
        .check_current(code.trim())
        .map_err(ApiError::internal)
}

fn encrypt_secret(
    state: &AppState,
    user_id: i64,
    secret: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    let cipher = Aes256Gcm::new_from_slice(&state.secret_key).map_err(ApiError::internal)?;
    let nonce = rand::random::<[u8; 12]>();
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: secret,
                aad: &user_id.to_be_bytes(),
            },
        )
        .map_err(|_| ApiError::internal("MFA seed encryption failed"))?;
    Ok((encrypted, nonce.to_vec()))
}

fn decrypt_secret(
    state: &AppState,
    user_id: i64,
    encrypted: &[u8],
    nonce: &[u8],
) -> Result<Vec<u8>, ApiError> {
    if nonce.len() != 12 {
        return Err(ApiError::internal("invalid MFA nonce"));
    }
    let cipher = Aes256Gcm::new_from_slice(&state.secret_key).map_err(ApiError::internal)?;
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: encrypted,
                aad: &user_id.to_be_bytes(),
            },
        )
        .map_err(|_| ApiError::internal("MFA seed decryption failed"))
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
