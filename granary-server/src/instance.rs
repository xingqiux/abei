use axum::{
    Extension, Json,
    extract::State,
    http::{HeaderMap, StatusCode, header},
};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};

use crate::{
    admin::require_instance_admin,
    auth::{
        ApiError, Principal, hash_password, initialize_book_accounts, issue_session,
        normalize_email, session_cookie, user_agent, validate_password,
    },
    http::AppState,
};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RegistrationMode {
    InviteOnly,
    Open,
}

impl RegistrationMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::InviteOnly => "invite_only",
            Self::Open => "open",
        }
    }
}

#[derive(Serialize)]
pub struct InstanceInfoResponse {
    initialized: bool,
    registration_mode: String,
    version: i64,
    service_version: &'static str,
}

#[derive(Deserialize)]
pub struct UpdateInstanceSettings {
    registration_mode: RegistrationMode,
    version: i64,
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    email: String,
    display_name: String,
    password: String,
}

#[derive(Serialize)]
pub struct RegisterResponse {
    user_id: i64,
    organization_id: i64,
    book_id: i64,
    csrf_token: String,
}

pub async fn info(State(state): State<AppState>) -> Result<Json<InstanceInfoResponse>, ApiError> {
    let settings = settings(&state).await?;
    let initialized = sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM users)")
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::database)?;
    Ok(Json(InstanceInfoResponse {
        initialized,
        registration_mode: settings.0,
        version: settings.1,
        service_version: env!("CARGO_PKG_VERSION"),
    }))
}

pub async fn admin_settings(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<InstanceInfoResponse>, ApiError> {
    require_instance_admin(&state, &principal).await?;
    info(State(state)).await
}

pub async fn update_settings(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<UpdateInstanceSettings>,
) -> Result<Json<InstanceInfoResponse>, ApiError> {
    require_instance_admin(&state, &principal).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, (String, i64)>(
        "SELECT registration_mode, version FROM instance_settings WHERE singleton FOR UPDATE",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    if current.1 != request.version {
        return Err(ApiError::conflict(
            "version_conflict",
            "实例设置已经被其他请求修改，请刷新后重试",
        ));
    }
    let version = sqlx::query_scalar::<_, i64>(
        r#"
        UPDATE instance_settings
        SET registration_mode = $1, version = version + 1,
            updated_by_user_id = $2, updated_at = now()
        WHERE singleton
        RETURNING version
        "#,
    )
    .bind(request.registration_mode.as_str())
    .bind(principal.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_settings(
        &mut tx,
        &principal,
        serde_json::json!({ "registration_mode": current.0, "version": current.1 }),
        serde_json::json!({
            "registration_mode": request.registration_mode.as_str(), "version": version
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(Json(InstanceInfoResponse {
        initialized: true,
        registration_mode: request.registration_mode.as_str().to_owned(),
        version,
        service_version: env!("CARGO_PKG_VERSION"),
    }))
}

pub async fn register(
    State(state): State<AppState>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<RegisterRequest>,
) -> Result<(StatusCode, CookieJar, Json<RegisterResponse>), ApiError> {
    validate_origin(&state, &headers)?;
    let email = normalize_email(&request.email)?;
    let display_name = normalize_name(&request.display_name)?;
    validate_password(&request.password)?;
    let password_hash = hash_password(request.password).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let registration_mode = sqlx::query_scalar::<_, String>(
        "SELECT registration_mode FROM instance_settings WHERE singleton FOR SHARE",
    )
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    if registration_mode != "open" {
        return Err(ApiError::forbidden(
            "registration_closed",
            "当前实例仅允许邀请注册",
        ));
    }
    let (user_id, organization_id, book_id) =
        create_personal_workspace(&mut tx, &email, &display_name, &password_hash).await?;
    tx.commit().await.map_err(ApiError::database)?;
    let (session_token, csrf_token, _) =
        issue_session(&state, user_id, 0, user_agent(&headers)).await?;
    Ok((
        StatusCode::CREATED,
        jar.add(session_cookie(&state, session_token)),
        Json(RegisterResponse {
            user_id,
            organization_id,
            book_id,
            csrf_token,
        }),
    ))
}

async fn create_personal_workspace(
    tx: &mut Transaction<'_, Postgres>,
    email: &str,
    display_name: &str,
    password_hash: &str,
) -> Result<(i64, i64, i64), ApiError> {
    let user_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(email)
    .bind(display_name)
    .bind(password_hash)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    let organization_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO organizations (name, created_by_user_id) VALUES ($1, $2) RETURNING id",
    )
    .bind(format!("{display_name}的个人空间"))
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query(
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(organization_id)
    .bind(user_id)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    let book_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO books (organization_id, name, created_by_user_id) VALUES ($1, '默认账本', $2) RETURNING id",
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query("INSERT INTO book_memberships (book_id, user_id, role) VALUES ($1, $2, 'manager')")
        .bind(book_id)
        .bind(user_id)
        .execute(&mut **tx)
        .await
        .map_err(ApiError::database)?;
    initialize_book_accounts(tx, book_id, "CNY").await?;
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, book_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, after_data
        ) VALUES ($1, $2, 'user', $3, 'user.registered', 'user', $3,
                  jsonb_build_object('display_name', $4))
        "#,
    )
    .bind(organization_id)
    .bind(book_id)
    .bind(user_id)
    .bind(display_name)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok((user_id, organization_id, book_id))
}

async fn settings(state: &AppState) -> Result<(String, i64), ApiError> {
    sqlx::query_as("SELECT registration_mode, version FROM instance_settings WHERE singleton")
        .fetch_one(&state.pool)
        .await
        .map_err(ApiError::database)
}

async fn audit_settings(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    before_data: serde_json::Value,
    after_data: serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            actor_kind, actor_user_id, action, entity_type, entity_id,
            before_data, after_data
        ) VALUES ($1, $2, 'instance.settings_updated', 'instance_settings', 1, $3, $4)
        "#,
    )
    .bind(match principal.auth_kind {
        crate::auth::AuthKind::Session => "user",
        crate::auth::AuthKind::Pat => "pat",
    })
    .bind(principal.user_id)
    .bind(before_data)
    .bind(after_data)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(())
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

fn normalize_name(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 100 {
        return Err(ApiError::bad_request(
            "display_name_invalid",
            "显示名称长度必须为 1 到 100 个字符",
        ));
    }
    Ok(value.to_owned())
}
