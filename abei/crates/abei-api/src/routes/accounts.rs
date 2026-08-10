use abei_core::AccountsListParams;
use axum::Json;
use axum::extract::State;
use serde_json::Value;

use crate::auth::AuthToken;
use crate::extract::{ValidQuery, check_enum, check_limit, check_page};
use crate::problem::Problem;
use crate::state::AppState;

const ACCOUNT_TYPES: &[&str] = &["asset", "expense", "revenue", "liability", "all"];

pub async fn list(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    ValidQuery(params): ValidQuery<AccountsListParams>,
) -> Result<Json<Value>, Problem> {
    check_enum("type", params.kind.as_ref(), ACCOUNT_TYPES)?;
    check_page(params.page)?;
    check_limit(params.limit)?;

    let query = [
        ("type", params.kind.unwrap_or_default()),
        (
            "page",
            params.page.map(|v| v.to_string()).unwrap_or_default(),
        ),
        (
            "limit",
            params.limit.map(|v| v.to_string()).unwrap_or_default(),
        ),
    ];

    state
        .firefly
        .get_json(&token, "/api/v1/accounts", &query)
        .await
        .map(Json)
        .map_err(|problem| problem.at("accounts", "list"))
}
