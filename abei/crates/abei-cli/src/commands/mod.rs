pub mod auth;
pub mod docs;

use abei_core::Method;
use clap::{Args, ValueEnum};
use serde_json::Value;

use crate::client::Client;
use crate::error::CliError;
use crate::hooks::Hooks;
use crate::io::Io;

/// 逃生舱：目录里没建模的接口直接打。
#[derive(Debug, Args)]
pub struct ApiArgs {
    /// HTTP 方法
    #[arg(value_enum, value_name = "方法")]
    pub method: HttpMethod,
    /// 路径，比如 /v1/catalog 或 /v1/firefly/api/v1/about
    #[arg(value_name = "路径")]
    pub path: String,
    /// 查询参数，写成 key=value，可重复
    #[arg(long = "query", short = 'q', value_name = "KEY=VALUE")]
    pub query: Vec<String>,
    /// 请求体（JSON 字符串）
    #[arg(long, value_name = "JSON")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
#[value(rename_all = "lower")]
pub enum HttpMethod {
    Get,
    Post,
    Patch,
    Delete,
}

impl From<HttpMethod> for Method {
    fn from(value: HttpMethod) -> Self {
        match value {
            HttpMethod::Get => Method::Get,
            HttpMethod::Post => Method::Post,
            HttpMethod::Patch => Method::Patch,
            HttpMethod::Delete => Method::Delete,
        }
    }
}

pub async fn api(
    io: &mut Io,
    client: &Client,
    hooks: &Hooks,
    args: &ApiArgs,
) -> Result<(), CliError> {
    let mut path = args.path.clone();
    if !path.starts_with('/') {
        path.insert(0, '/');
    }

    let mut query = Vec::new();
    for pair in &args.query {
        let (key, value) = pair.split_once('=').ok_or_else(|| {
            CliError::Usage(format!("--query 要写成 key=value，收到的是 {pair}。"))
        })?;
        query.push((key.to_owned(), value.to_owned()));
    }

    let body = match &args.body {
        Some(raw) => Some(
            serde_json::from_str::<Value>(raw)
                .map_err(|error| CliError::Usage(format!("--body 不是合法 JSON：{error}")))?,
        ),
        None => None,
    };

    let response = client
        .request(args.method.into(), &path, &query, body)
        .await?;

    // 逃生舱不做摊平：原样吐，只认 --jq。
    if let Some(filter) = &hooks.jq {
        for line in crate::jq::run(filter, &response)? {
            io.line(&line)
                .map_err(|error| CliError::Other(error.to_string()))?;
        }
        return Ok(());
    }

    let text = serde_json::to_string_pretty(&response)
        .map_err(|error| CliError::Other(error.to_string()))?;
    io.line(&text)
        .map_err(|error| CliError::Other(error.to_string()))
}

/// 裸 `abei`：一眼看完最近的钱怎么走的。
pub async fn overview(io: &mut Io, client: &Client, month: &str) -> Result<(), CliError> {
    let (start, end) = month_bounds(month);
    let summary = client
        .request(
            Method::Get,
            "/v1/transactions/summary",
            &[
                ("start".to_owned(), start.clone()),
                ("end".to_owned(), end.clone()),
            ],
            None,
        )
        .await?;

    io.line(&crate::render::summary(&summary, io.tty))
        .map_err(|error| CliError::Other(error.to_string()))?;

    let accounts = client
        .request(
            Method::Get,
            "/v1/accounts",
            &[("type".to_owned(), "asset".to_owned())],
            None,
        )
        .await?;
    let rows = crate::normalize::rows_for("accounts.list", &accounts);
    if !rows.is_empty() {
        io.blank()
            .map_err(|error| CliError::Other(error.to_string()))?;
        io.line("资产账户")
            .map_err(|error| CliError::Other(error.to_string()))?;
        io.line(&crate::render::table(&rows, io.tty))
            .map_err(|error| CliError::Other(error.to_string()))?;
    }

    io.note("");
    io.note("看具体交易：abei tx list　全部用法：abei --help　给 AI 看：abei guide");
    Ok(())
}

/// `2026-08` -> (2026-08-01, 2026-08-31)
fn month_bounds(month: &str) -> (String, String) {
    let query = crate::query::parse(&[format!("date:{month}")]);
    match query {
        Ok(parsed) => (
            parsed.start.unwrap_or_else(|| format!("{month}-01")),
            parsed.end.unwrap_or_else(|| format!("{month}-28")),
        ),
        Err(_) => (format!("{month}-01"), format!("{month}-28")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn month_bounds_cover_the_whole_month() {
        assert_eq!(
            month_bounds("2026-08"),
            ("2026-08-01".to_owned(), "2026-08-31".to_owned())
        );
        assert_eq!(
            month_bounds("2024-02"),
            ("2024-02-01".to_owned(), "2024-02-29".to_owned())
        );
    }

    #[test]
    fn http_methods_map_across() {
        assert_eq!(Method::from(HttpMethod::Get), Method::Get);
        assert_eq!(Method::from(HttpMethod::Delete), Method::Delete);
    }
}
