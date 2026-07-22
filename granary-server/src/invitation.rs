use std::collections::{BTreeMap, HashMap};

use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use email_address::EmailAddress;
use password_auth::{generate_hash, verify_password};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use subtle::ConstantTimeEq;
use time::OffsetDateTime;

use crate::{
    access::{BookRole, OrganizationRole, require_organization_admin},
    auth::{ApiError, AuthKind, Principal},
    http::AppState,
    mail,
};

#[derive(Deserialize)]
pub struct InvitationBookGrant {
    book_id: i64,
    role: BookRole,
}

#[derive(Deserialize)]
pub struct CreateInvitation {
    email: String,
    organization_role: OrganizationRole,
    #[serde(default)]
    books: Vec<InvitationBookGrant>,
    #[serde(default = "default_expiry_days")]
    expires_in_days: u8,
}

#[derive(Clone, Serialize, FromRow)]
pub struct InvitationBookResponse {
    book_id: i64,
    book_name: String,
    role: String,
}

#[derive(Serialize)]
pub struct CreatedInvitationResponse {
    id: i64,
    email: String,
    organization_role: String,
    books: Vec<InvitationBookResponse>,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
    token: String,
}

#[derive(FromRow)]
struct InvitationRow {
    id: i64,
    email: String,
    organization_role: String,
    expires_at: OffsetDateTime,
    accepted_at: Option<OffsetDateTime>,
    revoked_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
}

#[derive(Serialize)]
pub struct InvitationResponse {
    id: i64,
    email: String,
    organization_role: String,
    books: Vec<InvitationBookResponse>,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    accepted_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    revoked_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

#[derive(Deserialize)]
pub struct AcceptInvitation {
    token: String,
    display_name: Option<String>,
    password: String,
}

#[derive(Serialize)]
pub struct AcceptedInvitationResponse {
    user_id: i64,
    organization_id: i64,
    book_ids: Vec<i64>,
}

pub async fn create_invitation(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(organization_id): Path<i64>,
    Json(request): Json<CreateInvitation>,
) -> Result<(StatusCode, Json<CreatedInvitationResponse>), ApiError> {
    let actor_role = require_organization_admin(&state.pool, &principal, organization_id).await?;
    if actor_role != "owner" && matches!(request.organization_role, OrganizationRole::Owner) {
        return Err(ApiError::forbidden(
            "owner_required",
            "只有组织所有者可以邀请新的 owner",
        ));
    }
    if !(1..=30).contains(&request.expires_in_days) {
        return Err(ApiError::bad_request(
            "invitation_expiry_invalid",
            "邀请有效期必须为 1 到 30 天",
        ));
    }
    let email = normalize_email(&request.email)?;
    let organization_name =
        sqlx::query_scalar::<_, String>("SELECT name FROM organizations WHERE id = $1")
            .bind(organization_id)
            .fetch_one(&state.pool)
            .await
            .map_err(ApiError::database)?;
    let grants: BTreeMap<i64, BookRole> = request
        .books
        .into_iter()
        .map(|grant| (grant.book_id, grant.role))
        .collect();
    let (selector, secret, token_hash) = new_invitation_token();
    let token = format!("grn_inv_{selector}_{secret}");
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    sqlx::query(
        r#"
        UPDATE organization_invitations
        SET revoked_by_user_id = $3, revoked_at = now()
        WHERE organization_id = $1 AND lower(email) = $2
          AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()
        "#,
    )
    .bind(organization_id)
    .bind(&email)
    .bind(principal.user_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    let existing_member = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM organization_memberships m
            JOIN users u ON u.id = m.user_id
            WHERE m.organization_id = $1 AND lower(u.email) = $2
        )
        "#,
    )
    .bind(organization_id)
    .bind(&email)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    if existing_member {
        return Err(ApiError::conflict(
            "organization_member_exists",
            "该用户已经是组织成员",
        ));
    }
    let id_and_expiry = sqlx::query_as::<_, (i64, OffsetDateTime)>(
        r#"
        INSERT INTO organization_invitations (
            organization_id, email, organization_role, selector, token_hash,
            invited_by_user_id, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
        RETURNING id, expires_at
        "#,
    )
    .bind(organization_id)
    .bind(&email)
    .bind(request.organization_role.as_str())
    .bind(&selector)
    .bind(token_hash)
    .bind(principal.user_id)
    .bind(i32::from(request.expires_in_days))
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;

    let mut books = Vec::with_capacity(grants.len());
    for (book_id, role) in grants {
        let book_name = sqlx::query_scalar::<_, String>(
            "SELECT name FROM books WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL",
        )
        .bind(book_id)
        .bind(organization_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::bad_request("invitation_book_invalid", "邀请中的账本不存在"))?;
        sqlx::query(
            r#"
            INSERT INTO organization_invitation_books (invitation_id, organization_id, book_id, role)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(id_and_expiry.0)
        .bind(organization_id)
        .bind(book_id)
        .bind(role.as_str())
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
        books.push(InvitationBookResponse {
            book_id,
            book_name,
            role: role.as_str().to_owned(),
        });
    }
    audit(
        &mut tx,
        &principal,
        organization_id,
        "invitation.created",
        id_and_expiry.0,
        serde_json::json!({
            "email": email,
            "organization_role": request.organization_role.as_str(),
            "book_ids": books.iter().map(|book| book.book_id).collect::<Vec<_>>()
        }),
    )
    .await?;
    send_invitation_email(&state, &email, &organization_name, &token, id_and_expiry.1).await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(CreatedInvitationResponse {
            id: id_and_expiry.0,
            email,
            organization_role: request.organization_role.as_str().to_owned(),
            books,
            expires_at: id_and_expiry.1,
            token,
        }),
    ))
}

