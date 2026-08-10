//! 透传逃生舱。还没建模的 Firefly 接口从这里走，客户端不必绕过 abei-api 另开一条连接。
//! 建模一个域之后，对应路径就该从透传改成正式资源接口。

use axum::body::to_bytes;
use axum::extract::{Request, State};
use axum::response::Response;

use crate::auth::AuthToken;
use crate::problem::Problem;
use crate::state::AppState;

const PREFIX: &str = "/v1/firefly";
const MAX_BODY: usize = 16 * 1024 * 1024;

pub async fn proxy(
    State(state): State<AppState>,
    AuthToken(token): AuthToken,
    request: Request,
) -> Result<Response, Problem> {
    let path = request
        .uri()
        .path()
        .strip_prefix(PREFIX)
        .unwrap_or_default()
        .to_owned();
    if path.is_empty() || path == "/" {
        return Err(Problem::not_found(
            "透传要带上 Firefly 的完整路径，例如 /v1/firefly/api/v1/about。",
        ));
    }

    let method = request.method().clone();
    let query = request.uri().query().map(str::to_owned);
    let headers = request.headers().clone();
    let body = to_bytes(request.into_body(), MAX_BODY)
        .await
        .map_err(|error| Problem::invalid_params(format!("请求体读不下来：{error}")))?;

    state
        .firefly
        .proxy(&token, method, &path, query.as_deref(), &headers, body)
        .await
}
