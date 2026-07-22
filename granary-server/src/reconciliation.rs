use std::collections::BTreeSet;

use axum::{
    Extension, Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};
use time::OffsetDateTime;

use crate::{
    api::{actor_kind, map_ledger_error, require_book},
    auth::{ApiError, Principal},
    http::AppState,
    ledger::{PostJournal, PostingInput, post_journal_in_tx},
};

const MAX_RECONCILIATION_POSTINGS: usize = 500;

#[derive(Deserialize)]
pub struct CreateReconciliation {
    account_id: i64,
    #[serde(with = "time::serde::rfc3339")]
    statement_ending_at: OffsetDateTime,
    #[serde(with = "rust_decimal::serde::str")]
    statement_balance: Decimal,
    #[serde(default)]
    posting_ids: Vec<i64>,
    notes: Option<String>,
}

#[derive(Deserialize)]
pub struct UpdateReconciliation {
    version: i64,
    #[serde(with = "time::serde::rfc3339")]
    statement_ending_at: OffsetDateTime,
    #[serde(with = "rust_decimal::serde::str")]
    statement_balance: Decimal,
    #[serde(default)]
    posting_ids: Vec<i64>,
    notes: Option<String>,
}

#[derive(Deserialize)]
pub struct CompleteReconciliation {
    version: i64,
    #[serde(default)]
    create_adjustment: bool,
    #[serde(default, with = "rust_decimal::serde::str_option")]
    adjustment_book_amount: Option<Decimal>,
    reason: String,
}

#[derive(Deserialize)]
pub struct ReconciliationVersionQuery {
    version: i64,
}

#[derive(Deserialize)]
pub struct ReconciliationListQuery {
    status: Option<ReconciliationStatus>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationStatus {
    Draft,
    Completed,
    Cancelled,
}

impl ReconciliationStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(FromRow)]
struct ReconciliationRow {
    id: i64,
    book_id: i64,
    account_id: i64,
    account_name: String,
    currency_code: String,
    base_currency_code: String,
    statement_ending_at: OffsetDateTime,
    statement_balance: Decimal,
    status: String,
    notes: Option<String>,
    adjustment_journal_id: Option<i64>,
    version: i64,
    completed_at: Option<OffsetDateTime>,
    cancelled_at: Option<OffsetDateTime>,
    created_at: OffsetDateTime,
}

#[derive(Serialize)]
pub struct ReconciliationResponse {
    id: i64,
    book_id: i64,
    account_id: i64,
    account_name: String,
    currency_code: String,
    #[serde(with = "time::serde::rfc3339")]
    statement_ending_at: OffsetDateTime,
    #[serde(with = "rust_decimal::serde::str")]
    statement_balance: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    reconciled_balance_before: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    selected_total: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    projected_balance: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    difference: Decimal,
    selected_posting_ids: Vec<i64>,
    selected_transaction_count: i64,
    status: String,
    notes: Option<String>,
    adjustment_journal_id: Option<i64>,
    version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    completed_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    cancelled_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

struct ReconciliationTotals {
    reconciled_before: Decimal,
    selected_total: Decimal,
    selected_posting_ids: Vec<i64>,
    selected_transaction_count: i64,
}

pub async fn create_reconciliation(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Json(request): Json<CreateReconciliation>,
) -> Result<(StatusCode, Json<ReconciliationResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    validate_posting_ids(&request.posting_ids)?;
    let notes = normalize_notes(request.notes)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    lock_account(&mut tx, book_id, request.account_id).await?;
    let reconciliation_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO account_reconciliations (
            book_id, account_id, statement_ending_at, statement_balance,
            notes, created_by_user_id
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(book_id)
    .bind(request.account_id)
    .bind(request.statement_ending_at)
    .bind(request.statement_balance)
    .bind(notes)
    .bind(principal.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    assign_postings(
        &mut tx,
        book_id,
        request.account_id,
        reconciliation_id,
        request.statement_ending_at,
        &request.posting_ids,
    )
    .await?;
    audit_reconciliation(
        &mut tx,
        &principal,
        book_id,
        "reconciliation.created",
        reconciliation_id,
        serde_json::json!({
            "account_id": request.account_id,
            "posting_count": request.posting_ids.len(),
            "statement_balance": request.statement_balance,
        }),
        None,
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(load_response(&state.pool, book_id, reconciliation_id).await?),
    ))
}

pub async fn list_reconciliations(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<ReconciliationListQuery>,
) -> Result<Json<Vec<ReconciliationResponse>>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let ids = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT id FROM account_reconciliations
        WHERE book_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY statement_ending_at DESC, id DESC
        "#,
    )
    .bind(book_id)
    .bind(query.status.map(ReconciliationStatus::as_str))
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    let mut rows = Vec::with_capacity(ids.len());
    for id in ids {
        rows.push(load_response(&state.pool, book_id, id).await?);
    }
    Ok(Json(rows))
}

