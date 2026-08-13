//! 根命令的组装与分发。
//!
//! 生成的资源命令树 + 手写命令（derive 写好后嫁接进来），共用一套全局开关和
//! 一个钩子层。

use abei_core::{Verb, catalog};
use clap::{Arg, Command};
use clap::{ArgMatches, CommandFactory, FromArgMatches, Parser, Subcommand};
use clap_complete::Shell;

use crate::client::Client;
use crate::commands::{self, auth::AuthCommand, docs, parser::ParserCommand};
use crate::config::Settings;
use crate::error::CliError;
use crate::exit::Exit;
use crate::hooks::{Format, Hooks};
use crate::io::Io;
use crate::tree;

// 手写命令。用 derive 定义，再嫁接到生成的命令树上。
#[derive(Debug, Subcommand)]
enum Handwritten {
    /// 配对与令牌
    Auth {
        #[command(subcommand)]
        command: AuthCommand,
    },
    /// 解析流程开发与发布
    Parser {
        #[command(subcommand)]
        command: ParserCommand,
    },
    /// 讲清楚一个资源有哪些动词和参数
    Explain {
        /// 资源名或别名
        #[arg(value_name = "资源")]
        resource: String,
    },
    /// 一页纸说明书，给 AI 看
    Guide,
    /// 生成 shell 补全脚本
    #[command(hide = true)]
    Completion {
        #[arg(value_name = "SHELL")]
        shell: Shell,
    },
    /// 生成 man page
    #[command(hide = true)]
    Man,
}

/// 只为拿到 `--help` 里的全局说明，实际解析走 builder。
#[derive(Debug, Parser)]
#[command(
    name = "abei",
    version,
    about = "阿贝：记账的命令行",
    long_about = "阿贝（abei）——记账工具的命令行。\n\n\
                  名词在前：abei <资源> <动词>。默认输出给人看，\n\
                  要机器读就加 --json 或 --jq。写操作要 --yes。\n\n\
                  不知道能干什么就跑 abei guide。",
    disable_help_subcommand = true
)]
struct Root;

pub fn root_command() -> Command {
    let mut command = Root::command()
        .arg(
            Arg::new("__url")
                .long("url")
                .global(true)
                .value_name("URL")
                .help("abei-api 地址，盖过配置与 ABEI_API_URL"),
        )
        .arg(
            Arg::new("__token")
                .long("token")
                .global(true)
                .value_name("TOKEN")
                .help("令牌，盖过令牌文件与 ABEI_TOKEN；auth login 存的也是它，写 - 从标准输入读"),
        )
        .arg(
            Arg::new("__json")
                .long("json")
                .global(true)
                .num_args(0..=1)
                .require_equals(true)
                .default_missing_value("")
                .value_name("字段,字段")
                .help("输出 JSON；不带值时列出可选字段"),
        )
        .arg(
            Arg::new("__jq")
                .long("jq")
                .global(true)
                .value_name("表达式")
                .help("对原始响应跑 jq 表达式"),
        )
        .arg(
            Arg::new("__month")
                .long("month")
                .value_name("YYYY-MM")
                .help("裸命令看哪个月，默认本月"),
        );

    // 手写命令嫁接。
    command = Handwritten::augment_subcommands(command);

    // 目录生成的资源命令。
    for resource in tree::resource_commands() {
        command = command.subcommand(resource);
    }

    command
        .subcommand_required(false)
        .arg_required_else_help(false)
}

fn hooks_from(matches: &ArgMatches) -> Hooks {
    let format = match matches.get_one::<String>("__json") {
        None => Format::Human,
        Some(value) if value.is_empty() => Format::FieldList,
        Some(value) => Format::Json(
            value
                .split(',')
                .map(str::trim)
                .filter(|field| !field.is_empty())
                .map(str::to_owned)
                .collect(),
        ),
    };

    let (dry_run, yes) = gate_flags(matches);
    Hooks {
        format,
        jq: matches.get_one::<String>("__jq").cloned(),
        dry_run,
        yes,
    }
}

/// --dry-run / --yes 只长在写能力的叶子上，别处取不到，得容错。
fn gate_flags(matches: &ArgMatches) -> (bool, bool) {
    let flag = |name: &str| {
        matches
            .try_get_one::<bool>(name)
            .ok()
            .flatten()
            .copied()
            .unwrap_or(false)
    };
    (flag("__dry_run"), flag("__yes"))
}

