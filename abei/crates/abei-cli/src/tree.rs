//! 命令树由能力目录生成。
//!
//! 一条能力 = 一条 `abei <资源> <动词>` 子命令，参数由它的 JSON Schema 摊成 flag。
//! 资源和动词是目录里的一等字段，所以不存在「API 操作名 -> 命令路径」的翻译表
//! （Oxide 的 CLI 就得手工维护那么一张四百多行的表，我们不必）。
//!
//! 手写命令用 derive 写好，再按路径嫁接进这棵树。

use abei_core::{Capability, Verb, catalog};
use clap::{Arg, ArgAction, ArgMatches, Command, value_parser};
use serde_json::{Map, Value};
use std::io::{BufRead, IsTerminal};

use crate::error::CliError;

/// schema 里的字段类型，只区分 CLI 需要区分的那几种。
#[derive(Debug, Clone, Copy, PartialEq)]
enum FieldKind {
    Text,
    Integer,
    Flag,
    List,
}

fn kind_of(schema: &Value) -> FieldKind {
    // Option<T> 会生成 ["string","null"] 这样的联合，取非 null 的那个。
    let name = match schema.get("type") {
        Some(Value::String(single)) => single.as_str(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .find(|item| *item != "null")
            .unwrap_or("string"),
        _ => "string",
    };
    match name {
        "integer" | "number" => FieldKind::Integer,
        "boolean" => FieldKind::Flag,
        "array" => FieldKind::List,
        _ => FieldKind::Text,
    }
}

/// `exclude_category` -> `--exclude-category`
fn flag_name(field: &str) -> String {
    match field {
        "labels" => "label".to_owned(),
        "submitted_by" => "by".to_owned(),
        _ => field.replace('_', "-"),
    }
}

/// 列表项的模式。`Vec<u64>` 和 `Vec<RowSplit>` 在命令行上要写成不同的样子，
/// 差别只能从这里看出来。
fn item_schema(schema: &Value) -> Option<&Value> {
    schema.get("items").filter(|items| items.is_object())
}

/// 对象的属性名，按模式里的顺序。
fn keys_of(schema: &Value) -> Vec<&str> {
    schema
        .get("properties")
        .and_then(Value::as_object)
        .map(|map| map.keys().map(String::as_str).collect())
        .unwrap_or_default()
}

/// 把命令行上的一个列表项还原成 JSON。
///
/// 整数列表直接转数字；对象列表写成 `键=值,键=值`（值里有逗号时改写整段 JSON）。
/// 两种写法都认，因为人手敲的和 agent 生成的习惯不一样。
fn parse_item(field: &str, item: Option<&Value>, raw: &str) -> Result<Value, CliError> {
    let Some(item) = item else {
        return Ok(Value::String(raw.to_owned()));
    };

    match kind_of(item) {
        FieldKind::Integer => raw.trim().parse::<i64>().map(Value::from).map_err(|_| {
            CliError::Usage(format!(
                "--{} 要的是整数，收到的是 {raw}。",
                flag_name(field)
            ))
        }),
        FieldKind::Text if keys_of(item).is_empty() => Ok(Value::String(raw.to_owned())),
        // 对象：先试整段 JSON，再试 键=值。
        _ => {
            if raw.trim_start().starts_with('{') {
                return serde_json::from_str(raw).map_err(|error| {
                    CliError::Usage(format!("--{} 这段 JSON 读不了：{error}", flag_name(field)))
                });
            }

            let allowed = keys_of(item);
            let mut object = Map::new();
            for pair in raw.split(',') {
                let Some((key, value)) = pair.split_once('=') else {
                    return Err(CliError::Usage(format!(
                        "--{} 要写成 键=值,键=值，比如 {}。值里带逗号就改写整段 JSON。",
                        flag_name(field),
                        example_of(item)
                    )));
                };
                let key = key.trim();
                if !allowed.contains(&key) {
                    return Err(CliError::Usage(format!(
                        "--{} 里没有 {key} 这一项。能填的是：{}。",
                        flag_name(field),
                        allowed.join("、")
                    )));
                }
                let typed = item
                    .get("properties")
                    .and_then(|props| props.get(key))
                    .map(|schema| coerce(schema, value.trim()))
                    .unwrap_or_else(|| Value::String(value.trim().to_owned()));
                object.insert(key.to_owned(), typed);
            }
            Ok(Value::Object(object))
        }
    }
}

/// 单个值按模式里的类型还原；转不动就按字符串留着，让服务端报更准的错。
fn coerce(schema: &Value, raw: &str) -> Value {
    match kind_of(schema) {
        FieldKind::Integer => raw
            .parse::<i64>()
            .map(Value::from)
            .unwrap_or_else(|_| Value::String(raw.to_owned())),
        FieldKind::Flag => match raw {
            "true" | "1" | "yes" => Value::Bool(true),
            "false" | "0" | "no" => Value::Bool(false),
            other => Value::String(other.to_owned()),
        },
        _ => Value::String(raw.to_owned()),
    }
}

/// 报错时给一个照着抄的样子，键名从模式里来。
fn example_of(item: &Value) -> String {
    keys_of(item)
        .iter()
        .take(2)
        .map(|key| format!("{key}=…"))
        .collect::<Vec<_>>()
        .join(",")
}

fn properties(capability: &Capability) -> Vec<(String, Value)> {
    capability
        .params
        .as_value()
        .get("properties")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn required(capability: &Capability) -> Vec<String> {
    capability
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
        .unwrap_or_default()
}

/// 有 start 和 end 的能力接受 hledger 式查询串。这是看 schema 决定的，
/// 不是按资源名写死的，将来别的资源有同样字段也自动获得。
fn takes_query(capability: &Capability) -> bool {
    let fields = properties(capability);
    let has = |name: &str| fields.iter().any(|(key, _)| key == name);
    has("start") && has("end")
}

fn leaf(capability: &Capability) -> Command {
    let mut command = Command::new(capability.verb.as_str())
        .about(capability.label)
        .long_about(long_about(capability));

    let required_fields = required(capability);
    let human_only = capability.human_only();
    let file_inputs = capability.file_inputs();
    let json_inputs = capability.json_inputs();

    for (field, schema) in properties(capability) {
        if capability.fixed_param_value(&field).is_some() {
            continue;
        }
        let help = schema
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();

        if capability.path_param() == Some(field.as_str()) {
            command = command.arg(
                Arg::new(field.clone())
                    .help(if help.is_empty() {
                        format!("对象 {field}")
                    } else {
                        help
                    })
                    .required(true)
                    .value_name(field.to_uppercase()),
            );
            continue;
        }

        // 目录里标了 x-abei-positional 的那个参数直接写在命令后面。
        if capability.positional().as_deref() == Some(field.as_str()) {
            command = command.arg(
                Arg::new(field.clone())
                    .help(help)
                    .required(required_fields.contains(&field))
                    .value_name(field.to_uppercase()),
            );
            continue;
        }

        let kind = kind_of(&schema);
        // 对象列表的 flag 要在帮助里把能填的键列出来，不然只能去猜。
        let item_keys = if kind == FieldKind::List {
            item_schema(&schema).map(keys_of).unwrap_or_default()
        } else {
            Vec::new()
        };
        let help = if item_keys.is_empty() {
            help
        } else {
            format!(
                "{help}　每项写成 键=值,键=值，可重复。能填：{}",
                item_keys.join("、")
            )
        };
        // 只能人填的值提醒一句怎么不落进 shell 历史。
        let help = if json_inputs.contains(&field) {
            format!("{help}　填写 JSON，支持 @文件 或 -（标准输入）")
        } else if human_only.contains(&field) {
            format!("{help}　由人现填，写 - 从标准输入读")
        } else if file_inputs.contains(&field) {
            format!("{help}　支持 @文件、-（标准输入）或直接写正文")
        } else {
            help
        };

        let mut arg = Arg::new(field.clone())
            .long(flag_name(&field))
            .help(help)
            .required(required_fields.contains(&field));

        arg = match kind {
            FieldKind::Flag => arg.action(ArgAction::SetTrue),
            FieldKind::Integer => arg
                .action(ArgAction::Set)
                .value_parser(value_parser!(u32))
                .value_name("数字"),
            FieldKind::List if !item_keys.is_empty() => {
                arg.action(ArgAction::Append).value_name("键=值,键=值")
            }
            FieldKind::List => arg
                .action(ArgAction::Append)
                .value_name(field.to_uppercase()),
            FieldKind::Text => arg.action(ArgAction::Set).value_name(field.to_uppercase()),
        };

        command = command.arg(arg);
    }

    if takes_query(capability) {
        command = command.arg(
            Arg::new("__query")
                .help("查询条件，比如 餐饮 date:2026-07 amt:'>100'（见 abei guide）")
                .value_name("查询")
                .num_args(0..)
                .action(ArgAction::Append),
        );
    }

    // 写能力才有闸门开关，只读命令的 --help 不该被它们占地方。
    if capability.risk.is_write() {
        command = command
            .arg(
                Arg::new("__dry_run")
                    .long("dry-run")
                    .help("只看会改什么，不落库")
                    .action(ArgAction::SetTrue),
            )
            .arg(
                Arg::new("__yes")
                    .long("yes")
                    .help("确认执行这次写操作")
                    .action(ArgAction::SetTrue),
            );
    }

    command
}

/// 帮助正文里带上示例，人和 agent 都照着抄。
fn long_about(capability: &Capability) -> String {
    let mut text = capability.description.to_owned();
    text.push_str(&format!(
        "\n\n风险：{}　后端：{}",
        capability.risk.as_str(),
        capability.backend.as_str()
    ));
    if !capability.examples.is_empty() {
        text.push_str("\n\n示例：");
        for example in &capability.examples {
            text.push_str(&format!("\n  # {}\n  {}", example.title, example.command));
        }
    }
    text
}

/// 生成资源子命令。
pub fn resource_commands() -> Vec<Command> {
    catalog()
        .resources()
        .iter()
        .filter_map(|resource| {
            let verbs = catalog().verbs_for(resource.name);
            if verbs.is_empty() {
                return None;
            }
            let mut command = Command::new(resource.name)
                .about(resource.label)
                .long_about(format!(
                    "{}\n\n别名：{}",
                    resource.description,
                    resource.aliases.join("、")
                ))
                .subcommand_required(true)
                .arg_required_else_help(true);
            for alias in resource.aliases {
                command = command.alias(*alias);
            }
            for verb in verbs {
                if let Some(capability) = catalog().get(resource.name, verb) {
                    command = command.subcommand(leaf(capability));
                }
            }
            Some(command)
        })
        .collect()
}

/// 从解析结果还原参数对象。schema 是唯一真源，这里只做类型还原。
pub fn params_from(
    capability: &Capability,
    matches: &ArgMatches,
) -> Result<Map<String, Value>, CliError> {
    let mut params = Map::new();
    let human_only = capability.human_only();
    let file_inputs = capability.file_inputs();
    let json_inputs = capability.json_inputs();

    for (field, schema) in properties(capability) {
        if capability.fixed_param_value(&field).is_some() {
            continue;
        }
        if capability.path_param() == Some(field.as_str()) {
            if let Some(value) = matches.get_one::<String>(&field) {
                params.insert(field, Value::String(value.clone()));
            }
            continue;
        }

        match kind_of(&schema) {
            FieldKind::Flag => {
                if matches.get_flag(&field) {
                    params.insert(field, Value::Bool(true));
                }
            }
            FieldKind::Integer => {
                if let Some(number) = matches.get_one::<u32>(&field) {
                    params.insert(field, Value::from(*number));
                }
            }
            FieldKind::List => {
                let item = item_schema(&schema);
                let mut values = Vec::new();
                for raw in matches.get_many::<String>(&field).into_iter().flatten() {
                    values.push(parse_item(&field, item, raw)?);
                }
                if !values.is_empty() {
                    params.insert(field, Value::Array(values));
                }
            }
            FieldKind::Text => {
                if let Some(text) = matches.get_one::<String>(&field) {
                    // 只能人填的值（密码、验证码）支持 `-` 从标准输入读，别落进 shell 历史。
                    let value = if human_only.contains(&field) {
                        read_secret(&field, text)?
                    } else if file_inputs.contains(&field) {
                        read_text_input(&field, text)?
                    } else {
                        text.clone()
                    };
                    if json_inputs.contains(&field) {
                        let parsed = serde_json::from_str(&value).map_err(|error| {
                            CliError::Usage(format!(
                                "--{} 不是有效 JSON：{error}",
                                flag_name(&field)
                            ))
                        })?;
                        params.insert(field, parsed);
                    } else {
                        params.insert(field, Value::String(value));
                    }
                }
            }
        }
    }

    for fixed in capability.fixed_params() {
        params.insert(fixed.name.to_owned(), Value::String(fixed.value.to_owned()));
    }

    Ok(params)
}

fn read_text_input(field: &str, raw: &str) -> Result<String, CliError> {
    if raw == "-" {
        let mut buffer = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut buffer).map_err(|error| {
            CliError::Usage(format!("从标准输入读 {} 失败：{error}", flag_name(field)))
        })?;
        return Ok(buffer);
    }
    if let Some(path) = raw.strip_prefix('@') {
        if path.is_empty() {
            return Err(CliError::Usage(format!(
                "{} 的 @ 后面要写文件路径。",
                flag_name(field)
            )));
        }
        return std::fs::read_to_string(path).map_err(|error| {
            CliError::Usage(format!(
                "读取 {} 的文件 {path} 失败：{error}",
                flag_name(field)
            ))
        });
    }
    Ok(raw.to_owned())
}

/// `--secret -` 从标准输入读，跟 `--token -` 一个规矩。
fn read_secret(field: &str, raw: &str) -> Result<String, CliError> {
    if raw != "-" {
        return Ok(raw.to_owned());
    }
    let value = if std::io::stdin().is_terminal() {
        rpassword::prompt_password(format!("请输入 {}（输入不回显）：", flag_name(field)))
            .map_err(|error| CliError::Usage(format!("读取 {} 失败：{error}", flag_name(field))))?
    } else {
        read_secret_line(&mut std::io::BufReader::new(std::io::stdin()), field)?
    };
    if value.is_empty() {
        return Err(CliError::Usage(format!(
            "标准输入里没有 {}。",
            flag_name(field)
        )));
    }
    Ok(value)
}

fn read_secret_line<R: BufRead>(reader: &mut R, field: &str) -> Result<String, CliError> {
    let mut buffer = String::new();
    reader.read_line(&mut buffer).map_err(|error| {
        CliError::Usage(format!("从标准输入读 {} 失败：{error}", flag_name(field)))
    })?;
    if buffer.is_empty() {
        return Err(CliError::Usage(format!(
            "标准输入里没有 {}。",
            flag_name(field)
        )));
    }
    Ok(buffer.trim_end_matches(['\r', '\n']).to_owned())
}

/// 取出位置参数里的查询串。没有时间范围的能力压根没这个位置参数，所以要容错取。
pub fn query_terms(matches: &ArgMatches) -> Vec<String> {
    matches
        .try_get_many::<String>("__query")
        .ok()
        .flatten()
        .map(|items| items.cloned().collect())
        .unwrap_or_default()
}

/// 找出用户输入的资源对应的目录条目。别名也算。
pub fn resolve(resource: &str) -> Option<&'static str> {
    catalog().resolve_resource(resource).map(|def| def.name)
}

