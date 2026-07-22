use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};
use time::{Date, Month, OffsetDateTime};

use crate::{
    api::require_book,
    auth::{ApiError, AuthKind, Principal},
    http::AppState,
};

#[derive(Deserialize)]
pub struct ArchiveQuery {
    #[serde(default)]
    archived: bool,
}

#[derive(Deserialize)]
pub struct VersionQuery {
    version: i64,
}

#[derive(Deserialize)]
pub struct CreateNamedResource {
    name: String,
    color: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateNamedResource {
    name: String,
    color: Option<String>,
    version: i64,
}

#[derive(Clone, Serialize, FromRow)]
pub struct TagResponse {
    id: i64,
    name: String,
    color: Option<String>,
    version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    archived_at: Option<OffsetDateTime>,
}

#[derive(Clone, Serialize, FromRow)]
pub struct BudgetResponse {
    id: i64,
    name: String,
    color: Option<String>,
    version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    archived_at: Option<OffsetDateTime>,
}

#[derive(Deserialize)]
pub struct CreateBudgetLimit {
    month: String,
    #[serde(with = "rust_decimal::serde::str")]
    amount: Decimal,
}

#[derive(Deserialize)]
pub struct UpdateBudgetLimit {
    month: String,
    #[serde(with = "rust_decimal::serde::str")]
    amount: Decimal,
    version: i64,
}

#[derive(FromRow)]
struct BudgetLimitRow {
    id: i64,
    budget_id: i64,
    month: Date,
    amount: Decimal,
    version: i64,
    archived_at: Option<OffsetDateTime>,
}

#[derive(Serialize)]
pub struct BudgetLimitResponse {
    id: i64,
    budget_id: i64,
    month: String,
    #[serde(with = "rust_decimal::serde::str")]
    amount: Decimal,
    version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    archived_at: Option<OffsetDateTime>,
}

impl From<BudgetLimitRow> for BudgetLimitResponse {
    fn from(row: BudgetLimitRow) -> Self {
        Self {
            id: row.id,
            budget_id: row.budget_id,
            month: format_month(row.month),
            amount: row.amount.normalize(),
            version: row.version,
            archived_at: row.archived_at,
        }
    }
}

#[derive(Deserialize)]
pub struct BudgetReportQuery {
    month: String,
}

#[derive(FromRow)]
struct BudgetReportRow {
    budget_id: i64,
    name: String,
    color: Option<String>,
    limit_amount: Option<Decimal>,
    actual_amount: Decimal,
}

#[derive(Serialize)]
pub struct BudgetReportItem {
    budget_id: i64,
    name: String,
    color: Option<String>,
    #[serde(with = "rust_decimal::serde::str_option")]
    limit_amount: Option<Decimal>,
    #[serde(with = "rust_decimal::serde::str")]
    actual_amount: Decimal,
    #[serde(with = "rust_decimal::serde::str_option")]
    remaining_amount: Option<Decimal>,
    exceeded: bool,
}

#[derive(Serialize)]
pub struct BudgetReportResponse {
    month: String,
    timezone: String,
    currency_code: String,
    items: Vec<BudgetReportItem>,
}

pub async fn create_tag(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Json(request): Json<CreateNamedResource>,
) -> Result<(StatusCode, Json<TagResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let name = normalize_name(&request.name, "标签名称")?;
    let color = normalize_color(request.color)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO tags (book_id, name, color) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(book_id)
    .bind(&name)
    .bind(&color)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_named(
        &mut tx,
        &principal,
        book_id,
        "tag.created",
        "tag",
        id,
        serde_json::json!({ "name": name, "color": color, "version": 1 }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(TagResponse {
            id,
            name,
            color,
            version: 1,
            archived_at: None,
        }),
    ))
}

pub async fn list_tags(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<Vec<TagResponse>>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let rows = sqlx::query_as::<_, TagResponse>(
        r#"
        SELECT id, name, color, version, archived_at
        FROM tags
        WHERE book_id = $1 AND ($2 = (archived_at IS NOT NULL))
        ORDER BY lower(name), id
        "#,
    )
    .bind(book_id)
    .bind(query.archived)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

pub async fn update_tag(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, tag_id)): Path<(i64, i64)>,
    Json(request): Json<UpdateNamedResource>,
) -> Result<Json<TagResponse>, ApiError> {
    let (name, color, version) =
        update_named_resource(&state, &principal, book_id, tag_id, request, NamedKind::Tag).await?;
    Ok(Json(TagResponse {
        id: tag_id,
        name,
        color,
        version,
        archived_at: None,
    }))
}