pub async fn run(io: &mut Io, settings: Settings, argv: Vec<String>) -> Exit {
    let matches = match root_command().try_get_matches_from(argv.clone()) {
        Ok(matches) => matches,
        Err(error) => return report_clap_error(io, error),
    };

    let settings = effective_settings(settings, &matches);
    match dispatch(io, settings.clone(), &matches, &argv).await {
        Ok(()) => Exit::Ok,
        Err(error) => {
            // 管道被下游关掉是正常收工，不该报错也不该 panic。
            if crate::hooks::is_broken_pipe(&error) {
                return Exit::Ok;
            }
            let hooks = hooks_from(&matches);
            if matches!(error, CliError::Auth(_))
                && settings.token.is_none()
                && !hooks.machine()
                && io.tty
                && crate::pairing::can_open()
                && let Some(url) = crate::pairing::open_pairing(&settings).await
            {
                io.note(&format!(
                    "还没配对。已经在浏览器打开配对页：{url}\n\
                     复制完整的配对命令，粘回终端就行。（agent 与 CI 设 ABEI_TOKEN 更省事）"
                ));
                return error.exit();
            }
            hooks.emit_error(io, &error);
            error.exit()
        }
    }
}

fn effective_settings(settings: Settings, matches: &ArgMatches) -> Settings {
    Settings::new(
        matches
            .get_one::<String>("__url")
            .cloned()
            .unwrap_or(settings.api_url),
        matches
            .get_one::<String>("__token")
            .cloned()
            .or(settings.token),
    )
}

async fn dispatch(
    io: &mut Io,
    settings: Settings,
    matches: &ArgMatches,
    argv: &[String],
) -> Result<(), CliError> {
    let Some((name, sub)) = matches.subcommand() else {
        // 裸 abei：本月概览。
        let client = Client::new(
            &settings.api_url,
            Some(settings.require_token()?.to_owned()),
        )?;
        let month = matches
            .get_one::<String>("__month")
            .cloned()
            .unwrap_or_else(crate::clock::current_month);
        return commands::overview(io, &client, &month).await;
    };

    // 手写命令：不碰目录，也不都需要令牌。
    if matches!(
        name,
        "auth" | "parser" | "explain" | "guide" | "completion" | "man"
    ) {
        let command = Handwritten::from_arg_matches(matches)
            .map_err(|error| CliError::Usage(error.to_string()))?;
        return run_handwritten(io, &settings, command).await;
    }

    // 其余走目录。
    run_capability(io, &settings, name, sub, argv).await
}

async fn run_handwritten(
    io: &mut Io,
    settings: &Settings,
    command: Handwritten,
) -> Result<(), CliError> {
    match command {
        Handwritten::Auth { command } => commands::auth::run(io, settings, &command).await,
        Handwritten::Parser { command } => commands::parser::run(io, settings, &command).await,
        Handwritten::Explain { resource } => docs::explain(io, &resource),
        Handwritten::Guide => docs::guide(io),
        Handwritten::Completion { shell } => {
            let mut buffer = Vec::new();
            clap_complete::generate(shell, &mut root_command(), "abei", &mut buffer);
            io.line(&String::from_utf8_lossy(&buffer))
                .map_err(|error| CliError::Other(error.to_string()))
        }
        Handwritten::Man => {
            let mut buffer = Vec::new();
            clap_mangen::Man::new(root_command())
                .render(&mut buffer)
                .map_err(|error| CliError::Other(error.to_string()))?;
            io.line(&String::from_utf8_lossy(&buffer))
                .map_err(|error| CliError::Other(error.to_string()))
        }
    }
}

/// 把用户敲的命令还原成一行，给「缺 --yes」的报错回显用——agent 照抄就能重试。
/// argv[0] 是程序路径（可能是 target/debug/abei），一律换成 abei。
fn retyped(argv: &[String]) -> String {
    let rest: Vec<&str> = argv
        .iter()
        .skip(1)
        .map(String::as_str)
        .filter(|token| !token.starts_with("--yes"))
        .collect();
    if rest.is_empty() {
        "abei".to_owned()
    } else {
        format!("abei {}", rest.join(" "))
    }
}

