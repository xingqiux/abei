use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};

use crate::{
    auth::{ApiError, AuthKind, Principal},
    http::AppState,
};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrganizationRole {
    Owner,
    Admin,
    Member,
}

impl OrganizationRole {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Owner => "owner",
            Self::Admin => "admin",
            Self::Member => "member",
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BookRole {
    Manager,
    Editor,
    Viewer,
}

impl BookRole {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Manager => "manager",
            Self::Editor => "editor",
            Self::Viewer => "viewer",
        }
    }
}

#[derive(Deserialize)]
pub struct AddOrganizationMember {
    user_id: i64,
    role: OrganizationRole,
}

#[derive(Deserialize)]
pub struct UpdateOrganizationMember {
    role: OrganizationRole,
}

#[derive(Serialize, FromRow)]
pub struct OrganizationMemberResponse {
    user_id: i64,
    email: String,
    display_name: String,
    role: String,
}

#[derive(Deserialize)]
pub struct AddBookMember {
    user_id: i64,
    role: BookRole,
}

#[derive(Deserialize)]
pub struct UpdateBookMember {
    role: BookRole,
}

#[derive(Serialize, FromRow)]
pub struct BookMemberResponse {
    user_id: i64,
    email: String,
    display_name: String,
    role: String,
}

pub async fn list_organization_members(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(organization_id): Path<i64>,
) -> Result<Json<Vec<OrganizationMemberResponse>>, ApiError> {
    require_organization_admin(&state.pool, &principal, organization_id).await?;
    let rows = sqlx::query_as::<_, OrganizationMemberResponse>(
        r#"
        SELECT u.id AS user_id, u.email, u.display_name, m.role
        FROM organization_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1
        ORDER BY u.id
        "#,
    )
    .bind(organization_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

pub async fn add_organization_member(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(organization_id): Path<i64>,
    Json(request): Json<AddOrganizationMember>,
) -> Result<(StatusCode, Json<OrganizationMemberResponse>), ApiError> {
    let actor_role = require_organization_admin(&state.pool, &principal, organization_id).await?;
    if actor_role != "owner" && matches!(request.role, OrganizationRole::Owner) {
        return Err(ApiError::forbidden(
            "owner_required",
            "只有组织所有者可以授予 owner 角色",
        ));
    }
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    lock_organization(&mut tx, organization_id).await?;
    let user = sqlx::query_as::<_, (String, String)>(
        "SELECT email, display_name FROM users WHERE id = $1 AND disabled_at IS NULL",
    )
    .bind(request.user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("用户不存在或已停用"))?;
    sqlx::query(
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, $3)",
    )
    .bind(organization_id)
    .bind(request.user_id)
    .bind(request.role.as_str())
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit(
        &mut tx,
        &principal,
        organization_id,
        None,
        "organization.member_added",
        request.user_id,
        serde_json::json!({ "role": request.role.as_str() }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(OrganizationMemberResponse {
            user_id: request.user_id,
            email: user.0,
            display_name: user.1,
            role: request.role.as_str().to_owned(),
        }),
    ))
}

pub async fn update_organization_member(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((organization_id, user_id)): Path<(i64, i64)>,
    Json(request): Json<UpdateOrganizationMember>,
) -> Result<Json<OrganizationMemberResponse>, ApiError> {
    let actor_role = require_organization_admin(&state.pool, &principal, organization_id).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    lock_organization(&mut tx, organization_id).await?;
    let current = organization_member(&mut tx, organization_id, user_id).await?;
    if actor_role != "owner"
        && (current.role == "owner" || matches!(request.role, OrganizationRole::Owner))
    {
        return Err(ApiError::forbidden(
            "owner_required",
            "只有组织所有者可以修改 owner 角色",
        ));
    }
    protect_last_role(
        &mut tx,
        "organization_memberships",
        "organization_id",
        organization_id,
        &current.role,
        request.role.as_str(),
        "owner",
    )
    .await?;
    sqlx::query(
        "UPDATE organization_memberships SET role = $3 WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(organization_id)
    .bind(user_id)
    .bind(request.role.as_str())
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit(
        &mut tx,
        &principal,
        organization_id,
        None,
        "organization.member_role_updated",
        user_id,
        serde_json::json!({ "before": current.role, "after": request.role.as_str() }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(Json(OrganizationMemberResponse {
        user_id,
        email: current.email,
        display_name: current.display_name,
        role: request.role.as_str().to_owned(),
    }))
}

pub async fn remove_organization_member(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((organization_id, user_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let actor_role = require_organization_admin(&state.pool, &principal, organization_id).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    lock_organization(&mut tx, organization_id).await?;
    let current = organization_member(&mut tx, organization_id, user_id).await?;
    if actor_role != "owner" && current.role == "owner" {
        return Err(ApiError::forbidden(
            "owner_required",
            "只有组织所有者可以移除 owner",
        ));
    }
    protect_last_role(
        &mut tx,
        "organization_memberships",
        "organization_id",
        organization_id,
        &current.role,
        "",
        "owner",
    )
    .await?;
    sqlx::query("DELETE FROM organization_memberships WHERE organization_id = $1 AND user_id = $2")
        .bind(organization_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    audit(
        &mut tx,
        &principal,
        organization_id,
        None,
        "organization.member_removed",
        user_id,
        serde_json::json!({ "role": current.role }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_book_members(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
) -> Result<Json<Vec<BookMemberResponse>>, ApiError> {
    require_book_admin(&state.pool, &principal, book_id).await?;
    let rows = sqlx::query_as::<_, BookMemberResponse>(
        r#"
        SELECT u.id AS user_id, u.email, u.display_name, m.role
        FROM book_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.book_id = $1
        ORDER BY u.id
        "#,
    )
    .bind(book_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

pub async fn add_book_member(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Json(request): Json<AddBookMember>,
) -> Result<(StatusCode, Json<BookMemberResponse>), ApiError> {
    let organization_id = require_book_admin(&state.pool, &principal, book_id).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    lock_book(&mut tx, book_id).await?;
    let user = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT u.email, u.display_name
        FROM users u
        JOIN organization_memberships m ON m.user_id = u.id
        WHERE u.id = $1 AND m.organization_id = $2 AND u.disabled_at IS NULL
        "#,
    )
    .bind(request.user_id)
    .bind(organization_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::bad_request("organization_member_required", "用户不是该组织成员"))?;
    sqlx::query("INSERT INTO book_memberships (book_id, user_id, role) VALUES ($1, $2, $3)")
        .bind(book_id)
        .bind(request.user_id)
        .bind(request.role.as_str())
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    audit(
        &mut tx,
        &principal,
        organization_id,
        Some(book_id),
        "book.member_added",
        request.user_id,
        serde_json::json!({ "role": request.role.as_str() }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(BookMemberResponse {
            user_id: request.user_id,
            email: user.0,
            display_name: user.1,
            role: request.role.as_str().to_owned(),
        }),
    ))
}

pub async fn update_book_member(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, user_id)): Path<(i64, i64)>,
    Json(request): Json<UpdateBookMember>,
) -> Result<Json<BookMemberResponse>, ApiError> {
    let organization_id = require_book_admin(&state.pool, &principal, book_id).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    lock_book(&mut tx, book_id).await?;
    let current = book_member(&mut tx, book_id, user_id).await?;
    protect_last_role(
        &mut tx,
        "book_memberships",
        "book_id",
        book_id,
        &current.role,
        request.role.as_str(),
        "manager",
    )
    .await?;
    sqlx::query("UPDATE book_memberships SET role = $3 WHERE book_id = $1 AND user_id = $2")
        .bind(book_id)
        .bind(user_id)
        .bind(request.role.as_str())
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    audit(
        &mut tx,
        &principal,
        organization_id,
        Some(book_id),
        "book.member_role_updated",
        user_id,
        serde_json::json!({ "before": current.role, "after": request.role.as_str() }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(Json(BookMemberResponse {
        user_id,
        email: current.email,
        display_name: current.display_name,
        role: request.role.as_str().to_owned(),
    }))
}

pub async fn remove_book_member(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, user_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    let organization_id = require_book_admin(&state.pool, &principal, book_id).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    lock_book(&mut tx, book_id).await?;
    let current = book_member(&mut tx, book_id, user_id).await?;
    protect_last_role(
        &mut tx,
        "book_memberships",
        "book_id",
        book_id,
        &current.role,
        "",
        "manager",
    )
    .await?;
    sqlx::query("DELETE FROM book_memberships WHERE book_id = $1 AND user_id = $2")
        .bind(book_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    audit(
        &mut tx,
        &principal,
        organization_id,
        Some(book_id),
        "book.member_removed",
        user_id,
        serde_json::json!({ "role": current.role }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(FromRow)]
struct MemberRow {
    email: String,
    display_name: String,
    role: String,
}

async fn organization_member(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: i64,
    user_id: i64,
) -> Result<MemberRow, ApiError> {
    sqlx::query_as::<_, MemberRow>(
        r#"
        SELECT u.email, u.display_name, m.role
        FROM organization_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = $1 AND m.user_id = $2
        FOR UPDATE OF m
        "#,
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("组织成员不存在"))
}

async fn book_member(
    tx: &mut Transaction<'_, Postgres>,
    book_id: i64,
    user_id: i64,
) -> Result<MemberRow, ApiError> {
    sqlx::query_as::<_, MemberRow>(
        r#"
        SELECT u.email, u.display_name, m.role
        FROM book_memberships m
        JOIN users u ON u.id = m.user_id
        WHERE m.book_id = $1 AND m.user_id = $2
        FOR UPDATE OF m
        "#,
    )
    .bind(book_id)
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("账本成员不存在"))
}

pub(crate) async fn require_organization_admin(
    pool: &PgPool,
    principal: &Principal,
    organization_id: i64,
) -> Result<String, ApiError> {
    require_scope(principal, "organizations:manage")?;
    let role = sqlx::query_scalar::<_, String>(
        r#"
        SELECT m.role
        FROM organization_memberships m
        JOIN organizations o ON o.id = m.organization_id
        WHERE m.organization_id = $1 AND m.user_id = $2 AND o.archived_at IS NULL
        "#,
    )
    .bind(organization_id)
    .bind(principal.user_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("组织不存在"))?;
    if !matches!(role.as_str(), "owner" | "admin") {
        return Err(ApiError::forbidden(
            "organization_admin_required",
            "需要组织管理员权限",
        ));
    }
    Ok(role)
}

async fn require_book_admin(
    pool: &PgPool,
    principal: &Principal,
    book_id: i64,
) -> Result<i64, ApiError> {
    require_scope(principal, "organizations:manage")?;
    let row = sqlx::query_as::<_, (i64, Option<String>, Option<String>)>(
        r#"
        SELECT b.organization_id, om.role, bm.role
        FROM books b
        JOIN organizations o ON o.id = b.organization_id
        LEFT JOIN organization_memberships om
          ON om.organization_id = b.organization_id AND om.user_id = $2
        LEFT JOIN book_memberships bm ON bm.book_id = b.id AND bm.user_id = $2
        WHERE b.id = $1 AND b.archived_at IS NULL AND o.archived_at IS NULL
        "#,
    )
    .bind(book_id)
    .bind(principal.user_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("账本不存在"))?;
    if !matches!(row.1.as_deref(), Some("owner" | "admin")) && row.2.as_deref() != Some("manager") {
        return Err(ApiError::forbidden(
            "book_manager_required",
            "需要组织管理员或账本管理者权限",
        ));
    }
    Ok(row.0)
}

async fn lock_organization(
    tx: &mut Transaction<'_, Postgres>,
    organization_id: i64,
) -> Result<(), ApiError> {
    sqlx::query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE")
        .bind(organization_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(ApiError::database)?;
    Ok(())
}

async fn lock_book(tx: &mut Transaction<'_, Postgres>, book_id: i64) -> Result<(), ApiError> {
    sqlx::query("SELECT id FROM books WHERE id = $1 FOR UPDATE")
        .bind(book_id)
        .fetch_one(&mut **tx)
        .await
        .map_err(ApiError::database)?;
    Ok(())
}

async fn protect_last_role(
    tx: &mut Transaction<'_, Postgres>,
    table: &'static str,
    owner_column: &'static str,
    owner_id: i64,
    current_role: &str,
    next_role: &str,
    protected_role: &'static str,
) -> Result<(), ApiError> {
    if current_role != protected_role || next_role == protected_role {
        return Ok(());
    }
    let sql = format!("SELECT count(*) FROM {table} WHERE {owner_column} = $1 AND role = $2");
    let count = sqlx::query_scalar::<_, i64>(&sql)
        .bind(owner_id)
        .bind(protected_role)
        .fetch_one(&mut **tx)
        .await
        .map_err(ApiError::database)?;
    if count == 1 {
        return Err(ApiError::conflict(
            "last_manager_required",
            format!("至少需要保留一个 {protected_role}"),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    organization_id: i64,
    book_id: Option<i64>,
    action: &'static str,
    user_id: i64,
    after_data: serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, book_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, after_data
        ) VALUES ($1, $2, $3, $4, $5, 'user_membership', $6, $7)
        "#,
    )
    .bind(organization_id)
    .bind(book_id)
    .bind(match principal.auth_kind {
        AuthKind::Session => "user",
        AuthKind::Pat => "pat",
    })
    .bind(principal.user_id)
    .bind(action)
    .bind(user_id)
    .bind(after_data)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
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
