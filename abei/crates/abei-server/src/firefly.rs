//! abei-server 这一侧的 Firefly III 客户端。
//!
//! 以前 abei-server 完全不认识 Firefly：入账这件事由 abei-api 编排，它拿着用户令牌，
//! 一步步 HTTP 调回来推进状态机（prepare → mark-sending → 自己写 Firefly → complete）。
//! 结果是 saga 的中段在网络上，abei-api 崩在 mark-sending 和 complete 之间，
//! 状态就没人收尾了——只能等清扫器把它捞成 uncertain。
//!
//! 现在整条 saga 沉进 abei-server，所以这里需要一个能替用户写 Firefly 的客户端。
//! 它比 abei-api 那份小：只有入账真正用得上的两个动作，没有透传逃生舱，也不做令牌校验
//! （校验仍然是 abei-api 的活）。
//!
//! 令牌不落库、不进日志：只在一次请求的调用栈里传递。

use std::time::Duration;

use axum::http::{Method, StatusCode};
use serde_json::Value;

use crate::ApiError;

const TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub(crate) struct Firefly {
    base: String,
    http: reqwest::Client,
}

/// 写 Firefly 失败的三种情况。
///
/// 必须分开，因为它们对账本的含义完全不同：`Http` 是 Firefly 明确拒绝了，账没记上；
/// `Transport` 和 `InvalidResponse` 是我们不知道账记没记上——这两种只能进 uncertain
/// 等对账，绝不能当失败直接重发。
#[derive(Debug)]
pub(crate) enum WriteError {
    /// 连接层面就没成功，请求可能送达也可能没有。
    Transport(String),
    /// Firefly 明确返回了非 2xx。
    Http { status: StatusCode, body: Value },
    /// Firefly 说成功了，但响应读不懂。
    InvalidResponse(String),
}

impl Firefly {
    pub(crate) fn new(base_url: &str) -> Result<Self, reqwest::Error> {
        Ok(Self {
            base: base_url.trim_end_matches('/').to_owned(),
            http: reqwest::Client::builder().timeout(TIMEOUT).build()?,
        })
    }

    /// 从 `FIREFLY_URL` 建。默认值和 abei-api 那份保持一致。
    ///
    /// 建不出客户端只可能是 TLS 初始化炸了，那时候整个进程也没法干活，直接 panic
    /// 比留一个每次调用都失败的空壳诚实。
    pub(crate) fn from_env() -> Self {
        let base =
            std::env::var("FIREFLY_URL").unwrap_or_else(|_| "http://127.0.0.1:18001".to_owned());
        Self::new(&base).expect("构建 Firefly HTTP 客户端失败")
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// 读一次。查询参数里值为空的丢掉。
    pub(crate) async fn get_json(
        &self,
        token: &str,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Value, ApiError> {
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
            .map_err(|error| {
                ApiError::upstream(format!("连不上 Firefly：{error}"))
                    .with_reason(reasons::FIREFLY_UNAVAILABLE)
            })?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();

        if status.is_success() {
            return serde_json::from_str(&body).map_err(|error| {
                ApiError::upstream(format!("Firefly 返回的不是 JSON：{error}"))
                    .with_reason(reasons::FIREFLY_BAD_RESPONSE)
            });
        }

        Err(match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                ApiError::forbidden("Firefly 拒绝了这个令牌。")
                    .with_reason(reasons::FIREFLY_TOKEN_REJECTED)
            }
            StatusCode::NOT_FOUND => ApiError::not_found(format!("Firefly 上没有 {path}。"))
                .with_reason(reasons::FIREFLY_NOT_FOUND),
            other => ApiError::upstream(format!("Firefly 返回 {other}。"))
                .with_reason(reasons::FIREFLY_UNAVAILABLE),
        })
    }

    /// 写一次。刻意不折叠成 `ApiError`：调用方必须能区分「被拒」和「结果不明」。
    ///
    /// 请求体不进日志——账单明细和账户信息从这里过。
    pub(crate) async fn send_json(
        &self,
        token: &str,
        method: Method,
        path: &str,
        body: &Value,
    ) -> Result<(StatusCode, Value), WriteError> {
        let response = self
            .http
            .request(method, self.url(path))
            .bearer_auth(token)
            .header("Accept", "application/json")
            .json(body)
            .send()
            .await
            .map_err(|error| WriteError::Transport(error.to_string()))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let value = if text.trim().is_empty() {
            Value::Null
        } else if status.is_success() {
            serde_json::from_str(&text)
                .map_err(|error| WriteError::InvalidResponse(error.to_string()))?
        } else {
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        };
        if status.is_success() {
            Ok((status, value))
        } else {
            Err(WriteError::Http {
                status,
                body: value,
            })
        }
    }
}

/// `ApiError.reason` 用的机器码。
///
/// 前端和 CLI 想按原因分支，只有八个通用 reason（Conflict、InvalidParams……）是不够的，
/// 于是它们退而去匹配中文 detail 文案——文案一改就悄悄失效。这些码补上那一层。
/// 加码只加不改：detail 文案保持原样，老的字符串匹配继续能跑。
pub(crate) mod reasons {
    pub(crate) const FIREFLY_UNAVAILABLE: &str = "firefly_unavailable";
    pub(crate) const FIREFLY_BAD_RESPONSE: &str = "firefly_bad_response";
    pub(crate) const FIREFLY_TOKEN_REJECTED: &str = "firefly_token_rejected";
    pub(crate) const FIREFLY_NOT_FOUND: &str = "firefly_not_found";
}

/// 从 Firefly 的错误响应里挖出一句能给人看的话。
///
/// 逐字保持 abei-api 原来那份 `firefly_error_message` 的行为——这句话会原样出现在
/// 收件箱的失败提示里，前端按文案分支，改一个字都是破坏性变更。
pub(crate) fn error_message(body: &Value, status: u16) -> String {
    body.get("message")
        .and_then(Value::as_str)
        .or_else(|| body.get("detail").and_then(Value::as_str))
        .map(|value| value.chars().take(2_000).collect())
        .unwrap_or_else(|| format!("Firefly 返回 HTTP {status}。"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_firefly_rejection_is_reported_in_firefly_own_words() {
        assert_eq!(
            error_message(&json!({ "message": "参数校验没过" }), 422),
            "参数校验没过"
        );
        // 有些端点用 detail 而不是 message。
        assert_eq!(
            error_message(&json!({ "detail": "余额不足" }), 422),
            "余额不足"
        );
    }

    #[test]
    fn an_opaque_firefly_error_still_says_something_useful() {
        assert_eq!(error_message(&json!({}), 500), "Firefly 返回 HTTP 500。");
        assert_eq!(
            error_message(&Value::String("<html>502</html>".to_owned()), 502),
            "Firefly 返回 HTTP 502。"
        );
    }

    #[test]
    fn a_pathologically_long_firefly_message_is_capped() {
        let body = json!({ "message": "错".repeat(5_000) });
        // 按字符截断而不是按字节——中文按字节切会切出半个字。
        assert_eq!(error_message(&body, 422).chars().count(), 2_000);
    }
}
