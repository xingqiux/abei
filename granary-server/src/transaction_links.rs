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
    api::{actor_kind, require_book},
    auth::{ApiError, Principal},
    http::AppState,
};

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionLinkKind {
    Refund,
    Reimbursement,
    Installment,
    Duplicate,
    Related,
    CrossBookTransfer,
}

impl TransactionLinkKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Refund => "refund",
            Self::Reimbursement => "reimbursement",
            Self::Installment => "installment",
            Self::Duplicate => "duplicate",
            Self::Related => "related",
            Self::CrossBookTransfer => "cross_book_transfer",
        }
    }

    fn has_partial_amount(self) -> bool {
        matches!(self, Self::Refund | Self::Reimbursement)
    }
}

#[derive(Deserialize)]
pub struct CreateTransactionLink {
    kind: TransactionLinkKind,
    source_transaction_id: i64,
    target_book_id: Option<i64>,
    target_transaction_id: i64,
    #[serde(default, with = "rust_decimal::serde::str_option")]
    amount: Option<Decimal>,
}

#[derive(Deserialize)]
pub struct TransactionLinkQuery {
    transaction_id: Option<i64>,
    #[serde(default)]
    deleted: bool,
}

#[derive(Deserialize)]
pub struct LinkVersionQuery {
    version: i64,
}

#[derive(Serialize, FromRow)]
pub struct TransactionLinkResponse {
    id: i64,
    kind: String,
    source_book_id: i64,
    source_transaction_id: i64,
    source_description: String,
    target_book_id: i64,
    target_transaction_id: i64,
    target_description: String,
    #[serde(with = "rust_decimal::serde::str_option")]
    amount: Option<Decimal>,
    version: i64,
    #[serde(with = "time::serde::rfc3339::option")]
    deleted_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339")]
    created_at: OffsetDateTime,
}

#[derive(FromRow)]
struct LinkEndpoint {
    status: String,
    reversal_of_id: Option<i64>,
    transaction_type: String,
    expense_amount: Decimal,
    income_amount: Decimal,
}

