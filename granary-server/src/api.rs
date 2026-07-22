use std::collections::{BTreeSet, HashMap};

use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use time::{Date, OffsetDateTime};

use crate::{
    auth::{ApiError, AuthKind, Principal, initialize_book_accounts},
    http::AppState,
    ledger::{
        AuditActorKind, LedgerError, PostJournal, PostingInput, ReverseJournal, post_journal,
        restore_trashed_journal, reverse_journal, trash_journal,
    },
};

#[derive(Deserialize)]
pub struct CreateOrganization {
    name: String,
    kind: OrganizationKind,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum OrganizationKind {
    Personal,
    Household,
    Business,
}

impl OrganizationKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Personal => "personal",
            Self::Household => "household",
            Self::Business => "business",
        }
    }
}

#[derive(Serialize, FromRow)]
pub struct OrganizationResponse {
    id: i64,
    name: String,
    kind: String,
    role: String,
    version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    archived_at: Option<OffsetDateTime>,
}

#[derive(Deserialize)]
pub struct UpdateOrganization {
    name: String,
    kind: OrganizationKind,
    version: i64,
}

#[derive(Deserialize)]
pub struct CreateBook {
    name: String,
    #[serde(default = "default_currency")]
    base_currency_code: String,
    #[serde(default = "default_timezone")]
    timezone: String,
}

#[derive(Serialize, FromRow)]
pub struct BookResponse {
    id: i64,
    organization_id: i64,
    name: String,
    base_currency_code: String,
    timezone: String,
    role: String,
    version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    archived_at: Option<OffsetDateTime>,
}

#[derive(Deserialize)]
pub struct UpdateBook {
    name: String,
    base_currency_code: String,
    timezone: String,
    version: i64,
}

#[derive(Deserialize)]
pub struct CreateAccount {
    name: String,
    class: AccountClass,
    role: AccountRole,
    currency_code: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AccountClass {
    Asset,
    Liability,
}

impl AccountClass {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Asset => "asset",
            Self::Liability => "liability",
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum AccountRole {
    Bank,
    Cash,
    Card,
    Loan,
    Other,
}

impl AccountRole {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Bank => "bank",
            Self::Cash => "cash",
            Self::Card => "card",
            Self::Loan => "loan",
            Self::Other => "other",
        }
    }
}

#[derive(Serialize, FromRow)]
pub struct AccountResponse {
    id: i64,
    name: String,
    class: String,
    role: String,
    currency_code: String,
    #[serde(with = "rust_decimal::serde::str")]
    balance: Decimal,
    version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    archived_at: Option<OffsetDateTime>,
}

#[derive(Serialize, FromRow)]
pub struct CurrencyResponse {
    code: String,
    name: String,
    symbol: String,
    minor_units: i16,
    enabled_by_default: bool,
}

#[derive(Deserialize)]
pub struct UpdateAccount {
    name: String,
    class: AccountClass,
    role: AccountRole,
    currency_code: String,
    version: i64,
}

#[derive(Deserialize)]
pub struct CreateCategory {
    name: String,
    kind: CategoryKind,
    parent_id: Option<i64>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CategoryKind {
    Income,
    Expense,
}

impl CategoryKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Income => "income",
            Self::Expense => "expense",
        }
    }
}

#[derive(Serialize, FromRow)]
pub struct CategoryResponse {
    id: i64,
    name: String,
    kind: String,
    parent_id: Option<i64>,
    version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    archived_at: Option<OffsetDateTime>,
}

#[derive(Deserialize)]
pub struct UpdateCategory {
    name: String,
    kind: CategoryKind,
    parent_id: Option<i64>,
    version: i64,
}

#[derive(Deserialize)]
pub struct CreateCounterparty {
    name: String,
    #[serde(default)]
    kind: CounterpartyKind,
    notes: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CounterpartyKind {
    #[default]
    Merchant,
    Person,
    Institution,
    Other,
}

impl CounterpartyKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Merchant => "merchant",
            Self::Person => "person",
            Self::Institution => "institution",
            Self::Other => "other",
        }
    }
}

#[derive(Serialize, FromRow)]
pub struct CounterpartyResponse {
    id: i64,
    name: String,
    kind: String,
    review_status: String,
    notes: Option<String>,
    version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    archived_at: Option<OffsetDateTime>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReviewStatus {
    Confirmed,
    Unreviewed,
}

impl ReviewStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Unreviewed => "unreviewed",
        }
    }
}

#[derive(Deserialize)]
pub struct UpdateCounterparty {
    name: String,
    kind: CounterpartyKind,
    review_status: ReviewStatus,
    notes: Option<String>,
    version: i64,
}

#[derive(Deserialize)]
pub struct ArchiveQuery {
    #[serde(default)]
    archived: bool,
}

