//! 参数提取。参数类型带 `deny_unknown_fields`，拼错的字段会连同「应该是哪些」一起报回去，
//! 而不是被悄悄丢掉——财务工具里静默丢字段是最危险的失败。

use std::collections::HashMap;

use abei_core::Risk;
use axum::extract::{FromRequest, FromRequestParts, Request};
use axum::http::request::Parts;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::problem::Problem;

pub struct ValidQuery<T>(pub T);

impl<T, S> FromRequestParts<S> for ValidQuery<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Problem;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let raw = parts.uri.query().unwrap_or_default();
        serde_html_form::from_str::<T>(raw)
            .map(ValidQuery)
            .map_err(|error| Problem::invalid_params(error.to_string()))
    }
}

/// 写操作的请求体。
///
/// 收到的 JSON 会先被路径参数补全，再按能力的参数类型解析。目录里一条能力只有
/// 一份参数模式（`id` 在里面是必填），但 `id` 走的是 URL 不是请求体——补全这一步
/// 就是把两者对上，省得为每条写能力再养一个「去掉 id 的」结构体。
///
/// 顺带两点包容：空请求体当成 `{}`（`abei bills retry 42` 这种不带参数的写命令），
/// 请求体里也写了 `id` 时以路径为准（agent 习惯把参数摊成一个对象发过来）。
pub struct ValidJson<T>(pub T);

impl<T, S> FromRequest<S> for ValidJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Problem;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let (mut parts, body) = request.into_parts();
        let path =
            axum::extract::Path::<HashMap<String, String>>::from_request_parts(&mut parts, state)
                .await
                .ok();

        let bytes = axum::body::Bytes::from_request(Request::from_parts(parts, body), state)
            .await
            .map_err(|error| Problem::invalid_params(error.to_string()))?;

        let mut value: Value = if bytes.is_empty() {
            Value::Object(Default::default())
        } else {
            serde_json::from_slice(&bytes)
                .map_err(|error| Problem::invalid_params(error.to_string()))?
        };

        if let (Some(axum::extract::Path(params)), Some(object)) = (path, value.as_object_mut()) {
            for (key, from_path) in params {
                object.insert(key, Value::String(from_path));
            }
        }

        serde_json::from_value::<T>(value)
            .map(ValidJson)
            .map_err(|error| Problem::invalid_params(error.to_string()))
    }
}

/// 写闸门参数。三个客户端（CLI、web、agent）走同一套查询参数，闸只在服务端这一处。
///
/// - `dry_run=true`：跑校验和预览，不落库。
/// - `confirm=true`：显式确认。confirm 档的能力没有它就退 409。
///
/// 两个都给时 dry_run 优先——先看再改，永远是安全的那一侧。
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct Gate {
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub confirm: bool,
}

impl Gate {
    /// 这次调用是不是只预览。
    pub fn previewing(self) -> bool {
        self.dry_run
    }

    /// 闸门判定。read 直接过；draft 正常执行；confirm 必须显式确认或者只是预览。
    pub fn check(self, risk: Risk, capability_id: &str) -> Result<(), Problem> {
        if risk != Risk::Confirm || self.dry_run || self.confirm {
            return Ok(());
        }
        Err(Problem::confirmation_required(capability_id))
    }
}

impl<S> FromRequestParts<S> for Gate
where
    S: Send + Sync,
{
    type Rejection = Problem;

    /// 只认 dry_run 和 confirm 两个键，其余查询参数与它无关，别的提取器会管。
    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let mut gate = Gate::default();
        for (key, value) in serde_html_form::from_str::<Vec<(String, String)>>(
            parts.uri.query().unwrap_or_default(),
        )
        .unwrap_or_default()
        {
            let on = matches!(value.as_str(), "true" | "1" | "yes" | "");
            match key.as_str() {
                "dry_run" => gate.dry_run = on,
                "confirm" => gate.confirm = on,
                _ => {}
            }
        }
        Ok(gate)
    }
}

/// id 必须是正整数。挡在这里比让上游回一个含糊的 404 好。
pub fn check_id(raw: &str) -> Result<&str, Problem> {
    let ok = !raw.is_empty() && raw.bytes().all(|b| b.is_ascii_digit()) && !raw.starts_with('0');
    if ok {
        Ok(raw)
    } else {
        Err(Problem::invalid_params(format!(
            "id 得是正整数，收到的是 {raw}。"
        )))
    }
}

/// 可选参数转查询串用的字符串，None 变空串（`get_json` 会把空的丢掉）。
pub fn optional<T: ToString>(value: Option<T>) -> String {
    value.map(|v| v.to_string()).unwrap_or_default()
}

/// 日期必须是 YYYY-MM-DD。这里只做形状和范围检查，不引日期库。
pub fn check_date(field: &str, value: Option<&String>) -> Result<(), Problem> {
    let Some(value) = value else {
        return Ok(());
    };
    if is_date(value) {
        Ok(())
    } else {
        Err(Problem::invalid_date(field, value))
    }
}

pub fn is_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    if !bytes
        .iter()
        .enumerate()
        .all(|(index, byte)| matches!(index, 4 | 7) || byte.is_ascii_digit())
    {
        return false;
    }
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    (1..=12).contains(&month) && (1..=31).contains(&day)
}

/// 取值必须落在允许集合里。给 agent 的报错要把允许值列全。
pub fn check_enum(field: &str, value: Option<&String>, allowed: &[&str]) -> Result<(), Problem> {
    let Some(value) = value else {
        return Ok(());
    };
    if allowed.contains(&value.as_str()) {
        return Ok(());
    }
    Err(Problem::invalid_params(format!(
        "{field} 只能是 {}，收到的是 {value}。",
        allowed.join(" / ")
    )))
}

/// 分页参数的边界。
pub fn check_limit(limit: Option<u32>) -> Result<(), Problem> {
    match limit {
        Some(value) if !(1..=100).contains(&value) => Err(Problem::invalid_params(format!(
            "limit 只能是 1 到 100，收到的是 {value}。"
        ))),
        _ => Ok(()),
    }
}

pub fn check_page(page: Option<u32>) -> Result<(), Problem> {
    match page {
        Some(0) => Err(Problem::invalid_params("page 从 1 开始。")),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn date_shape_is_checked() {
        assert!(is_date("2026-08-09"));
        assert!(!is_date("2026-8-9"));
        assert!(!is_date("2026-13-01"));
        assert!(!is_date("2026-08-32"));
        assert!(!is_date("昨天"));
        assert!(!is_date(""));
    }

    #[test]
    fn enum_error_lists_allowed_values() {
        let problem =
            check_enum("type", Some(&"foo".to_owned()), &["asset", "expense"]).unwrap_err();
        let detail = problem.detail.unwrap();
        assert!(detail.contains("asset / expense"), "{detail}");
    }

    #[test]
    fn pagination_bounds() {
        assert!(check_limit(Some(0)).is_err());
        assert!(check_limit(Some(101)).is_err());
        assert!(check_limit(Some(50)).is_ok());
        assert!(check_limit(None).is_ok());
        assert!(check_page(Some(0)).is_err());
        assert!(check_page(Some(1)).is_ok());
    }
}
