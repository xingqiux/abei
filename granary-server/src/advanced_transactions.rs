use std::collections::{BTreeMap, BTreeSet};

use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};
use time::{Duration, OffsetDateTime};

use crate::{
    api::{
        CreateTransaction, TransactionResponse, actor_kind, get_transaction, map_ledger_error,
        prepare_transaction, require_book,
    },
    auth::{ApiError, Principal},
    http::AppState,
    ledger::{
        PostJournal, PostingInput, ReverseJournal, post_journal_in_tx, reverse_journal_in_tx,
        trash_journal_in_tx,
    },
};

const MAX_BATCH_ITEMS: usize = 100;
const BATCH_PREVIEW_TTL: Duration = Duration::minutes(15);

#[derive(Deserialize)]
pub struct CloneTransaction {
    #[serde(default, with = "time::serde::rfc3339::option")]
    occurred_at: Option<OffsetDateTime>,
    description: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct VersionedTransaction {
    transaction_id: i64,
    version: i64,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct BatchReplacement {
    transaction_id: i64,
    version: i64,
    replacement: CreateTransaction,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum PreviewBatchTransactions {
    Replace {
        reason: String,
        items: Vec<BatchReplacement>,
    },
    Trash {
        reason: String,
        items: Vec<VersionedTransaction>,
    },
}

impl PreviewBatchTransactions {
    fn operation(&self) -> &'static str {
        match self {
            Self::Replace { .. } => "replace",
            Self::Trash { .. } => "trash",
        }
    }

    fn reason(&self) -> &str {
        match self {
            Self::Replace { reason, .. } | Self::Trash { reason, .. } => reason,
        }
    }

    fn versions(&self) -> Vec<VersionedTransaction> {
        match self {
            Self::Replace { items, .. } => items
                .iter()
                .map(|item| VersionedTransaction {
                    transaction_id: item.transaction_id,
                    version: item.version,
                })
                .collect(),
            Self::Trash { items, .. } => items.clone(),
        }
    }
}

#[derive(Serialize)]
pub struct BatchPreviewItem {
    transaction_id: i64,
    source_version: i64,
    before: TransactionResponse,
    replacement: Option<CreateTransaction>,
}

#[derive(Serialize)]
pub struct AccountImpact {
    account_id: i64,
    account_name: String,
    #[serde(with = "rust_decimal::serde::str")]
    book_amount_delta: Decimal,
}

#[derive(Serialize)]
pub struct BatchPreviewResponse {
    preview_id: i64,
    operation: String,
    item_count: usize,
    #[serde(with = "time::serde::rfc3339")]
    expires_at: OffsetDateTime,
    items: Vec<BatchPreviewItem>,
    account_impacts: Vec<AccountImpact>,
}

#[derive(Serialize)]
pub struct BatchExecutionItem {
    original_journal_id: i64,
    reversal_journal_id: i64,
    replacement_journal_id: Option<i64>,
}

#[derive(Serialize)]
pub struct BatchExecutionResponse {
    preview_id: i64,
    operation: String,
    #[serde(with = "time::serde::rfc3339")]
    executed_at: OffsetDateTime,
    results: Vec<BatchExecutionItem>,
}

#[derive(FromRow)]
struct StoredBatchPreview {
    actor_user_id: i64,
    operation: String,
    request: serde_json::Value,
    expires_at: OffsetDateTime,
    executed_at: Option<OffsetDateTime>,
}

pub async fn clone_transaction(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, transaction_id)): Path<(i64, i64)>,
    Json(request): Json<CloneTransaction>,
) -> Result<(StatusCode, Json<TransactionResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let source = sqlx::query_as::<_, (String, String, Option<i64>, Option<i64>)>(
        r#"
        SELECT status, description, counterparty_id, reversal_of_id
        FROM journal_entries
        WHERE book_id = $1 AND id = $2
        FOR SHARE
        "#,
    )
    .bind(book_id)
    .bind(transaction_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("交易不存在"))?;
    if source.3.is_some() {
        return Err(ApiError::bad_request(
            "reversal_clone_invalid",
            "冲正分录不能作为克隆来源",
        ));
    }
    if !matches!(source.0.as_str(), "posted" | "reversed") {
        return Err(ApiError::conflict(
            "journal_not_posted",
            "只有已入账交易可以克隆",
        ));
    }

    let description = match request.description {
        Some(description) => normalize_description(&description)?,
        None => source.1,
    };
    let postings = load_postings(&mut tx, book_id, transaction_id).await?;
    let tag_ids = sqlx::query_scalar::<_, i64>(
        "SELECT tag_id FROM journal_entry_tags WHERE book_id = $1 AND journal_entry_id = $2 ORDER BY tag_id",
    )
    .bind(book_id)
    .bind(transaction_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    let command = PostJournal {
        book_id,
        description,
        occurred_at: request.occurred_at.unwrap_or_else(OffsetDateTime::now_utc),
        counterparty_id: source.2,
        created_by_user_id: principal.user_id,
        audit_actor_kind: actor_kind(&principal),
        postings,
        tag_ids,
    };
    let cloned_id = post_journal_in_tx(&mut tx, &command, Some(transaction_id))
        .await
        .map_err(map_ledger_error)?;
    record_audit(
        &mut tx,
        &principal,
        book_id,
        "journal.cloned",
        "journal_entry",
        cloned_id,
        serde_json::json!({ "cloned_from_id": transaction_id }),
        None,
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;

    Ok((
        StatusCode::CREATED,
        Json(get_transaction(&state.pool, book_id, cloned_id).await?),
    ))
}

pub async fn preview_batch_transactions(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Json(request): Json<PreviewBatchTransactions>,
) -> Result<(StatusCode, Json<BatchPreviewResponse>), ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    validate_reason(request.reason())?;
    let versions = request.versions();
    validate_batch_items(&versions)?;

    let mut items = Vec::with_capacity(versions.len());
    let mut impacts = BTreeMap::<i64, Decimal>::new();
    match &request {
        PreviewBatchTransactions::Replace {
            items: replacements,
            ..
        } => {
            for item in replacements {
                validate_source(&state.pool, book_id, item.transaction_id, item.version).await?;
                let prepared =
                    prepare_transaction(&state.pool, book_id, item.replacement.clone()).await?;
                accumulate_source_impact(
                    &state.pool,
                    book_id,
                    item.transaction_id,
                    &mut impacts,
                    -Decimal::ONE,
                )
                .await?;
                accumulate_postings(&prepared.postings, &mut impacts, Decimal::ONE);
                items.push(BatchPreviewItem {
                    transaction_id: item.transaction_id,
                    source_version: item.version,
                    before: get_transaction(&state.pool, book_id, item.transaction_id).await?,
                    replacement: Some(item.replacement.clone()),
                });
            }
        }
        PreviewBatchTransactions::Trash { items: targets, .. } => {
            for item in targets {
                validate_source(&state.pool, book_id, item.transaction_id, item.version).await?;
                accumulate_source_impact(
                    &state.pool,
                    book_id,
                    item.transaction_id,
                    &mut impacts,
                    -Decimal::ONE,
                )
                .await?;
                items.push(BatchPreviewItem {
                    transaction_id: item.transaction_id,
                    source_version: item.version,
                    before: get_transaction(&state.pool, book_id, item.transaction_id).await?,
                    replacement: None,
                });
            }
        }
    }

    let account_impacts = hydrate_impacts(&state.pool, book_id, impacts).await?;
    let request_json = serde_json::to_value(&request).map_err(ApiError::internal)?;
    let expires_at = OffsetDateTime::now_utc() + BATCH_PREVIEW_TTL;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let preview_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO transaction_batch_previews (
            book_id, actor_user_id, actor_kind, operation, request, expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
        "#,
    )
    .bind(book_id)
    .bind(principal.user_id)
    .bind(actor_kind(&principal).as_str())
    .bind(request.operation())
    .bind(request_json)
    .bind(expires_at)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    record_audit(
        &mut tx,
        &principal,
        book_id,
        "transaction_batch.previewed",
        "transaction_batch_preview",
        preview_id,
        serde_json::json!({
            "operation": request.operation(),
            "item_count": versions.len(),
            "expires_at": expires_at,
        }),
        Some(request.reason()),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;

    Ok((
        StatusCode::CREATED,
        Json(BatchPreviewResponse {
            preview_id,
            operation: request.operation().to_owned(),
            item_count: items.len(),
            expires_at,
            items,
            account_impacts,
        }),
    ))
}

pub async fn execute_batch_transactions(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, preview_id)): Path<(i64, i64)>,
) -> Result<Json<BatchExecutionResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, true).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let stored = sqlx::query_as::<_, StoredBatchPreview>(
        r#"
        SELECT actor_user_id, operation, request, expires_at, executed_at
        FROM transaction_batch_previews
        WHERE book_id = $1 AND id = $2
        FOR UPDATE
        "#,
    )
    .bind(book_id)
    .bind(preview_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("批量操作预览不存在"))?;
    if stored.actor_user_id != principal.user_id {
        return Err(ApiError::not_found("批量操作预览不存在"));
    }
    if stored.executed_at.is_some() {
        return Err(ApiError::conflict(
            "batch_already_executed",
            "批量操作已经执行",
        ));
    }
    let now = OffsetDateTime::now_utc();
    if stored.expires_at <= now {
        return Err(ApiError::conflict(
            "batch_preview_expired",
            "批量操作预览已过期",
        ));
    }
    let request: PreviewBatchTransactions =
        serde_json::from_value(stored.request).map_err(ApiError::internal)?;
    let versions = request.versions();
    lock_and_validate_sources(&mut tx, book_id, &versions).await?;

    let reason = request.reason().trim().to_owned();
    let mut results = Vec::with_capacity(versions.len());
    match request {
        PreviewBatchTransactions::Replace { items, .. } => {
            for item in items {
                let prepared = prepare_transaction(&state.pool, book_id, item.replacement).await?;
                let reverse = reverse_command(book_id, item.transaction_id, &principal, &reason);
                let reversal_id = reverse_journal_in_tx(&mut tx, &reverse)
                    .await
                    .map_err(map_ledger_error)?;
                let replacement_id =
                    post_journal_in_tx(&mut tx, &prepared.into_journal(book_id, &principal), None)
                        .await
                        .map_err(map_ledger_error)?;
                sqlx::query(
                    r#"
                    INSERT INTO transaction_replacements (
                        book_id, original_journal_id, reversal_journal_id,
                        replacement_journal_id, batch_preview_id, replaced_by_user_id,
                        replaced_actor_kind, reason
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    "#,
                )
                .bind(book_id)
                .bind(item.transaction_id)
                .bind(reversal_id)
                .bind(replacement_id)
                .bind(preview_id)
                .bind(principal.user_id)
                .bind(actor_kind(&principal).as_str())
                .bind(&reason)
                .execute(&mut *tx)
                .await
                .map_err(ApiError::database)?;
                results.push(BatchExecutionItem {
                    original_journal_id: item.transaction_id,
                    reversal_journal_id: reversal_id,
                    replacement_journal_id: Some(replacement_id),
                });
            }
        }
        PreviewBatchTransactions::Trash { items, .. } => {
            for item in items {
                let reverse = reverse_command(book_id, item.transaction_id, &principal, &reason);
                let reversal_id = trash_journal_in_tx(&mut tx, &reverse)
                    .await
                    .map_err(map_ledger_error)?;
                results.push(BatchExecutionItem {
                    original_journal_id: item.transaction_id,
                    reversal_journal_id: reversal_id,
                    replacement_journal_id: None,
                });
            }
        }
    }

    sqlx::query(
        "UPDATE transaction_batch_previews SET executed_at = $3 WHERE book_id = $1 AND id = $2",
    )
    .bind(book_id)
    .bind(preview_id)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    record_audit(
        &mut tx,
        &principal,
        book_id,
        "transaction_batch.executed",
        "transaction_batch_preview",
        preview_id,
        serde_json::json!({
            "operation": stored.operation,
            "item_count": results.len(),
        }),
        Some(&reason),
    )
    .await?;
    sqlx::query(
        r#"
        INSERT INTO outbox_events (book_id, event_type, aggregate_type, aggregate_id, payload)
        VALUES ($1, 'transaction_batch.executed', 'transaction_batch_preview', $2,
                jsonb_build_object('preview_id', $2, 'operation', $3::text, 'item_count', $4::bigint))
        "#,
    )
    .bind(book_id)
    .bind(preview_id)
    .bind(&stored.operation)
    .bind(results.len() as i64)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    tx.commit().await.map_err(ApiError::database)?;

    Ok(Json(BatchExecutionResponse {
        preview_id,
        operation: stored.operation,
        executed_at: now,
        results,
    }))
}

