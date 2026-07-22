use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    middleware,
    response::IntoResponse,
    routing::{delete, get, post, put},
};
use serde::Serialize;
use sqlx::PgPool;
use tower_http::{
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    trace::TraceLayer,
};

use crate::{
    access, admin, advanced_transactions, api, auth, config::Config, instance, invitation, mfa,
    password_reset, planning, reconciliation, transaction_links,
};

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub cookie_secure: bool,
    pub allowed_origin: String,
    pub secret_key: [u8; 32],
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_username: String,
    pub smtp_password: String,
    pub mail_from: String,
    pub public_url: String,
}

impl AppState {
    pub fn session_cookie_name(&self) -> &'static str {
        if self.cookie_secure {
            "__Host-granary_session"
        } else {
            "granary_session"
        }
    }
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
    version: &'static str,
}

pub fn router(pool: PgPool, config: &Config) -> Router {
    let state = AppState {
        pool,
        cookie_secure: config.cookie_secure,
        allowed_origin: config.allowed_origin.clone(),
        secret_key: config.secret_key,
        smtp_host: config.smtp_host.clone(),
        smtp_port: config.smtp_port,
        smtp_username: config.smtp_username.clone(),
        smtp_password: config.smtp_password.clone(),
        mail_from: config.mail_from.clone(),
        public_url: config.public_url.clone(),
    };
    let protected = Router::new()
        .route("/api/v1/auth/logout", post(auth::logout))
        .route("/api/v1/me", get(auth::me))
        .route("/api/v1/auth/sessions", get(auth::list_sessions))
        .route(
            "/api/v1/auth/sessions/{session_id}",
            delete(auth::revoke_session),
        )
        .route(
            "/api/v1/auth/pats",
            get(auth::list_pats).post(auth::create_pat),
        )
        .route("/api/v1/auth/pats/{pat_id}", delete(auth::revoke_pat))
        .route("/api/v1/auth/mfa", get(mfa::status).delete(mfa::disable))
        .route("/api/v1/auth/mfa/setup", post(mfa::setup))
        .route("/api/v1/auth/mfa/confirm", post(mfa::confirm))
        .route(
            "/api/v1/auth/mfa/recovery-codes",
            post(mfa::regenerate_recovery_codes),
        )
        .route(
            "/api/v1/organizations",
            get(api::list_organizations).post(api::create_organization),
        )
        .route(
            "/api/v1/organizations/{organization_id}",
            put(api::update_organization).delete(api::archive_organization),
        )
        .route(
            "/api/v1/organizations/{organization_id}/restore",
            post(api::restore_organization),
        )
        .route(
            "/api/v1/organizations/{organization_id}/books",
            post(api::create_book),
        )
        .route(
            "/api/v1/organizations/{organization_id}/members",
            get(access::list_organization_members).post(access::add_organization_member),
        )
        .route(
            "/api/v1/organizations/{organization_id}/members/{user_id}",
            put(access::update_organization_member).delete(access::remove_organization_member),
        )
        .route(
            "/api/v1/organizations/{organization_id}/invitations",
            get(invitation::list_invitations).post(invitation::create_invitation),
        )
        .route(
            "/api/v1/organizations/{organization_id}/invitations/{invitation_id}",
            delete(invitation::revoke_invitation),
        )
        .route("/api/v1/books", get(api::list_books))
        .route(
            "/api/v1/books/{book_id}",
            put(api::update_book).delete(api::archive_book),
        )
        .route("/api/v1/books/{book_id}/restore", post(api::restore_book))
        .route(
            "/api/v1/books/{book_id}/members",
            get(access::list_book_members).post(access::add_book_member),
        )
        .route(
            "/api/v1/books/{book_id}/members/{user_id}",
            put(access::update_book_member).delete(access::remove_book_member),
        )
        .route(
            "/api/v1/books/{book_id}/accounts",
            get(api::list_accounts).post(api::create_account),
        )
        .route(
            "/api/v1/books/{book_id}/accounts/{account_id}",
            put(api::update_account).delete(api::archive_account),
        )
        .route(
            "/api/v1/books/{book_id}/accounts/{account_id}/restore",
            post(api::restore_account),
        )
        .route(
            "/api/v1/books/{book_id}/categories",
            get(api::list_categories).post(api::create_category),
        )
        .route(
            "/api/v1/books/{book_id}/categories/{category_id}",
            put(api::update_category).delete(api::archive_category),
        )
        .route(
            "/api/v1/books/{book_id}/categories/{category_id}/restore",
            post(api::restore_category),
        )
        .route(
            "/api/v1/books/{book_id}/tags",
            get(planning::list_tags).post(planning::create_tag),
        )
        .route(
            "/api/v1/books/{book_id}/tags/{tag_id}",
            put(planning::update_tag).delete(planning::archive_tag),
        )
        .route(
            "/api/v1/books/{book_id}/tags/{tag_id}/restore",
            post(planning::restore_tag),
        )
        .route(
            "/api/v1/books/{book_id}/budgets",
            get(planning::list_budgets).post(planning::create_budget),
        )
        .route(
            "/api/v1/books/{book_id}/budgets/{budget_id}",
            put(planning::update_budget).delete(planning::archive_budget),
        )
        .route(
            "/api/v1/books/{book_id}/budgets/{budget_id}/restore",
            post(planning::restore_budget),
        )
        .route(
            "/api/v1/books/{book_id}/budgets/{budget_id}/limits",
            get(planning::list_budget_limits).post(planning::create_budget_limit),
        )
        .route(
            "/api/v1/books/{book_id}/budgets/{budget_id}/limits/{limit_id}",
            put(planning::update_budget_limit).delete(planning::archive_budget_limit),
        )
        .route(
            "/api/v1/books/{book_id}/budgets/{budget_id}/limits/{limit_id}/restore",
            post(planning::restore_budget_limit),
        )
        .route(
            "/api/v1/books/{book_id}/budget-report",
            get(planning::budget_report),
        )
        .route(
            "/api/v1/books/{book_id}/counterparties",
            get(api::list_counterparties).post(api::create_counterparty),
        )
        .route(
            "/api/v1/books/{book_id}/counterparties/{counterparty_id}",
            put(api::update_counterparty).delete(api::archive_counterparty),
        )
        .route(
            "/api/v1/books/{book_id}/counterparties/{counterparty_id}/restore",
            post(api::restore_counterparty),
        )
        .route(
            "/api/v1/books/{book_id}/transactions",
            get(api::list_transactions).post(api::create_transaction),
        )
        .route(
            "/api/v1/books/{book_id}/transactions/recycle-bin",
            get(api::list_transaction_recycle_bin),
        )
        .route(
            "/api/v1/books/{book_id}/transactions/batches/preview",
            post(advanced_transactions::preview_batch_transactions),
        )
        .route(
            "/api/v1/books/{book_id}/transactions/batches/{preview_id}/execute",
            post(advanced_transactions::execute_batch_transactions),
        )
        .route(
            "/api/v1/books/{book_id}/transactions/{transaction_id}",
            get(api::show_transaction),
        )
        .route(
            "/api/v1/books/{book_id}/transactions/{transaction_id}/clone",
            post(advanced_transactions::clone_transaction),
        )
        .route(
            "/api/v1/books/{book_id}/transactions/{transaction_id}/reverse",
            post(api::reverse_transaction),
        )
        .route(
            "/api/v1/books/{book_id}/transactions/{transaction_id}/trash",
            post(api::trash_transaction),
        )
        .route(
            "/api/v1/books/{book_id}/transactions/{transaction_id}/restore",
            post(api::restore_transaction),
        )
        .route(
            "/api/v1/books/{book_id}/transaction-links",
            get(transaction_links::list_transaction_links)
                .post(transaction_links::create_transaction_link),
        )
        .route(
            "/api/v1/books/{book_id}/transaction-links/{link_id}",
            delete(transaction_links::delete_transaction_link),
        )
        .route(
            "/api/v1/books/{book_id}/transaction-links/{link_id}/restore",
            post(transaction_links::restore_transaction_link),
        )
        .route(
            "/api/v1/books/{book_id}/reconciliations",
            get(reconciliation::list_reconciliations).post(reconciliation::create_reconciliation),
        )
        .route(
            "/api/v1/books/{book_id}/reconciliations/{reconciliation_id}",
            get(reconciliation::show_reconciliation)
                .put(reconciliation::update_reconciliation)
                .delete(reconciliation::cancel_reconciliation),
        )
        .route(
            "/api/v1/books/{book_id}/reconciliations/{reconciliation_id}/complete",
            post(reconciliation::complete_reconciliation),
        )
        .route("/api/v1/admin/users", get(admin::list_users))
        .route(
            "/api/v1/admin/users/{user_id}/disable",
            post(admin::disable_user),
        )
        .route(
            "/api/v1/admin/users/{user_id}/restore",
            post(admin::restore_user),
        )
        .route(
            "/api/v1/admin/users/{user_id}/instance-admin",
            put(admin::update_instance_admin),
        )
        .route(
            "/api/v1/admin/users/{user_id}/mfa/reset",
            post(admin::reset_user_mfa),
        )
        .route(
            "/api/v1/admin/users/{user_id}/sessions",
            get(admin::list_user_sessions),
        )
        .route(
            "/api/v1/admin/users/{user_id}/sessions/{session_id}",
            delete(admin::revoke_user_session),
        )
        .route(
            "/api/v1/admin/users/{user_id}/pats",
            get(admin::list_user_pats),
        )
        .route(
            "/api/v1/admin/users/{user_id}/pats/{pat_id}",
            delete(admin::revoke_user_pat),
        )
        .route(
            "/api/v1/admin/instance/settings",
            get(instance::admin_settings).put(instance::update_settings),
        )
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/api/v1/instance", get(instance::info))
        .route("/api/v1/auth/bootstrap", post(auth::bootstrap))
        .route("/api/v1/auth/register", post(instance::register))
        .route("/api/v1/auth/login", post(auth::login))
        .route(
            "/api/v1/auth/password-reset/request",
            post(password_reset::request),
        )
        .route(
            "/api/v1/auth/password-reset/confirm",
            post(password_reset::reset),
        )
        .route("/api/v1/auth/mfa/verify-login", post(mfa::verify_login))
        .route(
            "/api/v1/auth/invitations/accept",
            post(invitation::accept_invitation),
        )
        .merge(protected)
        .with_state(state)
        .layer(PropagateRequestIdLayer::x_request_id())
        .layer(SetRequestIdLayer::x_request_id(MakeRequestUuid))
        .layer(TraceLayer::new_for_http())
}

async fn live() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "granary-server",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pool)
        .await
    {
        Ok(1) => (
            StatusCode::OK,
            Json(HealthResponse {
                status: "ok",
                service: "granary-server",
                version: env!("CARGO_PKG_VERSION"),
            }),
        ),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(HealthResponse {
                status: "unavailable",
                service: "granary-server",
                version: env!("CARGO_PKG_VERSION"),
            }),
        ),
    }
}