pub async fn archive_tag(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, tag_id)): Path<(i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_named_archived(
        &state,
        &principal,
        book_id,
        tag_id,
        query.version,
        true,
        NamedKind::Tag,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_tag(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, tag_id)): Path<(i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_named_archived(
        &state,
        &principal,
        book_id,
        tag_id,
        query.version,
        false,
        NamedKind::Tag,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_budget(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Json(request): Json<CreateNamedResource>,
) -> Result<(StatusCode, Json<BudgetResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let name = normalize_name(&request.name, "预算名称")?;
    let color = normalize_color(request.color)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO budgets (book_id, name, color) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(book_id)
    .bind(&name)
    .bind(&color)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_named(
        &mut tx,
        &principal,
        book_id,
        "budget.created",
        "budget",
        id,
        serde_json::json!({ "name": name, "color": color, "version": 1 }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(BudgetResponse {
            id,
            name,
            color,
            version: 1,
            archived_at: None,
        }),
    ))
}

pub async fn list_budgets(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<Vec<BudgetResponse>>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let rows = sqlx::query_as::<_, BudgetResponse>(
        r#"
        SELECT id, name, color, version, archived_at
        FROM budgets
        WHERE book_id = $1 AND ($2 = (archived_at IS NOT NULL))
        ORDER BY lower(name), id
        "#,
    )
    .bind(book_id)
    .bind(query.archived)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

pub async fn update_budget(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, budget_id)): Path<(i64, i64)>,
    Json(request): Json<UpdateNamedResource>,
) -> Result<Json<BudgetResponse>, ApiError> {
    let (name, color, version) = update_named_resource(
        &state,
        &principal,
        book_id,
        budget_id,
        request,
        NamedKind::Budget,
    )
    .await?;
    Ok(Json(BudgetResponse {
        id: budget_id,
        name,
        color,
        version,
        archived_at: None,
    }))
}

pub async fn archive_budget(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, budget_id)): Path<(i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_named_archived(
        &state,
        &principal,
        book_id,
        budget_id,
        query.version,
        true,
        NamedKind::Budget,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_budget(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, budget_id)): Path<(i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_named_archived(
        &state,
        &principal,
        book_id,
        budget_id,
        query.version,
        false,
        NamedKind::Budget,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn create_budget_limit(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, budget_id)): Path<(i64, i64)>,
    Json(request): Json<CreateBudgetLimit>,
) -> Result<(StatusCode, Json<BudgetLimitResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let month = parse_month(&request.month)?;
    validate_amount(request.amount)?;
    ensure_active_budget(&state, book_id, budget_id).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO budget_month_limits (book_id, budget_id, month, amount)
        VALUES ($1, $2, $3, $4) RETURNING id
        "#,
    )
    .bind(book_id)
    .bind(budget_id)
    .bind(month)
    .bind(request.amount)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_named(
        &mut tx,
        &principal,
        book_id,
        "budget_limit.created",
        "budget_month_limit",
        id,
        serde_json::json!({
            "budget_id": budget_id, "month": format_month(month),
            "amount": request.amount.to_string(), "version": 1
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(BudgetLimitResponse {
            id,
            budget_id,
            month: format_month(month),
            amount: request.amount.normalize(),
            version: 1,
            archived_at: None,
        }),
    ))
}

pub async fn list_budget_limits(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, budget_id)): Path<(i64, i64)>,
    Query(query): Query<ArchiveQuery>,
) -> Result<Json<Vec<BudgetLimitResponse>>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    ensure_budget(&state, book_id, budget_id).await?;
    let rows = sqlx::query_as::<_, BudgetLimitRow>(
        r#"
        SELECT id, budget_id, month, amount, version, archived_at
        FROM budget_month_limits
        WHERE book_id = $1 AND budget_id = $2 AND ($3 = (archived_at IS NOT NULL))
        ORDER BY month DESC, id DESC
        "#,
    )
    .bind(book_id)
    .bind(budget_id)
    .bind(query.archived)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows.into_iter().map(Into::into).collect()))
}

