pub mod auth;
pub mod config;
pub mod extract;
pub mod firefly;
pub mod openapi;
pub mod problem;
pub mod routes;
pub mod state;
pub mod summary;
#[cfg(feature = "testkit")]
pub mod testkit;

use axum::Router;
use axum::routing::{any, get, patch, post};
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::TraceLayer;

use crate::state::AppState;

/// 路由表。资源路径来自能力目录（见 abei_core::Capability::route_path），
/// 集成测试会逐条比对，防止目录与实际挂载漂移。
pub fn build_app(state: AppState) -> Router {
    let protected = Router::new()
        .route("/v1/catalog", get(routes::catalog::get_catalog))
        .route("/v1/transactions", get(routes::transactions::list))
        .route(
            "/v1/transactions/summary",
            get(routes::transactions::summary),
        )
        .route("/v1/transactions/search", get(routes::transactions::search))
        .route("/v1/transactions/{id}", get(routes::transactions::show))
        .route("/v1/accounts", get(routes::accounts::list))
        // 账单收件箱。集合级的意图动词排在 {id} 前面，静态段先匹配。
        .route("/v1/bills", get(routes::bills::list))
        .route("/v1/bills/sync", post(routes::bills::sync))
        .route("/v1/bills/process", post(routes::bills::process))
        .route("/v1/bills/{id}", get(routes::bills::show))
        .route("/v1/bills/{id}/review", get(routes::bills::review))
        .route("/v1/bills/{id}/import", post(routes::bills::import))
        .route("/v1/bills/{id}/unlock", post(routes::bills::unlock))
        .route("/v1/bills/{id}/ignore", post(routes::bills::ignore))
        .route("/v1/bills/{id}/retry", post(routes::bills::retry))
        .route("/v1/rows/{id}", patch(routes::rows::update))
        .route("/v1/rows/{id}/split", post(routes::rows::split))
        .route("/v1/firefly/{*path}", any(routes::proxy::proxy))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_token,
        ));

    Router::new()
        .route("/health", get(routes::health))
        .route("/v1/openapi.json", get(routes::openapi_json))
        .merge(protected)
        .fallback(routes::not_found)
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .with_state(state)
}
