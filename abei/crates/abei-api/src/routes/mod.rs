pub mod accounts;
pub mod bill_imports;
pub mod bills;
pub mod catalog;
pub mod proxy;
pub mod rows;
pub mod server;
pub mod transactions;

use axum::Json;
use axum::extract::{Extension, State};
use axum::http::Uri;
use serde_json::{Value, json};

use crate::auth::AuthIdentity;
use crate::problem::Problem;
use crate::state::AppState;

/// 免鉴权。
pub async fn health(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "abei-api",
        "version": env!("CARGO_PKG_VERSION"),
        "web_url": state.web_url,
    }))
}

/// 免鉴权：OpenAPI 是导出产物，给 web 端生成类型用，不该要令牌。
pub async fn openapi_json() -> Json<Value> {
    Json(crate::openapi::document())
}

/// 当前令牌对应的可信身份，供 Web 做导航与 owner 路由守卫。
pub async fn session(Extension(identity): Extension<AuthIdentity>) -> Json<Value> {
    Json(json!({
        "data": {
            "user_id": identity.0.id,
            "actor": identity.0.actor,
            "role": identity.0.role,
            "is_owner": identity.0.role == "owner",
        }
    }))
}

pub async fn not_found(uri: Uri) -> Problem {
    Problem::not_found(format!(
        "{} 没有这个接口。看 GET /v1/catalog 里有哪些能力。",
        uri.path()
    ))
}
