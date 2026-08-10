pub mod accounts;
pub mod bills;
pub mod catalog;
pub mod proxy;
pub mod rows;
pub mod transactions;

use axum::Json;
use axum::http::Uri;
use serde_json::{Value, json};

use crate::problem::Problem;

/// 免鉴权。
pub async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "abei-api",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// 免鉴权：OpenAPI 是导出产物，给 web 端生成类型用，不该要令牌。
pub async fn openapi_json() -> Json<Value> {
    Json(crate::openapi::document())
}

pub async fn not_found(uri: Uri) -> Problem {
    Problem::not_found(format!(
        "{} 没有这个接口。看 GET /v1/catalog 里有哪些能力。",
        uri.path()
    ))
}
