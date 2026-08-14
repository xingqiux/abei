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
use abei_core::internal_auth::{
    ACTOR_HEADER, FIREFLY_TOKEN_HEADER, Identity, ROLE_HEADER, SIGNATURE_HEADER, USER_ID_HEADER,
    sign,
};

/// 给一次转发装上可信身份头和覆盖它们的签名。
///
/// abei-server 不自己验 Firefly token，它只认这套签名——没签名或签名对不上一律 401。
/// 三个身份头必须和签名同时设置，漏一个就整体失效。
fn sign_identity(
    request: reqwest::RequestBuilder,
    secret: &str,
    identity: &VerifiedUser,
) -> reqwest::RequestBuilder {
    let signed = Identity::new(&identity.actor, &identity.role, identity.id);
    request
        .header(ACTOR_HEADER, &identity.actor)
        .header(ROLE_HEADER, &identity.role)
        .header(USER_ID_HEADER, identity.id)
        .header(SIGNATURE_HEADER, sign(secret.as_bytes(), &signed))
}

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
    let request = sign_identity(
        state
            .http
            .request(method, format!("{}{path}", state.server_url)),
        &state.internal_secret,
        identity,
    );
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
    request_json_inner(state, identity, method, path, body, None).await
}

/// 和 [`request_json`] 一样，另外把用户的 Firefly 令牌转交给 abei-server。
///
/// 只有入账用得上：整条入账 saga 已经沉到 abei-server，它要替用户写账本就得拿着
/// 用户自己的令牌。别的转发一律走 [`request_json`]——令牌给得越少越好。
pub async fn request_json_with_token(
    state: &AppState,
    identity: &VerifiedUser,
    method: Method,
    path: &str,
    body: &Value,
    token: &str,
) -> Result<(StatusCode, Value), Problem> {
    request_json_inner(state, identity, method, path, body, Some(token)).await
}

async fn request_json_inner(
    state: &AppState,
    identity: &VerifiedUser,
    method: Method,
    path: &str,
    body: &Value,
    token: Option<&str>,
) -> Result<(StatusCode, Value), Problem> {
    let mut request = sign_identity(
        state
            .http
            .request(method, format!("{}{path}", state.server_url)),
        &state.internal_secret,
        identity,
    );
    if let Some(token) = token {
        request = request.header(FIREFLY_TOKEN_HEADER, token);
    }
    let upstream = request
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
        // 浏览器传来的身份头和签名头一律丢掉，只有下面这一份是可信的；
        // 留着会变成同名的第二个值，abei-server 读到哪个就说不准了。
        // 令牌头同理：它只能由 request_json_with_token 注入，不能被调用方自带。
        if !crate::firefly::is_hop_by_hop(name)
            && name != "authorization"
            && name != ACTOR_HEADER
            && name != ROLE_HEADER
            && name != USER_ID_HEADER
            && name != SIGNATURE_HEADER
            && name != FIREFLY_TOKEN_HEADER
        {
            upstream = upstream.header(name, value);
        }
    }
    upstream = sign_identity(upstream, &state.internal_secret, identity);
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