async fn send_invitation_email(
    state: &AppState,
    recipient: &str,
    organization_name: &str,
    token: &str,
    expires_at: OffsetDateTime,
) -> Result<(), ApiError> {
    let invitation_url = format!(
        "{}/accept-invitation?token={}",
        state.public_url.trim_end_matches('/'),
        token
    );
    mail::send_text(
        state,
        recipient,
        "Granary 组织邀请",
        format!(
            "You were invited to join the Granary organization \"{organization_name}\".\n\n{invitation_url}\n\nThis invitation expires at {expires_at}."
        ),
    )
    .await
}

pub async fn list_invitations(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(organization_id): Path<i64>,
) -> Result<Json<Vec<InvitationResponse>>, ApiError> {
    require_organization_admin(&state.pool, &principal, organization_id).await?;
    let invitations = sqlx::query_as::<_, InvitationRow>(
        r#"
        SELECT id, email, organization_role, expires_at, accepted_at, revoked_at, created_at
        FROM organization_invitations
        WHERE organization_id = $1
        ORDER BY created_at DESC, id DESC
        "#,
    )
    .bind(organization_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    let grants = sqlx::query_as::<_, (i64, i64, String, String)>(
        r#"
        SELECT g.invitation_id, g.book_id, b.name AS book_name, g.role
        FROM organization_invitation_books g
        JOIN books b ON b.id = g.book_id
        WHERE g.organization_id = $1
        ORDER BY g.invitation_id, g.book_id
        "#,
    )
    .bind(organization_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    let mut grants_by_invitation: HashMap<i64, Vec<InvitationBookResponse>> = HashMap::new();
    for (invitation_id, book_id, book_name, role) in grants {
        grants_by_invitation
            .entry(invitation_id)
            .or_default()
            .push(InvitationBookResponse {
                book_id,
                book_name,
                role,
            });
    }
    Ok(Json(
        invitations
            .into_iter()
            .map(|row| InvitationResponse {
                id: row.id,
                email: row.email,
                organization_role: row.organization_role,
                books: grants_by_invitation.remove(&row.id).unwrap_or_default(),
                expires_at: row.expires_at,
                accepted_at: row.accepted_at,
                revoked_at: row.revoked_at,
                created_at: row.created_at,
            })
            .collect(),
    ))
}

pub async fn revoke_invitation(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((organization_id, invitation_id)): Path<(i64, i64)>,
) -> Result<StatusCode, ApiError> {
    require_organization_admin(&state.pool, &principal, organization_id).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let state_row = sqlx::query_as::<_, (Option<OffsetDateTime>, Option<OffsetDateTime>)>(
        r#"
        SELECT accepted_at, revoked_at
        FROM organization_invitations
        WHERE organization_id = $1 AND id = $2
        FOR UPDATE
        "#,
    )
    .bind(organization_id)
    .bind(invitation_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("邀请不存在"))?;
    if state_row.0.is_some() || state_row.1.is_some() {
        return Err(ApiError::conflict(
            "invitation_not_active",
            "邀请已经接受或撤销",
        ));
    }
    sqlx::query(
        "UPDATE organization_invitations SET revoked_by_user_id = $3, revoked_at = now() WHERE organization_id = $1 AND id = $2",
    )
    .bind(organization_id)
    .bind(invitation_id)
    .bind(principal.user_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit(
        &mut tx,
        &principal,
        organization_id,
        "invitation.revoked",
        invitation_id,
        serde_json::json!({ "revoked": true }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn accept_invitation(
    State(state): State<AppState>,
    Json(request): Json<AcceptInvitation>,
) -> Result<(StatusCode, Json<AcceptedInvitationResponse>), ApiError> {
    let (selector, secret) = parse_invitation_token(&request.token)?;
    validate_password(&request.password)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let invitation = sqlx::query_as::<
        _,
        (
            i64,
            i64,
            String,
            String,
            Vec<u8>,
            OffsetDateTime,
            Option<OffsetDateTime>,
            Option<OffsetDateTime>,
        ),
    >(
        r#"
        SELECT id, organization_id, email, organization_role, token_hash, expires_at,
               accepted_at, revoked_at
        FROM organization_invitations
        WHERE selector = $1
        FOR UPDATE
        "#,
    )
    .bind(selector)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::unauthorized("邀请无效或已过期"))?;
    if !constant_time_equal(&invitation.4, &digest(secret))
        || invitation.5 <= OffsetDateTime::now_utc()
        || invitation.6.is_some()
        || invitation.7.is_some()
    {
        return Err(ApiError::unauthorized("邀请无效或已过期"));
    }

    let existing = sqlx::query_as::<_, (i64, String, Option<OffsetDateTime>)>(
        "SELECT id, password_hash, disabled_at FROM users WHERE lower(email) = $1",
    )
    .bind(&invitation.2)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    let user_id = if let Some((user_id, password_hash, disabled_at)) = existing {
        if disabled_at.is_some()
            || !verify_password_async(request.password.clone(), password_hash).await?
        {
            return Err(ApiError::unauthorized("邮箱或密码错误"));
        }
        user_id
    } else {
        let display_name = normalize_name(request.display_name.as_deref().ok_or_else(|| {
            ApiError::bad_request("display_name_required", "新用户需要显示名称")
        })?)?;
        let password_hash = hash_password(request.password).await?;
        sqlx::query_scalar::<_, i64>(
            "INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING id",
        )
        .bind(&invitation.2)
        .bind(display_name)
        .bind(password_hash)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::database)?
    };
    let already_member = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM organization_memberships WHERE organization_id = $1 AND user_id = $2)",
    )
    .bind(invitation.1)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    if already_member {
        return Err(ApiError::conflict(
            "organization_member_exists",
            "用户已经是组织成员",
        ));
    }
    sqlx::query(
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, $3)",
    )
    .bind(invitation.1)
    .bind(user_id)
    .bind(&invitation.3)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    let grants = sqlx::query_as::<_, (i64, String)>(
        "SELECT book_id, role FROM organization_invitation_books WHERE invitation_id = $1 ORDER BY book_id",
    )
    .bind(invitation.0)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    for (book_id, role) in &grants {
        sqlx::query("INSERT INTO book_memberships (book_id, user_id, role) VALUES ($1, $2, $3)")
            .bind(book_id)
            .bind(user_id)
            .bind(role)
            .execute(&mut *tx)
            .await
            .map_err(ApiError::database)?;
    }
    sqlx::query(
        "UPDATE organization_invitations SET accepted_by_user_id = $2, accepted_at = now() WHERE id = $1",
    )
    .bind(invitation.0)
    .bind(user_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, after_data
        ) VALUES ($1, 'user', $2, 'invitation.accepted', 'organization_invitation', $3,
                  jsonb_build_object('user_id', $2))
        "#,
    )
    .bind(invitation.1)
    .bind(user_id)
    .bind(invitation.0)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(AcceptedInvitationResponse {
            user_id,
            organization_id: invitation.1,
            book_ids: grants.into_iter().map(|grant| grant.0).collect(),
        }),
    ))
}

