//! 自文档：`explain` 讲一个资源，`guide` 给 agent 一页纸。
//!
//! 两份都从能力目录现渲染，不存第二份文案——目录改了，文档跟着改。

use abei_core::{Capability, catalog};
use serde_json::Value;

use crate::error::CliError;
use crate::io::Io;

fn line(io: &mut Io, text: &str) -> Result<(), CliError> {
    io.line(text).map_err(|e| CliError::Other(e.to_string()))
}

/// `abei explain <资源>`
pub fn explain(io: &mut Io, resource: &str) -> Result<(), CliError> {
    let Some(def) = catalog().resolve_resource(resource) else {
        let names: Vec<&str> = catalog().resources().iter().map(|r| r.name).collect();
        let guesses = crate::suggest::closest(resource, names.clone());
        let hint = if guesses.is_empty() {
            format!("有这些资源：{}。", names.join("、"))
        } else {
            format!("是不是想说 {}？", guesses.join(" 或 "))
        };
        return Err(CliError::Usage(format!("没有叫 {resource} 的资源。{hint}")));
    };

    line(io, &format!("{}（{}）", def.label, def.name))?;
    line(io, def.description)?;
    if !def.aliases.is_empty() {
        line(io, &format!("别名：{}", def.aliases.join("、")))?;
    }

    for verb in catalog().verbs_for(def.name) {
        let Some(capability) = catalog().get(def.name, verb) else {
            continue;
        };
        line(io, "")?;
        line(
            io,
            &format!(
                "abei {} {}　—— {}（风险 {}，后端 {}）",
                def.name,
                verb,
                capability.label,
                capability.risk.as_str(),
                capability.backend.as_str()
            ),
        )?;
        line(io, &format!("  {}", capability.description))?;

        for (field, schema, required) in fields_of(capability) {
            let kind = type_name(&schema);
            let note = schema
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("");
            // 「人填」比「必填」更要紧：这一格是在告诉模型别自己编。
            let mark = if capability.human_only().contains(&field) {
                "人填"
            } else if required {
                "必填"
            } else {
                "可选"
            };
            // 位置参数（abei tx show 42、abei tx search 星巴克）别写成 --id / --query 误导人。
            let positional = (field == "id" && crate::tree::id_is_positional(capability))
                || capability.positional().as_deref() == Some(field.as_str());
            let name = if positional {
                format!("<{}>", field.to_uppercase())
            } else {
                format!("--{}", field.replace('_', "-"))
            };
            // 对象列表光说「可重复」不够，得说清一项里写什么。
            let note = match item_keys(&schema) {
                keys if keys.is_empty() => note.to_owned(),
                keys => format!("{note}　每项写成 键=值,键=值——{}", keys.join("、")),
            };
            line(io, &format!("    {name:<22} {kind}　{mark}　{note}"))?;
        }

        for example in &capability.examples {
            line(io, &format!("    例：{}", example.command))?;
        }
    }

    Ok(())
}

