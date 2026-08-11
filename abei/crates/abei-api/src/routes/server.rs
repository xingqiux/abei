use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use serde_json::Value;

use crate::auth::AuthIdentity;
use crate::firefly::VerifiedUser;
use crate::problem::Problem;
use crate::state::AppState;

const MAX_BODY: usize = 2 * 1024 * 1024;
const ACTOR_HEADER: &str = "x-abei-authenticated-user";
const ROLE_HEADER: &str = "x-abei-authenticated-role";
const USER_ID_HEADER: &str = "x-abei-authenticated-user-id";

/// `abei-server` 只接受这里注入的可信身份头；浏览器传入的同名头会被丢弃。
pub async fn proxy(State(state): State<AppState>, request: Request) -> Result<Response, Problem> {
    let identity = request
        .extensions()
        .get::<AuthIdentity>()
        .cloned()
        .ok_or_else(|| Problem::internal("认证中间件没有提供用户身份。"))?;
    let mut path = request.uri().path().to_owned();
    if let Some(query) = request.uri().query() {
        path.push('?');
        path.push_str(query);
    }

    let method = request.method().clone();
    let headers = request.headers().clone();
    let body = to_bytes(request.into_body(), MAX_BODY)
        .await
        .map_err(|error| Problem::invalid_params(format!("请求体读不下来：{error}")))?;
    forward(&state, &identity.0, method, &path, &headers, body).await
}

pub async fn send_json(
    state: &AppState,
    identity: &VerifiedUser,
    method: Method,
    path: &str,
    body: &Value,
) -> Result<Response, Problem> {
    let upstream = state
        .http
        .request(method, format!("{}{path}", state.server_url))
        .header(ACTOR_HEADER, &identity.actor)
        .header(ROLE_HEADER, &identity.role)
        .header(USER_ID_HEADER, identity.id)
        .json(body)
        .send()
        .await
        .map_err(server_unavailable)?;
    response(upstream)
}

async fn forward(
    state: &AppState,
    identity: &VerifiedUser,
    method: Method,
    path: &str,
    headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, Problem> {
    let mut upstream = state
        .http
        .request(method, format!("{}{path}", state.server_url));
    for (name, value) in headers {
        if !crate::firefly::is_hop_by_hop(name)
            && name != "authorization"
            && name != ACTOR_HEADER
            && name != ROLE_HEADER
            && name != USER_ID_HEADER
        {
            upstream = upstream.header(name, value);
        }
    }
    upstream = upstream
        .header(ACTOR_HEADER, &identity.actor)
        .header(ROLE_HEADER, &identity.role)
        .header(USER_ID_HEADER, identity.id);
    if !body.is_empty() {
        upstream = upstream.body(body);
    }

    let upstream = upstream.send().await.map_err(server_unavailable)?;
    response(upstream)
}

fn response(upstream: reqwest::Response) -> Result<Response, Problem> {
    let status = upstream.status();
    let mut response = Response::builder().status(status);
    for (name, value) in upstream.headers() {
        if !crate::firefly::is_hop_by_hop(name) {
            response = response.header(name, value);
        }
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|error| Problem::internal(error.to_string()))
}

fn server_unavailable(error: reqwest::Error) -> Problem {
    Problem::server_unavailable(format!(
        "abei-server 没有响应：{error}。确认它已启动，或检查 ABEI_SERVER_URL。"
    ))
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderName;

    #[test]
    fn server_proxy_uses_the_complete_hop_by_hop_list() {
        for name in [
            "connection",
            "keep-alive",
            "proxy-authenticate",
            "proxy-authorization",
            "te",
            "trailer",
            "transfer-encoding",
            "upgrade",
            "host",
            "content-length",
        ] {
            assert!(crate::firefly::is_hop_by_hop(&HeaderName::from_static(
                name
            )));
        }
    }
}
