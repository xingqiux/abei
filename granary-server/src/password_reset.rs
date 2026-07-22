use axum::{
    Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
};
use serde::Deserialize;
use time::OffsetDateTime;

use crate::{
    auth::{
        ApiError, constant_time_equal, digest, hash_password, normalize_email, random_token,
        validate_password,
    },
    http::AppState,
    mail,
};

#[derive(Deserialize)]
pub struct RequestPasswordReset {
    email: String,
}

#[derive(Deserialize)]
pub struct ResetPassword {
    token: String,
    password: String,
}

pub async fn request(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<RequestPasswordReset>,
) -> Result<StatusCode, ApiError> {
    validate_origin(&state, &headers)?;
    let email = normalize_email(&request.email)?;
    let user = sqlx::query_as::<_, (i64, String)>(
        "SELECT id, email FROM users WHERE lower(email) = $1 AND disabled_at IS NULL",
    )
    .bind(email)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::database)?;
    let Some((user_id, recipient)) = user else {
        return Ok(StatusCode::ACCEPTED);
    };
    let recently_requested = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM password_reset_tokens
            WHERE user_id = $1 AND created_at > now() - interval '1 minute'
        )
        "#,
    )
    .bind(user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(ApiError::database)?;
    if recently_requested {
        return Ok(StatusCode::ACCEPTED);
    }

    if create_and_send(&state, user_id, &recipient).await.is_err() {
        tracing::error!(user_id, "failed to deliver password reset email");
    }
    Ok(StatusCode::ACCEPTED)
}

pub async fn reset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ResetPassword>,
) -> Result<StatusCode, ApiError> {
    validate_origin(&state, &headers)?;
    validate_password(&request.password)?;
    let (selector, secret) = parse_token(&request.token)?;
    let password_hash = hash_password(request.password).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let token = sqlx::query_as::<_, (i64, i64, Vec<u8>, OffsetDateTime, Option<OffsetDateTime>)>(
        r#"
        SELECT id, user_id, token_hash, expires_at, consumed_at
        FROM password_reset_tokens
        WHERE selector = $1
        FOR UPDATE
        "#,
    )
    .bind(selector)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::unauthorized("密码重置链接无效或已过期"))?;
    if !constant_time_equal(&token.2, &digest(secret))
        || token.3 <= OffsetDateTime::now_utc()
        || token.4.is_some()
    {
        return Err(ApiError::unauthorized("密码重置链接无效或已过期"));
    }
    sqlx::query(
        "UPDATE users SET password_hash = $2, auth_epoch = auth_epoch + 1, updated_at = now() WHERE id = $1 AND disabled_at IS NULL",
    )
    .bind(token.1)
    .bind(password_hash)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query(
        r#"
        UPDATE user_sessions
        SET revoked_at = now(), revoke_reason = '密码已重置'
        WHERE user_id = $1 AND revoked_at IS NULL
        "#,
    )
    .bind(token.1)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query("UPDATE personal_access_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL")
        .bind(token.1)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id = $1")
        .bind(token.1)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    sqlx::query("DELETE FROM user_mfa WHERE user_id = $1")
        .bind(token.1)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    sqlx::query("DELETE FROM mfa_login_challenges WHERE user_id = $1")
        .bind(token.1)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    sqlx::query("UPDATE password_reset_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL")
        .bind(token.1)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    sqlx::query(
        "INSERT INTO audit_events (actor_kind, actor_user_id, action, entity_type, entity_id) VALUES ('user', $1, 'password.reset', 'user', $1)",
    )
    .bind(token.1)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn create_and_send(state: &AppState, user_id: i64, recipient: &str) -> Result<(), ApiError> {
    let selector = hex::encode(rand::random::<[u8; 8]>());
    let secret = random_token();
    let token = format!("grn_reset_{selector}_{secret}");
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    sqlx::query("UPDATE password_reset_tokens SET consumed_at = now() WHERE user_id = $1 AND consumed_at IS NULL")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    sqlx::query(
        r#"
        INSERT INTO password_reset_tokens (selector, token_hash, user_id, expires_at)
        VALUES ($1, $2, $3, now() + interval '30 minutes')
        "#,
    )
    .bind(selector)
    .bind(digest(&secret))
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    send_email(state, recipient, &token).await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(())
}

async fn send_email(state: &AppState, recipient: &str, token: &str) -> Result<(), ApiError> {
    let reset_url = format!(
        "{}/reset-password?token={}",
        state.public_url.trim_end_matches('/'),
        token
    );
    mail::send_text(
        state,
        recipient,
        "重置你的 Granary 密码",
        format!(
            "A Granary password reset was requested. This link expires in 30 minutes:\n\n{reset_url}\n\nIgnore this message if you did not request it."
        ),
    )
    .await
}

fn parse_token(value: &str) -> Result<(&str, &str), ApiError> {
    value
        .strip_prefix("grn_reset_")
        .and_then(|value| value.split_once('_'))
        .ok_or_else(|| ApiError::unauthorized("密码重置链接无效或已过期"))
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
