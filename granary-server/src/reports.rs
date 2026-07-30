use axum::{
    Extension, Json,
    extract::{Path, Query, State},
};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use time::Date;

use crate::{
    api::require_book,
    auth::{ApiError, Principal},
    http::AppState,
};

#[derive(Deserialize)]
pub struct DateRangeQuery {
    start: String,
    end: String,
}

#[derive(Serialize, FromRow)]
pub struct SummaryResponse {
    currency_code: String,
    #[serde(with = "rust_decimal::serde::str")]
    expense: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    income: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    net_cashflow: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    net_worth: Decimal,
}

#[derive(Serialize, FromRow)]
pub struct CategoryExpenseResponse {
    id: i64,
    name: String,
    currency_code: String,
    #[serde(with = "rust_decimal::serde::str")]
    amount: Decimal,
}

pub async fn summary(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<DateRangeQuery>,
) -> Result<Json<SummaryResponse>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let (start, end) = parse_range(&query)?;
    let row = sqlx::query_as::<_, SummaryResponse>(
        r#"
        SELECT b.base_currency_code AS currency_code,
               COALESCE((
                   SELECT sum(p.book_amount)
                   FROM postings p
                   JOIN journal_entries j ON j.id = p.journal_entry_id
                   JOIN ledger_accounts a ON a.id = p.account_id
                   WHERE p.book_id = b.id AND j.status IN ('posted', 'reversed')
                     AND a.class = 'expense'
                     AND (j.occurred_at AT TIME ZONE b.timezone)::date BETWEEN $2 AND $3
               ), 0) AS expense,
               COALESCE((
                   SELECT -sum(p.book_amount)
                   FROM postings p
                   JOIN journal_entries j ON j.id = p.journal_entry_id
                   JOIN ledger_accounts a ON a.id = p.account_id
                   WHERE p.book_id = b.id AND j.status IN ('posted', 'reversed')
                     AND a.class = 'income'
                     AND (j.occurred_at AT TIME ZONE b.timezone)::date BETWEEN $2 AND $3
               ), 0) AS income,
               COALESCE((
                   SELECT -sum(p.book_amount)
                   FROM postings p
                   JOIN journal_entries j ON j.id = p.journal_entry_id
                   JOIN ledger_accounts a ON a.id = p.account_id
                   WHERE p.book_id = b.id AND j.status IN ('posted', 'reversed')
                     AND a.class IN ('expense', 'income')
                     AND (j.occurred_at AT TIME ZONE b.timezone)::date BETWEEN $2 AND $3
               ), 0) AS net_cashflow,
               COALESCE((
                   SELECT sum(p.book_amount)
                   FROM postings p
                   JOIN journal_entries j ON j.id = p.journal_entry_id
                   JOIN ledger_accounts a ON a.id = p.account_id
                   WHERE p.book_id = b.id AND j.status IN ('posted', 'reversed')
                     AND a.class IN ('asset', 'liability')
               ), 0) AS net_worth
        FROM books b
        WHERE b.id = $1
        "#,
    )
    .bind(book_id)
    .bind(start)
    .bind(end)
    .fetch_one(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(row))
}

pub async fn expense_by_category(
    State(state): State<AppState>,
    Extension(principal): Extension<Principal>,
    Path(book_id): Path<i64>,
    Query(query): Query<DateRangeQuery>,
) -> Result<Json<Vec<CategoryExpenseResponse>>, ApiError> {
    require_book(&state.pool, &principal, book_id, false).await?;
    let (start, end) = parse_range(&query)?;
    let rows = sqlx::query_as::<_, CategoryExpenseResponse>(
        r#"
        SELECT c.id, c.name, b.base_currency_code AS currency_code,
               sum(p.book_amount) AS amount
        FROM categories c
        JOIN books b ON b.id = c.book_id
        JOIN postings p
          ON p.book_id = c.book_id AND p.category_id = c.id
        JOIN ledger_accounts a
          ON a.book_id = p.book_id AND a.id = p.account_id
        JOIN journal_entries j ON j.id = p.journal_entry_id
        WHERE c.book_id = $1 AND a.class = 'expense'
          AND j.status IN ('posted', 'reversed')
          AND (j.occurred_at AT TIME ZONE b.timezone)::date BETWEEN $2 AND $3
        GROUP BY c.id, c.name, b.base_currency_code
        HAVING sum(p.book_amount) <> 0
        ORDER BY amount DESC, c.name, c.id
        "#,
    )
    .bind(book_id)
    .bind(start)
    .bind(end)
    .fetch_all(&state.pool)
    .await
    .map_err(ApiError::database)?;
    Ok(Json(rows))
}

fn parse_range(query: &DateRangeQuery) -> Result<(Date, Date), ApiError> {
    let format = time::format_description::parse_borrowed::<3>("[year]-[month]-[day]")
        .map_err(ApiError::internal)?;
    let start = Date::parse(&query.start, &format)
        .map_err(|_| ApiError::bad_request("date_invalid", "start 必须是 YYYY-MM-DD"))?;
    let end = Date::parse(&query.end, &format)
        .map_err(|_| ApiError::bad_request("date_invalid", "end 必须是 YYYY-MM-DD"))?;
    if start > end {
        return Err(ApiError::bad_request(
            "date_range_invalid",
            "start 不能晚于 end",
        ));
    }
    Ok((start, end))
}
