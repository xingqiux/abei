use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};
use time::OffsetDateTime;

use crate::{
    auth::{ApiError, AuthKind, Principal},
    http::AppState,
};

#[derive(Deserialize)]
pub struct UserPageQuery {
    after_id: Option<i64>,
    #[serde(default = "default_page_size")]
    limit: i64,
}

#[derive(Serialize, FromRow)]
pub struct AdminUserResponse {
    id: i64,
    email: String,
    display_name: String,
    instance_admin: bool,
    #[serde(with = "time::serde::rfc3339::option")]
    disabled_at: Option<OffsetDateTime>,
    disabled_reason: Option<String>,
    mfa_enabled: bool,
    active_sessions: i64,
    active_pats: i64,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

#[derive(Serialize)]
pub struct AdminUserPage {
    items: Vec<AdminUserResponse>,
    next_after_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct DisableUserRequest {
    reason: String,
}

#[derive(Deserialize)]
pub struct UpdateInstanceAdminRequest {
    instance_admin: bool,
}

#[derive(Serialize, FromRow)]
pub struct AdminSessionResponse {
    id: i64,
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

#[derive(Serialize, FromRow)]
pub struct AdminPatResponse {
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

pub async fn list_users(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<UserPageQuery>,
) -> Result<Json<AdminUserPage>, ApiError> {
    require_instance_admin(&state, &principal).await?;
    if !(1..=100).contains(&query.limit) {
        return Err(ApiError::bad_request(
            "page_size_invalid",
            "分页大小必须为 1 到 100",
        ));
    }
    let mut items = sqlx::query_as::<_, AdminUserResponse>(
        r#"
        SELECT u.id, u.email, u.display_name, u.is_instance_admin AS instance_admin,
               u.disabled_at, u.disabled_reason,
               EXISTS (
                   SELECT 1 FROM user_mfa m
                   WHERE m.user_id = u.id AND m.enabled_at IS NOT NULL
               ) AS mfa_enabled,
               (
                   SELECT count(*) FROM user_sessions s
                   WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()
               ) AS active_sessions,
               (
                   SELECT count(*) FROM personal_access_tokens p
                   WHERE p.user_id = u.id AND p.revoked_at IS NULL
                     AND (p.expires_at IS NULL OR p.expires_at > now())
               ) AS active_pats,
               u.created_at
        FROM users u
        WHERE ($1::bigint IS NULL OR u.id > $1)
        ORDER BY u.id
        LIMIT $2
        "#,
    )
    .bind(query.after_id)
    .bind(query.limit + 1)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    let next_after_id = if items.len() > query.limit as usize {
        items.pop();
        items.last().map(|user| user.id)
    } else {
        None
    };
    Ok(Json(AdminUserPage {
        items,
        next_after_id,
    }))
}

pub async fn disable_user(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(user_id): Path<i64>,
    Json(request): Json<DisableUserRequest>,
) -> Result<StatusCode, ApiError> {
    require_instance_admin(&state, &principal).await?;
    if user_id == principal.user_id {
        return Err(ApiError::conflict(
            "cannot_disable_self",
            "不能停用当前登录用户",
        ));
    }
    let reason = normalize_reason(&request.reason)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    sqlx::query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    let target = sqlx::query_as::<_, (bool, Option<OffsetDateTime>)>(
        "SELECT is_instance_admin, disabled_at FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("用户不存在"))?;
    if target.1.is_some() {
        return Err(ApiError::conflict("user_already_disabled", "用户已经停用"));
    }
    if target.0 {
        let active_admins = sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM users WHERE is_instance_admin AND disabled_at IS NULL",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::database)?;
        if active_admins <= 1 {
            return Err(ApiError::conflict(
                "last_instance_admin",
                "至少需要保留一个可用的实例管理员",
            ));
        }
    }
    sqlx::query(
        r#"
        UPDATE users
        SET disabled_at = now(), disabled_by_user_id = $2, disabled_reason = $3,
            auth_epoch = auth_epoch + 1, updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .bind(principal.user_id)
    .bind(&reason)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    revoke_all_credentials(&mut tx, user_id, principal.user_id, "用户已被管理员停用").await?;
    audit(
        &mut tx,
        &principal,
        "admin.user_disabled",
        "user",
        user_id,
        serde_json::json!({ "reason": reason }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_user(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(user_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_instance_admin(&state, &principal).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let disabled_at = sqlx::query_scalar::<_, Option<OffsetDateTime>>(
        "SELECT disabled_at FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("用户不存在"))?;
    if disabled_at.is_none() {
        return Err(ApiError::conflict("user_not_disabled", "用户未被停用"));
    }
    sqlx::query(
        r#"
        UPDATE users
        SET disabled_at = NULL, disabled_by_user_id = NULL, disabled_reason = NULL,
            updated_at = now()
        WHERE id = $1
        "#,
    )
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit(
        &mut tx,
        &principal,
        "admin.user_restored",
        "user",
        user_id,
        serde_json::json!({ "disabled": false }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_instance_admin(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(user_id): Path<i64>,
    Json(request): Json<UpdateInstanceAdminRequest>,
) -> Result<StatusCode, ApiError> {
    require_instance_admin(&state, &principal).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    sqlx::query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE")
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    let target = sqlx::query_as::<_, (bool, Option<OffsetDateTime>)>(
        "SELECT is_instance_admin, disabled_at FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("用户不存在"))?;
    if target.0 == request.instance_admin {
        return Err(ApiError::conflict(
            "instance_admin_unchanged",
            "用户的实例管理员状态没有变化",
        ));
    }
    if request.instance_admin && target.1.is_some() {
        return Err(ApiError::conflict(
            "user_disabled",
            "不能把已停用用户设为实例管理员",
        ));
    }
    if !request.instance_admin {
        let active_admins = sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM users WHERE is_instance_admin AND disabled_at IS NULL",
        )
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::database)?;
        if active_admins <= 1 {
            return Err(ApiError::conflict(
                "last_instance_admin",
                "至少需要保留一个可用的实例管理员",
            ));
        }
    }
    sqlx::query("UPDATE users SET is_instance_admin = $2, updated_at = now() WHERE id = $1")
        .bind(user_id)
        .bind(request.instance_admin)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    if !request.instance_admin {
        sqlx::query(
            "UPDATE users SET auth_epoch = auth_epoch + 1, updated_at = now() WHERE id = $1",
        )
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
        revoke_all_credentials(&mut tx, user_id, principal.user_id, "实例管理员权限已撤销").await?;
    }
    audit(
        &mut tx,
        &principal,
        "admin.instance_role_updated",
        "user",
        user_id,
        serde_json::json!({
            "before": target.0, "after": request.instance_admin
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn reset_user_mfa(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(user_id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    require_instance_admin(&state, &principal).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    if !exists {
        return Err(ApiError::not_found("用户不存在"));
    }
    let had_mfa = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL)",
    )
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query("DELETE FROM mfa_recovery_codes WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    sqlx::query("DELETE FROM user_mfa WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    sqlx::query("DELETE FROM mfa_login_challenges WHERE user_id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    sqlx::query("UPDATE users SET auth_epoch = auth_epoch + 1, updated_at = now() WHERE id = $1")
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    revoke_all_credentials(&mut tx, user_id, principal.user_id, "管理员重置了 MFA").await?;
    audit(
        &mut tx,
        &principal,
        "admin.mfa_reset",
        "user",
        user_id,
        serde_json::json!({ "had_mfa": had_mfa }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_user_sessions(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(user_id): Path<i64>,
) -> Result<Json<Vec<AdminSessionResponse>>, ApiError> {
    require_instance_admin(&state, &principal).await?;
    ensure_user_exists(&state, user_id).await?;
    let sessions = sqlx::query_as::<_, AdminSessionResponse>(
        r#"
        SELECT id, user_agent, expires_at, last_seen_at, revoked_at, revoke_reason, created_at
        FROM user_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(sessions))
}

pub async fn revoke_user_session(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((user_id, session_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    require_instance_admin(&state, &principal).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let revoked_at = sqlx::query_scalar::<_, Option<OffsetDateTime>>(
        "SELECT revoked_at FROM user_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(session_id)
    .bind(user_id)
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
        SET revoked_at = now(), revoked_by_user_id = $3, revoke_reason = '管理员撤销'
        WHERE id = $1 AND user_id = $2
        "#,
    )
    .bind(session_id)
    .bind(user_id)
    .bind(principal.user_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit(
        &mut tx,
        &principal,
        "admin.session_revoked",
        "user_session",
        session_id,
        serde_json::json!({ "user_id": user_id }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_user_pats(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(user_id): Path<i64>,
) -> Result<Json<Vec<AdminPatResponse>>, ApiError> {
    require_instance_admin(&state, &principal).await?;
    ensure_user_exists(&state, user_id).await?;
    let pats = sqlx::query_as::<_, AdminPatResponse>(
        r#"
        SELECT id, 'grn_pat_' || selector || '_' AS token_prefix, name, scopes,
               expires_at, revoked_at, last_used_at, created_at
        FROM personal_access_tokens
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(pats))
}

pub async fn revoke_user_pat(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((user_id, pat_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    require_instance_admin(&state, &principal).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let revoked_at = sqlx::query_scalar::<_, Option<OffsetDateTime>>(
        "SELECT revoked_at FROM personal_access_tokens WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(pat_id)
    .bind(user_id)
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
    audit(
        &mut tx,
        &principal,
        "admin.pat_revoked",
        "personal_access_token",
        pat_id,
        serde_json::json!({ "user_id": user_id }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn require_instance_admin(
    state: &AppState,
    principal: &Principal,
) -> Result<(), ApiError> {
    if !principal.has_scope("instance:manage") {
        return Err(ApiError::forbidden(
            "scope_required",
            "PAT 缺少 instance:manage 权限范围",
        ));
    }
    let allowed = sqlx::query_scalar::<_, bool>(
        "SELECT is_instance_admin FROM users WHERE id = $1 AND disabled_at IS NULL",
    )
    .bind(principal.user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::database)?
    .unwrap_or(false);
    if !allowed {
        return Err(ApiError::forbidden(
            "instance_admin_required",
            "需要实例管理员权限",
        ));
    }
    Ok(())
}

async fn ensure_user_exists(state: &AppState, user_id: i64) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM users WHERE id = $1)")
        .bind(user_id)
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::database)?;
    if !exists {
        return Err(ApiError::not_found("用户不存在"));
    }
    Ok(())
}

async fn revoke_all_credentials(
    tx: &mut Transaction<'_, Postgres>,
    user_id: i64,
    actor_user_id: i64,
    reason: &'static str,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        UPDATE user_sessions
        SET revoked_at = now(), revoked_by_user_id = $2, revoke_reason = $3
        WHERE user_id = $1 AND revoked_at IS NULL
        "#,
    )
    .bind(user_id)
    .bind(actor_user_id)
    .bind(reason)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query(
        "UPDATE personal_access_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
    )
    .bind(user_id)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(())
}

async fn audit(
    tx: &mut Transaction<'_, Postgres>,
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

fn normalize_reason(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.len() > 500 {
        return Err(ApiError::bad_request(
            "reason_invalid",
            "停用原因必须为 1 到 500 个字符",
        ));
    }
    Ok(value.to_owned())
}

fn default_page_size() -> i64 {
    50
}