pub async fn update_budget_limit(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, budget_id, limit_id)): Path<(i64, i64, i64)>,
    Json(request): Json<UpdateBudgetLimit>,
) -> Result<Json<BudgetLimitResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let month = parse_month(&request.month)?;
    validate_amount(request.amount)?;
    ensure_active_budget(&state, book_id, budget_id).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, BudgetLimitRow>(
        r#"
        SELECT id, budget_id, month, amount, version, archived_at
        FROM budget_month_limits
        WHERE book_id = $1 AND budget_id = $2 AND id = $3
        FOR UPDATE
        "#,
    )
    .bind(book_id)
    .bind(budget_id)
    .bind(limit_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("预算限额不存在"))?;
    require_active_version(
        current.version,
        request.version,
        current.archived_at,
        "预算限额",
    )?;
    sqlx::query(
        r#"
        UPDATE budget_month_limits
        SET month = $4, amount = $5, version = version + 1, updated_at = now()
        WHERE book_id = $1 AND budget_id = $2 AND id = $3
        "#,
    )
    .bind(book_id)
    .bind(budget_id)
    .bind(limit_id)
    .bind(month)
    .bind(request.amount)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change(
        &mut tx,
        &principal,
        book_id,
        "budget_limit.updated",
        "budget_month_limit",
        limit_id,
        serde_json::json!({
            "month": format_month(current.month), "amount": current.amount.to_string(),
            "version": current.version
        }),
        serde_json::json!({
            "month": format_month(month), "amount": request.amount.to_string(),
            "version": current.version + 1
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(Json(BudgetLimitResponse {
        id: limit_id,
        budget_id,
        month: format_month(month),
        amount: request.amount.normalize(),
        version: current.version + 1,
        archived_at: None,
    }))
}

pub async fn archive_budget_limit(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, budget_id, limit_id)): Path<(i64, i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_budget_limit_archived(
        &state,
        &principal,
        book_id,
        budget_id,
        limit_id,
        query.version,
        true,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_budget_limit(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, budget_id, limit_id)): Path<(i64, i64, i64)>,
    Query(query): Query<VersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_budget_limit_archived(
        &state,
        &principal,
        book_id,
        budget_id,
        limit_id,
        query.version,
        false,
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn budget_report(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<BudgetReportQuery>,
) -> Result<Json<BudgetReportResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let month = parse_month(&query.month)?;
    let book = sqlx::query_as::<_, (String, String)>(
        "SELECT timezone, base_currency_code FROM books WHERE id = $1",
    )
    .bind(book_id)
    .fetch_one(&state.pool)
    .await
    .map_err(ApiError::database)?;
    let rows = sqlx::query_as::<_, BudgetReportRow>(
        r#"
        SELECT bu.id AS budget_id, bu.name, bu.color, lim.amount AS limit_amount,
               COALESCE(sum(
                   CASE WHEN j.id IS NOT NULL THEN p.book_amount ELSE 0 END
               ), 0) AS actual_amount
        FROM budgets bu
        JOIN books b ON b.id = bu.book_id
        LEFT JOIN budget_month_limits lim
          ON lim.budget_id = bu.id AND lim.month = $2 AND lim.archived_at IS NULL
        LEFT JOIN postings p
          ON p.book_id = bu.book_id AND p.budget_id = bu.id
        LEFT JOIN journal_entries j
          ON j.book_id = p.book_id AND j.id = p.journal_entry_id
         AND j.status IN ('posted', 'reversed')
         AND (j.occurred_at AT TIME ZONE b.timezone)::date >= $2
         AND (j.occurred_at AT TIME ZONE b.timezone)::date < ($2 + interval '1 month')::date
        WHERE bu.book_id = $1 AND bu.archived_at IS NULL
        GROUP BY bu.id, bu.name, bu.color, lim.amount
        ORDER BY lower(bu.name), bu.id
        "#,
    )
    .bind(book_id)
    .bind(month)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    let items = rows
        .into_iter()
        .map(|row| {
            let limit_amount = row.limit_amount.map(|amount| amount.normalize());
            let actual_amount = row.actual_amount.normalize();
            let remaining_amount = limit_amount.map(|limit| (limit - actual_amount).normalize());
            BudgetReportItem {
                budget_id: row.budget_id,
                name: row.name,
                color: row.color,
                limit_amount,
                actual_amount,
                remaining_amount,
                exceeded: remaining_amount.is_some_and(|remaining| remaining < Decimal::ZERO),
            }
        })
        .collect();
    Ok(Json(BudgetReportResponse {
        month: format_month(month),
        timezone: book.0,
        currency_code: book.1,
        items,
    }))
}

#[derive(Clone, Copy)]
enum NamedKind {
    Tag,
    Budget,
}

impl NamedKind {
    fn table(self) -> &'static str {
        match self {
            Self::Tag => "tags",
            Self::Budget => "budgets",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Tag => "标签",
            Self::Budget => "预算",
        }
    }

    fn entity(self) -> &'static str {
        match self {
            Self::Tag => "tag",
            Self::Budget => "budget",
        }
    }
}