async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    organization_id: i64,
    action: &'static str,
    invitation_id: i64,
    after_data: serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, after_data
        ) VALUES ($1, $2, $3, $4, 'organization_invitation', $5, $6)
        "#,
    )
    .bind(organization_id)
    .bind(match principal.auth_kind {
        AuthKind::Session => "user",
        AuthKind::Pat => "pat",
    })
    .bind(principal.user_id)
    .bind(action)
    .bind(invitation_id)
    .bind(after_data)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(())
}

fn default_expiry_days() -> u8 {
    7
}

fn normalize_email(value: &str) -> Result<String, ApiError> {
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

fn validate_password(value: &str) -> Result<(), ApiError> {
    if !(12..=128).contains(&value.chars().count()) {
        return Err(ApiError::bad_request(
            "password_invalid",
            "密码长度必须为 12 到 128 个字符",
        ));
    }
    Ok(())
}

async fn hash_password(password: String) -> Result<String, ApiError> {
    tokio::task::spawn_blocking(move || generate_hash(password))
        .await
        .map_err(ApiError::internal)
}

async fn verify_password_async(password: String, hash: String) -> Result<bool, ApiError> {
    tokio::task::spawn_blocking(move || verify_password(password, &hash).is_ok())
        .await
        .map_err(ApiError::internal)
}

fn new_invitation_token() -> (String, String, Vec<u8>) {
    let selector = hex::encode(rand::random::<[u8; 8]>());
    let secret = URL_SAFE_NO_PAD.encode(rand::random::<[u8; 32]>());
    let hash = digest(&secret);
    (selector, secret, hash)
}

fn parse_invitation_token(value: &str) -> Result<(&str, &str), ApiError> {
    let rest = value
        .strip_prefix("grn_inv_")
        .ok_or_else(|| ApiError::unauthorized("邀请无效或已过期"))?;
    rest.split_once('_')
        .ok_or_else(|| ApiError::unauthorized("邀请无效或已过期"))
}

fn digest(value: &str) -> Vec<u8> {
    Sha256::digest(value.as_bytes()).to_vec()
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && bool::from(left.ct_eq(right))
}
