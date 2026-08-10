//! 打 abei-api 的 HTTP 客户端。
//!
//! CLI 只认 abei-api 一个地址：能力走资源路由，没建模的接口走 `/v1/firefly/*` 逃生舱。
//! 服务端的 problem+json 在这里翻成 `CliError`，退出码由 `reason` 决定。

use std::time::Duration;

use abei_core::{Capability, Method};
use serde_json::{Map, Value};

use crate::error::{CliError, ServerProblem};

const TIMEOUT: Duration = Duration::from_secs(30);

/// 写闸门在查询串上的样子，和服务端的 `abei_api::extract::Gate` 一一对应。
///
/// `--dry-run` 发 `dry_run=true`，`--yes` 发 `confirm=true`。少了后者，
/// confirm 档的能力过不了服务端那道闸——本地 `--yes` 只是让命令得以发出，
/// 真正放行的是服务端。
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Gate {
    pub dry_run: bool,
    pub confirm: bool,
}

pub struct Client {
    http: reqwest::Client,
    base: String,
    token: Option<String>,
}

impl Client {
    pub fn new(base: &str, token: Option<String>) -> Result<Self, CliError> {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .user_agent(concat!("abei-cli/", env!("CARGO_PKG_VERSION")))
            .build()?;
        Ok(Self {
            http,
            base: base.trim_end_matches('/').to_owned(),
            token,
        })
    }

    /// 按能力发一次请求。GET 的参数进查询串，写操作进请求体。
    pub async fn invoke(
        &self,
        capability: &Capability,
        params: &Map<String, Value>,
        gate: Gate,
    ) -> Result<Value, CliError> {
        let mut path = capability.route_path();
        let mut rest = params.clone();

        // 路径里的 {id} 由同名参数填。
        if path.contains("{id}") {
            let id = rest
                .remove("id")
                .and_then(|value| scalar(&value))
                .ok_or_else(|| CliError::Usage("这条命令要一个 id。".to_owned()))?;
            path = path.replace("{id}", &id);
        }

        let method = capability.method();
        let mut query: Vec<(String, String)> = Vec::new();
        let mut body: Option<Value> = None;

        if matches!(method, Method::Get) {
            query.extend(flatten(&rest));
        } else if !rest.is_empty() {
            body = Some(Value::Object(rest));
        }

        // 闸门参数一律走查询串，读能力用不上就不发。
        if capability.risk.is_write() {
            if gate.dry_run {
                query.push(("dry_run".to_owned(), "true".to_owned()));
            }
            if gate.confirm {
                query.push(("confirm".to_owned(), "true".to_owned()));
            }
        }

        self.request(method, &path, &query, body).await
    }

    pub async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(String, String)],
        body: Option<Value>,
    ) -> Result<Value, CliError> {
        let url = format!("{}{}", self.base, path);
        let verb = match method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Patch => reqwest::Method::PATCH,
            Method::Delete => reqwest::Method::DELETE,
        };

        let mut request = self.http.request(verb, &url).query(query);
        if let Some(token) = &self.token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }

        let response = request.send().await?;
        let status = response.status().as_u16();
        let text = response.text().await?;

        if (200..300).contains(&status) {
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_str(&text)
                .map_err(|error| CliError::Other(format!("响应不是 JSON：{error}")));
        }

        Err(match ServerProblem::parse(status, &text) {
            Some(problem) => CliError::Server(Box::new(problem)),
            // 不是 problem+json，多半根本没打到 abei-api（反代、错端口）。
            None => CliError::Other(format!(
                "{url} 返回 {status}，而且不是 problem+json：{}",
                text.chars().take(200).collect::<String>()
            )),
        })
    }
}

/// 标量转字符串，其它类型返回 None。
fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// 参数摊平成查询串。数组重复同一个键（`?exclude_category=a&exclude_category=b`），
/// 服务端用 serde_html_form 收，跟 axum 那边对得上。
fn flatten(params: &Map<String, Value>) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for (key, value) in params {
        match value {
            Value::Array(items) => {
                for item in items {
                    if let Some(text) = scalar(item) {
                        pairs.push((key.clone(), text));
                    }
                }
            }
            Value::Null => {}
            other => {
                if let Some(text) = scalar(other) {
                    pairs.push((key.clone(), text));
                }
            }
        }
    }
    pairs
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn arrays_repeat_the_key() {
        let pairs = flatten(&map(json!({ "exclude_category": ["房租", "还款"] })));
        assert_eq!(
            pairs,
            vec![
                ("exclude_category".to_owned(), "房租".to_owned()),
                ("exclude_category".to_owned(), "还款".to_owned()),
            ]
        );
    }

    #[test]
    fn nulls_are_dropped_and_numbers_stringified() {
        let pairs = flatten(&map(
            json!({ "page": 2, "start": null, "type": "withdrawal" }),
        ));
        assert_eq!(pairs.len(), 2);
        assert!(pairs.contains(&("page".to_owned(), "2".to_owned())));
        assert!(pairs.contains(&("type".to_owned(), "withdrawal".to_owned())));
    }

    #[test]
    fn scalars_convert_but_containers_do_not() {
        assert_eq!(scalar(&json!("x")), Some("x".to_owned()));
        assert_eq!(scalar(&json!(42)), Some("42".to_owned()));
        assert_eq!(scalar(&json!(true)), Some("true".to_owned()));
        assert_eq!(scalar(&json!({})), None);
        assert_eq!(scalar(&json!([])), None);
    }
}