fn reverse_command(
    book_id: i64,
    transaction_id: i64,
    principal: &Principal,
    reason: &str,
) -> ReverseJournal {
    ReverseJournal {
        book_id,
        journal_id: transaction_id,
        occurred_at: OffsetDateTime::now_utc(),
        reason: reason.to_owned(),
        actor_user_id: principal.user_id,
        audit_actor_kind: actor_kind(principal),
    }
}

fn validate_reason(reason: &str) -> Result<(), ApiError> {
    let length = reason.trim().chars().count();
    if !(1..=500).contains(&length) {
        return Err(ApiError::bad_request(
            "batch_reason_invalid",
            "批量操作原因长度必须为 1 到 500 个字符",
        ));
    }
    Ok(())
}

fn validate_batch_items(items: &[VersionedTransaction]) -> Result<(), ApiError> {
    if items.is_empty() || items.len() > MAX_BATCH_ITEMS {
        return Err(ApiError::bad_request(
            "batch_size_invalid",
            format!("每次批量操作必须包含 1 到 {MAX_BATCH_ITEMS} 笔交易"),
        ));
    }
    let unique = items
        .iter()
        .map(|item| item.transaction_id)
        .collect::<BTreeSet<_>>();
    if unique.len() != items.len() {
        return Err(ApiError::bad_request(
            "batch_duplicate_transaction",
            "批量操作不能重复包含同一笔交易",
        ));
    }
    if items.iter().any(|item| item.version <= 0) {
        return Err(ApiError::bad_request(
            "version_invalid",
            "交易版本必须大于 0",
        ));
    }
    Ok(())
}