async fn update_named_resource(
    state: &AppState,
    principal: &Principal,
    book_id: i64,
    entity_id: i64,
    request: UpdateNamedResource,
    kind: NamedKind,
) -> Result<(String, Option<String>, i64), ApiError> {
    require_book(&state.pool, principal, book_id, true).await?;
    let name = normalize_name(&request.name, kind.label())?;
    let color = normalize_color(request.color)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let query = format!(
        "SELECT name, color, version, archived_at FROM {} WHERE book_id = $1 AND id = $2 FOR UPDATE",
        kind.table()
    );
    let current =
        sqlx::query_as::<_, (String, Option<String>, i64, Option<OffsetDateTime>)>(&query)
            .bind(book_id)
            .bind(entity_id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found(format!("{}不存在", kind.label())))?;
    require_active_version(current.2, request.version, current.3, kind.label())?;
    let query = format!(
        "UPDATE {} SET name = $3, color = $4, version = version + 1, updated_at = now() WHERE book_id = $1 AND id = $2",
        kind.table()
    );
    sqlx::query(&query)
        .bind(book_id)
        .bind(entity_id)
        .bind(&name)
        .bind(&color)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    audit_change(
        &mut tx,
        principal,
        book_id,
        match kind {
            NamedKind::Tag => "tag.updated",
            NamedKind::Budget => "budget.updated",
        },
        kind.entity(),
        entity_id,
        serde_json::json!({
            "name": current.0, "color": current.1, "version": current.2
        }),
        serde_json::json!({
            "name": name, "color": color, "version": current.2 + 1
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((name, color, current.2 + 1))
}

#[allow(clippy::too_many_arguments)]
async fn set_named_archived(
    state: &AppState,
    principal: &Principal,
    book_id: i64,
    entity_id: i64,
    version: i64,
    archived: bool,
    kind: NamedKind,
) -> Result<(), ApiError> {
    require_book(&state.pool, principal, book_id, true).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let query = format!(
        "SELECT name, version, archived_at FROM {} WHERE book_id = $1 AND id = $2 FOR UPDATE",
        kind.table()
    );
    let current = sqlx::query_as::<_, (String, i64, Option<OffsetDateTime>)>(&query)
        .bind(book_id)
        .bind(entity_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found(format!("{}不存在", kind.label())))?;
    require_archive_version(current.1, version, current.2, archived, kind.label())?;
    let archived_at = archived.then(OffsetDateTime::now_utc);
    let query = format!(
        "UPDATE {} SET archived_at = $3, version = version + 1, updated_at = now() WHERE book_id = $1 AND id = $2",
        kind.table()
    );
    sqlx::query(&query)
        .bind(book_id)
        .bind(entity_id)
        .bind(archived_at)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
    audit_change(
        &mut tx,
        principal,
        book_id,
        match (kind, archived) {
            (NamedKind::Tag, true) => "tag.archived",
            (NamedKind::Tag, false) => "tag.restored",
            (NamedKind::Budget, true) => "budget.archived",
            (NamedKind::Budget, false) => "budget.restored",
        },
        kind.entity(),
        entity_id,
        serde_json::json!({
            "name": current.0, "archived": !archived, "version": current.1
        }),
        serde_json::json!({
            "name": current.0, "archived": archived, "version": current.1 + 1
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn set_budget_limit_archived(
    state: &AppState,
    principal: &Principal,
    book_id: i64,
    budget_id: i64,
    limit_id: i64,
    version: i64,
    archived: bool,
) -> Result<(), ApiError> {
    require_book(&state.pool, principal, book_id, true).await?;
    ensure_active_budget(state, book_id, budget_id).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<_, BudgetLimitRow>(
        r#"
        SELECT id, budget_id, month, amount, version, archived_at
        FROM budget_month_limits
        WHERE book_id = $1 AND budget_id = $2 AND id = $3
        FOR UPDATE
        "#,
    )
    .bind(book_id)
    .bind(budget_id)
    .bind(limit_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("预算限额不存在"))?;
    require_archive_version(
        current.version,
        version,
        current.archived_at,
        archived,
        "预算限额",
    )?;
    let archived_at = archived.then(OffsetDateTime::now_utc);
    sqlx::query(
        r#"
        UPDATE budget_month_limits
        SET archived_at = $4, version = version + 1, updated_at = now()
        WHERE book_id = $1 AND budget_id = $2 AND id = $3
        "#,
    )
    .bind(book_id)
    .bind(budget_id)
    .bind(limit_id)
    .bind(archived_at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_change(
        &mut tx,
        principal,
        book_id,
        if archived {
            "budget_limit.archived"
        } else {
            "budget_limit.restored"
        },
        "budget_month_limit",
        limit_id,
        serde_json::json!({ "archived": !archived, "version": current.version }),
        serde_json::json!({ "archived": archived, "version": current.version + 1 }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(())
}

async fn ensure_active_budget(
    state: &AppState,
    book_id: i64,
    budget_id: i64,
) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM budgets WHERE book_id = $1 AND id = $2 AND archived_at IS NULL)",
    )
    .bind(book_id)
    .bind(budget_id)
    .fetch_one(&state.pool)
    .await
    .map_err(ApiError::database)?;
    if !exists {
        return Err(ApiError::not_found("预算不存在"));
    }
    Ok(())
}

async fn ensure_budget(state: &AppState, book_id: i64, budget_id: i64) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (SELECT 1 FROM budgets WHERE book_id = $1 AND id = $2)",
    )
    .bind(book_id)
    .bind(budget_id)
    .fetch_one(&state.pool)
    .await
    .map_err(ApiError::database)?;
    if !exists {
        return Err(ApiError::not_found("预算不存在"));
    }
    Ok(())
}

async fn audit_named(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    book_id: i64,
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
        )
        SELECT b.organization_id, b.id, $2, $3, $4, $5, $6, $7
        FROM books b WHERE b.id = $1
        "#,
    )
    .bind(book_id)
    .bind(actor_kind(principal))
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

#[allow(clippy::too_many_arguments)]
async fn audit_change(
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
        FROM books b WHERE b.id = $1
        "#,
    )
    .bind(book_id)
    .bind(actor_kind(principal))
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

fn actor_kind(principal: &Principal) -> &'static str {
    match principal.auth_kind {
        AuthKind::Session => "user",
        AuthKind::Pat => "pat",
    }
}

fn normalize_name(value: &str, field: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 120 {
        return Err(ApiError::bad_request(
            "name_invalid",
            format!("{field}长度必须为 1 到 120 个字符"),
        ));
    }
    Ok(value.to_owned())
}

fn normalize_color(value: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_uppercase();
    if value.len() != 7
        || !value.starts_with('#')
        || !value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ApiError::bad_request(
            "color_invalid",
            "颜色必须使用 #RRGGBB 格式",
        ));
    }
    Ok(Some(value))
}

fn parse_month(value: &str) -> Result<Date, ApiError> {
    let (year, month) = value
        .split_once('-')
        .ok_or_else(|| ApiError::bad_request("month_invalid", "月份必须使用 YYYY-MM 格式"))?;
    if year.len() != 4 || month.len() != 2 {
        return Err(ApiError::bad_request(
            "month_invalid",
            "月份必须使用 YYYY-MM 格式",
        ));
    }
    let year = year
        .parse::<i32>()
        .map_err(|_| ApiError::bad_request("month_invalid", "月份必须使用 YYYY-MM 格式"))?;
    let month = month
        .parse::<u8>()
        .ok()
        .and_then(|month| Month::try_from(month).ok())
        .ok_or_else(|| ApiError::bad_request("month_invalid", "月份必须使用 YYYY-MM 格式"))?;
    Date::from_calendar_date(year, month, 1)
        .map_err(|_| ApiError::bad_request("month_invalid", "月份必须使用 YYYY-MM 格式"))
}

fn format_month(value: Date) -> String {
    format!("{:04}-{:02}", value.year(), u8::from(value.month()))
}

fn validate_amount(value: Decimal) -> Result<(), ApiError> {
    if value <= Decimal::ZERO {
        return Err(ApiError::bad_request(
            "amount_invalid",
            "预算限额必须大于 0",
        ));
    }
    Ok(())
}

fn require_active_version(
    current: i64,
    requested: i64,
    archived_at: Option<OffsetDateTime>,
    entity: &str,
) -> Result<(), ApiError> {
    if archived_at.is_some() {
        return Err(ApiError::conflict(
            "resource_archived",
            format!("{entity}已归档"),
        ));
    }
    require_version(current, requested)
}

fn require_archive_version(
    current: i64,
    requested: i64,
    archived_at: Option<OffsetDateTime>,
    archived: bool,
    entity: &str,
) -> Result<(), ApiError> {
    require_version(current, requested)?;
    if archived == archived_at.is_some() {
        return Err(ApiError::conflict(
            "archive_state_unchanged",
            format!("{entity}归档状态没有变化"),
        ));
    }
    Ok(())
}

fn require_version(current: i64, requested: i64) -> Result<(), ApiError> {
    if current != requested {
        return Err(ApiError::conflict(
            "version_conflict",
            "数据已经被其他请求修改，请刷新后重试",
        ));
    }
    Ok(())
}
