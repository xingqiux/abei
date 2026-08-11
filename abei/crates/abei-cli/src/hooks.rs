//! 输出与写闸门都集中在这里。
//!
//! 每条命令只管把响应交给 `emit`，不自己决定怎么打印；`--json` / `--jq` /
//! `--dry-run` / `--yes` 的语义因此只有一份实现，新增能力自动继承。
//! 对应 Oxide CLI 里 `CliConfig` 那一层的位置。

use abei_core::{Capability, Risk};
use serde_json::Value;

use crate::error::CliError;
use crate::io::Io;
use crate::normalize;
use crate::render;

/// 输出形态。默认人话；机器格式显式开启。
#[derive(Debug, Clone, PartialEq)]
pub enum Format {
    /// 表格或报表。
    Human,
    /// `--json 字段,字段`：投影出这些字段。
    Json(Vec<String>),
    /// `--json` 不带值：列出这条命令有哪些字段可选，供 agent 自发现。
    FieldList,
}

#[derive(Debug, Clone)]
pub struct Hooks {
    pub format: Format,
    pub jq: Option<String>,
    pub dry_run: bool,
    pub yes: bool,
}

impl Default for Hooks {
    fn default() -> Self {
        Self {
            format: Format::Human,
            jq: None,
            dry_run: false,
            yes: false,
        }
    }
}

impl Hooks {
    /// 机器输出模式下不打人话提示，免得混进管道。
    pub fn machine(&self) -> bool {
        self.jq.is_some() || !matches!(self.format, Format::Human)
    }

    /// 本地开关翻成发给服务端的闸门参数。`--yes` 必须传到服务端，
    /// 否则 confirm 档的能力会被服务端挡回来（409 ConfirmationRequired）。
    pub fn gate_params(&self) -> crate::client::Gate {
        crate::client::Gate {
            dry_run: self.dry_run,
            confirm: self.yes,
        }
    }

    /// 只有 confirm 档必须显式 `--yes`，draft 可以直接写草稿。
    pub fn gate(&self, capability: &Capability, command: &str) -> Result<(), CliError> {
        if capability.risk != Risk::Confirm || self.yes || self.dry_run {
            return Ok(());
        }
        Err(CliError::NeedsConfirmation {
            command: format!("{command} --yes"),
        })
    }

    /// 把响应发出去。
    pub fn emit(&self, io: &mut Io, capability_id: &str, body: &Value) -> Result<(), CliError> {
        // 预览要说明白自己是预览。服务端打了 dry_run 记号，但那记号在投影和表格里
        // 会被摊掉——一份「还没发生的事」看起来跟「已经发生的事」一模一样是要出事的。
        // 走 stderr，不脏数据管道。
        if body.get("dry_run") == Some(&Value::Bool(true)) {
            io.note(&format!(
                "这是预览，没有真的改数据。确认无误就把 --dry-run 换成 --yes 再跑一次。\
                 （{capability_id}）"
            ));
        }

        // --jq 作用在原始响应体上，保住全部保真度。
        if let Some(filter) = &self.jq {
            for line in crate::jq::run(filter, body)? {
                io.line(&line).map_err(broken_pipe)?;
            }
            return Ok(());
        }

        let rows = normalize::rows_for(capability_id, body);

        match &self.format {
            Format::FieldList => {
                let listing = serde_json::to_string_pretty(&rows.fields)
                    .map_err(|error| CliError::Other(error.to_string()))?;
                io.line(&listing).map_err(broken_pipe)?;
            }
            Format::Json(fields) => {
                let unknown = rows.unknown(fields);
                if !unknown.is_empty() {
                    return Err(CliError::Usage(format!(
                        "--json 里这些字段不认得：{}\n这条命令能选的字段：{}",
                        unknown
                            .iter()
                            .map(|f| f.as_str())
                            .collect::<Vec<_>>()
                            .join("、"),
                        rows.fields.join("、")
                    )));
                }
                let picked = rows.project(fields);
                let text = serde_json::to_string_pretty(&picked)
                    .map_err(|error| CliError::Other(error.to_string()))?;
                io.line(&text).map_err(broken_pipe)?;
            }
            Format::Human => {
                // 汇总是报表不是列表，走另一套排版。
                let text = if capability_id == "transactions.summary" {
                    render::summary(body, io.tty)
                } else {
                    render::table(&rows, io.tty)
                };
                io.line(&text).map_err(broken_pipe)?;
            }
        }

        Ok(())
    }