fn fields_of(capability: &Capability) -> Vec<(String, Value, bool)> {
    let required: Vec<String> = capability
        .params
        .as_value()
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    capability
        .params
        .as_value()
        .get("properties")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(key, schema)| {
                    let is_required = required.contains(key);
                    (key.clone(), schema.clone(), is_required)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 列表项如果是对象，返回它能填的键；不是对象就空。
fn item_keys(schema: &Value) -> Vec<&str> {
    schema
        .get("items")
        .and_then(|item| item.get("properties"))
        .and_then(Value::as_object)
        .map(|map| map.keys().map(String::as_str).collect())
        .unwrap_or_default()
}

fn type_name(schema: &Value) -> &'static str {
    let raw = match schema.get("type") {
        Some(Value::String(single)) => single.as_str(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .find(|item| *item != "null")
            .unwrap_or("string"),
        _ => "string",
    };
    match raw {
        "integer" | "number" => "数字",
        "boolean" => "开关",
        "array" => "可重复",
        _ => "文本",
    }
}

/// `abei guide` —— 给 agent 看的一页纸。内容全部来自目录，不是手写副本。
pub fn guide(io: &mut Io) -> Result<(), CliError> {
    let mut out = String::new();

    out.push_str(
        "# abei\n\n\
         记账工具的命令行。名词在前：abei <资源> <动词>。\n\
         默认输出给人看；要机器读就显式加 --json 或 --jq。\n\n",
    );

    out.push_str("## 资源与动词\n\n");
    for resource in catalog().resources() {
        let verbs: Vec<String> = catalog()
            .verbs_for(resource.name)
            .iter()
            .map(|verb| verb.to_string())
            .collect();
        out.push_str(&format!(
            "- {}（{}）：{}　别名 {}\n",
            resource.name,
            resource.label,
            verbs.join(" / "),
            resource.aliases.join(" ")
        ));
    }

    out.push_str("\n## 能力一览\n\n");
    for capability in catalog().capabilities() {
        out.push_str(&format!(
            "- `abei {} {}` {}（风险 {}）：{}\n",
            capability.resource,
            capability.verb,
            capability.label,
            capability.risk.as_str(),
            capability.description
        ));
    }

    out.push_str(
        "\n## 查询语法（有 start/end 的命令可用）\n\n\
         位置参数就是条件，空格并列表示「且」：\n\n\
         - 裸词：在摘要、账户、分类里找\n\
         - `date:2026`、`date:2026-07`、`date:2026-07-15`、`date:2026-07-01..2026-07-31`\n\
         - `amt:'>100'`、`amt:'<=50'`、`amt:45`（比较号要加引号，否则 shell 当重定向）\n\
         - `desc:` 摘要　`acct:` 账户　`cat:` 分类　`cur:` 币种\n\
         - `not:` 取反，比如 `not:cat:房租`\n\n\
         date: 会翻译成服务端的 start/end；其余条件在本地过滤。\n\n\
         所以裸词只在**这一页结果**里筛。要在整个账本里找一家店、一个人，\
         用 `abei transactions search <词>`——那是服务端全文检索，不受翻页限制。\n\n",
    );

    out.push_str(
        "## 输出\n\n\
         - 默认：终端里是表格，管道里是制表符分隔（第一行是字段名）\n\
         - `--json=字段,字段`：只出这些字段的 JSON\n\
         - `--json`（不带值）：列出这条命令有哪些字段可选\n\
         - `--jq '<表达式>'`：对原始响应体跑 jq，内置实现不用装 jq\n\n\
         字段名是契约，改名算破坏性变更；表格排版不是。\n\n",
    );

    out.push_str(
        "## 退出码\n\n\
         0 成功　1 失败　2 中断　3 参数不对　4 没配对/令牌失效　5 上游连不上　6 写操作缺 --yes\n\n\
         draft 会直接写草稿；confirm 必须显式 `--yes`，想先看会改什么就用 `--dry-run`。\n\n",
    );

    // 目录里标了 human_only 的参数在这里点名，模型看到这一段就不该再去编密码。
    let human_only: Vec<String> = catalog()
        .capabilities()
        .iter()
        .flat_map(|capability| {
            let id = capability.id();
            capability
                .human_only()
                .into_iter()
                .map(move |field| format!("`{id}` 的 {field}"))
        })
        .collect();
    if !human_only.is_empty() {
        out.push_str(&format!(
            "## 只能由人填的参数\n\n\
             这些值必须由人在可信界面现敲，模型不要自己编，也不要从别处猜：\n\n\
             {}\n\n\
             命令行上写 `-` 可以从标准输入读，免得落进 shell 历史。\n\n",
            human_only
                .iter()
                .map(|item| format!("- {item}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }

    out.push_str("## 例子\n\n");
    for capability in catalog().capabilities() {
        for example in &capability.examples {
            out.push_str(&format!("# {}\n{}\n", example.title, example.command));
        }
    }
    out.push_str("# 只要金额和分类，交给脚本\nabei tx list date:2026-08 --json=amount,category\n");

    line(io, &out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::SharedBuffer;

    fn capture() -> (Io, SharedBuffer) {
        let out = SharedBuffer::new();
        (Io::capture(out.clone(), SharedBuffer::new()), out)
    }

    #[test]
    fn explain_lists_verbs_flags_and_examples() {
        let (mut io, out) = capture();
        explain(&mut io, "transactions").unwrap();
        let text = out.text();
        assert!(text.contains("交易（transactions）"));
        assert!(text.contains("abei transactions list"));
        assert!(text.contains("--start"));
        assert!(text.contains("例："));
        // id 是位置参数，不能写成 --id。
        assert!(text.contains("<ID>"), "{text}");
        assert!(!text.contains("--id"), "{text}");
    }

    /// 别名也该能 explain。
    #[test]
    fn explain_accepts_aliases() {
        let (mut io, out) = capture();
        explain(&mut io, "tx").unwrap();
        assert!(out.text().contains("交易（transactions）"));
    }

    #[test]
    fn explain_suggests_on_typos() {
        let (mut io, _) = capture();
        let error = explain(&mut io, "transaction s").unwrap_err();
        assert_eq!(error.exit(), crate::exit::Exit::InvalidUsage);
    }

    #[test]
    fn guide_covers_the_whole_contract() {
        let (mut io, out) = capture();
        guide(&mut io).unwrap();
        let text = out.text();
        for needle in [
            "abei <资源> <动词>",
            "查询语法",
            "退出码",
            "--json",
            "--jq",
            "--yes",
            "date:2026-07",
            "not:",
        ] {
            assert!(text.contains(needle), "guide 少了 {needle}");
        }
        // 目录里每条能力都要在 guide 里露面。
        for capability in catalog().capabilities() {
            assert!(
                text.contains(&format!("abei {} {}", capability.resource, capability.verb)),
                "guide 少了 {}",
                capability.id()
            );
        }
    }

    /// guide 是喂给模型的那一页，「别自己编密码」必须写在里面。
    #[test]
    fn guide_names_the_params_only_a_human_may_fill() {
        let (mut io, out) = capture();
        guide(&mut io).unwrap();
        let text = out.text();
        assert!(text.contains("只能由人填的参数"), "{text}");
        assert!(text.contains("`bills.unlock` 的 secret"), "{text}");
        assert!(text.contains("模型不要自己编"), "{text}");
    }

    /// 本地过滤和全文检索长得像，说不清楚人和模型都会拿 list 去翻整个账本。
    #[test]
    fn guide_separates_local_filtering_from_full_text_search() {
        let (mut io, out) = capture();
        guide(&mut io).unwrap();
        let text = out.text();
        assert!(text.contains("abei transactions search"), "{text}");
        assert!(text.contains("这一页结果"), "{text}");
    }

    /// 搜索词是位置参数，explain 里别写成 --query。
    #[test]
    fn explain_shows_the_search_term_as_a_positional() {
        let (mut io, out) = capture();
        explain(&mut io, "transactions").unwrap();
        let text = out.text();
        assert!(text.contains("<QUERY>"), "{text}");
        assert!(!text.contains("--query"), "{text}");
    }

    /// explain 里这一格写「人填」而不是「必填」——后者会被当成「你去想一个」。
    #[test]
    fn explain_marks_human_only_params() {
        let (mut io, out) = capture();
        explain(&mut io, "bills").unwrap();
        let line = out
            .text()
            .lines()
            .find(|line| line.contains("--secret"))
            .unwrap_or_default()
            .to_owned();
        assert!(line.contains("人填"), "{line}");
        assert!(!line.contains("必填"), "{line}");
    }
}
