use abei_core::{TransactionsListParams, TransactionsSearchParams, TransactionsSummaryParams};
use axum::Json;
use axum::extract::{Path, State};
use serde_json::Value;

use crate::auth::AuthToken;
use crate::extract::{
    ValidQuery, check_date, check_enum, check_id, check_limit, check_page, optional,
};
use crate::problem::Problem;
use crate::state::AppState;
use crate::summary::{Range, fetch_rows, summarize};

const TRANSACTION_TYPES: &[&str] = &["withdrawal", "deposit", "transfer", "all"];

pub async fn list(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    ValidQuery(params): ValidQuery<TransactionsListParams>,
) -> Result<Json<Value>, Problem> {
    check_date("start", params.start.as_ref())?;
    check_date("end", params.end.as_ref())?;
    check_enum("type", params.kind.as_ref(), TRANSACTION_TYPES)?;
    check_page(params.page)?;
    check_limit(params.limit)?;

    let query = [
        ("start", params.start.unwrap_or_default()),
        ("end", params.end.unwrap_or_default()),
        ("type", params.kind.unwrap_or_default()),
        ("page", optional(params.page)),
        ("limit", optional(params.limit)),
    ];

    state
        .firefly
        .get_json(&token, "/api/v1/transactions", &query)
        .await
        .map(Json)
        .map_err(|problem| problem.at("transactions", "list"))
}

/// 全文检索。上游那条叫 `/search/transactions`，词序跟阿贝相反，这里换过来。
pub async fn search(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    ValidQuery(params): ValidQuery<TransactionsSearchParams>,
) -> Result<Json<Value>, Problem> {
    let at = |problem: Problem| problem.at("transactions", "search");

    let query = params.query.trim();
    if query.is_empty() {
        return Err(at(Problem::invalid_params("要搜什么？query 不能是空的。")));
    }
    // 上游限 500 字，就地挡掉，免得换回一个含糊的 422。
    if query.chars().count() > 500 {
        return Err(at(Problem::invalid_params("搜索词最多 500 字。")));
    }
    check_page(params.page).map_err(at)?;
    check_limit(params.limit).map_err(at)?;

    let query = [
        ("query", query.to_owned()),
        ("page", optional(params.page)),
        ("limit", optional(params.limit)),
    ];

    state
        .firefly
        .get_json(&token, "/api/v1/search/transactions", &query)
        .await
        .map(Json)
        .map_err(at)
}

pub async fn show(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    Path(id): Path<String>,
) -> Result<Json<Value>, Problem> {
    let id = check_id(&id).map_err(|problem| problem.at("transactions", "show"))?;

    state
        .firefly
        .get_json(&token, &format!("/api/v1/transactions/{id}"), &[])
        .await
        .map(Json)
        .map_err(|problem| problem.at("transactions", "show"))
}

pub async fn summary(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    ValidQuery(params): ValidQuery<TransactionsSummaryParams>,
) -> Result<Json<Value>, Problem> {
    check_date("start", params.start.as_ref())?;
    check_date("end", params.end.as_ref())?;

    let range = Range {
        start: params.start,
        end: params.end,
    };
    let rows = fetch_rows(&state.firefly, &token, &range)
        .await
        .map_err(|problem| problem.at("transactions", "summary"))?;

    let report = summarize(&rows, &params.exclude_category.unwrap_or_default(), range);
    serde_json::to_value(report)
        .map(Json)
        .map_err(|error| Problem::internal(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_must_be_positive_integers() {
        assert!(check_id("42").is_ok());
        assert!(check_id("0").is_err());
        assert!(check_id("01").is_err());
        assert!(check_id("-1").is_err());
        assert!(check_id("abc").is_err());
        assert!(check_id("").is_err());
    }
}