pub async fn show_reconciliation(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, reconciliation_id)): Path<(i64, i64)>,
) -> Result<Json<ReconciliationResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    Ok(Json(
        load_response(&state.pool, book_id, reconciliation_id).await?,
    ))
}

pub async fn update_reconciliation(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, reconciliation_id)): Path<(i64, i64)>,
    Json(request): Json<UpdateReconciliation>,
) -> Result<Json<ReconciliationResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    validate_posting_ids(&request.posting_ids)?;
    let notes = normalize_notes(request.notes)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = lock_reconciliation(&mut tx, book_id, reconciliation_id).await?;
    require_draft_version(&current, request.version)?;
    sqlx::query(
        "UPDATE postings SET reconciliation_id = NULL WHERE book_id = $1 AND reconciliation_id = $2 AND cleared_at IS NULL",
    )
    .bind(book_id)
    .bind(reconciliation_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query(
        r#"
        UPDATE account_reconciliations
        SET statement_ending_at = $3, statement_balance = $4, notes = $5,
            version = version + 1, updated_at = now()
        WHERE book_id = $1 AND id = $2
        "#,
    )
    .bind(book_id)
    .bind(reconciliation_id)
    .bind(request.statement_ending_at)
    .bind(request.statement_balance)
    .bind(notes)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    assign_postings(
        &mut tx,
        book_id,
        current.account_id,
        reconciliation_id,
        request.statement_ending_at,
        &request.posting_ids,
    )
    .await?;
    audit_reconciliation(
        &mut tx,
        &principal,
        book_id,
        "reconciliation.updated",
        reconciliation_id,
        serde_json::json!({
            "posting_count": request.posting_ids.len(),
            "statement_balance": request.statement_balance,
            "version": request.version + 1,
        }),
        None,
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(Json(
        load_response(&state.pool, book_id, reconciliation_id).await?,
    ))
}

pub async fn cancel_reconciliation(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, reconciliation_id)): Path<(i64, i64)>,
    Query(query): Query<ReconciliationVersionQuery>,
) -> Result<StatusCode, ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = lock_reconciliation(&mut tx, book_id, reconciliation_id).await?;
    require_draft_version(&current, query.version)?;
    sqlx::query(
        "UPDATE postings SET reconciliation_id = NULL WHERE book_id = $1 AND reconciliation_id = $2 AND cleared_at IS NULL",
    )
    .bind(book_id)
    .bind(reconciliation_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    let now = OffsetDateTime::now_utc();
    sqlx::query(
        r#"
        UPDATE account_reconciliations
        SET status = 'cancelled', cancelled_by_user_id = $3, cancelled_at = $4,
            version = version + 1, updated_at = now()
        WHERE book_id = $1 AND id = $2
        "#,
    )
    .bind(book_id)
    .bind(reconciliation_id)
    .bind(principal.user_id)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_reconciliation(
        &mut tx,
        &principal,
        book_id,
        "reconciliation.cancelled",
        reconciliation_id,
        serde_json::json!({ "version": query.version + 1 }),
        None,
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn complete_reconciliation(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, reconciliation_id)): Path<(i64, i64)>,
    Json(request): Json<CompleteReconciliation>,
) -> Result<Json<ReconciliationResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    validate_reason(&request.reason)?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = lock_reconciliation(&mut tx, book_id, reconciliation_id).await?;
    require_draft_version(&current, request.version)?;
    let totals = calculate_totals(&mut tx, &current).await?;
    let projected = totals.reconciled_before + totals.selected_total;
    let difference = current.statement_balance - projected;
    let mut adjustment_journal_id = None;
    if !difference.is_zero() {
        if !request.create_adjustment {
            return Err(ApiError::conflict(
                "reconciliation_not_balanced",
                "对账仍有差额；请更新勾选项或明确创建对账调整",
            ));
        }
        let adjustment_book_amount = adjustment_book_amount(
            difference,
            &current.currency_code,
            &current.base_currency_code,
            request.adjustment_book_amount,
        )?;
        let adjustment_account_id = sqlx::query_scalar::<_, i64>(
            r#"
            SELECT id FROM ledger_accounts
            WHERE book_id = $1 AND role = 'reconciliation' AND hidden = TRUE
              AND archived_at IS NULL
            "#,
        )
        .bind(book_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::database)?;
        let journal_id = post_journal_in_tx(
            &mut tx,
            &PostJournal {
                book_id,
                description: format!("对账调整：{}", current.account_name),
                occurred_at: current.statement_ending_at,
                counterparty_id: None,
                created_by_user_id: principal.user_id,
                audit_actor_kind: actor_kind(&principal),
                postings: vec![
                    PostingInput {
                        account_id: current.account_id,
                        budget_id: None,
                        amount: difference,
                        book_amount: adjustment_book_amount,
                        memo: Some(request.reason.trim().to_owned()),
                    },
                    PostingInput {
                        account_id: adjustment_account_id,
                        budget_id: None,
                        amount: -adjustment_book_amount,
                        book_amount: -adjustment_book_amount,
                        memo: Some(request.reason.trim().to_owned()),
                    },
                ],
                tag_ids: Vec::new(),
            },
            None,
        )
        .await
        .map_err(map_ledger_error)?;
        let assigned = sqlx::query(
            r#"
            UPDATE postings SET reconciliation_id = $3
            WHERE book_id = $1 AND journal_entry_id = $2 AND account_id = $4
            "#,
        )
        .bind(book_id)
        .bind(journal_id)
        .bind(reconciliation_id)
        .bind(current.account_id)
        .execute(&mut *tx)
        .await
        .map_err(ApiError::database)?;
        if assigned.rows_affected() != 1 {
            return Err(ApiError::internal(
                "对账调整分录没有生成唯一的目标账户 posting",
            ));
        }
        adjustment_journal_id = Some(journal_id);
    }

    let completed_at = OffsetDateTime::now_utc();
    sqlx::query(
        "UPDATE postings SET cleared_at = $3 WHERE book_id = $1 AND reconciliation_id = $2",
    )
    .bind(book_id)
    .bind(reconciliation_id)
    .bind(completed_at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    sqlx::query(
        r#"
        UPDATE account_reconciliations
        SET status = 'completed', adjustment_journal_id = $3,
            completed_by_user_id = $4, completed_at = $5,
            version = version + 1, updated_at = now()
        WHERE book_id = $1 AND id = $2
        "#,
    )
    .bind(book_id)
    .bind(reconciliation_id)
    .bind(adjustment_journal_id)
    .bind(principal.user_id)
    .bind(completed_at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_reconciliation(
        &mut tx,
        &principal,
        book_id,
        "reconciliation.completed",
        reconciliation_id,
        serde_json::json!({
            "difference_before_adjustment": difference,
            "adjustment_journal_id": adjustment_journal_id,
            "posting_count": totals.selected_posting_ids.len(),
            "version": request.version + 1,
        }),
        Some(request.reason.trim()),
    )
    .await?;
    sqlx::query(
        r#"
        INSERT INTO outbox_events (book_id, event_type, aggregate_type, aggregate_id, payload)
        VALUES ($1, 'reconciliation.completed', 'account_reconciliation', $2,
                jsonb_build_object('reconciliation_id', $2, 'adjustment_journal_id', $3::bigint))
        "#,
    )
    .bind(book_id)
    .bind(reconciliation_id)
    .bind(adjustment_journal_id)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(Json(
        load_response(&state.pool, book_id, reconciliation_id).await?,
    ))
}

async fn load_response(
    pool: &sqlx::PgPool,
    book_id: i64,
    reconciliation_id: i64,
) -> Result<ReconciliationResponse, ApiError> {
    let row = load_row(pool, book_id, reconciliation_id).await?;
    let mut tx = pool.begin().await.map_err(ApiError::database)?;
    let totals = calculate_totals(&mut tx, &row).await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(into_response(row, totals))
}

fn into_response(row: ReconciliationRow, totals: ReconciliationTotals) -> ReconciliationResponse {
    let projected_balance = totals.reconciled_before + totals.selected_total;
    ReconciliationResponse {
        id: row.id,
        book_id: row.book_id,
        account_id: row.account_id,
        account_name: row.account_name,
        currency_code: row.currency_code,
        statement_ending_at: row.statement_ending_at,
        statement_balance: row.statement_balance,
        reconciled_balance_before: totals.reconciled_before,
        selected_total: totals.selected_total,
        projected_balance,
        difference: row.statement_balance - projected_balance,
        selected_posting_ids: totals.selected_posting_ids,
        selected_transaction_count: totals.selected_transaction_count,
        status: row.status,
        notes: row.notes,
        adjustment_journal_id: row.adjustment_journal_id,
        version: row.version,
        completed_at: row.completed_at,
        cancelled_at: row.cancelled_at,
        created_at: row.created_at,
    }
}

async fn load_row(
    pool: &sqlx::PgPool,
    book_id: i64,
    reconciliation_id: i64,
) -> Result<ReconciliationRow, ApiError> {
    sqlx::query_as::<_, ReconciliationRow>(reconciliation_select(false))
        .bind(book_id)
        .bind(reconciliation_id)
        .fetch_optional(pool)
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found("对账会话不存在"))
}