async fn run_capability(
    io: &mut Io,
    settings: &Settings,
    resource_input: &str,
    sub: &ArgMatches,
    argv: &[String],
) -> Result<(), CliError> {
    let resource = tree::resolve(resource_input)
        .ok_or_else(|| CliError::Usage(format!("没有叫 {resource_input} 的资源。")))?;

    let (verb_name, leaf) = sub
        .subcommand()
        .ok_or_else(|| CliError::Usage(format!("abei {resource} 后面还要跟一个动词。")))?;
    let verb: Verb = verb_name
        .parse()
        .map_err(|_| CliError::Usage(format!("不认得动词 {verb_name}。")))?;

    let capability = catalog()
        .get(resource, verb)
        .ok_or_else(|| CliError::Usage(format!("{resource} 没有 {verb_name} 这个动作。")))?;

    let mut hooks = hooks_from(sub);
    let (dry_run, yes) = gate_flags(leaf);
    hooks.dry_run = hooks.dry_run || dry_run;
    hooks.yes = hooks.yes || yes;

    // 写闸门：只读能力直接过，写能力必须 --yes 或 --dry-run。
    hooks.gate(capability, &retyped(argv))?;

    let mut params = tree::params_from(capability, leaf)?;
    if capability.id() == "feedback.create" {
        crate::diagnostics::enrich_feedback_create(&mut params)?;
    }

    // 查询串里的 date: 下推成 start/end，其余留到本地过滤。
    let terms = tree::query_terms(leaf);
    let query = crate::query::parse(&terms).map_err(|error| {
        // miette 负责画波浪线，这里把渲染好的报告整段交给上层。
        CliError::Usage(format!("{:?}", miette::Report::new(*error)))
    })?;
    if let Some(start) = &query.start {
        params
            .entry("start".to_owned())
            .or_insert_with(|| serde_json::Value::String(start.clone()));
    }
    if let Some(end) = &query.end {
        params
            .entry("end".to_owned())
            .or_insert_with(|| serde_json::Value::String(end.clone()));
    }

    let client = Client::new(
        &settings.api_url,
        Some(settings.require_token()?.to_owned()),
    )?;
    let invocation = client
        .invoke(capability, &params, hooks.gate_params())
        .await;
    if !capability.id().starts_with("feedback.") {
        match &invocation {
            Ok(_) => crate::diagnostics::record(
                &capability.id(),
                client.last_request_id(),
                "success",
                None,
                Exit::Ok.code(),
            ),
            Err(error) => crate::diagnostics::record(
                &capability.id(),
                client.last_request_id(),
                "error",
                Some(error.machine_reason()),
                error.exit().code(),
            ),
        }
    }
    let response = invocation?;

    // 本地过滤：API 还没有对应参数的条件在这里生效。
    if !query.filters.is_empty() {
        let mut rows = crate::normalize::rows_for(&capability.id(), &response);
        let before = rows.rows.len();
        rows.retain(&query);
        if !hooks.machine() && rows.rows.len() < before {
            io.note(&format!(
                "本地过滤掉 {} 条（服务端还不支持这些条件）。",
                before - rows.rows.len()
            ));
        }
        return emit_rows(io, &hooks, &rows);
    }

    hooks.emit(io, &capability.id(), &response)
}

/// 本地过滤后走的输出路径：行已经定了，不能再从原始响应摊一次。
fn emit_rows(io: &mut Io, hooks: &Hooks, rows: &crate::normalize::Rows) -> Result<(), CliError> {
    match &hooks.format {
        Format::FieldList => {
            let listing = serde_json::to_string_pretty(&rows.fields)
                .map_err(|error| CliError::Other(error.to_string()))?;
            io.line(&listing)
                .map_err(|error| CliError::Other(error.to_string()))
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
            let text = serde_json::to_string_pretty(&rows.project(fields))
                .map_err(|error| CliError::Other(error.to_string()))?;
            io.line(&text)
                .map_err(|error| CliError::Other(error.to_string()))
        }
        Format::Human => io
            .line(&crate::render::table(rows, io.tty))
            .map_err(|error| CliError::Other(error.to_string())),
    }
}