#[derive(Deserialize)]
pub struct VersionQuery {
    version: i64,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct CategorySplit {
    category_id: i64,
    budget_id: Option<i64>,
    #[serde(with = "rust_decimal::serde::str")]
    amount: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    book_amount: Decimal,
    memo: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CreateTransaction {
    Withdrawal {
        #[serde(with = "time::serde::rfc3339")]
        occurred_at: OffsetDateTime,
        description: String,
        counterparty_id: Option<i64>,
        account_id: i64,
        #[serde(with = "rust_decimal::serde::str")]
        amount: Decimal,
        #[serde(with = "rust_decimal::serde::str")]
        book_amount: Decimal,
        splits: Vec<CategorySplit>,
        #[serde(default)]
        tag_ids: Vec<i64>,
    },
    Deposit {
        #[serde(with = "time::serde::rfc3339")]
        occurred_at: OffsetDateTime,
        description: String,
        counterparty_id: Option<i64>,
        account_id: i64,
        #[serde(with = "rust_decimal::serde::str")]
        amount: Decimal,
        #[serde(with = "rust_decimal::serde::str")]
        book_amount: Decimal,
        splits: Vec<CategorySplit>,
        #[serde(default)]
        tag_ids: Vec<i64>,
    },
    Transfer {
        #[serde(with = "time::serde::rfc3339")]
        occurred_at: OffsetDateTime,
        description: String,
        counterparty_id: Option<i64>,
        source_account_id: i64,
        #[serde(with = "rust_decimal::serde::str")]
        source_amount: Decimal,
        #[serde(with = "rust_decimal::serde::str")]
        source_book_amount: Decimal,
        destination_account_id: i64,
        #[serde(with = "rust_decimal::serde::str")]
        destination_amount: Decimal,
        #[serde(with = "rust_decimal::serde::str")]
        destination_book_amount: Decimal,
        #[serde(default)]
        tag_ids: Vec<i64>,
    },
}

#[derive(Serialize, FromRow)]
struct JournalRow {
    id: i64,
    status: String,
    occurred_at: OffsetDateTime,
    description: String,
    counterparty_id: Option<i64>,
    counterparty_name: Option<String>,
    reversal_of_id: Option<i64>,
    reversed_by_id: Option<i64>,
    cloned_from_id: Option<i64>,
    replaces_id: Option<i64>,
    replaced_by_id: Option<i64>,
    version: i64,
}

#[derive(Serialize, FromRow)]
pub struct PostingResponse {
    id: i64,
    line_no: i32,
    account_id: i64,
    account_name: String,
    account_class: String,
    currency_code: String,
    category_id: Option<i64>,
    category_name: Option<String>,
    budget_id: Option<i64>,
    budget_name: Option<String>,
    #[serde(with = "rust_decimal::serde::str")]
    amount: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    book_amount: Decimal,
    memo: Option<String>,
    cleared_at: Option<OffsetDateTime>,
}

#[derive(Serialize, FromRow)]
pub struct TransactionTagResponse {
    id: i64,
    name: String,
    color: Option<String>,
    archived: bool,
}

#[derive(Serialize)]
pub struct TransactionResponse {
    id: i64,
    status: String,
    transaction_type: String,
    #[serde(with = "time::serde::rfc3339")]
    occurred_at: OffsetDateTime,
    description: String,
    counterparty_id: Option<i64>,
    counterparty_name: Option<String>,
    reversal_of_id: Option<i64>,
    reversed_by_id: Option<i64>,
    cloned_from_id: Option<i64>,
    replaces_id: Option<i64>,
    replaced_by_id: Option<i64>,
    version: i64,
    postings: Vec<PostingResponse>,
    tags: Vec<TransactionTagResponse>,
}

pub(crate) struct PreparedTransaction {
    pub(crate) description: String,
    pub(crate) occurred_at: OffsetDateTime,
    pub(crate) counterparty_id: Option<i64>,
    pub(crate) postings: Vec<PostingInput>,
    pub(crate) tag_ids: Vec<i64>,
}

#[derive(Serialize)]
pub struct TransactionPage {
    data: Vec<TransactionResponse>,
    next_before_id: Option<i64>,
}

#[derive(Deserialize)]
pub struct PageQuery {
    limit: Option<u16>,
    before_id: Option<i64>,
    start: Option<String>,
    end: Option<String>,
    #[serde(rename = "type")]
    transaction_type: Option<String>,
    account_id: Option<i64>,
    query: Option<String>,
}

#[derive(Deserialize)]
pub struct ReverseTransaction {
    #[serde(default, with = "time::serde::rfc3339::option")]
    occurred_at: Option<OffsetDateTime>,
    reason: String,
}

#[derive(Deserialize)]
pub struct RecycleQuery {
    #[serde(default)]
    restored: bool,
}

#[derive(Serialize, FromRow)]
pub struct RecycleBinTransaction {
    original_journal_id: i64,
    reversal_journal_id: i64,
    description: String,
    #[serde(with = "time::serde::rfc3339")]
    occurred_at: OffsetDateTime,
    delete_reason: String,
    #[serde(with = "time::serde::rfc3339")]
    deleted_at: OffsetDateTime,
    restored_journal_id: Option<i64>,
    restore_reason: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    restored_at: Option<OffsetDateTime>,
}

pub async fn create_organization(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Json(request): Json<CreateOrganization>,
) -> Result<(StatusCode, Json<OrganizationResponse>), ApiError> {
    require_scope(&principal, "organizations:manage")?;
    let name = normalize_name(&request.name, "组织名称")?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO organizations (name, kind, created_by_user_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(&name)
    .bind(request.kind.as_str())
    .bind(principal.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query(
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(id)
    .bind(principal.user_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit(
        &mut tx,
        &principal,
        Some(id),
        None,
        "organization.created",
        "organization",
        id,
        json_name(&name),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;

    Ok((
        StatusCode::CREATED,
        Json(OrganizationResponse {
            id,
            name,
            kind: request.kind.as_str().to_owned(),
            role: "owner".to_owned(),
            version: 1,
            archived_at: None,
        }),
    ))
}

pub async fn list_organizations(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<Vec<OrganizationResponse>>, ApiError> {
    require_scope(&principal, "organizations:read")?;
    let rows = sqlx::query_as::<_, OrganizationResponse>(
        r#"
        SELECT o.id, o.name, o.kind, m.role, o.version, o.archived_at
        FROM organizations o
        JOIN organization_memberships m ON m.organization_id = o.id
        WHERE m.user_id = $1 AND ($2 = (o.archived_at IS NOT NULL))
        ORDER BY o.id
        "#,
    )
    .bind(principal.user_id)
    .bind(query.archived)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

pub async fn update_organization(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(organization_id): Path<i64>,
    Json(request): Json<UpdateOrganization>,
) -> Result<Json<OrganizationResponse>, ApiError> {
    let role = require_organization_admin(&state.pool, &principal, organization_id).await?;
    let name = normalize_name(&request.name, "组织名称")?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, (String, String, i64, Option<OffsetDateTime>)>(
        "SELECT name, kind, version, archived_at FROM organizations WHERE id = $1 FOR UPDATE",
    )
    .bind(organization_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    require_active_version(current.2, request.version, current.3, "组织")?;
    let version = sqlx::query_scalar::<_, i64>(
        r#"
        UPDATE organizations
        SET name = $2, kind = $3, version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING version
        "#,
    )
    .bind(organization_id)
    .bind(&name)
    .bind(request.kind.as_str())
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change(
        &mut tx,
        &principal,
        Some(organization_id),
        None,
        "organization.updated",
        "organization",
        organization_id,
        serde_json::json!({ "name": current.0, "kind": current.1, "version": current.2 }),
        serde_json::json!({ "name": name, "kind": request.kind.as_str(), "version": version }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(Json(OrganizationResponse {
        id: organization_id,
        name,
        kind: request.kind.as_str().to_owned(),
        role,
        version,
        archived_at: None,
    }))
}

pub async fn archive_organization(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(organization_id): Path<i64>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    let role = require_organization_admin(&state.pool, &principal, organization_id).await?;
    if role != "owner" {
        return Err(ApiError::forbidden(
            "organization_owner_required",
            "只有组织所有者可以归档组织",
        ));
    }
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, (String, String, i64, Option<OffsetDateTime>)>(
        "SELECT name, kind, version, archived_at FROM organizations WHERE id = $1 FOR UPDATE",
    )
    .bind(organization_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    require_active_version(current.2, query.version, current.3, "组织")?;
    let archived_at = OffsetDateTime::now_utc();
    sqlx::query(
        "UPDATE organizations SET archived_at = $2, version = version + 1, updated_at = now() WHERE id = $1",
    )
    .bind(organization_id)
    .bind(archived_at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change(
        &mut tx,
        &principal,
        Some(organization_id),
        None,
        "organization.archived",
        "organization",
        organization_id,
        serde_json::json!({ "archived_at": null, "version": current.2 }),
        serde_json::json!({ "archived_at": archived_at, "version": current.2 + 1 }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_organization(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(organization_id): Path<i64>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    let role =
        require_organization_admin_including_archived(&state.pool, &principal, organization_id)
            .await?;
    if role != "owner" {
        return Err(ApiError::forbidden(
            "organization_owner_required",
            "只有组织所有者可以恢复组织",
        ));
    }
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, (i64, Option<OffsetDateTime>)>(
        "SELECT version, archived_at FROM organizations WHERE id = $1 FOR UPDATE",
    )
    .bind(organization_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    if current.0 != query.version {
        return Err(ApiError::conflict(
            "version_conflict",
            "组织已经被其他请求修改，请刷新后重试",
        ));
    }
    let archived_at = current
        .1
        .ok_or_else(|| ApiError::conflict("organization_not_archived", "组织未归档"))?;
    sqlx::query(
        "UPDATE organizations SET archived_at = NULL, version = version + 1, updated_at = now() WHERE id = $1",
    )
    .bind(organization_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change(
        &mut tx,
        &principal,
        Some(organization_id),
        None,
        "organization.restored",
        "organization",
        organization_id,
        serde_json::json!({ "archived_at": archived_at, "version": current.0 }),
        serde_json::json!({ "archived_at": null, "version": current.0 + 1 }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_book(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(organization_id): Path<i64>,
    Json(request): Json<CreateBook>,
) -> Result<(StatusCode, Json<BookResponse>), ApiError> {
    require_organization_admin(&state.pool, &principal, organization_id).await?;
    let name = normalize_name(&request.name, "账本名称")?;
    let currency = normalize_currency(&request.base_currency_code)?;
    let timezone = normalize_timezone(&request.timezone)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO books (organization_id, name, base_currency_code, timezone, created_by_user_id)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
        "#,
    )
    .bind(organization_id)
    .bind(&name)
    .bind(&currency)
    .bind(&timezone)
    .bind(principal.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query("INSERT INTO book_memberships (book_id, user_id, role) VALUES ($1, $2, 'manager')")
        .bind(id)
        .bind(principal.user_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    initialize_book_accounts(&mut tx, id, &currency).await?;
    audit(
        &mut tx,
        &principal,
        Some(organization_id),
        Some(id),
        "book.created",
        "book",
        id,
        json_name(&name),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;

    Ok((
        StatusCode::CREATED,
        Json(BookResponse {
            id,
            organization_id,
            name,
            base_currency_code: currency,
            timezone,
            role: "manager".to_owned(),
            version: 1,
            archived_at: None,
        }),
    ))
}

pub async fn list_books(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<Vec<BookResponse>>, ApiError> {
    require_scope(&principal, "books:read")?;
    let rows = sqlx::query_as::<_, BookResponse>(
        r#"
        SELECT b.id, b.organization_id, b.name, b.base_currency_code, b.timezone, m.role,
               b.version, b.archived_at
        FROM books b
        JOIN organizations o ON o.id = b.organization_id AND o.archived_at IS NULL
        JOIN book_memberships m ON m.book_id = b.id
        WHERE m.user_id = $1 AND ($2 = (b.archived_at IS NOT NULL))
        ORDER BY b.id
        "#,
    )
    .bind(principal.user_id)
    .bind(query.archived)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

pub async fn update_book(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Json(request): Json<UpdateBook>,
) -> Result<Json<BookResponse>, ApiError> {
    let (organization_id, role) =
        require_book_manager(&state.pool, &principal, book_id, false).await?;
    let name = normalize_name(&request.name, "账本名称")?;
    let currency = normalize_currency(&request.base_currency_code)?;
    let timezone = normalize_timezone(&request.timezone)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, (String, String, String, i64, Option<OffsetDateTime>)>(
        r#"
        SELECT name, base_currency_code, timezone, version, archived_at
        FROM books WHERE id = $1 FOR UPDATE
        "#,
    )
    .bind(book_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    require_active_version(current.3, request.version, current.4, "账本")?;
    let version = sqlx::query_scalar::<_, i64>(
        r#"
        UPDATE books
        SET name = $2, base_currency_code = $3, timezone = $4,
            version = version + 1, updated_at = now()
        WHERE id = $1
        RETURNING version
        "#,
    )
    .bind(book_id)
    .bind(&name)
    .bind(&currency)
    .bind(&timezone)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    if current.1 != currency {
        sqlx::query(
            r#"
            UPDATE ledger_accounts
            SET currency_code = $2, version = version + 1, updated_at = now()
            WHERE book_id = $1 AND hidden
              AND role IN ('category', 'opening_balance', 'reconciliation', 'fx_gain_loss')
            "#,
        )
        .bind(book_id)
        .bind(&currency)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    }
    audit_change(
        &mut tx,
        &principal,
        Some(organization_id),
        Some(book_id),
        "book.updated",
        "book",
        book_id,
        serde_json::json!({
            "name": current.0, "base_currency_code": current.1,
            "timezone": current.2, "version": current.3
        }),
        serde_json::json!({
            "name": name, "base_currency_code": currency,
            "timezone": timezone, "version": version
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(Json(BookResponse {
        id: book_id,
        organization_id,
        name,
        base_currency_code: currency,
        timezone,
        role,
        version,
        archived_at: None,
    }))
}

pub async fn archive_book(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    let (organization_id, _) =
        require_book_manager(&state.pool, &principal, book_id, false).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, (i64, Option<OffsetDateTime>)>(
        "SELECT version, archived_at FROM books WHERE id = $1 FOR UPDATE",
    )
    .bind(book_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    require_active_version(current.0, query.version, current.1, "账本")?;
    let archived_at = OffsetDateTime::now_utc();
    sqlx::query(
        "UPDATE books SET archived_at = $2, version = version + 1, updated_at = now() WHERE id = $1",
    )
    .bind(book_id)
    .bind(archived_at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change(
        &mut tx,
        &principal,
        Some(organization_id),
        Some(book_id),
        "book.archived",
        "book",
        book_id,
        serde_json::json!({ "archived_at": null, "version": current.0 }),
        serde_json::json!({ "archived_at": archived_at, "version": current.0 + 1 }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_book(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    let (organization_id, _) = require_book_manager(&state.pool, &principal, book_id, true).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, (i64, Option<OffsetDateTime>)>(
        "SELECT version, archived_at FROM books WHERE id = $1 FOR UPDATE",
    )
    .bind(book_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    if current.0 != query.version {
        return Err(ApiError::conflict(
            "version_conflict",
            "账本已经被其他请求修改，请刷新后重试",
        ));
    }
    let archived_at = current
        .1
        .ok_or_else(|| ApiError::conflict("book_not_archived", "账本未归档"))?;
    sqlx::query(
        "UPDATE books SET archived_at = NULL, version = version + 1, updated_at = now() WHERE id = $1",
    )
    .bind(book_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change(
        &mut tx,
        &principal,
        Some(organization_id),
        Some(book_id),
        "book.restored",
        "book",
        book_id,
        serde_json::json!({ "archived_at": archived_at, "version": current.0 }),
        serde_json::json!({ "archived_at": null, "version": current.0 + 1 }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_account(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Json(request): Json<CreateAccount>,
) -> Result<(StatusCode, Json<AccountResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    validate_account_role(&request.class, &request.role)?;
    let name = normalize_name(&request.name, "账户名称")?;
    let currency = normalize_currency(&request.currency_code)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO ledger_accounts (book_id, name, class, role, currency_code)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
        "#,
    )
    .bind(book_id)
    .bind(&name)
    .bind(request.class.as_str())
    .bind(request.role.as_str())
    .bind(&currency)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_for_book(
        &mut tx,
        &principal,
        book_id,
        "account.created",
        "ledger_account",
        id,
        json_name(&name),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;

    Ok((
        StatusCode::CREATED,
        Json(AccountResponse {
            id,
            name,
            class: request.class.as_str().to_owned(),
            role: request.role.as_str().to_owned(),
            currency_code: currency,
            balance: Decimal::ZERO,
            version: 1,
            archived_at: None,
        }),
    ))
}

pub async fn list_accounts(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<Vec<AccountResponse>>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let rows = sqlx::query_as::<_, AccountResponse>(
        r#"
        SELECT a.id, a.name, a.class, a.role, a.currency_code,
               COALESCE(sum(p.amount) FILTER (WHERE j.status IN ('posted', 'reversed')), 0) AS balance,
               a.version, a.archived_at
        FROM ledger_accounts a
        LEFT JOIN postings p ON p.book_id = a.book_id AND p.account_id = a.id
        LEFT JOIN journal_entries j ON j.id = p.journal_entry_id
        WHERE a.book_id = $1 AND a.hidden = FALSE
          AND (($2 = FALSE AND a.archived_at IS NULL) OR ($2 = TRUE AND a.archived_at IS NOT NULL))
          AND a.class IN ('asset', 'liability')
        GROUP BY a.id
        ORDER BY a.id
        "#,
    )
    .bind(book_id)
    .bind(query.archived)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

pub async fn show_account(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, account_id)): Path<(i64, i64)>,
) -> Result<Json<AccountResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let account = sqlx::query_as::<_, AccountResponse>(
        r#"
        SELECT a.id, a.name, a.class, a.role, a.currency_code,
               COALESCE(sum(p.amount) FILTER (WHERE j.status IN ('posted', 'reversed')), 0) AS balance,
               a.version, a.archived_at
        FROM ledger_accounts a
        LEFT JOIN postings p ON p.book_id = a.book_id AND p.account_id = a.id
        LEFT JOIN journal_entries j ON j.id = p.journal_entry_id
        WHERE a.book_id = $1 AND a.id = $2 AND a.hidden = FALSE
          AND a.class IN ('asset', 'liability')
        GROUP BY a.id
        "#,
    )
    .bind(book_id)
    .bind(account_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("账户不存在"))?;
    Ok(Json(account))
}

pub async fn list_currencies(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<Vec<CurrencyResponse>>, ApiError> {
    require_scope(&principal, "books:read")?;
    let currencies = sqlx::query_as::<_, CurrencyResponse>(
        "SELECT code, name, symbol, exponent AS minor_units, enabled_by_default FROM currencies ORDER BY code",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(currencies))
}

pub async fn update_account(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, account_id)): Path<(i64, i64)>,
    Json(request): Json<UpdateAccount>,
) -> Result<Json<AccountResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    validate_account_role(&request.class, &request.role)?;
    let name = normalize_name(&request.name, "账户名称")?;
    let currency = normalize_currency(&request.currency_code)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current =
        sqlx::query_as::<_, (String, String, String, String, i64, Option<OffsetDateTime>)>(
            r#"
        SELECT name, class, role, currency_code, version, archived_at
        FROM ledger_accounts
        WHERE book_id = $1 AND id = $2 AND hidden = FALSE
        FOR UPDATE
        "#,
        )
        .bind(book_id)
        .bind(account_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found("账户不存在"))?;
    require_active_version(current.4, request.version, current.5, "账户")?;

    sqlx::query(
        r#"
        UPDATE ledger_accounts
        SET name = $3, class = $4, role = $5, currency_code = $6,
            version = version + 1, updated_at = now()
        WHERE book_id = $1 AND id = $2
        "#,
    )
    .bind(book_id)
    .bind(account_id)
    .bind(&name)
    .bind(request.class.as_str())
    .bind(request.role.as_str())
    .bind(&currency)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change_for_book(
        &mut tx,
        &principal,
        book_id,
        "account.updated",
        "ledger_account",
        account_id,
        serde_json::json!({
            "name": current.0,
            "class": current.1,
            "role": current.2,
            "currency_code": current.3,
            "version": current.4
        }),
        serde_json::json!({
            "name": name,
            "class": request.class.as_str(),
            "role": request.role.as_str(),
            "currency_code": currency,
            "version": request.version + 1
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;

    let balance = sqlx::query_scalar::<_, Decimal>(
        r#"
        SELECT COALESCE(sum(p.amount) FILTER (WHERE j.status IN ('posted', 'reversed')), 0)
        FROM postings p
        JOIN journal_entries j ON j.id = p.journal_entry_id
        WHERE p.book_id = $1 AND p.account_id = $2
        "#,
    )
    .bind(book_id)
    .bind(account_id)
    .fetch_one(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(AccountResponse {
        id: account_id,
        name,
        class: request.class.as_str().to_owned(),
        role: request.role.as_str().to_owned(),
        currency_code: currency,
        balance,
        version: request.version + 1,
        archived_at: None,
    }))
}

pub async fn archive_account(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, account_id)): Path<(i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_account_archived(&state, &principal, book_id, account_id, query.version, true).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_account(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, account_id)): Path<(i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_account_archived(
        &state,
        &principal,
        book_id,
        account_id,
        query.version,
        false,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_account_archived(
    state: &AppState,
    principal: &Principal,
    book_id: i64,
    account_id: i64,
    version: i64,
    archived: bool,
) -> Result<(), ApiError> {
    require_book(&state.pool, principal, book_id, true).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, (String, i64, Option<OffsetDateTime>)>(
        "SELECT name, version, archived_at FROM ledger_accounts WHERE book_id = $1 AND id = $2 AND hidden = FALSE FOR UPDATE",
    )
    .bind(book_id)
    .bind(account_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("账户不存在"))?;
    require_archive_version(current.1, version, current.2, archived, "账户")?;
    let archived_at = archived.then(OffsetDateTime::now_utc);
    sqlx::query(
        "UPDATE ledger_accounts SET archived_at = $3, version = version + 1, updated_at = now() WHERE book_id = $1 AND id = $2",
    )
    .bind(book_id)
    .bind(account_id)
    .bind(archived_at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change_for_book(
        &mut tx,
        principal,
        book_id,
        if archived {
            "account.archived"
        } else {
            "account.restored"
        },
        "ledger_account",
        account_id,
        serde_json::json!({ "name": current.0, "archived": !archived, "version": current.1 }),
        serde_json::json!({ "name": current.0, "archived": archived, "version": version + 1 }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(())
}

pub async fn create_category(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Json(request): Json<CreateCategory>,
) -> Result<(StatusCode, Json<CategoryResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let name = normalize_name(&request.name, "分类名称")?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let currency = sqlx::query_scalar::<_, String>(
        "SELECT base_currency_code FROM books WHERE id = $1 AND archived_at IS NULL",
    )
    .bind(book_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("账本不存在"))?;
    let account_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO ledger_accounts (book_id, name, class, role, currency_code, hidden)
        VALUES ($1, $2, $3, 'category', $4, TRUE) RETURNING id
        "#,
    )
    .bind(book_id)
    .bind(&name)
    .bind(request.kind.as_str())
    .bind(currency)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO categories (book_id, parent_id, ledger_account_id, name, kind)
        VALUES ($1, $2, $3, $4, $5) RETURNING id
        "#,
    )
    .bind(book_id)
    .bind(request.parent_id)
    .bind(account_id)
    .bind(&name)
    .bind(request.kind.as_str())
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_for_book(
        &mut tx,
        &principal,
        book_id,
        "category.created",
        "category",
        id,
        json_name(&name),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;

    Ok((
        StatusCode::CREATED,
        Json(CategoryResponse {
            id,
            name,
            kind: request.kind.as_str().to_owned(),
            parent_id: request.parent_id,
            version: 1,
            archived_at: None,
        }),
    ))
}

pub async fn list_categories(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<Vec<CategoryResponse>>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let rows = sqlx::query_as::<_, CategoryResponse>(
        r#"
        SELECT id, name, kind, parent_id, version, archived_at
        FROM categories
        WHERE book_id = $1
          AND (($2 = FALSE AND archived_at IS NULL) OR ($2 = TRUE AND archived_at IS NOT NULL))
        ORDER BY kind, parent_id NULLS FIRST, name
        "#,
    )
    .bind(book_id)
    .bind(query.archived)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

pub async fn update_category(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, category_id)): Path<(i64, i64)>,
    Json(request): Json<UpdateCategory>,
) -> Result<Json<CategoryResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let name = normalize_name(&request.name, "分类名称")?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<
        _,
        (
            String,
            String,
            Option<i64>,
            i64,
            i64,
            Option<OffsetDateTime>,
        ),
    >(
        r#"
        SELECT name, kind, parent_id, ledger_account_id, version, archived_at
        FROM categories
        WHERE book_id = $1 AND id = $2
        FOR UPDATE
        "#,
    )
    .bind(book_id)
    .bind(category_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("分类不存在"))?;
    require_active_version(current.4, request.version, current.5, "分类")?;
    if request.parent_id == Some(category_id) {
        return Err(ApiError::bad_request(
            "category_parent_invalid",
            "分类不能以自身作为父分类",
        ));
    }

    sqlx::query(
        "UPDATE ledger_accounts SET name = $3, class = $4, version = version + 1, updated_at = now() WHERE book_id = $1 AND id = $2",
    )
    .bind(book_id)
    .bind(current.3)
    .bind(&name)
    .bind(request.kind.as_str())
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query(
        r#"
        UPDATE categories
        SET name = $3, kind = $4, parent_id = $5, version = version + 1, updated_at = now()
        WHERE book_id = $1 AND id = $2
        "#,
    )
    .bind(book_id)
    .bind(category_id)
    .bind(&name)
    .bind(request.kind.as_str())
    .bind(request.parent_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change_for_book(
        &mut tx,
        &principal,
        book_id,
        "category.updated",
        "category",
        category_id,
        serde_json::json!({
            "name": current.0,
            "kind": current.1,
            "parent_id": current.2,
            "version": current.4
        }),
        serde_json::json!({
            "name": name,
            "kind": request.kind.as_str(),
            "parent_id": request.parent_id,
            "version": request.version + 1
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(Json(CategoryResponse {
        id: category_id,
        name,
        kind: request.kind.as_str().to_owned(),
        parent_id: request.parent_id,
        version: request.version + 1,
        archived_at: None,
    }))
}

pub async fn archive_category(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, category_id)): Path<(i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_category_archived(
        &state,
        &principal,
        book_id,
        category_id,
        query.version,
        true,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_category(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, category_id)): Path<(i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_category_archived(
        &state,
        &principal,
        book_id,
        category_id,
        query.version,
        false,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_category_archived(
    state: &AppState,
    principal: &Principal,
    book_id: i64,
    category_id: i64,
    version: i64,
    archived: bool,
) -> Result<(), ApiError> {
    require_book(&state.pool, principal, book_id, true).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, (String, i64, i64, Option<OffsetDateTime>)>(
        "SELECT name, ledger_account_id, version, archived_at FROM categories WHERE book_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(book_id)
    .bind(category_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("分类不存在"))?;
    require_archive_version(current.2, version, current.3, archived, "分类")?;
    if archived {
        let has_children = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM categories WHERE book_id = $1 AND parent_id = $2 AND archived_at IS NULL)",
        )
        .bind(book_id)
        .bind(category_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::database)?;
        if has_children {
            return Err(ApiError::conflict(
                "category_has_children",
                "请先归档该分类下的子分类",
            ));
        }
    }

    let archived_at = archived.then(OffsetDateTime::now_utc);
    sqlx::query(
        "UPDATE ledger_accounts SET archived_at = $3, version = version + 1, updated_at = now() WHERE book_id = $1 AND id = $2",
    )
    .bind(book_id)
    .bind(current.1)
    .bind(archived_at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query(
        "UPDATE categories SET archived_at = $3, version = version + 1, updated_at = now() WHERE book_id = $1 AND id = $2",
    )
    .bind(book_id)
    .bind(category_id)
    .bind(archived_at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change_for_book(
        &mut tx,
        principal,
        book_id,
        if archived {
            "category.archived"
        } else {
            "category.restored"
        },
        "category",
        category_id,
        serde_json::json!({ "name": current.0, "archived": !archived, "version": current.2 }),
        serde_json::json!({ "name": current.0, "archived": archived, "version": version + 1 }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(())
}

pub async fn create_counterparty(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Json(request): Json<CreateCounterparty>,
) -> Result<(StatusCode, Json<CounterpartyResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let name = normalize_name(&request.name, "交易方名称")?;
    let notes = request
        .notes
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO counterparties (book_id, name, kind, notes) VALUES ($1, $2, $3, $4) RETURNING id",
    )
    .bind(book_id)
    .bind(&name)
    .bind(request.kind.as_str())
    .bind(&notes)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_for_book(
        &mut tx,
        &principal,
        book_id,
        "counterparty.created",
        "counterparty",
        id,
        json_name(&name),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;

    Ok((
        StatusCode::CREATED,
        Json(CounterpartyResponse {
            id,
            name,
            kind: request.kind.as_str().to_owned(),
            review_status: "confirmed".to_owned(),
            notes,
            version: 1,
            archived_at: None,
        }),
    ))
}

pub async fn list_counterparties(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<Vec<CounterpartyResponse>>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let rows = sqlx::query_as::<_, CounterpartyResponse>(
        r#"
        SELECT id, name, kind, review_status, notes, version, archived_at
        FROM counterparties
        WHERE book_id = $1
          AND (($2 = FALSE AND archived_at IS NULL) OR ($2 = TRUE AND archived_at IS NOT NULL))
        ORDER BY name
        "#,
    )
    .bind(book_id)
    .bind(query.archived)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

pub async fn update_counterparty(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, counterparty_id)): Path<(i64, i64)>,
    Json(request): Json<UpdateCounterparty>,
) -> Result<Json<CounterpartyResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let name = normalize_name(&request.name, "交易方名称")?;
    let notes = normalize_notes(request.notes);
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<
        _,
        (
            String,
            String,
            String,
            Option<String>,
            i64,
            Option<OffsetDateTime>,
        ),
    >(
        r#"
        SELECT name, kind, review_status, notes, version, archived_at
        FROM counterparties
        WHERE book_id = $1 AND id = $2
        FOR UPDATE
        "#,
    )
    .bind(book_id)
    .bind(counterparty_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("交易方不存在"))?;
    require_active_version(current.4, request.version, current.5, "交易方")?;
    sqlx::query(
        r#"
        UPDATE counterparties
        SET name = $3, kind = $4, review_status = $5, notes = $6,
            version = version + 1, updated_at = now()
        WHERE book_id = $1 AND id = $2
        "#,
    )
    .bind(book_id)
    .bind(counterparty_id)
    .bind(&name)
    .bind(request.kind.as_str())
    .bind(request.review_status.as_str())
    .bind(&notes)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change_for_book(
        &mut tx,
        &principal,
        book_id,
        "counterparty.updated",
        "counterparty",
        counterparty_id,
        serde_json::json!({
            "name": current.0,
            "kind": current.1,
            "review_status": current.2,
            "notes": current.3,
            "version": current.4
        }),
        serde_json::json!({
            "name": name,
            "kind": request.kind.as_str(),
            "review_status": request.review_status.as_str(),
            "notes": notes,
            "version": request.version + 1
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(Json(CounterpartyResponse {
        id: counterparty_id,
        name,
        kind: request.kind.as_str().to_owned(),
        review_status: request.review_status.as_str().to_owned(),
        notes,
        version: request.version + 1,
        archived_at: None,
    }))
}

pub async fn archive_counterparty(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, counterparty_id)): Path<(i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_counterparty_archived(
        &state,
        &principal,
        book_id,
        counterparty_id,
        query.version,
        true,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_counterparty(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, counterparty_id)): Path<(i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_counterparty_archived(
        &state,
        &principal,
        book_id,
        counterparty_id,
        query.version,
        false,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_counterparty_archived(
    state: &AppState,
    principal: &Principal,
    book_id: i64,
    counterparty_id: i64,
    version: i64,
    archived: bool,
) -> Result<(), ApiError> {
    require_book(&state.pool, principal, book_id, true).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, (String, i64, Option<OffsetDateTime>)>(
        "SELECT name, version, archived_at FROM counterparties WHERE book_id = $1 AND id = $2 FOR UPDATE",
    )
    .bind(book_id)
    .bind(counterparty_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("交易方不存在"))?;
    require_archive_version(current.1, version, current.2, archived, "交易方")?;
    let archived_at = archived.then(OffsetDateTime::now_utc);
    sqlx::query(
        "UPDATE counterparties SET archived_at = $3, version = version + 1, updated_at = now() WHERE book_id = $1 AND id = $2",
    )
    .bind(book_id)
    .bind(counterparty_id)
    .bind(archived_at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change_for_book(
        &mut tx,
        principal,
        book_id,
        if archived {
            "counterparty.archived"
        } else {
            "counterparty.restored"
        },
        "counterparty",
        counterparty_id,
        serde_json::json!({ "name": current.0, "archived": !archived, "version": current.1 }),
        serde_json::json!({ "name": current.0, "archived": archived, "version": version + 1 }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(())
}

pub async fn create_transaction(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Json(request): Json<CreateTransaction>,
) -> Result<(StatusCode, Json<TransactionResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let prepared = prepare_transaction(&state.pool, book_id, request).await?;
    let journal_id = post_journal(&state.pool, &prepared.into_journal(book_id, &principal))
        .await
        .map_err(map_ledger_error)?;
    let response = get_transaction(&state.pool, book_id, journal_id).await?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub(crate) async fn prepare_transaction(
    pool: &PgPool,
    book_id: i64,
    request: CreateTransaction,
) -> Result<PreparedTransaction, ApiError> {
    let (description, occurred_at, counterparty_id, postings, tag_ids) = match request {
        CreateTransaction::Withdrawal {
            occurred_at,
            description,
            counterparty_id,
            account_id,
            amount,
            book_amount,
            splits,
            tag_ids,
        } => {
            validate_positive(amount, "amount")?;
            validate_positive(book_amount, "book_amount")?;
            validate_split_totals(&splits, amount, book_amount)?;
            let mut postings = vec![PostingInput {
                account_id,
                budget_id: None,
                amount: -amount,
                book_amount: -book_amount,
                memo: None,
            }];
            postings.extend(
                category_postings(pool, book_id, CategoryKind::Expense, splits, false).await?,
            );
            (description, occurred_at, counterparty_id, postings, tag_ids)
        }
        CreateTransaction::Deposit {
            occurred_at,
            description,
            counterparty_id,
            account_id,
            amount,
            book_amount,
            splits,
            tag_ids,
        } => {
            validate_positive(amount, "amount")?;
            validate_positive(book_amount, "book_amount")?;
            validate_split_totals(&splits, amount, book_amount)?;
            let mut postings = vec![PostingInput {
                account_id,
                budget_id: None,
                amount,
                book_amount,
                memo: None,
            }];
            postings.extend(
                category_postings(pool, book_id, CategoryKind::Income, splits, true).await?,
            );
            (description, occurred_at, counterparty_id, postings, tag_ids)
        }
        CreateTransaction::Transfer {
            occurred_at,
            description,
            counterparty_id,
            source_account_id,
            source_amount,
            source_book_amount,
            destination_account_id,
            destination_amount,
            destination_book_amount,
            tag_ids,
        } => {
            for (field, value) in [
                ("source_amount", source_amount),
                ("source_book_amount", source_book_amount),
                ("destination_amount", destination_amount),
                ("destination_book_amount", destination_book_amount),
            ] {
                validate_positive(value, field)?;
            }
            if source_account_id == destination_account_id {
                return Err(ApiError::bad_request(
                    "same_transfer_account",
                    "转账来源账户和目标账户不能相同",
                ));
            }
            if source_book_amount != destination_book_amount {
                return Err(ApiError::bad_request(
                    "transfer_not_balanced",
                    "转账两端的本位币金额必须相等",
                ));
            }
            (
                description,
                occurred_at,
                counterparty_id,
                vec![
                    PostingInput {
                        account_id: source_account_id,
                        budget_id: None,
                        amount: -source_amount,
                        book_amount: -source_book_amount,
                        memo: None,
                    },
                    PostingInput {
                        account_id: destination_account_id,
                        budget_id: None,
                        amount: destination_amount,
                        book_amount: destination_book_amount,
                        memo: None,
                    },
                ],
                tag_ids,
            )
        }
    };
    let description = normalize_name(&description, "交易描述")?;
    validate_transaction_tags(pool, book_id, &tag_ids).await?;
    Ok(PreparedTransaction {
        description,
        occurred_at,
        counterparty_id,
        postings,
        tag_ids,
    })
}

impl PreparedTransaction {
    pub(crate) fn into_journal(self, book_id: i64, principal: &Principal) -> PostJournal {
        PostJournal {
            book_id,
            description: self.description,
            occurred_at: self.occurred_at,
            counterparty_id: self.counterparty_id,
            created_by_user_id: principal.user_id,
            audit_actor_kind: actor_kind(principal),
            postings: self.postings,
            tag_ids: self.tag_ids,
        }
    }
}

pub async fn list_transactions(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<PageQuery>,
) -> Result<Json<TransactionPage>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let limit = i64::from(query.limit.unwrap_or(50).clamp(1, 200));
    let start = parse_query_date(query.start.as_deref(), "start")?;
    let end = parse_query_date(query.end.as_deref(), "end")?;
    if start.zip(end).is_some_and(|(start, end)| start > end) {
        return Err(ApiError::bad_request(
            "date_range_invalid",
            "start 不能晚于 end",
        ));
    }
    let transaction_type = match query.transaction_type.as_deref() {
        None | Some("all") => None,
        Some(value @ ("withdrawal" | "deposit" | "transfer")) => Some(value),
        Some(_) => {
            return Err(ApiError::bad_request(
                "transaction_type_invalid",
                "type 只支持 withdrawal、deposit 或 transfer",
            ));
        }
    };
    let search = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let journals = sqlx::query_as::<_, JournalRow>(
        r#"
        SELECT j.id, j.status, j.occurred_at, j.description, j.counterparty_id,
               c.name AS counterparty_name, j.reversal_of_id,
               reversal.id AS reversed_by_id, j.cloned_from_id,
               replacement_source.original_journal_id AS replaces_id,
               replacement_target.replacement_journal_id AS replaced_by_id,
               j.version
        FROM journal_entries j
        LEFT JOIN counterparties c ON c.id = j.counterparty_id
        LEFT JOIN journal_entries reversal ON reversal.reversal_of_id = j.id
        LEFT JOIN transaction_replacements replacement_source
          ON replacement_source.book_id = j.book_id
         AND replacement_source.replacement_journal_id = j.id
        LEFT JOIN transaction_replacements replacement_target
          ON replacement_target.book_id = j.book_id
         AND replacement_target.original_journal_id = j.id
        JOIN books b ON b.id = j.book_id
        WHERE j.book_id = $1 AND j.status IN ('posted', 'reversed')
          AND ($2::bigint IS NULL OR j.id < $2)
          AND ($3::date IS NULL OR (j.occurred_at AT TIME ZONE b.timezone)::date >= $3)
          AND ($4::date IS NULL OR (j.occurred_at AT TIME ZONE b.timezone)::date <= $4)
          AND (
            $5::text IS NULL
            OR ($5 = 'withdrawal' AND EXISTS (
                SELECT 1 FROM postings fp JOIN ledger_accounts fa ON fa.id = fp.account_id
                WHERE fp.journal_entry_id = j.id AND fa.class = 'expense'
            ))
            OR ($5 = 'deposit' AND EXISTS (
                SELECT 1 FROM postings fp JOIN ledger_accounts fa ON fa.id = fp.account_id
                WHERE fp.journal_entry_id = j.id AND fa.class = 'income'
            ))
            OR ($5 = 'transfer' AND NOT EXISTS (
                SELECT 1 FROM postings fp JOIN ledger_accounts fa ON fa.id = fp.account_id
                WHERE fp.journal_entry_id = j.id AND fa.class IN ('expense', 'income')
            ))
          )
          AND ($6::bigint IS NULL OR EXISTS (
              SELECT 1 FROM postings fp
              WHERE fp.journal_entry_id = j.id AND fp.account_id = $6
          ))
          AND (
            $7::text IS NULL OR j.description ILIKE '%' || $7 || '%'
            OR c.name ILIKE '%' || $7 || '%'
            OR EXISTS (
                SELECT 1 FROM postings fp JOIN ledger_accounts fa ON fa.id = fp.account_id
                WHERE fp.journal_entry_id = j.id AND fa.name ILIKE '%' || $7 || '%'
            )
          )
        ORDER BY j.id DESC
        LIMIT $8
        "#,
    )
    .bind(book_id)
    .bind(query.before_id)
    .bind(start)
    .bind(end)
    .bind(transaction_type)
    .bind(query.account_id)
    .bind(search)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    let next_before_id = (journals.len() == limit as usize)
        .then(|| journals.last().map(|journal| journal.id))
        .flatten();
    let data = hydrate_transactions(&state.pool, journals).await?;
    Ok(Json(TransactionPage {
        data,
        next_before_id,
    }))
}

fn parse_query_date(value: Option<&str>, field: &'static str) -> Result<Option<Date>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let format = time::format_description::parse_borrowed::<3>("[year]-[month]-[day]")
        .map_err(ApiError::internal)?;
    Date::parse(value, &format)
        .map(Some)
        .map_err(|_| ApiError::bad_request("date_invalid", format!("{field} 必须是 YYYY-MM-DD")))
}

pub async fn reverse_transaction(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, transaction_id)): Path<(i64, i64)>,
    Json(request): Json<ReverseTransaction>,
) -> Result<(StatusCode, Json<TransactionResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let reversal_id = reverse_journal(
        &state.pool,
        &reversal_command(book_id, transaction_id, &principal, request),
    )
    .await
    .map_err(map_ledger_error)?;
    let response = get_transaction(&state.pool, book_id, reversal_id).await?;
    Ok((StatusCode::CREATED, Json(response)))
}

pub async fn show_transaction(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, transaction_id)): Path<(i64, i64)>,
) -> Result<Json<TransactionResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    Ok(Json(
        get_transaction(&state.pool, book_id, transaction_id).await?,
    ))
}

pub async fn trash_transaction(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, transaction_id)): Path<(i64, i64)>,
    Json(request): Json<ReverseTransaction>,
) -> Result<(StatusCode, Json<TransactionResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let reversal_id = trash_journal(
        &state.pool,
        &reversal_command(book_id, transaction_id, &principal, request),
    )
    .await
    .map_err(map_ledger_error)?;
    Ok((
        StatusCode::CREATED,
        Json(get_transaction(&state.pool, book_id, reversal_id).await?),
    ))
}

pub async fn restore_transaction(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, transaction_id)): Path<(i64, i64)>,
    Json(request): Json<ReverseTransaction>,
) -> Result<(StatusCode, Json<TransactionResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let restored_id = restore_trashed_journal(
        &state.pool,
        &reversal_command(book_id, transaction_id, &principal, request),
    )
    .await
    .map_err(map_ledger_error)?;
    Ok((
        StatusCode::CREATED,
        Json(get_transaction(&state.pool, book_id, restored_id).await?),
    ))
}

pub async fn list_transaction_recycle_bin(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<RecycleQuery>,
) -> Result<Json<Vec<RecycleBinTransaction>>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let rows = sqlx::query_as::<_, RecycleBinTransaction>(
        r#"
        SELECT r.original_journal_id, r.reversal_journal_id, j.description, j.occurred_at,
               r.delete_reason, r.deleted_at, r.restored_journal_id,
               r.restore_reason, r.restored_at
        FROM transaction_recycle_bin r
        JOIN journal_entries j
          ON j.book_id = r.book_id AND j.id = r.original_journal_id
        WHERE r.book_id = $1
          AND (($2 = FALSE AND r.restored_at IS NULL) OR ($2 = TRUE AND r.restored_at IS NOT NULL))
        ORDER BY r.deleted_at DESC, r.original_journal_id DESC
        "#,
    )
    .bind(book_id)
    .bind(query.restored)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

fn reversal_command(
    book_id: i64,
    transaction_id: i64,
    principal: &Principal,
    request: ReverseTransaction,
) -> ReverseJournal {
    ReverseJournal {
        book_id,
        journal_id: transaction_id,
        occurred_at: request.occurred_at.unwrap_or_else(OffsetDateTime::now_utc),
        reason: request.reason,
        actor_user_id: principal.user_id,
        audit_actor_kind: actor_kind(principal),
    }
}

pub(crate) async fn get_transaction(
    pool: &PgPool,
    book_id: i64,
    journal_id: i64,
) -> Result<TransactionResponse, ApiError> {
    let journal = sqlx::query_as::<_, JournalRow>(
        r#"
        SELECT j.id, j.status, j.occurred_at, j.description, j.counterparty_id,
               c.name AS counterparty_name, j.reversal_of_id,
               reversal.id AS reversed_by_id, j.cloned_from_id,
               replacement_source.original_journal_id AS replaces_id,
               replacement_target.replacement_journal_id AS replaced_by_id,
               j.version
        FROM journal_entries j
        LEFT JOIN counterparties c ON c.id = j.counterparty_id
        LEFT JOIN journal_entries reversal ON reversal.reversal_of_id = j.id
        LEFT JOIN transaction_replacements replacement_source
          ON replacement_source.book_id = j.book_id
         AND replacement_source.replacement_journal_id = j.id
        LEFT JOIN transaction_replacements replacement_target
          ON replacement_target.book_id = j.book_id
         AND replacement_target.original_journal_id = j.id
        WHERE j.book_id = $1 AND j.id = $2
        "#,
    )
    .bind(book_id)
    .bind(journal_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("交易不存在"))?;
    hydrate_transactions(pool, vec![journal])
        .await?
        .pop()
        .ok_or_else(|| ApiError::not_found("交易不存在"))
}

async fn hydrate_transactions(
    pool: &PgPool,
    journals: Vec<JournalRow>,
) -> Result<Vec<TransactionResponse>, ApiError> {
    if journals.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<i64> = journals.iter().map(|journal| journal.id).collect();
    let mut postings_by_journal: HashMap<i64, Vec<PostingResponse>> = HashMap::new();
    let rows = sqlx::query_as::<_, PostingRow>(
        r#"
        SELECT p.journal_entry_id, p.id, p.line_no, p.account_id, a.name AS account_name,
               a.class AS account_class, a.currency_code, c.id AS category_id,
               c.name AS category_name, p.budget_id,
               bu.name AS budget_name, p.amount, p.book_amount, p.memo, p.cleared_at
        FROM postings p
        JOIN ledger_accounts a ON a.id = p.account_id
        LEFT JOIN categories c
          ON c.book_id = p.book_id AND c.ledger_account_id = p.account_id
        LEFT JOIN budgets bu ON bu.book_id = p.book_id AND bu.id = p.budget_id
        WHERE p.journal_entry_id = ANY($1)
        ORDER BY p.journal_entry_id, p.line_no
        "#,
    )
    .bind(&ids)
    .fetch_all(pool)
    .await
    .map_err(ApiError::database)?;
    for row in rows {
        postings_by_journal
            .entry(row.journal_entry_id)
            .or_default()
            .push(row.into());
    }
    let mut tags_by_journal: HashMap<i64, Vec<TransactionTagResponse>> = HashMap::new();
    let tag_rows = sqlx::query_as::<_, TransactionTagRow>(
        r#"
        SELECT jet.journal_entry_id, t.id, t.name, t.color,
               (t.archived_at IS NOT NULL) AS archived
        FROM journal_entry_tags jet
        JOIN tags t ON t.book_id = jet.book_id AND t.id = jet.tag_id
        WHERE jet.journal_entry_id = ANY($1)
        ORDER BY jet.journal_entry_id, lower(t.name), t.id
        "#,
    )
    .bind(&ids)
    .fetch_all(pool)
    .await
    .map_err(ApiError::database)?;
    for row in tag_rows {
        tags_by_journal
            .entry(row.journal_entry_id)
            .or_default()
            .push(TransactionTagResponse {
                id: row.id,
                name: row.name,
                color: row.color,
                archived: row.archived,
            });
    }

    Ok(journals
        .into_iter()
        .map(|journal| {
            let postings = postings_by_journal.remove(&journal.id).unwrap_or_default();
            let transaction_type = transaction_type(&postings).to_owned();
            TransactionResponse {
                id: journal.id,
                status: journal.status,
                transaction_type,
                occurred_at: journal.occurred_at,
                description: journal.description,
                counterparty_id: journal.counterparty_id,
                counterparty_name: journal.counterparty_name,
                reversal_of_id: journal.reversal_of_id,
                reversed_by_id: journal.reversed_by_id,
                cloned_from_id: journal.cloned_from_id,
                replaces_id: journal.replaces_id,
                replaced_by_id: journal.replaced_by_id,
                version: journal.version,
                postings,
                tags: tags_by_journal.remove(&journal.id).unwrap_or_default(),
            }
        })
        .collect())
}

fn transaction_type(postings: &[PostingResponse]) -> &'static str {
    if postings
        .iter()
        .any(|posting| posting.account_class == "expense")
    {
        "withdrawal"
    } else if postings
        .iter()
        .any(|posting| posting.account_class == "income")
    {
        "deposit"
    } else {
        "transfer"
    }
}

#[derive(FromRow)]
struct PostingRow {
    journal_entry_id: i64,
    id: i64,
    line_no: i32,
    account_id: i64,
    account_name: String,
    account_class: String,
    currency_code: String,
    category_id: Option<i64>,
    category_name: Option<String>,
    budget_id: Option<i64>,
    budget_name: Option<String>,
    amount: Decimal,
    book_amount: Decimal,
    memo: Option<String>,
    cleared_at: Option<OffsetDateTime>,
}

#[derive(FromRow)]
struct TransactionTagRow {
    journal_entry_id: i64,
    id: i64,
    name: String,
    color: Option<String>,
    archived: bool,
}

impl From<PostingRow> for PostingResponse {
    fn from(row: PostingRow) -> Self {
        Self {
            id: row.id,
            line_no: row.line_no,
            account_id: row.account_id,
            account_name: row.account_name,
            account_class: row.account_class,
            currency_code: row.currency_code,
            category_id: row.category_id,
            category_name: row.category_name,
            budget_id: row.budget_id,
            budget_name: row.budget_name,
            amount: row.amount,
            book_amount: row.book_amount,
            memo: row.memo,
            cleared_at: row.cleared_at,
        }
    }
}

async fn category_postings(
    pool: &PgPool,
    book_id: i64,
    kind: CategoryKind,
    splits: Vec<CategorySplit>,
    negate: bool,
) -> Result<Vec<PostingInput>, ApiError> {
    let mut postings = Vec::with_capacity(splits.len());
    for split in splits {
        let account_id = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT category.ledger_account_id
            FROM categories category
            WHERE category.book_id = $1
              AND category.id = $2
              AND category.kind = $3
              AND category.archived_at IS NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM categories child
                  WHERE child.book_id = category.book_id
                    AND child.parent_id = category.id
                    AND child.archived_at IS NULL
              )
            "#,
        )
        .bind(book_id)
        .bind(split.category_id)
        .bind(kind.as_str())
        .fetch_optional(pool)
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| {
            ApiError::bad_request("category_invalid", "分类不存在、类型不匹配或不是末级分类")
        })?;
        if split.budget_id.is_some() && matches!(kind, CategoryKind::Income) {
            return Err(ApiError::bad_request(
                "budget_income_invalid",
                "预算只能关联支出分类拆分",
            ));
        }
        if let Some(budget_id) = split.budget_id {
            let budget_exists = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (SELECT 1 FROM budgets WHERE book_id = $1 AND id = $2 AND archived_at IS NULL)",
            )
            .bind(book_id)
            .bind(budget_id)
            .fetch_one(pool)
            .await
            .map_err(ApiError::database)?;
            if !budget_exists {
                return Err(ApiError::bad_request(
                    "budget_invalid",
                    "预算不存在或已归档",
                ));
            }
        }
        let sign = if negate { -Decimal::ONE } else { Decimal::ONE };
        postings.push(PostingInput {
            account_id,
            budget_id: split.budget_id,
            amount: sign * split.book_amount,
            book_amount: sign * split.book_amount,
            memo: split.memo,
        });
    }
    Ok(postings)
}

async fn validate_transaction_tags(
    pool: &PgPool,
    book_id: i64,
    tag_ids: &[i64],
) -> Result<(), ApiError> {
    let unique = tag_ids.iter().copied().collect::<BTreeSet<_>>();
    if unique.len() != tag_ids.len() {
        return Err(ApiError::bad_request(
            "duplicate_tag",
            "一笔交易不能重复关联同一个标签",
        ));
    }
    if tag_ids.is_empty() {
        return Ok(());
    }
    let active_count = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM tags WHERE book_id = $1 AND id = ANY($2) AND archived_at IS NULL",
    )
    .bind(book_id)
    .bind(tag_ids)
    .fetch_one(pool)
    .await
    .map_err(ApiError::database)?;
    if active_count != tag_ids.len() as i64 {
        return Err(ApiError::bad_request("tag_invalid", "标签不存在或已归档"));
    }
    Ok(())
}

fn validate_split_totals(
    splits: &[CategorySplit],
    amount: Decimal,
    book_amount: Decimal,
) -> Result<(), ApiError> {
    if splits.is_empty() {
        return Err(ApiError::bad_request(
            "splits_required",
            "交易至少需要一个分类拆分",
        ));
    }
    let mut amount_total = Decimal::ZERO;
    let mut book_total = Decimal::ZERO;
    for split in splits {
        validate_positive(split.amount, "split.amount")?;
        validate_positive(split.book_amount, "split.book_amount")?;
        amount_total += split.amount;
        book_total += split.book_amount;
    }
    if amount_total != amount || book_total != book_amount {
        return Err(ApiError::bad_request(
            "split_total_mismatch",
            "拆分金额合计必须等于交易金额",
        ));
    }
    Ok(())
}

fn validate_positive(value: Decimal, field: &'static str) -> Result<(), ApiError> {
    if value <= Decimal::ZERO {
        return Err(ApiError::bad_request(
            "amount_invalid",
            format!("{field} 必须大于 0"),
        ));
    }
    Ok(())
}

fn validate_account_role(class: &AccountClass, role: &AccountRole) -> Result<(), ApiError> {
    let valid = matches!(
        (class, role),
        (
            AccountClass::Asset,
            AccountRole::Bank | AccountRole::Cash | AccountRole::Other
        ) | (
            AccountClass::Liability,
            AccountRole::Card | AccountRole::Loan | AccountRole::Other
        )
    );
    if !valid {
        return Err(ApiError::bad_request(
            "account_role_invalid",
            "账户类型与角色不匹配",
        ));
    }
    Ok(())
}

async fn require_organization_admin(
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

async fn require_organization_admin_including_archived(
    pool: &PgPool,
    principal: &Principal,
    organization_id: i64,
) -> Result<String, ApiError> {
    require_scope(principal, "organizations:manage")?;
    let role = sqlx::query_scalar::<_, String>(
        "SELECT role FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
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

pub(crate) async fn require_book(
    pool: &PgPool,
    principal: &Principal,
    book_id: i64,
    write: bool,
) -> Result<String, ApiError> {
    if write {
        require_scope(principal, "books:write")?;
    } else if !principal.has_scope("books:read") && !principal.has_scope("books:write") {
        return Err(ApiError::forbidden(
            "scope_required",
            "PAT 缺少 books:read 权限范围",
        ));
    }
    let role = sqlx::query_scalar::<_, String>(
        r#"
        SELECT m.role
        FROM book_memberships m
        JOIN books b ON b.id = m.book_id
        JOIN organizations o ON o.id = b.organization_id
        WHERE m.book_id = $1 AND m.user_id = $2
          AND b.archived_at IS NULL AND o.archived_at IS NULL
        "#,
    )
    .bind(book_id)
    .bind(principal.user_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("账本不存在"))?;
    if write && role == "viewer" {
        return Err(ApiError::forbidden(
            "book_write_required",
            "当前账本只有查看权限",
        ));
    }
    Ok(role)
}

async fn require_book_manager(
    pool: &PgPool,
    principal: &Principal,
    book_id: i64,
    include_archived: bool,
) -> Result<(i64, String), ApiError> {
    let can_manage_organization = principal.has_scope("organizations:manage");
    let can_write_book = principal.has_scope("books:write");
    if !can_manage_organization && !can_write_book {
        return Err(ApiError::forbidden(
            "scope_required",
            "PAT 缺少 organizations:manage 或 books:write 权限范围",
        ));
    }
    let row = sqlx::query_as::<_, (i64, Option<String>, Option<String>)>(
        r#"
        SELECT b.organization_id, om.role, bm.role
        FROM books b
        JOIN organizations o ON o.id = b.organization_id AND o.archived_at IS NULL
        LEFT JOIN organization_memberships om
          ON om.organization_id = b.organization_id AND om.user_id = $2
        LEFT JOIN book_memberships bm ON bm.book_id = b.id AND bm.user_id = $2
        WHERE b.id = $1 AND ($3 OR b.archived_at IS NULL)
        "#,
    )
    .bind(book_id)
    .bind(principal.user_id)
    .bind(include_archived)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("账本不存在"))?;
    let role = if can_manage_organization && matches!(row.1.as_deref(), Some("owner" | "admin")) {
        row.1.unwrap()
    } else if can_write_book && row.2.as_deref() == Some("manager") {
        row.2.unwrap()
    } else {
        return Err(ApiError::forbidden(
            "book_manager_required",
            "需要组织管理员或账本管理者权限",
        ));
    };
    Ok((row.0, role))
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

async fn audit_for_book(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    book_id: i64,
    action: &'static str,
    entity_type: &'static str,
    entity_id: i64,
    after_data: serde_json::Value,
) -> Result<(), ApiError> {
    let organization_id =
        sqlx::query_scalar::<_, i64>("SELECT organization_id FROM books WHERE id = $1")
            .bind(book_id)
            .fetch_one(&mut **tx)
            .await
            .map_err(ApiError::database)?;
    audit(
        tx,
        principal,
        Some(organization_id),
        Some(book_id),
        action,
        entity_type,
        entity_id,
        after_data,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn audit_change(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    organization_id: Option<i64>,
    book_id: Option<i64>,
    action: &'static str,
    entity_type: &'static str,
    entity_id: i64,
    before_data: serde_json::Value,
    after_data: serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, book_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, before_data, after_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
    .bind(entity_type)
    .bind(entity_id)
    .bind(before_data)
    .bind(after_data)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn audit_change_for_book(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    book_id: i64,
    action: &'static str,
    entity_type: &'static str,
    entity_id: i64,
    before_data: serde_json::Value,
    after_data: serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, book_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, before_data, after_data
        )
        SELECT b.organization_id, b.id, $2, $3, $4, $5, $6, $7, $8
        FROM books b
        WHERE b.id = $1
        "#,
    )
    .bind(book_id)
    .bind(match principal.auth_kind {
        AuthKind::Session => "user",
        AuthKind::Pat => "pat",
    })
    .bind(principal.user_id)
    .bind(action)
    .bind(entity_type)
    .bind(entity_id)
    .bind(before_data)
    .bind(after_data)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    organization_id: Option<i64>,
    book_id: Option<i64>,
    action: &'static str,
    entity_type: &'static str,
    entity_id: i64,
    after_data: serde_json::Value,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, book_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, after_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
    .bind(entity_type)
    .bind(entity_id)
    .bind(after_data)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(())
}

pub(crate) fn map_ledger_error(error: LedgerError) -> ApiError {
    match error {
        LedgerError::Database(error) => ApiError::database(error),
        LedgerError::JournalNotFound => ApiError::not_found("交易不存在"),
        LedgerError::AlreadyReversed => {
            ApiError::conflict("journal_already_reversed", "交易已经冲正")
        }
        LedgerError::JournalNotPosted => {
            ApiError::conflict("journal_not_posted", "只有已入账交易可以冲正")
        }
        LedgerError::JournalNotTrashed => ApiError::not_found("交易不在回收站中"),
        LedgerError::AlreadyRestored => {
            ApiError::conflict("journal_already_restored", "交易已经恢复")
        }
        other => ApiError::bad_request("journal_invalid", other.to_string()),
    }
}

pub(crate) fn actor_kind(principal: &Principal) -> AuditActorKind {
    match principal.auth_kind {
        AuthKind::Session => AuditActorKind::User,
        AuthKind::Pat => AuditActorKind::Pat,
    }
}

fn normalize_name(value: &str, field: &'static str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 120 {
        return Err(ApiError::bad_request(
            "name_invalid",
            format!("{field}长度必须为 1 到 120 个字符"),
        ));
    }
    Ok(value.to_owned())
}

fn normalize_currency(value: &str) -> Result<String, ApiError> {
    let value = value.trim().to_uppercase();
    if value.len() != 3 || !value.bytes().all(|value| value.is_ascii_uppercase()) {
        return Err(ApiError::bad_request(
            "currency_invalid",
            "币种必须是三个大写字母",
        ));
    }
    Ok(value)
}

fn normalize_timezone(value: &str) -> Result<String, ApiError> {
    value
        .trim()
        .parse::<chrono_tz::Tz>()
        .map(|timezone| timezone.to_string())
        .map_err(|_| ApiError::bad_request("timezone_invalid", "账本时区必须是有效的 IANA 时区"))
}

fn normalize_notes(value: Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn require_active_version(
    current: i64,
    requested: i64,
    archived_at: Option<OffsetDateTime>,
    entity: &'static str,
) -> Result<(), ApiError> {
    if archived_at.is_some() {
        return Err(ApiError::conflict(
            "resource_archived",
            format!("{entity}已经归档，请先恢复"),
        ));
    }
    require_version(current, requested)
}

fn require_archive_version(
    current: i64,
    requested: i64,
    archived_at: Option<OffsetDateTime>,
    archive: bool,
    entity: &'static str,
) -> Result<(), ApiError> {
    require_version(current, requested)?;
    if archive == archived_at.is_some() {
        return Err(ApiError::conflict(
            "resource_state_conflict",
            format!("{entity}当前状态已经发生变化"),
        ));
    }
    Ok(())
}

fn require_version(current: i64, requested: i64) -> Result<(), ApiError> {
    if current != requested {
        return Err(ApiError::conflict(
            "version_conflict",
            "数据已被其他操作修改，请刷新后重试",
        ));
    }
    Ok(())
}

fn default_currency() -> String {
    "CNY".to_owned()
}

fn default_timezone() -> String {
    "Asia/Shanghai".to_owned()
}

fn json_name(value: &str) -> serde_json::Value {
    serde_json::json!({ "name": value })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_totals_must_match_both_original_and_book_amounts() {
        let splits = vec![
            CategorySplit {
                category_id: 1,
                budget_id: None,
                amount: Decimal::from(40),
                book_amount: Decimal::from(280),
                memo: None,
            },
            CategorySplit {
                category_id: 2,
                budget_id: None,
                amount: Decimal::from(60),
                book_amount: Decimal::from(420),
                memo: None,
            },
        ];
        assert!(validate_split_totals(&splits, Decimal::from(100), Decimal::from(700)).is_ok());
        assert!(validate_split_totals(&splits, Decimal::from(99), Decimal::from(700)).is_err());
    }
}
