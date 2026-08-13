use axum::body::{Body, Bytes, to_bytes};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::http::{HeaderMap, Method};
use axum::response::Response;
use serde_json::Value;

use crate::auth::AuthIdentity;
use crate::firefly::VerifiedUser;
use crate::problem::Problem;
use crate::state::AppState;

// 1 MiB Markdown 在 JSON 里经过转义可能明显变大，入口仍保留一个明确上限。
const MAX_BODY: usize = 8 * 1024 * 1024;
const MAX_EML_BODY: usize = 26 * 1024 * 1024;
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
    let request_path = request.uri().path().to_owned();
    let max_body = if request_path.ends_with("/test-eml") {
        MAX_EML_BODY
    } else {
        MAX_BODY
    };
    let mut path = request_path;
    if let Some(query) = request.uri().query() {
        path.push('?');
        path.push_str(query);
    }

    let method = request.method().clone();
    let headers = request.headers().clone();
    let body = to_bytes(request.into_body(), max_body)
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
    let request = state
        .http
        .request(method, format!("{}{path}", state.server_url))
        .header(ACTOR_HEADER, &identity.actor)
        .header(ROLE_HEADER, &identity.role)
        .header(USER_ID_HEADER, identity.id);
    let request = if body.is_null() {
        request
    } else {
        request.json(body)
    };
    let upstream = request.send().await.map_err(server_unavailable)?;
    response(upstream)
}

pub async fn request_json(
    state: &AppState,
    identity: &VerifiedUser,
    method: Method,
    path: &str,
    body: &Value,
) -> Result<(StatusCode, Value), Problem> {
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
    let status = upstream.status();
    let text = upstream.text().await.unwrap_or_default();
    let value = if text.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&text).unwrap_or(Value::String(text))
    };
    if status.is_success() {
        Ok((status, value))
    } else {
        Err(server_problem(status, value))
    }
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

fn server_problem(status: StatusCode, upstream: Value) -> Problem {
    let detail = upstream
        .get("detail")
        .and_then(Value::as_str)
        .unwrap_or("abei-server 拒绝了请求。")
        .to_owned();
    let mut problem = match status {
        StatusCode::BAD_REQUEST => Problem::invalid_params(detail),
        StatusCode::NOT_FOUND => Problem::not_found(detail),
        StatusCode::CONFLICT => {
            Problem::new(status, "Conflict", "当前状态不允许这一步").detail(detail)
        }
        StatusCode::FORBIDDEN => Problem::new(status, "Forbidden", "没有权限").detail(detail),
        _ => Problem::new(StatusCode::BAD_GATEWAY, "ServerError", "账单服务返回了错误")
            .detail(detail),
    };
    problem.upstream = Some(Box::new(upstream));
    problem
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