async fn validate_source(
    pool: &sqlx::PgPool,
    book_id: i64,
    transaction_id: i64,
    expected_version: i64,
) -> Result<(), ApiError> {
    let row = sqlx::query_as::<_, (String, i64, Option<i64>)>(
        "SELECT status, version, reversal_of_id FROM journal_entries WHERE book_id = $1 AND id = $2",
    )
    .bind(book_id)
    .bind(transaction_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("交易不存在"))?;
    validate_source_state(&row.0, row.1, row.2, expected_version)
}

fn validate_source_state(
    status: &str,
    version: i64,
    reversal_of_id: Option<i64>,
    expected_version: i64,
) -> Result<(), ApiError> {
    if reversal_of_id.is_some() {
        return Err(ApiError::bad_request(
            "reversal_batch_invalid",
            "冲正分录不能参与批量编辑或删除",
        ));
    }
    if status != "posted" {
        return Err(ApiError::conflict(
            "journal_not_editable",
            "只有尚未冲正的已入账交易可以参与批量操作",
        ));
    }
    if version != expected_version {
        return Err(ApiError::conflict(
            "version_conflict",
            "交易已经变化，请重新生成预览",
        ));
    }
    Ok(())
}

async fn lock_and_validate_sources(
    tx: &mut Transaction<'_, Postgres>,
    book_id: i64,
    items: &[VersionedTransaction],
) -> Result<(), ApiError> {
    for item in items {
        let row = sqlx::query_as::<_, (String, i64, Option<i64>)>(
            r#"
            SELECT status, version, reversal_of_id
            FROM journal_entries
            WHERE book_id = $1 AND id = $2
            FOR UPDATE
            "#,
        )
        .bind(book_id)
        .bind(item.transaction_id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found("交易不存在"))?;
        validate_source_state(&row.0, row.1, row.2, item.version)?;
    }
    Ok(())
}