async fn lock_reconciliation(
    tx: &mut Transaction<'_, Postgres>,
    book_id: i64,
    reconciliation_id: i64,
) -> Result<ReconciliationRow, ApiError> {
    sqlx::query_as::<_, ReconciliationRow>(reconciliation_select(true))
        .bind(book_id)
        .bind(reconciliation_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found("对账会话不存在"))
}

fn reconciliation_select(for_update: bool) -> &'static str {
    if for_update {
        r#"
        SELECT r.id, r.book_id, r.account_id, a.name AS account_name,
               a.currency_code, b.base_currency_code, r.statement_ending_at,
               r.statement_balance, r.status, r.notes, r.adjustment_journal_id,
               r.version, r.completed_at, r.cancelled_at, r.created_at
        FROM account_reconciliations r
        JOIN ledger_accounts a ON a.book_id = r.book_id AND a.id = r.account_id
        JOIN books b ON b.id = r.book_id
        WHERE r.book_id = $1 AND r.id = $2
        FOR UPDATE OF r
        "#
    } else {
        r#"
        SELECT r.id, r.book_id, r.account_id, a.name AS account_name,
               a.currency_code, b.base_currency_code, r.statement_ending_at,
               r.statement_balance, r.status, r.notes, r.adjustment_journal_id,
               r.version, r.completed_at, r.cancelled_at, r.created_at
        FROM account_reconciliations r
        JOIN ledger_accounts a ON a.book_id = r.book_id AND a.id = r.account_id
        JOIN books b ON b.id = r.book_id
        WHERE r.book_id = $1 AND r.id = $2
        "#
    }
}

