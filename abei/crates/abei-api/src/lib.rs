pub mod auth;
pub mod config;
mod existing_transactions;
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
use axum::routing::{any, delete, get, patch, post};
use tower_http::request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer};
use tower_http::trace::TraceLayer;

use crate::state::AppState;

/// 路由表。资源路径来自能力目录（见 abei_core::Capability::route_path），
/// 集成测试会逐条比对，防止目录与实际挂载漂移。
pub fn build_app(state: AppState) -> Router {
    let protected = Router::new()
        .route("/v1/catalog", get(routes::catalog::get_catalog))
        .route("/v1/session", get(routes::session))
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
        .route(
            "/v1/bills/mailbox",
            get(routes::server::proxy).put(routes::server::proxy),
        )
        .route(
            "/v1/bills/mailbox/google/connect",
            post(routes::server::proxy),
        )
        .route(
            "/v1/bills/mailbox/google/callback",
            post(routes::server::proxy),
        )
        .route("/v1/bills/mailbox/google", delete(routes::server::proxy))
        .route("/v1/bills/sync", post(routes::bills::sync))
        .route("/v1/bills/{id}", get(routes::bills::show))
        .route("/v1/bills/{id}/review", get(routes::bills::review))
        .route("/v1/bills/{id}/rows", get(routes::server::proxy))
        .route("/v1/bills/{id}/artifacts", get(routes::server::proxy))
        .route("/v1/bills/{id}/events", get(routes::server::proxy))
        .route(
            "/v1/bills/{id}/import",
            post(routes::bill_imports::import_document),
        )
        .route("/v1/bills/{id}/unlock", post(routes::bills::unlock))
        .route("/v1/bills/{id}/ignore", post(routes::bills::ignore))
        .route("/v1/bills/{id}/retry", post(routes::bills::retry))
        .route("/v1/bill-documents", get(routes::server::proxy))
        .route("/v1/bill-documents/{id}", get(routes::server::proxy))
        .route(
            "/v1/bill-documents/{id}/revisions",
            get(routes::server::proxy),
        )
        .route(
            "/v1/bill-documents/{id}/artifacts",
            get(routes::server::proxy),
        )
        .route("/v1/bill-documents/{id}/events", get(routes::server::proxy))
        .route(
            "/v1/bill-artifacts/{id}/download",
            get(routes::server::proxy),
        )
        .route("/v1/bill-documents/{id}/review", get(routes::server::proxy))
        .route(
            "/v1/bill-documents/{id}/reparse",
            post(routes::server::proxy),
        )
        .route(
            "/v1/bill-documents/{id}/archive",
            post(routes::server::proxy),
        )
        .route(
            "/v1/bill-documents/{id}/restore",
            post(routes::server::proxy),
        )
        .route("/v1/parse-jobs/{id}", get(routes::server::proxy))
        .route("/v1/parse-jobs/{id}/retry", post(routes::server::proxy))
        .route("/v1/parse-jobs/{id}/cancel", post(routes::server::proxy))
        .route("/v1/parse-jobs/{id}/secret", post(routes::server::proxy))
        .route("/v1/bill-rows", get(routes::server::proxy))
        .route("/v1/bill-rows/dismiss", post(routes::server::proxy))
        .route("/v1/bill-rows/restore", post(routes::server::proxy))
        .route(
            "/v1/bill-rows/{id}",
            get(routes::server::proxy).patch(routes::rows::update),
        )
        .route(
            "/v1/bill-rows/update-many",
            axum::routing::patch(routes::rows::update_many),
        )
        .route(
            "/v1/bill-rows/import",
            post(routes::bill_imports::import_rows),
        )
        .route("/v1/bill-rows/{id}/split", post(routes::rows::split))
        .route(
            "/v1/bill-rows/{id}/mark-unique",
            post(routes::server::proxy),
        )
        .route("/v1/bill-inbox/summary", get(routes::server::proxy))
        .route(
            "/v1/bill-inbox/processing-summary",
            get(routes::server::proxy),
        )
        .route("/v1/admin/processing-summary", get(routes::server::proxy))
        .route(
            "/v1/bill-import-attempts/{id}",
            get(routes::bill_imports::get_attempt),
        )
        .route(
            "/v1/bill-import-attempts/{id}/reconcile",
            post(routes::bill_imports::reconcile_attempt),
        )
        .route(
            "/v1/bill-import-attempts/{id}/retry",
            post(routes::bill_imports::retry_attempt),
        )
        .route(
            "/v1/bill-account-mappings",
            get(routes::server::proxy).put(routes::bill_imports::upsert_mapping),
        )
        .route(
            "/v1/bill-account-mappings/{id}",
            delete(routes::bill_imports::delete_mapping),
        )
        .route("/v1/mailboxes", get(routes::server::proxy))
        .route(
            "/v1/mailboxes/{id}",
            get(routes::server::proxy).put(routes::server::proxy),
        )
        .route("/v1/mailboxes/{id}/sync", post(routes::server::proxy))
        .route("/v1/mailboxes/{id}/rescan", post(routes::server::proxy))
        .route("/v1/mail-sync-runs", get(routes::server::proxy))
        .route("/v1/mail-sync-runs/{id}", get(routes::server::proxy))
        .route(
            "/v1/mail-sync-runs/{id}/cancel",
            post(routes::server::proxy),
        )
        .route("/v1/mail-messages", get(routes::server::proxy))
        .route("/v1/mail-messages/{id}", get(routes::server::proxy))
        .route("/v1/mail-messages/{id}/raw", get(routes::server::proxy))
        .route("/v1/mail-messages/{id}/cache", post(routes::server::proxy))
        .route(
            "/v1/mail-messages/{id}/reroute",
            post(routes::server::proxy),
        )
        .route(
            "/v1/mail-rules",
            get(routes::server::proxy).post(routes::server::proxy),
        )
        .route("/v1/mail-rules/test", post(routes::server::proxy))
        .route("/v1/mail-rules/{id}", patch(routes::server::proxy))
        .route("/v1/mail-rules/{id}/publish", post(routes::server::proxy))
        .route("/v1/mail-rules/{id}/rollback", post(routes::server::proxy))
        .route(
            "/v1/mail-samples",
            get(routes::server::proxy).post(routes::server::proxy),
        )
        .route("/v1/mail-samples/{id}", delete(routes::server::proxy))
        .route("/v1/parser-flows/validate", post(routes::server::proxy))
        .route("/v1/parser-flows/test-eml", post(routes::server::proxy))
        .route(
            "/v1/parser-flows",
            get(routes::server::proxy).post(routes::server::proxy),
        )
        .route(
            "/v1/parser-flows/{id}",
            get(routes::server::proxy).patch(routes::server::proxy),
        )
        .route("/v1/parser-flows/{id}/clone", post(routes::server::proxy))
        .route("/v1/parser-flows/{id}/test", post(routes::server::proxy))
        .route(
            "/v1/parser-flows/{id}/test-eml",
            post(routes::server::proxy),
        )
        .route("/v1/parser-flows/{id}/publish", post(routes::server::proxy))
        .route(
            "/v1/parser-flows/{id}/rollback",
            post(routes::server::proxy),
        )
        .route("/v1/parser-flows/{id}/retire", post(routes::server::proxy))
        .route("/v1/parser-flows/{id}/versions", get(routes::server::proxy))
        .route(
            "/v1/parser-flows/{id}/versions/{version}",
            get(routes::server::proxy),
        )
        .route(
            "/v1/parser-flows/{id}/test-cases",
            post(routes::server::proxy),
        )
        .route(
            "/v1/parser-test-cases/{id}",
            patch(routes::server::proxy).delete(routes::server::proxy),
        )
        .route("/v1/parser-test-runs/{id}", get(routes::server::proxy))
        .route(
            "/v1/profile-doc",
            get(routes::server::proxy).post(routes::server::proxy),
        )
        .route(
            "/v1/profile-doc/{slug}",
            get(routes::server::proxy)
                .patch(routes::server::proxy)
                .delete(routes::server::proxy),
        )
        .route(
            "/v1/feedback",
            get(routes::server::proxy).post(routes::server::proxy),
        )
        .route("/v1/feedback/{id}", get(routes::server::proxy))
        .route(
            "/v1/feedback/submissions/{id}/confirm",
            post(routes::server::proxy),
        )
        .route(
            "/v1/feedback/submissions/{id}/messages",
            post(routes::server::proxy),
        )
        .route("/v1/admin/feedback/submissions", get(routes::server::proxy))
        .route(
            "/v1/admin/feedback/submissions/{id}",
            get(routes::server::proxy).patch(routes::server::proxy),
        )
        .route(
            "/v1/admin/feedback/submissions/{id}/link",
            post(routes::server::proxy),
        )
        .route(
            "/v1/admin/feedback/submissions/{id}/messages",
            post(routes::server::proxy),
        )
        .route("/v1/admin/feedback/items", get(routes::server::proxy))
        .route(
            "/v1/admin/feedback/items/{id}",
            get(routes::server::proxy).patch(routes::server::proxy),
        )
        .route(
            "/v1/admin/feedback/items/{id}/updates",
            post(routes::server::proxy),
        )
        .route(
            "/v1/admin/feedback/items/{id}/merge",
            post(routes::server::proxy),
        )
        .route(
            "/v1/admin/feedback/items/{id}/archive",
            post(routes::server::proxy),
        )
        .route(
            "/v1/admin/feedback/items/{id}/restore",
            post(routes::server::proxy),
        )
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