    /// 错误一律走 stderr，stdout 只放数据。机器模式给 problem+json 原文。
    pub fn emit_error(&self, io: &mut Io, error: &CliError) {
        if self.machine() {
            let text = serde_json::to_string(&error.to_json())
                .unwrap_or_else(|_| r#"{"reason":"Failure"}"#.to_owned());
            io.note(&text);
        } else {
            io.note(&error.human());
        }
    }
}

/// 下游管道关了就当正常收工，别 panic 也别报错。
fn broken_pipe(error: std::io::Error) -> CliError {
    if error.kind() == std::io::ErrorKind::BrokenPipe {
        CliError::Other("__broken_pipe__".to_owned())
    } else {
        CliError::Other(error.to_string())
    }
}

/// 上层用它判断是不是「管道提前关了」这种正常结束。
pub fn is_broken_pipe(error: &CliError) -> bool {
    matches!(error, CliError::Other(message) if message == "__broken_pipe__")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::SharedBuffer;
    use abei_core::{Risk, Verb, catalog};
    use serde_json::json;

    fn capture() -> (Io, SharedBuffer, SharedBuffer) {
        let out = SharedBuffer::new();
        let err = SharedBuffer::new();
        (Io::capture(out.clone(), err.clone()), out, err)
    }

    fn body() -> Value {
        json!({ "data": [{ "id": "42", "attributes": { "transactions": [
            { "type": "withdrawal", "date": "2026-08-01T00:00:00+08:00", "amount": "45.00",
              "description": "午饭", "category_name": "餐饮" }
        ]}}]})
    }

    #[test]
    fn human_is_the_default() {
        let hooks = Hooks::default();
        assert_eq!(hooks.format, Format::Human);
        assert!(!hooks.machine());
    }

    #[test]
    fn json_projection_only_emits_asked_fields() {
        let (mut io, out, _) = capture();
        let hooks = Hooks {
            format: Format::Json(vec!["amount".to_owned(), "category".to_owned()]),
            ..Default::default()
        };
        hooks.emit(&mut io, "transactions.list", &body()).unwrap();

        let parsed: Value = serde_json::from_str(&out.text()).unwrap();
        assert_eq!(parsed[0]["amount"], "45.00");
        assert_eq!(parsed[0]["category"], "餐饮");
        assert!(parsed[0].get("description").is_none());
    }

    /// `--json` 不带值 = 告诉我有哪些字段。
    #[test]
    fn bare_json_lists_available_fields() {
        let (mut io, out, _) = capture();
        let hooks = Hooks {
            format: Format::FieldList,
            ..Default::default()
        };
        hooks.emit(&mut io, "transactions.list", &body()).unwrap();

        let fields: Vec<String> = serde_json::from_str(&out.text()).unwrap();
        assert!(fields.contains(&"amount".to_owned()));
        assert!(fields.contains(&"description".to_owned()));
    }

    #[test]
    fn unknown_json_fields_are_a_usage_error_that_lists_the_real_ones() {
        let (mut io, _, _) = capture();
        let hooks = Hooks {
            format: Format::Json(vec!["amonut".to_owned()]),
            ..Default::default()
        };
        let error = hooks
            .emit(&mut io, "transactions.list", &body())
            .unwrap_err();
        assert_eq!(error.exit(), crate::exit::Exit::InvalidUsage);
        assert!(error.human().contains("amonut"));
        assert!(error.human().contains("amount"));
    }

    /// --jq 拿的是原始响应体，不是摊平后的行。
    #[test]
    fn jq_runs_against_the_raw_body() {
        let (mut io, out, _) = capture();
        let hooks = Hooks {
            jq: Some(".data[0].id".to_owned()),
            ..Default::default()
        };
        hooks.emit(&mut io, "transactions.list", &body()).unwrap();
        assert_eq!(out.text().trim(), r#""42""#);
    }

    #[test]
    fn read_capabilities_pass_the_gate_untouched() {
        let list = catalog().get("transactions", Verb::List).unwrap();
        assert_eq!(list.risk, Risk::Read);
        assert!(Hooks::default().gate(list, "abei tx list").is_ok());
    }

    /// 写能力缺 --yes 时退 6，并把补好的命令给出来。
    #[test]
    fn write_capabilities_need_yes() {
        let write = abei_core::Capability::define("bills", Verb::Import)
            .risk(Risk::Confirm)
            .label("导入账单")
            .description("测试用")
            .params::<abei_core::TransactionsShowParams>();

        let error = Hooks::default()
            .gate(&write, "abei bills import 42")
            .unwrap_err();
        assert_eq!(error.exit(), crate::exit::Exit::ConfirmationRequired);
        assert!(error.human().contains("abei bills import 42 --yes"));

        // --yes 或 --dry-run 都能过闸。
        let yes = Hooks {
            yes: true,
            ..Default::default()
        };
        assert!(yes.gate(&write, "abei bills import 42").is_ok());
        let dry = Hooks {
            dry_run: true,
            ..Default::default()
        };
        assert!(dry.gate(&write, "abei bills import 42").is_ok());
    }

    /// 预览的提示只出现在预览里，真跑的时候不该有。
    #[test]
    fn previews_announce_themselves_on_stderr() {
        let (mut io, out, err) = capture();
        let hooks = Hooks {
            dry_run: true,
            ..Default::default()
        };
        let preview = json!({ "dry_run": true, "data": { "would_create": 2 } });
        hooks.emit(&mut io, "bills.import", &preview).unwrap();
        assert!(err.text().contains("这是预览"), "{}", err.text());
        assert!(!out.text().is_empty(), "数据还是要照常出");

        let (mut io, _, err) = capture();
        hooks
            .emit(
                &mut io,
                "bills.import",
                &json!({ "data": { "created": 2 } }),
            )
            .unwrap();
        assert!(err.text().is_empty(), "真跑不该有预览提示：{}", err.text());
    }

    /// 机器模式下错误也是机器可读的，且走 stderr 不脏 stdout。
    #[test]
    fn machine_mode_errors_are_json_on_stderr() {
        let (mut io, out, err) = capture();
        let hooks = Hooks {
            format: Format::Json(vec!["amount".to_owned()]),
            ..Default::default()
        };
        hooks.emit_error(&mut io, &CliError::Usage("参数不对".to_owned()));

        assert!(out.text().is_empty());
        let parsed: Value = serde_json::from_str(err.text().trim()).unwrap();
        assert_eq!(parsed["reason"], "InvalidUsage");
    }

    #[test]
    fn human_mode_errors_are_plain_sentences_on_stderr() {
        let (mut io, _, err) = capture();
        Hooks::default().emit_error(&mut io, &CliError::Usage("参数不对".to_owned()));
        assert_eq!(err.text().trim(), "参数不对");
    }
}