async fn load_postings(
    tx: &mut Transaction<'_, Postgres>,
    book_id: i64,
    transaction_id: i64,
) -> Result<Vec<PostingInput>, ApiError> {
    sqlx::query_as::<
        _,
        (
            i64,
            Option<i64>,
            Option<i64>,
            Decimal,
            Decimal,
            Option<String>,
        ),
    >(
        r#"
        SELECT account_id, category_id, budget_id, amount, book_amount, memo
        FROM postings
        WHERE book_id = $1 AND journal_entry_id = $2
        ORDER BY line_no
        "#,
    )
    .bind(book_id)
    .bind(transaction_id)
    .fetch_all(&mut **tx)
    .await
    .map(|rows| {
        rows.into_iter()
            .map(
                |(account_id, category_id, budget_id, amount, book_amount, memo)| PostingInput {
                    account_id,
                    category_id,
                    budget_id,
                    amount,
                    book_amount,
                    memo,
                },
            )
            .collect()
    })
    .map_err(ApiError::database)
}

async fn accumulate_source_impact(
    pool: &sqlx::PgPool,
    book_id: i64,
    transaction_id: i64,
    impacts: &mut BTreeMap<i64, Decimal>,
    multiplier: Decimal,
) -> Result<(), ApiError> {
    let rows = sqlx::query_as::<_, (i64, Decimal)>(
        "SELECT account_id, book_amount FROM postings WHERE book_id = $1 AND journal_entry_id = $2",
    )
    .bind(book_id)
    .bind(transaction_id)
    .fetch_all(pool)
    .await
    .map_err(ApiError::database)?;
    for (account_id, amount) in rows {
        *impacts.entry(account_id).or_default() += amount * multiplier;
    }
    Ok(())
}

