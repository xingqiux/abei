//! 统一错误形状：RFC 9457 problem+json。
//!
//! `reason` 是机读驼峰码，agent 靠它决定改参重试还是放弃；`title`/`detail` 给人看。
//! 全部错误都走这里，没有第二种错误格式。
//!
//! reason 和 title 是固定码表，所以用 `&'static str`；`type` URI 由 reason 算出来，
//! 不单独存一份。

use axum::http::{HeaderValue, StatusCode, header::CONTENT_TYPE};
use axum::response::{IntoResponse, Response};
use serde_json::{Map, Value};

const PROBLEM_JSON: &str = "application/problem+json";
const TYPE_BASE: &str = "https://abei.local/problems/";

#[derive(Debug, Clone)]
pub struct Problem {
    pub status: StatusCode,
    /// 机读码，驼峰，例如 InvalidParams、UpstreamUnavailable。
    pub reason: &'static str,
    pub title: &'static str,
    pub detail: Option<String>,
    pub resource: Option<&'static str>,
    pub verb: Option<&'static str>,
    /// 上游原样返回的错误体，排障用。
    pub upstream: Option<Box<Value>>,
}

impl Problem {
    pub fn new(status: StatusCode, reason: &'static str, title: &'static str) -> Self {
        Self {
            status,
            reason,
            title,
            detail: None,
            resource: None,
            verb: None,
            upstream: None,
        }
    }

    pub fn detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    /// 标注这个错误发生在哪条能力上，让 agent 不必解析文本就知道该重试什么。
    pub fn at(mut self, resource: &'static str, verb: &'static str) -> Self {
        self.resource = Some(resource);
        self.verb = Some(verb);
        self
    }

    pub fn upstream(mut self, body: Value) -> Self {
        self.upstream = Some(Box::new(body));
        self
    }

    /// `type` URI 由 reason 算出：InvalidParams -> .../invalid-params。
    pub fn type_uri(&self) -> String {
        format!("{TYPE_BASE}{}", kebab(self.reason))
    }

    pub fn to_json(&self) -> Value {
        let mut body = Map::new();
        body.insert("type".to_owned(), Value::String(self.type_uri()));
        body.insert("title".to_owned(), Value::String(self.title.to_owned()));
        body.insert("status".to_owned(), Value::from(self.status.as_u16()));
        body.insert("reason".to_owned(), Value::String(self.reason.to_owned()));
        if let Some(detail) = &self.detail {
            body.insert("detail".to_owned(), Value::String(detail.clone()));
        }
        if let Some(resource) = self.resource {
            body.insert("resource".to_owned(), Value::String(resource.to_owned()));
        }
        if let Some(verb) = self.verb {
            body.insert("verb".to_owned(), Value::String(verb.to_owned()));
        }
        if let Some(upstream) = &self.upstream {
            body.insert("upstream".to_owned(), (**upstream).clone());
        }
        Value::Object(body)
    }

    pub fn missing_token() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "MissingToken", "缺少访问令牌")
            .detail("请在 Authorization 头里带上 Bearer <Firefly 个人访问令牌>。")
    }

    pub fn invalid_token() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "InvalidToken", "令牌无效或已过期")
            .detail("Firefly 拒绝了这个令牌，重新配对一次：abei auth login。")
    }

    pub fn invalid_params(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "InvalidParams", "参数不对").detail(detail)
    }

    pub fn invalid_date(field: &str, value: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "InvalidDate", "日期格式不对")
            .detail(format!("{field} 应该写成 YYYY-MM-DD，收到的是 {value}。"))
    }

    pub fn not_found(detail: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "NotFound", "没找到").detail(detail)
    }

    /// confirm 档的能力没带确认参数。三个客户端撞的都是这一道闸。
    pub fn confirmation_required(id: &str) -> Self {
        Self::new(
            StatusCode::CONFLICT,
            "ConfirmationRequired",
            "这一步要人确认",
        )
        .detail(format!(
            "{id} 会真的改数据，得由人点头。先带 dry_run=true 看会改什么，\
             确认之后再带 confirm=true 执行。命令行对应 --dry-run 和 --yes。"
        ))
    }

    pub fn upstream_unavailable(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "UpstreamUnavailable",
            "连不上 Firefly",
        )
        .detail(detail)
    }

    pub fn upstream_error(status: StatusCode, detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "UpstreamError",
            "Firefly 返回了错误",
        )
        .detail(detail)
        .upstream(serde_json::json!({ "status": status.as_u16() }))
    }

    pub fn server_unavailable(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::BAD_GATEWAY,
            "ServerUnavailable",
            "连不上反馈服务",
        )
        .detail(detail)
    }

    pub fn internal(detail: impl Into<String>) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Internal",
            "服务内部出错",
        )
        .detail(detail)
    }
}

impl IntoResponse for Problem {
    fn into_response(self) -> Response {
        let body = serde_json::to_vec(&self.to_json()).unwrap_or_default();
        let mut response = (self.status, body).into_response();
        response
            .headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static(PROBLEM_JSON));
        response
    }
}

/// InvalidParams -> invalid-params
fn kebab(reason: &str) -> String {
    let mut out = String::with_capacity(reason.len() + 4);
    for (index, ch) in reason.char_indices() {
        if ch.is_ascii_uppercase() {
            if index != 0 {
                out.push('-');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_becomes_kebab_type_uri() {
        let problem = Problem::invalid_params("试试");
        assert_eq!(problem.reason, "InvalidParams");
        assert_eq!(
            problem.type_uri(),
            "https://abei.local/problems/invalid-params"
        );
        assert_eq!(problem.status, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn single_word_reason_has_no_dash() {
        assert_eq!(kebab("Internal"), "internal");
        assert_eq!(kebab("UpstreamUnavailable"), "upstream-unavailable");
    }

    /// 没设的字段不该出现在 JSON 里。
    #[test]
    fn empty_fields_are_omitted() {
        let body = Problem::new(StatusCode::NOT_FOUND, "NotFound", "没找到").to_json();
        assert_eq!(body["reason"], "NotFound");
        assert_eq!(body["status"], 404);
        assert!(body.get("detail").is_none());
        assert!(body.get("resource").is_none());
    }

    #[test]
    fn capability_context_is_carried() {
        let body = Problem::invalid_params("x")
            .at("transactions", "show")
            .to_json();
        assert_eq!(body["resource"], "transactions");
        assert_eq!(body["verb"], "show");
    }
}
