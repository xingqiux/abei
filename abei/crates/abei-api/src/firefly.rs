//! Firefly III 客户端。过渡期账本操作都从这里出去。

use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, HeaderName, Method, StatusCode};
use axum::response::Response;
use serde_json::Value;

use crate::problem::Problem;

const TIMEOUT: Duration = Duration::from_secs(30);

/// 逐跳头，不能转发。
const HOP_BY_HOP: &[&str] = &[
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
];

#[derive(Clone)]
pub struct Firefly {
    base: String,
    http: reqwest::Client,
}

/// Firefly 已认证的调用者。反馈审计使用这份身份，不信任请求体里自报的名字。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedUser {
    pub id: i64,
    pub actor: String,
    pub role: String,
}

impl Firefly {
    pub fn new(base_url: &str) -> Result<Self, reqwest::Error> {
        let http = reqwest::Client::builder().timeout(TIMEOUT).build()?;
        Ok(Self {
            base: base_url.trim_end_matches('/').to_owned(),
            http,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// 校验令牌并取回可信身份；结果由 AppState 短期缓存。
    pub async fn verify_token(&self, token: &str) -> Result<VerifiedUser, Problem> {
        let response = self
            .http
            .get(self.url("/api/v1/about/user"))
            .bearer_auth(token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|error| Problem::upstream_unavailable(error.to_string()))?;

        match response.status() {
            StatusCode::OK => {
                let body = response.json::<Value>().await.map_err(|error| {
                    Problem::upstream_error(
                        StatusCode::OK,
                        format!("Firefly 的用户身份响应不是 JSON：{error}"),
                    )
                })?;
                verified_user(&body).ok_or_else(|| {
                    Problem::upstream_error(StatusCode::OK, "Firefly 没返回用户 id 或 email。")
                })
            }
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(Problem::invalid_token()),
            other => Err(Problem::upstream_error(
                other,
                format!("校验令牌时 Firefly 返回 {other}。"),
            )),
        }
    }

    /// 取 JSON。查询参数里值为空的会被丢掉。
    pub async fn get_json(
        &self,
        token: &str,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Value, Problem> {
        let pairs: Vec<(&str, &str)> = query
            .iter()
            .filter(|(_, value)| !value.is_empty())
            .map(|(key, value)| (*key, value.as_str()))
            .collect();

        let response = self
            .http
            .get(self.url(path))
            .bearer_auth(token)
            .header("Accept", "application/json")
            .query(&pairs)
            .send()
            .await
            .map_err(|error| Problem::upstream_unavailable(error.to_string()))?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if status.is_success() {
            return serde_json::from_str(&body).map_err(|error| {
                Problem::upstream_error(status, format!("Firefly 返回的不是 JSON：{error}"))
            });
        }

        Err(match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Problem::invalid_token(),
            StatusCode::NOT_FOUND => Problem::not_found(format!("Firefly 上没有 {path}。")),
            other => {
                let upstream: Value =
                    serde_json::from_str(&body).unwrap_or_else(|_| Value::String(body.clone()));
                Problem::upstream_error(other, format!("Firefly 返回 {other}。")).upstream(upstream)
            }
        })
    }

    /// 写一次。body 原样发过去，响应按 JSON 收回来。
    ///
    /// 请求体不进日志：账单密码之类的东西从这里过。
    pub async fn send_json(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: &Value,
    ) -> Result<Value, Problem> {
        self.send_json_with_status(token, method, path, body)
            .await
            .map(|(_, value)| value)
    }

    /// 与 `send_json` 相同，但保留上游成功状态码。
    pub async fn send_json_with_status(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: &Value,
    ) -> Result<(StatusCode, Value), Problem> {
        let response = self
            .http
            .request(method, self.url(path))
            .bearer_auth(token)
            .header("Accept", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|error| Problem::upstream_unavailable(error.to_string()))?;

        let status = response.status();
        let text = response.text().await.unwrap_or_default();

        if status.is_success() {
            if text.trim().is_empty() {
                return Ok((status, Value::Null));
            }
            let value = serde_json::from_str(&text).map_err(|error| {
                Problem::upstream_error(status, format!("Firefly 返回的不是 JSON：{error}"))
            })?;
            return Ok((status, value));
        }

        Err(match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Problem::invalid_token(),
            StatusCode::NOT_FOUND => Problem::not_found(format!("Firefly 上没有 {path}。")),
            // 422 是校验没过，属于调用方的锅，原样把上游说法带回去。
            StatusCode::UNPROCESSABLE_ENTITY => {
                let upstream: Value =
                    serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.clone()));
                Problem::invalid_params(
                    upstream
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Firefly 说这些参数不合法。")
                        .to_owned(),
                )
                .upstream(upstream)
            }
            other => {
                let upstream: Value =
                    serde_json::from_str(&text).unwrap_or_else(|_| Value::String(text.clone()));
                Problem::upstream_error(other, format!("Firefly 返回 {other}。")).upstream(upstream)
            }
        })
    }

    /// 透传逃生舱：原样转发给 Firefly，响应流式回传。
    pub async fn proxy(
        &self,
        token: &str,
        method: Method,
        path: &str,
        query: Option<&str>,
        headers: &HeaderMap,
        body: Bytes,
    ) -> Result<Response, Problem> {
        let mut url = self.url(path);
        if let Some(query) = query.filter(|q| !q.is_empty()) {
            url.push('?');
            url.push_str(query);
        }

        let mut request = self.http.request(method, url).bearer_auth(token);
        for (name, value) in headers {
            if is_hop_by_hop(name) || name == "authorization" {
                continue;
            }
            request = request.header(name, value);
        }
        if !body.is_empty() {
            request = request.body(body);
        }

        let response = request
            .send()
            .await
            .map_err(|error| Problem::upstream_unavailable(error.to_string()))?;

        let status = response.status();
        let mut builder = Response::builder().status(status);
        for (name, value) in response.headers() {
            if is_hop_by_hop(name) {
                continue;
            }
            builder = builder.header(name, value);
        }

        builder
            .body(Body::from_stream(response.bytes_stream()))
            .map_err(|error| Problem::internal(error.to_string()))
    }
}

fn verified_user(body: &Value) -> Option<VerifiedUser> {
    let data = body.get("data")?;
    let attributes = data.get("attributes").unwrap_or(data);
    let id = data
        .get("id")
        .and_then(|value| {
            value
                .as_str()
                .and_then(|id| id.parse::<i64>().ok())
                .or_else(|| value.as_i64())
        })
        .filter(|id| *id > 0)?;
    let email = attributes.get("email").and_then(Value::as_str);
    let actor = email
        .filter(|value| value.is_ascii() && !value.chars().any(char::is_control))
        .map(str::to_owned)
        .unwrap_or_else(|| format!("user-{id}"));
    let role = attributes
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    Some(VerifiedUser { id, actor, role })
}

pub(crate) fn is_hop_by_hop(name: &HeaderName) -> bool {
    HOP_BY_HOP.contains(&name.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn verified_identity_comes_from_firefly_not_the_request_body() {
        let user = verified_user(&json!({
            "data": {
                "id": "7",
                "attributes": { "email": "owner@example.com", "role": "owner" }
            }
        }))
        .unwrap();
        assert_eq!(user.id, 7);
        assert_eq!(user.actor, "owner@example.com");
        assert_eq!(user.role, "owner");

        let fallback = verified_user(&json!({ "data": { "id": "8" } })).unwrap();
        assert_eq!(fallback.id, 8);
        assert_eq!(fallback.actor, "user-8");
        assert_eq!(fallback.role, "unknown");
    }
}