pub async fn create_transaction_link(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(source_book_id): Path<i64>,
    Json(request): Json<CreateTransactionLink>,
) -> Result<(StatusCode, Json<TransactionLinkResponse>), ApiError> {
    require_book(&state.pool, &principal, source_book_id, true).await?;
    let target_book_id = request.target_book_id.unwrap_or(source_book_id);
    if target_book_id != source_book_id {
        require_book(&state.pool, &principal, target_book_id, true).await?;
    }
    validate_link_shape(
        request.kind,
        source_book_id,
        request.source_transaction_id,
        target_book_id,
        request.target_transaction_id,
        request.amount,
    )?;

    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let (source, target) = lock_endpoints(
        &mut tx,
        source_book_id,
        request.source_transaction_id,
        target_book_id,
        request.target_transaction_id,
    )
    .await?;
    validate_endpoint_types(request.kind, &source, &target)?;
    if let Some(amount) = request.amount {
        validate_partial_totals(
            &mut tx,
            request.source_transaction_id,
            request.target_transaction_id,
            amount,
            source.expense_amount,
            target.income_amount,
            None,
        )
        .await?;
    }

    let link_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO transaction_links (
            kind, source_book_id, source_journal_id, target_book_id,
            target_journal_id, amount, created_by_user_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id
        "#,
    )
    .bind(request.kind.as_str())
    .bind(source_book_id)
    .bind(request.source_transaction_id)
    .bind(target_book_id)
    .bind(request.target_transaction_id)
    .bind(request.amount)
    .bind(principal.user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_link(
        &mut tx,
        &principal,
        source_book_id,
        target_book_id,
        "transaction_link.created",
        link_id,
        serde_json::json!({
            "kind": request.kind.as_str(),
            "source_transaction_id": request.source_transaction_id,
            "target_book_id": target_book_id,
            "target_transaction_id": request.target_transaction_id,
            "amount": request.amount,
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(get_link(&state.pool, link_id).await?),
    ))
}

pub async fn list_transaction_links(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<TransactionLinkQuery>,
) -> Result<Json<Vec<TransactionLinkResponse>>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let rows = sqlx::query_as::<_, TransactionLinkResponse>(
        r#"
        SELECT l.id, l.kind, l.source_book_id,
               l.source_journal_id AS source_transaction_id,
               source.description AS source_description,
               l.target_book_id, l.target_journal_id AS target_transaction_id,
               target.description AS target_description, l.amount, l.version,
               l.deleted_at, l.created_at
        FROM transaction_links l
        JOIN journal_entries source
          ON source.book_id = l.source_book_id AND source.id = l.source_journal_id
        JOIN journal_entries target
          ON target.book_id = l.target_book_id AND target.id = l.target_journal_id
        WHERE ($1 = l.source_book_id OR $1 = l.target_book_id)
          AND ($2::bigint IS NULL OR
               ($1 = l.source_book_id AND $2 = l.source_journal_id) OR
               ($1 = l.target_book_id AND $2 = l.target_journal_id))
          AND ($3 = (l.deleted_at IS NOT NULL))
          AND (
              l.source_book_id = l.target_book_id
              OR EXISTS (
                  SELECT 1
                  FROM book_memberships membership
                  JOIN books other_book ON other_book.id = membership.book_id
                  JOIN organizations organization ON organization.id = other_book.organization_id
                  WHERE membership.user_id = $4
                    AND membership.book_id = CASE
                        WHEN $1 = l.source_book_id THEN l.target_book_id
                        ELSE l.source_book_id
                    END
                    AND other_book.archived_at IS NULL
                    AND organization.archived_at IS NULL
              )
          )
        ORDER BY l.id DESC
        "#,
    )
    .bind(book_id)
    .bind(query.transaction_id)
    .bind(query.deleted)
    .bind(principal.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

pub async fn delete_transaction_link(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, link_id)): Path<(i64, i64)>,
    Query(query): Query<LinkVersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_link_deleted(&state, &principal, book_id, link_id, query.version, true).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_transaction_link(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path((book_id, link_id)): Path<(i64, i64)>,
    Query(query): Query<LinkVersionQuery>,
) -> Result<StatusCode, ApiError> {
    set_link_deleted(&state, &principal, book_id, link_id, query.version, false).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_link_deleted(
    state: &AppState,
    principal: &Principal,
    book_id: i64,
    link_id: i64,
    expected_version: i64,
    deleted: bool,
) -> Result<(), ApiError> {
    require_book(&state.pool, principal, book_id, true).await?;
    let mut tx = state.pool.begin().await.map_err(ApiError::database)?;
    let current = sqlx::query_as::<
        _,
        (
            String,
            i64,
            i64,
            i64,
            i64,
            Option<Decimal>,
            i64,
            Option<OffsetDateTime>,
        ),
    >(
        r#"
        SELECT kind, source_book_id, source_journal_id, target_book_id,
               target_journal_id, amount, version, deleted_at
        FROM transaction_links
        WHERE id = $1 AND ($2 = source_book_id OR $2 = target_book_id)
        FOR UPDATE
        "#,
    )
    .bind(link_id)
    .bind(book_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("交易链接不存在"))?;
    if current.1 != current.3 {
        let other_book_id = if book_id == current.1 {
            current.3
        } else {
            current.1
        };
        require_book(&state.pool, principal, other_book_id, true).await?;
    }
    if current.6 != expected_version {
        return Err(ApiError::conflict(
            "version_conflict",
            "交易链接已经变化，请刷新后重试",
        ));
    }
    if deleted == current.7.is_some() {
        return Err(ApiError::conflict(
            "link_state_conflict",
            if deleted {
                "交易链接已经删除"
            } else {
                "交易链接当前未删除"
            },
        ));
    }
    if !deleted {
        let (source, target) =
            lock_endpoints(&mut tx, current.1, current.2, current.3, current.4).await?;
        let kind = parse_kind(&current.0)?;
        validate_endpoint_types(kind, &source, &target)?;
        if let Some(amount) = current.5 {
            validate_partial_totals(
                &mut tx,
                current.2,
                current.4,
                amount,
                source.expense_amount,
                target.income_amount,
                Some(link_id),
            )
            .await?;
        }
    }
    let deleted_at = deleted.then(OffsetDateTime::now_utc);
    sqlx::query(
        "UPDATE transaction_links SET deleted_at = $2, version = version + 1, updated_at = now() WHERE id = $1",
    )
    .bind(link_id)
    .bind(deleted_at)
    .execute(&mut *tx)
    .await
    .map_err(ApiError::database)?;
    audit_link(
        &mut tx,
        principal,
        current.1,
        current.3,
        if deleted {
            "transaction_link.deleted"
        } else {
            "transaction_link.restored"
        },
        link_id,
        serde_json::json!({
            "kind": current.0,
            "deleted": deleted,
            "version": expected_version + 1,
        }),
    )
    .await?;
    tx.commit().await.map_err(ApiError::database)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_link_shape(
    kind: TransactionLinkKind,
    source_book_id: i64,
    source_transaction_id: i64,
    target_book_id: i64,
    target_transaction_id: i64,
    amount: Option<Decimal>,
) -> Result<(), ApiError> {
    if source_transaction_id == target_transaction_id {
        return Err(ApiError::bad_request(
            "self_link_invalid",
            "交易不能链接到自身",
        ));
    }
    if matches!(kind, TransactionLinkKind::CrossBookTransfer) != (source_book_id != target_book_id)
    {
        return Err(ApiError::bad_request(
            "link_book_invalid",
            "只有跨账本转账链接可以连接不同账本",
        ));
    }
    match (kind.has_partial_amount(), amount) {
        (true, Some(amount)) if amount > Decimal::ZERO => Ok(()),
        (true, _) => Err(ApiError::bad_request(
            "link_amount_required",
            "退款和报销链接必须填写大于 0 的本位币金额",
        )),
        (false, None) => Ok(()),
        (false, Some(_)) => Err(ApiError::bad_request(
            "link_amount_invalid",
            "当前链接类型不接受金额",
        )),
    }
}

fn validate_endpoint_types(
    kind: TransactionLinkKind,
    source: &LinkEndpoint,
    target: &LinkEndpoint,
) -> Result<(), ApiError> {
    for endpoint in [source, target] {
        if endpoint.status != "posted" || endpoint.reversal_of_id.is_some() {
            return Err(ApiError::conflict(
                "link_endpoint_invalid",
                "交易链接两端必须是尚未冲正的原始已入账交易",
            ));
        }
    }
    if matches!(
        kind,
        TransactionLinkKind::Refund
            | TransactionLinkKind::Reimbursement
            | TransactionLinkKind::CrossBookTransfer
    ) && (source.transaction_type != "withdrawal" || target.transaction_type != "deposit")
    {
        return Err(ApiError::bad_request(
            "link_type_mismatch",
            "退款、报销和跨账本转账必须从支出交易指向收入交易",
        ));
    }
    Ok(())
}

async fn lock_endpoints(
    tx: &mut Transaction<'_, Postgres>,
    source_book_id: i64,
    source_transaction_id: i64,
    target_book_id: i64,
    target_transaction_id: i64,
) -> Result<(LinkEndpoint, LinkEndpoint), ApiError> {
    let mut ids = [source_transaction_id, target_transaction_id];
    ids.sort_unstable();
    sqlx::query("SELECT id FROM journal_entries WHERE id = ANY($1) ORDER BY id FOR UPDATE")
        .bind(&ids[..])
        .fetch_all(&mut **tx)
        .await
        .map_err(ApiError::database)?;
    let source = load_endpoint(tx, source_book_id, source_transaction_id).await?;
    let target = load_endpoint(tx, target_book_id, target_transaction_id).await?;
    Ok((source, target))
}

async fn load_endpoint(
    tx: &mut Transaction<'_, Postgres>,
    book_id: i64,
    transaction_id: i64,
) -> Result<LinkEndpoint, ApiError> {
    sqlx::query_as::<_, LinkEndpoint>(
        r#"
        SELECT j.status, j.reversal_of_id,
               CASE
                   WHEN bool_or(a.class = 'expense') THEN 'withdrawal'
                   WHEN bool_or(a.class = 'income') THEN 'deposit'
                   ELSE 'transfer'
               END AS transaction_type,
               COALESCE(sum(p.book_amount) FILTER (WHERE a.class = 'expense' AND p.book_amount > 0), 0)
                   AS expense_amount,
               COALESCE(-sum(p.book_amount) FILTER (WHERE a.class = 'income' AND p.book_amount < 0), 0)
                   AS income_amount
        FROM journal_entries j
        JOIN postings p ON p.book_id = j.book_id AND p.journal_entry_id = j.id
        JOIN ledger_accounts a ON a.book_id = p.book_id AND a.id = p.account_id
        WHERE j.book_id = $1 AND j.id = $2
        GROUP BY j.id, j.status, j.reversal_of_id
        "#,
    )
    .bind(book_id)
    .bind(transaction_id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("交易不存在"))
}

#[allow(clippy::too_many_arguments)]
async fn validate_partial_totals(
    tx: &mut Transaction<'_, Postgres>,
    source_transaction_id: i64,
    target_transaction_id: i64,
    amount: Decimal,
    source_amount: Decimal,
    target_amount: Decimal,
    excluded_link_id: Option<i64>,
) -> Result<(), ApiError> {
    let source_linked = sqlx::query_scalar::<_, Decimal>(
        r#"
        SELECT COALESCE(sum(amount), 0)
        FROM transaction_links
        WHERE source_journal_id = $1 AND kind IN ('refund', 'reimbursement')
          AND deleted_at IS NULL AND ($2::bigint IS NULL OR id <> $2)
        "#,
    )
    .bind(source_transaction_id)
    .bind(excluded_link_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    let target_linked = sqlx::query_scalar::<_, Decimal>(
        r#"
        SELECT COALESCE(sum(amount), 0)
        FROM transaction_links
        WHERE target_journal_id = $1 AND kind IN ('refund', 'reimbursement')
          AND deleted_at IS NULL AND ($2::bigint IS NULL OR id <> $2)
        "#,
    )
    .bind(target_transaction_id)
    .bind(excluded_link_id)
    .fetch_one(&mut **tx)
    .await
    .map_err(ApiError::database)?;
    if source_linked + amount > source_amount {
        return Err(ApiError::conflict(
            "source_link_amount_exceeded",
            "累计退款或报销金额不能超过原支出金额",
        ));
    }
    if target_linked + amount > target_amount {
        return Err(ApiError::conflict(
            "target_link_amount_exceeded",
            "累计关联金额不能超过退款或报销收入金额",
        ));
    }
    Ok(())
}

async fn get_link(pool: &sqlx::PgPool, link_id: i64) -> Result<TransactionLinkResponse, ApiError> {
    sqlx::query_as::<_, TransactionLinkResponse>(
        r#"
        SELECT l.id, l.kind, l.source_book_id,
               l.source_journal_id AS source_transaction_id,
               source.description AS source_description,
               l.target_book_id, l.target_journal_id AS target_transaction_id,
               target.description AS target_description, l.amount, l.version,
               l.deleted_at, l.created_at
        FROM transaction_links l
        JOIN journal_entries source
          ON source.book_id = l.source_book_id AND source.id = l.source_journal_id
        JOIN journal_entries target
          ON target.book_id = l.target_book_id AND target.id = l.target_journal_id
        WHERE l.id = $1
        "#,
    )
    .bind(link_id)
    .fetch_optional(pool)
    .await
    .map_err(ApiError::database)?
    .ok_or_else(|| ApiError::not_found("交易链接不存在"))
}

fn parse_kind(value: &str) -> Result<TransactionLinkKind, ApiError> {
    match value {
        "refund" => Ok(TransactionLinkKind::Refund),
        "reimbursement" => Ok(TransactionLinkKind::Reimbursement),
        "installment" => Ok(TransactionLinkKind::Installment),
        "duplicate" => Ok(TransactionLinkKind::Duplicate),
        "related" => Ok(TransactionLinkKind::Related),
        "cross_book_transfer" => Ok(TransactionLinkKind::CrossBookTransfer),
        _ => Err(ApiError::internal("数据库包含未知交易链接类型")),
    }
}

#[allow(clippy::too_many_arguments)]
async fn audit_link(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    source_book_id: i64,
    target_book_id: i64,
    action: &'static str,
    link_id: i64,
    after_data: serde_json::Value,
) -> Result<(), ApiError> {
    for book_id in if source_book_id == target_book_id {
        vec![source_book_id]
    } else {
        vec![source_book_id, target_book_id]
    } {
        sqlx::query(
            r#"
            INSERT INTO audit_events (
                organization_id, book_id, actor_kind, actor_user_id, action,
                entity_type, entity_id, after_data
            )
            SELECT b.organization_id, b.id, $2, $3, $4,
                   'transaction_link', $5, $6
            FROM books b WHERE b.id = $1
            "#,
        )
        .bind(book_id)
        .bind(actor_kind(principal).as_str())
        .bind(principal.user_id)
        .bind(action)
        .bind(link_id)
        .bind(&after_data)
        .execute(&mut **tx)
        .await
        .map_err(ApiError::database)?;
    }
    Ok(())
}
