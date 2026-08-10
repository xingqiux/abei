//! 内置 jq（jaq）。装了 jq 与否都一样能用 `--jq`。

use jaq_core::load::{Arena, File, Loader};
use jaq_core::{Compiler, Ctx, Vars, data, unwrap_valr};
use jaq_json::Val;
use serde_json::Value;

use crate::error::CliError;

/// 对整个响应体跑一段 jq 表达式，每个输出值一行 JSON。
pub fn run(filter: &str, input: &Value) -> Result<Vec<String>, CliError> {
    let bytes = serde_json::to_vec(input)
        .map_err(|error| CliError::Other(format!("响应体没法序列化：{error}")))?;
    let input = jaq_json::read::parse_single(&bytes)
        .map_err(|error| CliError::Other(format!("响应体不是合法 JSON：{error}")))?;

    let defs = jaq_core::defs()
        .chain(jaq_std::defs())
        .chain(jaq_json::defs());
    let funs = jaq_core::funs()
        .chain(jaq_std::funs())
        .chain(jaq_json::funs());

    let loader = Loader::new(defs);
    let arena = Arena::default();
    let modules = loader
        .load(&arena, File { code: filter, path: () })
        .map_err(|_| {
            CliError::Usage(format!(
                "--jq 的表达式没看懂：{filter}\n它是 jq 语法，比如 '.data[0]' 或 'map(.amount)|add'。"
            ))
        })?;

    let compiled = Compiler::default()
        .with_funs(funs)
        .compile(modules)
        .map_err(|_| CliError::Usage(format!("--jq 的表达式编译不过：{filter}")))?;

    let ctx = Ctx::<data::JustLut<Val>>::new(&compiled.lut, Vars::new([]));
    let mut lines = Vec::new();
    for result in compiled.id.run((ctx, input)).map(unwrap_valr) {
        let value = result.map_err(|error| CliError::Other(format!("--jq 执行出错：{error}")))?;
        lines.push(value.to_string());
    }
    Ok(lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn identity_returns_the_whole_body() {
        let body = json!({ "a": 1 });
        assert_eq!(run(".", &body).unwrap(), vec![r#"{"a":1}"#]);
    }

    #[test]
    fn iterating_yields_one_line_per_value() {
        let body = json!({ "data": [1, 2, 3] });
        assert_eq!(run(".data[]", &body).unwrap(), vec!["1", "2", "3"]);
    }

    /// 标准库要接上，不然 map/add 这些用不了。
    #[test]
    fn standard_library_is_available() {
        let body = json!({ "rows": [{ "amount": 1.5 }, { "amount": 2.5 }] });
        assert_eq!(run("[.rows[].amount] | add", &body).unwrap(), vec!["4.0"]);
        assert_eq!(run(".rows | length", &body).unwrap(), vec!["2"]);
    }

    #[test]
    fn broken_filters_are_usage_errors() {
        let error = run(".[", &json!({})).unwrap_err();
        assert_eq!(error.exit(), crate::exit::Exit::InvalidUsage);
    }
}