async fn calculate_totals(
    tx: &mut Transaction<'_, Postgres>,
    row: &ReconciliationRow,
) -> Result<ReconciliationTotals, ApiError> {
    let reconciled_before = sqlx::query_scalar::<_, Decimal>(
        r#"
        SELECT COALESCE(sum(p.amount), 0)
        FROM postings p
        JOIN journal_entries j ON j.book_id = p.book_id AND j.id = p.journal_entry_id
        WHERE p.book_id = $1 AND p.account_id = $2
          AND j.occurred_at <= $3 AND p.cleared_at IS NOT NULL
          AND p.reconciliation_id IS DISTINCT FROM $4
        "#,
    )
    .bind(row.book_id)
    .bind(row.account_id)
    .bind(row.statement_ending_at)
    .bind(row.id)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    let selected_total = sqlx::query_scalar::<_, Decimal>(
        "SELECT COALESCE(sum(amount), 0) FROM postings WHERE book_id = $1 AND reconciliation_id = $2",
    )
    .bind(row.book_id)
    .bind(row.id)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    let selected_posting_ids = sqlx::query_scalar::<_, i64>(
        "SELECT id FROM postings WHERE book_id = $1 AND reconciliation_id = $2 ORDER BY id",
    )
    .bind(row.book_id)
    .bind(row.id)
    .fetch_all(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    let selected_transaction_count = sqlx::query_scalar::<_, i64>(
        "SELECT count(DISTINCT journal_entry_id) FROM postings WHERE book_id = $1 AND reconciliation_id = $2",
    )
    .bind(row.book_id)
    .bind(row.id)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(ReconciliationTotals {
        reconciled_before,
        selected_total,
        selected_posting_ids,
        selected_transaction_count,
    })
}

async fn lock_account(
    tx: &mut Transaction<'_, Postgres>,
    book_id: i64,
    account_id: i64,
) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
            SELECT 1 FROM ledger_accounts
            WHERE book_id = $1 AND id = $2 AND class IN ('asset', 'liability')
              AND hidden = FALSE AND archived_at IS NULL
            FOR UPDATE
        )
        "#,
    )
    .bind(book_id)
    .bind(account_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    if !exists {
        return Err(ApiError::bad_request(
            "reconciliation_account_invalid",
            "只有当前账本中有效的资产或负债账户可以对账",
        ));
    }
    Ok(())
}