/// clap 的错误收编进我们的退出码；顺便补一句 did-you-mean。
fn report_clap_error(io: &mut Io, error: clap::Error) -> Exit {
    use clap::error::{ContextKind, ContextValue, ErrorKind};

    // --help / --version 是正常输出，不是错误。
    if matches!(
        error.kind(),
        ErrorKind::DisplayHelp
            | ErrorKind::DisplayVersion
            | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
    ) {
        let _ = io.line(error.render().ansi().to_string().trim_end());
        return Exit::Ok;
    }

    io.note(error.render().ansi().to_string().trim_end());

    if error.kind() == ErrorKind::InvalidSubcommand
        && let Some(ContextValue::String(typed)) = error.get(ContextKind::InvalidSubcommand)
    {
        for hint in subcommand_hints(typed) {
            io.note(&hint);
        }
    }

    Exit::InvalidUsage
}

/// 词序写反（`abei list tx`）是从 kubectl 过来的人和模型最容易犯的错，单独点破。
fn subcommand_hints(typed: &str) -> Vec<String> {
    let mut hints = Vec::new();

    if tree::looks_like_a_verb(typed) {
        let owners: Vec<String> = catalog()
            .resources()
            .iter()
            .filter(|resource| {
                catalog()
                    .verbs_for(resource.name)
                    .iter()
                    .any(|verb| verb.as_str() == typed)
            })
            .map(|resource| format!("abei {} {typed}", resource.name))
            .collect();
        if !owners.is_empty() {
            hints.push(format!(
                "阿贝是名词在前的：先资源再动作。试试 {}。",
                owners.join(" 或 ")
            ));
        }
    }

    let names: Vec<&str> = catalog()
        .resources()
        .iter()
        .flat_map(|resource| std::iter::once(resource.name).chain(resource.aliases.iter().copied()))
        .collect();
    let guesses = crate::suggest::closest(typed, names);
    if !guesses.is_empty() {
        hints.push(format!("是不是想说 {}？", guesses.join(" 或 ")));
    }

    hints
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_carries_generated_and_handwritten_commands() {
        let root = root_command();
        let names: Vec<&str> = root.get_subcommands().map(|c| c.get_name()).collect();
        for handwritten in ["auth", "parser", "explain", "guide", "completion", "man"] {
            assert!(names.contains(&handwritten), "少了手写命令 {handwritten}");
        }
        assert!(!names.contains(&"api"));
        for resource in catalog().resources() {
            assert!(names.contains(&resource.name), "少了资源 {}", resource.name);
        }
    }

    #[test]
    fn root_help_does_not_leak_internal_command_docs() {
        let help = root_command().render_long_help().to_string();
        assert!(help.contains("阿贝（abei）——记账工具的命令行。"));
        assert!(!help.contains("手写命令"));
        for hidden in ["completion", "man"] {
            assert!(
                !help
                    .lines()
                    .any(|line| line.trim_start().starts_with(&format!("{hidden} "))),
                "默认帮助泄露了隐藏命令 {hidden}：\n{help}"
            );
        }
    }

    #[test]
    fn json_flag_parses_into_the_three_modes() {
        let parse = |args: &[&str]| {
            let matches = root_command().try_get_matches_from(args).unwrap();
            hooks_from(&matches).format
        };
        assert_eq!(parse(&["abei"]), Format::Human);
        assert_eq!(parse(&["abei", "--json"]), Format::FieldList);
        assert_eq!(
            parse(&["abei", "--json=amount,category"]),
            Format::Json(vec!["amount".to_owned(), "category".to_owned()])
        );
    }

    /// --json 要写等号才带值，所以裸 --json 后面跟的查询词不会被它吃掉。
    #[test]
    fn json_does_not_swallow_the_next_query_term() {
        let matches = root_command()
            .try_get_matches_from(["abei", "tx", "list", "--json", "餐饮"])
            .unwrap();
        assert_eq!(hooks_from(&matches).format, Format::FieldList);

        let leaf = matches
            .subcommand()
            .and_then(|(_, sub)| sub.subcommand())
            .map(|(_, leaf)| leaf)
            .unwrap();
        assert_eq!(tree::query_terms(leaf), vec!["餐饮".to_owned()]);
    }

    /// 闸门回显的命令要能直接粘回终端跑：程序路径换成 abei，已有的 --yes 不重复。
    #[test]
    fn retyped_command_is_copy_pasteable() {
        let argv = |args: &[&str]| args.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            retyped(&argv(&["target/debug/abei", "bills", "import", "42"])),
            "abei bills import 42"
        );
        assert_eq!(
            retyped(&argv(&[
                "/usr/local/bin/abei",
                "bills",
                "import",
                "42",
                "--yes"
            ])),
            "abei bills import 42"
        );
        assert_eq!(retyped(&argv(&["abei"])), "abei");
    }

    #[test]
    fn wrong_word_order_gets_a_pointed_hint() {
        let hints = subcommand_hints("list");
        assert!(hints.iter().any(|h| h.contains("名词在前")));
        assert!(hints.iter().any(|h| h.contains("abei transactions list")));
    }

    #[test]
    fn typos_get_a_suggestion() {
        let hints = subcommand_hints("acount");
        assert!(hints.iter().any(|h| h.contains("accounts")), "{hints:?}");
    }

    /// 认不出来的词不硬猜。
    #[test]
    fn nonsense_gets_no_hint() {
        assert!(subcommand_hints("zzzzzz").is_empty());
    }

    /// 目录里的示例是给人和 agent 照抄的，抄了跑不通就是坑。
    /// 每一条都真的解析一遍，参数还要能还原成示例给的那个对象。
    #[test]
    fn every_catalog_example_actually_parses() {
        for capability in catalog().capabilities() {
            for example in &capability.examples {
                let argv = split_words(&example.command);
                assert_eq!(
                    argv.first().map(String::as_str),
                    Some("abei"),
                    "{}",
                    example.command
                );

                let matches = root_command()
                    .try_get_matches_from(&argv)
                    .unwrap_or_else(|error| {
                        panic!(
                            "{} 的示例跑不通：{}\n{error}",
                            capability.id(),
                            example.command
                        )
                    });

                let leaf = matches
                    .subcommand()
                    .and_then(|(_, sub)| sub.subcommand())
                    .map(|(_, leaf)| leaf)
                    .unwrap_or_else(|| panic!("示例没落到叶子命令上：{}", example.command));

                let parsed = tree::params_from(capability, leaf)
                    .unwrap_or_else(|error| panic!("{}：{}", example.command, error.human()));
                let declared = example.params.as_object().unwrap();
                for (key, value) in declared {
                    assert_eq!(
                        parsed.get(key),
                        Some(value),
                        "{} 的示例命令与它声明的参数对不上：{key}\n命令：{}",
                        capability.id(),
                        example.command
                    );
                }
            }
        }
    }

    /// 按空白切词，认单引号（查询条件里的 amt:'>100' 得当成一个词）。
    fn split_words(line: &str) -> Vec<String> {
        let mut words = Vec::new();
        let mut current = String::new();
        let mut quoted = false;
        for ch in line.chars() {
            match ch {
                '\'' => quoted = !quoted,
                c if c.is_whitespace() && !quoted => {
                    if !current.is_empty() {
                        words.push(std::mem::take(&mut current));
                    }
                }
                c => current.push(c),
            }
        }
        if !current.is_empty() {
            words.push(current);
        }
        words
    }

    #[test]
    fn help_is_not_an_error() {
        let out = crate::io::SharedBuffer::new();
        let mut io = Io::capture(out.clone(), crate::io::SharedBuffer::new());
        let error = root_command()
            .try_get_matches_from(["abei", "--help"])
            .unwrap_err();
        assert_eq!(report_clap_error(&mut io, error), Exit::Ok);
        assert!(out.text().contains("abei"));
    }

    /// 用法错误统一退 3，别用 clap 默认的 2（2 留给中断）。
    #[test]
    fn usage_errors_exit_with_three() {
        let mut io = Io::capture(
            crate::io::SharedBuffer::new(),
            crate::io::SharedBuffer::new(),
        );
        let error = root_command()
            .try_get_matches_from(["abei", "nope"])
            .unwrap_err();
        assert_eq!(report_clap_error(&mut io, error), Exit::InvalidUsage);
    }
}