/// 用户把动词写在了前面（`abei list tx`）时给个方向。
pub fn looks_like_a_verb(token: &str) -> bool {
    token.parse::<Verb>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> Command {
        Command::new("abei")
            .no_binary_name(true)
            .subcommands(resource_commands())
    }

    #[test]
    fn file_input_preserves_markdown_bytes() {
        let path = std::env::temp_dir().join(format!(
            "abei-profile-doc-{}-{}.md",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let markdown = "# 规则\n\n- 原样保留\n";
        std::fs::write(&path, markdown).unwrap();
        let value = read_text_input("content_md", &format!("@{}", path.display())).unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(value, markdown);
        assert_eq!(read_text_input("content_md", "literal").unwrap(), "literal");
    }

    #[test]
    fn json_file_inputs_become_structured_request_values() {
        let matches = root()
            .try_get_matches_from([
                "mail-rules",
                "test",
                "--conditions",
                r#"{"type":"text","field":"from","operator":"contains","value":"bank"}"#,
            ])
            .unwrap();
        let (_, sub) = matches.subcommand().unwrap();
        let (_, leaf) = sub.subcommand().unwrap();
        let capability = catalog().get("mail-rules", Verb::Test).unwrap();
        let params = params_from(capability, leaf).unwrap();
        assert_eq!(params["conditions"]["field"], "from");
        assert!(params["conditions"].is_object());
    }

    #[test]
    fn every_capability_becomes_a_command() {
        let root = root();
        for capability in catalog().capabilities() {
            let [resource, verb] = capability.command_path();
            let found = root
                .get_subcommands()
                .find(|c| c.get_name() == resource)
                .and_then(|c| c.get_subcommands().find(|s| s.get_name() == verb));
            assert!(found.is_some(), "{} 没生成命令", capability.id());
        }
    }

    #[test]
    fn resource_aliases_work_as_commands() {
        let matches = root().try_get_matches_from(["tx", "list"]).unwrap();
        let (resource, sub) = matches.subcommand().unwrap();
        // 别名解析回正名由 resolve 负责。
        assert_eq!(resolve(resource), Some("transactions"));
        assert_eq!(sub.subcommand_name(), Some("list"));
    }

    #[test]
    fn schema_fields_become_flags() {
        let matches = root()
            .try_get_matches_from([
                "transactions",
                "list",
                "--start",
                "2026-08-01",
                "--limit",
                "5",
            ])
            .unwrap();
        let (_, sub) = matches.subcommand().unwrap();
        let (_, leaf) = sub.subcommand().unwrap();

        let capability = catalog().get("transactions", Verb::List).unwrap();
        let params = params_from(capability, leaf).unwrap();
        assert_eq!(params["start"], "2026-08-01");
        assert_eq!(params["limit"], 5);
    }

    /// serde 改过名的字段（kind -> type）要按 schema 里的名字出 flag。
    #[test]
    fn renamed_fields_use_their_schema_name() {
        let matches = root()
            .try_get_matches_from(["transactions", "list", "--type", "withdrawal"])
            .unwrap();
        let (_, sub) = matches.subcommand().unwrap();
        let (_, leaf) = sub.subcommand().unwrap();
        let capability = catalog().get("transactions", Verb::List).unwrap();
        let params = params_from(capability, leaf).unwrap();
        assert_eq!(params["type"], "withdrawal");
    }

    /// 下划线字段名变成中划线 flag，可重复。
    #[test]
    fn list_fields_become_repeatable_kebab_flags() {
        let matches = root()
            .try_get_matches_from([
                "transactions",
                "summary",
                "--exclude-category",
                "房租",
                "--exclude-category",
                "还款",
            ])
            .unwrap();
        let (_, sub) = matches.subcommand().unwrap();
        let (_, leaf) = sub.subcommand().unwrap();
        let capability = catalog().get("transactions", Verb::Summary).unwrap();
        let params = params_from(capability, leaf).unwrap();
        assert_eq!(
            params["exclude_category"],
            serde_json::json!(["房租", "还款"])
        );
    }

    #[test]
    fn id_is_a_positional_for_item_scoped_verbs() {
        let matches = root()
            .try_get_matches_from(["transactions", "show", "42"])
            .unwrap();
        let (_, sub) = matches.subcommand().unwrap();
        let (_, leaf) = sub.subcommand().unwrap();
        let capability = catalog().get("transactions", Verb::Show).unwrap();
        let params = params_from(capability, leaf).unwrap();
        assert_eq!(params["id"], "42");
    }

    /// 必填的 id 缺了要报用法错，不是打到服务端才发现。
    #[test]
    fn missing_id_is_caught_locally() {
        assert!(
            root()
                .try_get_matches_from(["transactions", "show"])
                .is_err()
        );
    }

    #[test]
    fn integers_are_validated_before_leaving_the_machine() {
        let bad = root().try_get_matches_from(["transactions", "list", "--limit", "abc"]);
        assert!(bad.is_err());
    }

    #[test]
    fn unknown_flags_are_rejected() {
        let bad = root().try_get_matches_from(["transactions", "list", "--nope", "1"]);
        assert!(bad.is_err());
    }

    #[test]
    fn query_terms_are_collected_for_range_capabilities() {
        let matches = root()
            .try_get_matches_from(["transactions", "list", "餐饮", "date:2026-07"])
            .unwrap();
        let (_, sub) = matches.subcommand().unwrap();
        let (_, leaf) = sub.subcommand().unwrap();
        assert_eq!(query_terms(leaf), vec!["餐饮", "date:2026-07"]);
    }

    /// show 没有 start/end，就不该接受查询串。
    #[test]
    fn capabilities_without_a_range_take_no_query() {
        let show = catalog().get("transactions", Verb::Show).unwrap();
        assert!(!takes_query(show));
        let list = catalog().get("transactions", Verb::List).unwrap();
        assert!(takes_query(list));
    }

    /// 只读命令不带 --yes / --dry-run。
    #[test]
    fn read_commands_have_no_write_gate_flags() {
        let bad = root().try_get_matches_from(["transactions", "list", "--yes"]);
        assert!(bad.is_err());
    }

    #[test]
    fn write_commands_carry_the_gate_flags() {
        let write = Capability::define("bills", Verb::Import)
            .risk(abei_core::Risk::Confirm)
            .label("导入账单")
            .description("测试用")
            .params::<abei_core::TransactionsShowParams>();
        let command = leaf(&write);
        let names: Vec<&str> = command
            .get_arguments()
            .map(|a| a.get_id().as_str())
            .collect();
        assert!(names.contains(&"__yes"));
        assert!(names.contains(&"__dry_run"));
    }

    #[test]
    fn fixed_params_are_hidden_and_injected() {
        let matches = root()
            .try_get_matches_from([
                "profile-doc",
                "create",
                "personal-rules",
                "--title",
                "个人规则",
                "--content-md",
                "# 规则",
            ])
            .unwrap();
        let (_, sub) = matches.subcommand().unwrap();
        let (_, leaf) = sub.subcommand().unwrap();
        let capability = catalog().get("profile-doc", Verb::Create).unwrap();
        assert!(leaf.try_get_one::<String>("source").is_err());
        let params = params_from(capability, leaf).unwrap();
        assert_eq!(params["source"], "cli");
    }

    #[test]
    fn help_text_carries_examples() {
        let capability = catalog().get("transactions", Verb::Summary).unwrap();
        let text = long_about(capability);
        assert!(text.contains("示例"));
        assert!(text.contains("abei transactions summary"));
        assert!(text.contains("风险：read"));
    }

    #[test]
    fn type_union_with_null_resolves_to_the_real_type() {
        assert_eq!(
            kind_of(&serde_json::json!({"type":["integer","null"]})),
            FieldKind::Integer
        );
        assert_eq!(
            kind_of(&serde_json::json!({"type":["array","null"]})),
            FieldKind::List
        );
        assert_eq!(
            kind_of(&serde_json::json!({"type":"string"})),
            FieldKind::Text
        );
        assert_eq!(
            kind_of(&serde_json::json!({"type":"boolean"})),
            FieldKind::Flag
        );
    }

    fn params_of(
        args: &[&str],
        resource: &str,
        verb: Verb,
    ) -> Result<Map<String, Value>, CliError> {
        let matches = root().try_get_matches_from(args).unwrap();
        let (_, sub) = matches.subcommand().unwrap();
        let (_, leaf) = sub.subcommand().unwrap();
        params_from(catalog().get(resource, verb).unwrap(), leaf)
    }

    /// 整数列表要真的变成数字，不能把 "1" 当字符串发出去。
    #[test]
    fn integer_lists_are_parsed_as_numbers() {
        let params = params_of(
            &["bills", "import", "42", "--row-ids", "1", "--row-ids", "2"],
            "bills",
            Verb::Import,
        )
        .unwrap();
        assert_eq!(params["row_ids"], serde_json::json!([1, 2]));
        assert_eq!(params["id"], "42");
    }

    #[test]
    fn integer_lists_reject_non_numbers_with_the_flag_name() {
        let error = params_of(
            &["rows", "split", "7", "--splits", "amount=x"],
            "rows",
            Verb::Split,
        );
        // 这条走的是对象列表，金额留成字符串交给服务端校验，不在这里报错。
        assert!(error.is_ok());

        let error = params_of(
            &["bills", "import", "42", "--row-ids", "第一行"],
            "bills",
            Verb::Import,
        )
        .unwrap_err();
        assert!(error.human().contains("--row-ids"), "{}", error.human());
    }

    /// 对象列表写成 键=值,键=值，可重复。
    #[test]
    fn object_lists_take_key_value_pairs() {
        let params = params_of(
            &[
                "rows",
                "split",
                "7",
                "--splits",
                "amount=20.00,description=菜",
                "--splits",
                "amount=25.00,description=酒,category_name=餐饮",
            ],
            "rows",
            Verb::Split,
        )
        .unwrap();
        assert_eq!(
            params["splits"],
            serde_json::json!([
                { "amount": "20.00", "description": "菜" },
                { "amount": "25.00", "description": "酒", "category_name": "餐饮" }
            ])
        );
    }

    /// 值里带逗号时可以改写整段 JSON。
    #[test]
    fn object_lists_also_take_raw_json() {
        let params = params_of(
            &[
                "rows",
                "split",
                "7",
                "--splits",
                r#"{"amount":"20.00","description":"菜，很多"}"#,
                "--splits",
                "amount=25.00,description=酒",
            ],
            "rows",
            Verb::Split,
        )
        .unwrap();
        assert_eq!(params["splits"][0]["description"], "菜，很多");
        assert_eq!(params["splits"][1]["amount"], "25.00");
    }

    /// 键写错要把能填的列出来，不是甩一句「格式不对」。
    #[test]
    fn object_lists_name_the_allowed_keys() {
        let error = params_of(
            &["rows", "split", "7", "--splits", "amont=20.00"],
            "rows",
            Verb::Split,
        )
        .unwrap_err();
        let message = error.human();
        assert!(message.contains("amont"), "{message}");
        assert!(message.contains("description"), "{message}");
    }

    #[test]
    fn object_lists_explain_the_shape_when_the_equals_is_missing() {
        let error = params_of(
            &["rows", "split", "7", "--splits", "20.00"],
            "rows",
            Verb::Split,
        )
        .unwrap_err();
        assert!(error.human().contains("键=值"), "{}", error.human());
    }

    /// 对象列表的帮助要把能填的键写出来。
    #[test]
    fn object_list_help_lists_the_keys() {
        let command = leaf(catalog().get("rows", Verb::Split).unwrap());
        let help = command
            .get_arguments()
            .find(|a| a.get_id() == "splits")
            .unwrap()
            .get_help()
            .unwrap()
            .to_string();
        assert!(help.contains("amount"), "{help}");
        assert!(help.contains("description"), "{help}");
    }

    /// 密码这类参数在帮助里要点破「由人现填」，不然模型会当成普通字符串编一个。
    #[test]
    fn human_only_params_say_so_in_the_help() {
        let unlock = catalog().get("bills", Verb::Unlock).unwrap();
        assert_eq!(unlock.human_only(), vec!["secret".to_owned()]);

        let help = leaf(unlock)
            .get_arguments()
            .find(|a| a.get_id() == "secret")
            .unwrap()
            .get_help()
            .unwrap()
            .to_string();
        assert!(help.contains("由人现填"), "{help}");
        assert!(help.contains("标准输入"), "{help}");

        // 普通参数不该被加上这句。
        let import = catalog().get("bills", Verb::Import).unwrap();
        let help = leaf(import)
            .get_arguments()
            .find(|a| a.get_id() == "row_ids")
            .unwrap()
            .get_help()
            .unwrap()
            .to_string();
        assert!(!help.contains("由人现填"), "{help}");
    }

    /// 不写 `-` 的值原样用，写了才去读标准输入。
    #[test]
    fn secrets_pass_through_unless_you_ask_for_stdin() {
        assert_eq!(read_secret("secret", "hunter2").unwrap(), "hunter2");
        // 空白不当成 `-`，免得把不小心敲的空格当命令用。
        assert_eq!(read_secret("secret", " - ").unwrap(), " - ");
    }

    #[test]
    fn secret_stdin_reads_one_line_without_waiting_for_eof() {
        let mut reader = std::io::Cursor::new(b"code-123\r\ntrailing".to_vec());
        assert_eq!(read_secret_line(&mut reader, "secret").unwrap(), "code-123");
    }

    #[test]
    fn verbs_are_recognisable_for_word_order_hints() {
        assert!(looks_like_a_verb("list"));
        assert!(looks_like_a_verb("import"));
        assert!(!looks_like_a_verb("transactions"));
    }
}