async fn assign_postings(
    tx: &mut Transaction<'_, Postgres>,
    book_id: i64,
    account_id: i64,
    reconciliation_id: i64,
    statement_ending_at: OffsetDateTime,
    posting_ids: &[i64],
) -> Result<(), ApiError> {
    if posting_ids.is_empty() {
        return Ok(());
    }
    let updated = sqlx::query(
        r#"
        UPDATE postings p
        SET reconciliation_id = $4
        FROM journal_entries j
        WHERE p.book_id = $1 AND p.account_id = $2 AND p.id = ANY($3)
          AND j.book_id = p.book_id AND j.id = p.journal_entry_id
          AND j.status IN ('posted', 'reversed') AND j.occurred_at <= $5
          AND p.cleared_at IS NULL AND p.reconciliation_id IS NULL
        "#,
    )
    .bind(book_id)
    .bind(account_id)
    .bind(posting_ids)
    .bind(reconciliation_id)
    .bind(statement_ending_at)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    if updated.rows_affected() != posting_ids.len() as u64 {
        return Err(ApiError::conflict(
            "reconciliation_posting_invalid",
            "部分 posting 不存在、不属于该账户、晚于账单时间或已经参与其他对账",
        ));
    }
    Ok(())
}

fn validate_posting_ids(posting_ids: &[i64]) -> Result<(), ApiError> {
    if posting_ids.len() > MAX_RECONCILIATION_POSTINGS {
        return Err(ApiError::bad_request(
            "reconciliation_too_large",
            format!("一次对账最多选择 {MAX_RECONCILIATION_POSTINGS} 个 posting"),
        ));
    }
    let unique = posting_ids.iter().copied().collect::<BTreeSet<_>>();
    if unique.len() != posting_ids.len() {
        return Err(ApiError::bad_request(
            "duplicate_posting",
            "对账不能重复选择同一个 posting",
        ));
    }
    Ok(())
}

fn require_draft_version(row: &ReconciliationRow, expected_version: i64) -> Result<(), ApiError> {
    if row.status != "draft" {
        return Err(ApiError::conflict(
            "reconciliation_not_draft",
            "只有草稿对账会话可以修改、取消或完成",
        ));
    }
    if row.version != expected_version {
        return Err(ApiError::conflict(
            "version_conflict",
            "对账会话已经变化，请刷新后重试",
        ));
    }
    Ok(())
}

fn adjustment_book_amount(
    difference: Decimal,
    account_currency: &str,
    base_currency: &str,
    requested: Option<Decimal>,
) -> Result<Decimal, ApiError> {
    if account_currency == base_currency {
        if let Some(requested) = requested
            && requested != difference
        {
            return Err(ApiError::bad_request(
                "adjustment_book_amount_invalid",
                "本位币账户的调整原币金额和本位币金额必须相同",
            ));
        }
        return Ok(difference);
    }
    let requested = requested.ok_or_else(|| {
        ApiError::bad_request(
            "adjustment_book_amount_required",
            "外币账户创建对账调整时必须填写本位币调整金额",
        )
    })?;
    if requested.is_zero() || requested.is_sign_negative() != difference.is_sign_negative() {
        return Err(ApiError::bad_request(
            "adjustment_book_amount_invalid",
            "本位币调整金额必须非零且与原币差额方向一致",
        ));
    }
    Ok(requested)
}

fn normalize_notes(notes: Option<String>) -> Result<Option<String>, ApiError> {
    let notes = notes
        .as_deref()
        .map(str::trim)
        .filter(|notes| !notes.is_empty())
        .map(str::to_owned);
    if notes
        .as_ref()
        .is_some_and(|notes| notes.chars().count() > 2000)
    {
        return Err(ApiError::bad_request(
            "notes_invalid",
            "对账备注不能超过 2000 个字符",
        ));
    }
    Ok(notes)
}

fn validate_reason(reason: &str) -> Result<(), ApiError> {
    if reason.trim().is_empty() || reason.trim().chars().count() > 500 {
        return Err(ApiError::bad_request(
            "reason_invalid",
            "对账完成原因长度必须为 1 到 500 个字符",
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn audit_reconciliation(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    book_id: i64,
    action: &'static str,
    reconciliation_id: i64,
    after_data: serde_json::Value,
    reason: Option<&str>,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, book_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, after_data, reason
        )
        SELECT b.organization_id, b.id, $2, $3, $4,
               'account_reconciliation', $5, $6, $7
        FROM books b WHERE b.id = $1
        "#,
    )
    .bind(book_id)
    .bind(actor_kind(principal).as_str())
    .bind(principal.user_id)
    .bind(action)
    .bind(reconciliation_id)
    .bind(after_data)
    .bind(reason)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(())
}