fn accumulate_postings(
    postings: &[PostingInput],
    impacts: &mut BTreeMap<i64, Decimal>,
    multiplier: Decimal,
) {
    for posting in postings {
        *impacts.entry(posting.account_id).or_default() += posting.book_amount * multiplier;
    }
}

async fn hydrate_impacts(
    pool: &sqlx::PgPool,
    book_id: i64,
    impacts: BTreeMap<i64, Decimal>,
) -> Result<Vec<AccountImpact>, ApiError> {
    let account_ids = impacts.keys().copied().collect::<Vec<_>>();
    let names = sqlx::query_as::<_, (i64, String)>(
        "SELECT id, name FROM ledger_accounts WHERE book_id = $1 AND id = ANY($2)",
    )
    .bind(book_id)
    .bind(&account_ids)
    .fetch_all(pool)
    .await
    .map_err(ApiError::database)?
    .into_iter()
    .collect::<BTreeMap<_, _>>();
    Ok(impacts
        .into_iter()
        .filter(|(_, delta)| !delta.is_zero())
        .map(|(account_id, book_amount_delta)| AccountImpact {
            account_id,
            account_name: names.get(&account_id).cloned().unwrap_or_default(),
            book_amount_delta,
        })
        .collect())
}

#[allow(clippy::too_many_arguments)]
async fn record_audit(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    book_id: i64,
    action: &'static str,
    entity_type: &'static str,
    entity_id: i64,
    after_data: serde_json::Value,
    reason: Option<&str>,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, book_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, after_data, reason
        )
        SELECT b.organization_id, b.id, $2, $3, $4, $5, $6, $7, $8
        FROM books b WHERE b.id = $1
        "#,
    )
    .bind(book_id)
    .bind(actor_kind(principal).as_str())
    .bind(principal.user_id)
    .bind(action)
    .bind(entity_type)
    .bind(entity_id)
    .bind(after_data)
    .bind(reason)
    .execute(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    Ok(())
}

fn normalize_description(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 120 {
        return Err(ApiError::bad_request(
            "description_invalid",
            "交易描述长度必须为 1 到 120 个字符",
        ));
    }
    Ok(value.to_owned())
}
