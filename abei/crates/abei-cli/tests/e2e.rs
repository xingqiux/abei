//! 端到端：进程内起真的 abei-api（上游是假 Firefly），CLI 打真路由。
//!
//! 不碰钥匙串，也不碰真 Firefly：Settings 直接构造，令牌显式传。

use abei_api::testkit::{GOOD_TOKEN, Recorder, start_api, start_api_recording};
use abei_cli::app;
use abei_cli::config::Settings;
use abei_cli::exit::Exit;
use abei_cli::io::{Io, SharedBuffer};
use serde_json::Value;

struct Run {
    exit: Exit,
    out: String,
    err: String,
}

impl Run {
    fn json(&self) -> Value {
        serde_json::from_str(&self.out)
            .unwrap_or_else(|error| panic!("输出不是 JSON（{error}）：\n{}", self.out))
    }
}

/// 跑一条命令，拿到退出码和两路输出。
async fn run(base: &str, token: &str, args: &[&str]) -> Run {
    let out = SharedBuffer::new();
    let err = SharedBuffer::new();
    let mut io = Io::capture(out.clone(), err.clone());

    let settings = Settings::new(base.to_owned(), Some(token.to_owned()));
    let argv: Vec<String> = std::iter::once("abei")
        .chain(args.iter().copied())
        .map(str::to_owned)
        .collect();

    let exit = app::run(&mut io, settings, argv).await;
    Run {
        exit,
        out: out.text(),
        err: err.text(),
    }
}

async fn ok(base: &str, args: &[&str]) -> Run {
    let result = run(base, GOOD_TOKEN, args).await;
    assert_eq!(
        result.exit,
        Exit::Ok,
        "abei {} 该成功，实际退 {:?}\nstderr: {}",
        args.join(" "),
        result.exit,
        result.err
    );
    result
}

#[tokio::test]
async fn bad_token_exits_unauthenticated_with_a_way_out() {
    let base = start_api().await;
    let result = run(&base, "wrong-token", &["transactions", "list"]).await;
    assert_eq!(result.exit, Exit::Unauthenticated);
    assert!(
        result.err.contains("abei auth login"),
        "报错要给出下一步：{}",
        result.err
    );
}

#[tokio::test]
async fn unreachable_api_exits_upstream() {
    // 没人监听的端口。
    let result = run("http://127.0.0.1:1", GOOD_TOKEN, &["transactions", "list"]).await;
    assert_eq!(result.exit, Exit::Upstream);
}

/// 不带 --json 时默认输出是人/脚本都能读的：管道里走制表符分隔，头一行是字段名。
#[tokio::test]
async fn transactions_list_defaults_to_tsv_when_piped() {
    let base = start_api().await;
    let result = ok(&base, &["transactions", "list"]).await;
    assert!(result.out.contains("餐饮"), "{}", result.out);
    assert!(result.out.contains("45.00"), "{}", result.out);
    assert!(!result.out.trim_start().starts_with('['), "不该是 JSON");

    let mut lines = result.out.lines();
    let header: Vec<&str> = lines.next().unwrap().split('\t').collect();
    assert!(header.contains(&"amount"), "{header:?}");
    assert!(header.contains(&"category"), "{header:?}");

    let first: Vec<&str> = lines.next().unwrap().split('\t').collect();
    assert_eq!(first.len(), header.len(), "列数要对齐");
    let amount = header.iter().position(|f| *f == "amount").unwrap();
    assert_eq!(first[amount], "45.00");
}

/// 搜索词直接写在命令后面，不用 `--query`；结果照样摊成表。
#[tokio::test]
async fn search_takes_the_term_as_a_positional() {
    let base = start_api().await;
    let result = ok(&base, &["transactions", "search", "星巴克"]).await;
    assert!(result.out.contains("星巴克"), "{}", result.out);
    let header: Vec<&str> = result.out.lines().next().unwrap().split('\t').collect();
    assert!(header.contains(&"amount"), "{header:?}");
    assert!(header.contains(&"category"), "{header:?}");
}

/// 少了搜索词是用法错，退 3，不是打到服务端才发现。
#[tokio::test]
async fn search_without_a_term_is_a_usage_error() {
    let base = start_api().await;
    let result = run(&base, GOOD_TOKEN, &["transactions", "search"]).await;
    assert_eq!(result.exit, Exit::InvalidUsage, "{}", result.err);
}

/// 别名跟正名走同一条路。
#[tokio::test]
async fn aliases_reach_the_same_capability() {
    let base = start_api().await;
    let long = ok(&base, &["transactions", "list"]).await;
    let short = ok(&base, &["tx", "list"]).await;
    assert_eq!(long.out, short.out);
}

#[tokio::test]
async fn json_projection_is_the_machine_contract() {
    let base = start_api().await;
    let result = ok(&base, &["tx", "list", "--json=amount,category"]).await;
    let rows = result.json();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["amount"], "45.00");
    assert_eq!(rows[0]["category"], "餐饮");
    // 只要点名的字段，别的不许漏出来。
    assert_eq!(rows[0].as_object().unwrap().len(), 2);
}

/// 裸 --json 是自查字段用的，给 agent 一个不用猜的入口。
#[tokio::test]
async fn bare_json_lists_the_available_fields() {
    let base = start_api().await;
    let result = ok(&base, &["tx", "list", "--json"]).await;
    let fields = result.json();
    let fields: Vec<&str> = fields
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect();
    assert!(fields.contains(&"amount"), "{fields:?}");
    assert!(fields.contains(&"category"), "{fields:?}");
}

#[tokio::test]
async fn unknown_json_field_is_a_usage_error_that_lists_the_real_ones() {
    let base = start_api().await;
    let result = run(&base, GOOD_TOKEN, &["tx", "list", "--json=amont"]).await;
    assert_eq!(result.exit, Exit::InvalidUsage);
    assert!(result.err.contains("amont"), "{}", result.err);
    assert!(result.err.contains("amount"), "{}", result.err);
}

#[tokio::test]
async fn jq_runs_against_the_raw_response() {
    let base = start_api().await;
    let result = ok(&base, &["tx", "list", "--jq", ".meta.pagination.count"]).await;
    assert_eq!(result.out.trim(), "2");
}

/// date: 下推成服务端的 start/end，其余条件本地过滤。
#[tokio::test]
async fn query_terms_filter_the_rows() {
    let base = start_api().await;
    let all = ok(&base, &["tx", "list", "date:2026-08", "--json=category"]).await;
    assert_eq!(all.json().as_array().unwrap().len(), 2);

    let only = ok(
        &base,
        &["tx", "list", "date:2026-08", "餐饮", "--json=category"],
    )
    .await;
    let rows = only.json();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["category"], "餐饮");

    let rest = ok(
        &base,
        &[
            "tx",
            "list",
            "date:2026-08",
            "not:cat:餐饮",
            "--json=category",
        ],
    )
    .await;
    let rows = rest.json();
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["category"], "账户转账");
}

#[tokio::test]
async fn amount_comparison_filters_locally() {
    let base = start_api().await;
    let result = ok(
        &base,
        &["tx", "list", "date:2026-08", "amt:>100", "--json=amount"],
    )
    .await;
    let rows = result.json();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["amount"], "3000.00");
}

/// 查询串写错要指到具体位置，不是甩一句「参数错误」。
#[tokio::test]
async fn broken_query_points_at_the_bad_token() {
    let base = start_api().await;
    let result = run(&base, GOOD_TOKEN, &["tx", "list", "date:20260801"]).await;
    assert_eq!(result.exit, Exit::InvalidUsage);
    assert!(result.err.contains("date:20260801"), "{}", result.err);
}

#[tokio::test]
async fn positional_id_reaches_the_show_route() {
    let base = start_api().await;
    let result = ok(&base, &["tx", "show", "7", "--jq", ".data.id"]).await;
    assert_eq!(result.out.trim(), "\"7\"");
}

#[tokio::test]
async fn summary_prints_a_report() {
    let base = start_api().await;
    let result = ok(&base, &["tx", "summary", "date:2026-08"]).await;
    assert!(result.out.contains("45.00"), "{}", result.out);
    // 3000 那笔是账户转账，不算日常消费。
    assert!(result.out.contains("餐饮"), "{}", result.out);
}

#[tokio::test]
async fn bare_abei_shows_the_month_overview() {
    let base = start_api().await;
    let result = ok(&base, &["--month", "2026-08"]).await;
    assert!(result.out.contains("45.00"), "{}", result.out);
    assert!(result.out.contains("招行卡"), "{}", result.out);
    assert!(result.err.contains("abei guide"), "{}", result.err);
}

#[tokio::test]
async fn api_escape_hatch_reaches_firefly_through_the_proxy() {
    let base = start_api().await;
    let result = ok(&base, &["api", "get", "/v1/firefly/api/v1/about"]).await;
    assert_eq!(result.json()["data"]["version"], "6.0.0");
}

#[tokio::test]
async fn api_escape_hatch_passes_query_parameters() {
    let base = start_api().await;
    let result = ok(
        &base,
        &["api", "get", "/v1/transactions", "-q", "type=withdrawal"],
    )
    .await;
    assert_eq!(result.json()["meta"]["pagination"]["count"], 2);
}

/// 服务端的 problem+json 要变成人话，并且带上退出码。
#[tokio::test]
async fn server_problems_become_plain_sentences() {
    let base = start_api().await;
    let result = run(&base, GOOD_TOKEN, &["api", "get", "/v1/nope"]).await;
    assert_eq!(result.exit, Exit::Failure);
    assert!(result.err.contains("/v1/catalog"), "{}", result.err);
}

/// 机器模式下报错也要是 JSON，不然 agent 得去 parse 中文。
#[tokio::test]
async fn machine_mode_errors_are_json() {
    let base = start_api().await;
    let result = run(&base, "wrong-token", &["tx", "list", "--json=amount"]).await;
    assert_eq!(result.exit, Exit::Unauthenticated);
    let problem: Value = serde_json::from_str(&result.err)
        .unwrap_or_else(|e| panic!("stderr 不是 JSON（{e}）：\n{}", result.err));
    // 服务端的 problem+json 原样透传，再补一个 exit 让 agent 不用去读进程退出码。
    assert_eq!(problem["reason"], "InvalidToken");
    assert_eq!(problem["status"], 401);
    assert_eq!(problem["exit"], 4);
    assert!(problem["detail"].is_string(), "{problem}");
}

#[tokio::test]
async fn explain_and_guide_need_no_server() {
    // 故意给个连不上的地址：这两条命令不该发请求。
    let explain = run("http://127.0.0.1:1", "x", &["explain", "tx"]).await;
    assert_eq!(explain.exit, Exit::Ok);
    assert!(explain.out.contains("abei transactions summary"));

    let guide = run("http://127.0.0.1:1", "x", &["guide"]).await;
    assert_eq!(guide.exit, Exit::Ok);
    assert!(guide.out.contains("退出码"));
}

#[tokio::test]
async fn wrong_word_order_is_caught_and_corrected() {
    let result = run("http://127.0.0.1:1", "x", &["list", "tx"]).await;
    assert_eq!(result.exit, Exit::InvalidUsage);
    assert!(result.err.contains("名词在前"), "{}", result.err);
    assert!(
        result.err.contains("abei transactions list"),
        "{}",
        result.err
    );
}

#[tokio::test]
async fn completion_scripts_generate() {
    let result = run("http://127.0.0.1:1", "x", &["completion", "zsh"]).await;
    assert_eq!(result.exit, Exit::Ok);
    assert!(result.out.contains("#compdef abei"), "{}", result.out);
}

#[tokio::test]
async fn help_exits_zero() {
    let result = run("http://127.0.0.1:1", "x", &["--help"]).await;
    assert_eq!(result.exit, Exit::Ok);
    assert!(result.out.contains("transactions"));
}

/// 新增的账单命令也要有 --help，示例照抄能跑。
#[tokio::test]
async fn bill_commands_document_themselves() {
    for args in [
        vec!["bills", "--help"],
        vec!["bills", "import", "--help"],
        vec!["bills", "unlock", "--help"],
        vec!["rows", "update", "--help"],
        vec!["rows", "split", "--help"],
    ] {
        let result = run("http://127.0.0.1:1", "x", &args).await;
        assert_eq!(
            result.exit,
            Exit::Ok,
            "abei {} 该正常出帮助",
            args.join(" ")
        );
        assert!(
            !result.out.trim().is_empty(),
            "abei {} 的帮助是空的",
            args.join(" ")
        );
    }

    // 写命令的帮助里要有闸门开关和风险等级。
    let import = run("http://127.0.0.1:1", "x", &["bills", "import", "--help"]).await;
    assert!(import.out.contains("--dry-run"), "{}", import.out);
    assert!(import.out.contains("--yes"), "{}", import.out);
    assert!(import.out.contains("风险：confirm"), "{}", import.out);

    // 只读命令不该出现闸门开关。
    let list = run("http://127.0.0.1:1", "x", &["bills", "list", "--help"]).await;
    assert!(!list.out.contains("--yes"), "{}", list.out);
}

#[tokio::test]
async fn bills_list_prints_the_pending_counts() {
    let base = start_api().await;
    let result = ok(&base, &["bills", "list"]).await;
    assert!(result.out.contains("alipay"), "{}", result.out);
    assert!(result.out.contains("needs_secret"), "{}", result.out);

    let header: Vec<&str> = result.out.lines().next().unwrap().split('\t').collect();
    assert!(header.contains(&"pending"), "{header:?}");

    let counts = ok(&base, &["inbox", "list", "--json=id,pending"]).await;
    let rows = counts.json();
    assert_eq!(rows[0]["id"], "42");
    assert_eq!(rows[0]["pending"], 3);
}

/// 审阅视图三个桶摊成一张表，要处理的排在最前面。
#[tokio::test]
async fn bills_review_puts_the_stuck_rows_first() {
    let base = start_api().await;
    let result = ok(&base, &["bills", "review", "42", "--json=bucket,id,amount"]).await;
    let rows = result.json();
    let rows = rows.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["bucket"], "needs_attention");
    assert_eq!(rows[0]["amount"], "128.50");
    assert_eq!(rows[1]["bucket"], "ready");
}

/// 写命令不带 --yes 就退 6，并把补好的命令原样给出来——agent 照抄就能重试。
#[tokio::test]
async fn writes_without_yes_exit_six_and_print_the_completed_command() {
    let base = start_api().await;
    let result = run(&base, GOOD_TOKEN, &["bills", "import", "42", "--all"]).await;

    assert_eq!(result.exit, Exit::ConfirmationRequired);
    assert!(
        result.err.contains("abei bills import 42 --all --yes"),
        "要回显补全后的命令：{}",
        result.err
    );
    assert!(result.out.is_empty(), "被挡下时 stdout 该是空的");
}

/// 机器模式下这道闸也要是机器可读的：reason + exit，不用去 parse 中文。
#[tokio::test]
async fn the_write_gate_is_machine_readable() {
    let base = start_api().await;
    let result = run(
        &base,
        GOOD_TOKEN,
        &["bills", "import", "42", "--all", "--json=id"],
    )
    .await;

    assert_eq!(result.exit, Exit::ConfirmationRequired);
    let problem: Value = serde_json::from_str(&result.err)
        .unwrap_or_else(|e| panic!("stderr 不是 JSON（{e}）：\n{}", result.err));
    assert_eq!(problem["reason"], "ConfirmationRequired");
    assert_eq!(problem["exit"], 6);
}

/// --dry-run 真的打到上游，但落在「不写」那一侧。
#[tokio::test]
async fn dry_run_reaches_the_upstream_without_committing() {
    let sent = Recorder::default();
    let base = start_api_recording(sent.clone()).await;
    let result = ok(&base, &["bills", "import", "42", "--all", "--dry-run"]).await;

    // 预览必须说明白自己是预览，否则跟真跑的输出长得一样。
    assert!(result.err.contains("这是预览"), "{}", result.err);
    assert!(result.err.contains("--yes"), "{}", result.err);
    assert!(result.out.contains("2"), "预览要说会写几笔：{}", result.out);

    let calls = sent.lock().unwrap();
    let (path, body) = calls.first().expect("干跑也该打到上游拿预览");
    assert!(path.contains("/bill-tasks/42/import"), "{path}");
    assert_eq!(body["confirm"], false, "干跑不能带 confirm");
    assert_eq!(body["all"], true);
}

/// --yes 要变成服务端认的 confirm=true，否则会被 409 挡回来。
#[tokio::test]
async fn yes_becomes_a_server_side_confirmation() {
    let sent = Recorder::default();
    let base = start_api_recording(sent.clone()).await;
    let result = ok(
        &base,
        &[
            "bills",
            "import",
            "42",
            "--all",
            "--yes",
            "--jq",
            ".data.created",
        ],
    )
    .await;
    assert_eq!(result.out.trim(), "2");

    let calls = sent.lock().unwrap();
    assert_eq!(calls[0].1["confirm"], true);
}

/// 密码不写在命令行历史里也能干跑；干跑不把密码递给上游。
#[tokio::test]
async fn unlock_dry_run_keeps_the_password_local() {
    let sent = Recorder::default();
    let base = start_api_recording(sent.clone()).await;
    let result = ok(
        &base,
        &["bills", "unlock", "43", "--secret", "hunter2", "--dry-run"],
    )
    .await;

    assert!(
        !result.out.contains("hunter2"),
        "密码不能回显：{}",
        result.out
    );
    assert!(sent.lock().unwrap().is_empty(), "干跑不该打到上游");
}

/// 改流水一律记成 AI 建议，命令行上没有关掉它的开关。
#[tokio::test]
async fn row_updates_go_out_as_suggestions() {
    let sent = Recorder::default();
    let base = start_api_recording(sent.clone()).await;
    ok(
        &base,
        &["rows", "update", "8", "--category-name", "餐饮", "--yes"],
    )
    .await;

    let (path, body) = sent.lock().unwrap().first().cloned().expect("该打到上游");
    assert!(path.contains("/bill-statement-rows/8"), "{path}");
    assert_eq!(body["as_suggestion"], true);
    assert_eq!(body["category_name"], "餐饮");

    // 银行原文没有对应的 flag，想改也改不了。
    let error = run(
        &base,
        GOOD_TOKEN,
        &["rows", "update", "8", "--counterparty", "改一下", "--yes"],
    )
    .await;
    assert_eq!(error.exit, Exit::InvalidUsage);
}

/// 拆分从命令行到上游是通的：键=值写法在这一路上不会散架。
#[tokio::test]
async fn splitting_a_row_travels_end_to_end() {
    let sent = Recorder::default();
    let base = start_api_recording(sent.clone()).await;
    ok(
        &base,
        &[
            "rows",
            "split",
            "8",
            "--splits",
            "amount=100.00,description=食材",
            "--splits",
            "amount=28.50,description=日用",
            "--yes",
        ],
    )
    .await;

    let calls = sent.lock().unwrap();
    let (path, body) = calls.first().expect("该打到上游");
    assert!(path.contains("/bill-statement-rows/8/split"), "{path}");
    let splits = body["splits"].as_array().unwrap();
    assert_eq!(splits.len(), 2);
    assert_eq!(splits[0]["amount"], "100.00");
    assert_eq!(splits[1]["description"], "日用");
}

/// 服务端的参数报错要带着上下文回到命令行，别退成一句「失败了」。
#[tokio::test]
async fn server_side_validation_comes_back_as_a_usage_error() {
    let base = start_api().await;
    let result = run(
        &base,
        GOOD_TOKEN,
        &[
            "rows",
            "split",
            "8",
            "--splits",
            "amount=100.00,description=只有一笔",
            "--yes",
        ],
    )
    .await;
    assert_eq!(result.exit, Exit::InvalidUsage);
    assert!(result.err.contains("2 到 20"), "{}", result.err);
}

/// draft 档在服务端不用确认，但命令行仍然要 --yes：本地这一道是给人的提醒。
#[tokio::test]
async fn draft_writes_still_need_yes_on_the_command_line() {
    let base = start_api().await;
    let blocked = run(&base, GOOD_TOKEN, &["bills", "retry", "42"]).await;
    assert_eq!(blocked.exit, Exit::ConfirmationRequired);

    let done = run(&base, GOOD_TOKEN, &["bills", "retry", "42", "--yes"]).await;
    assert_eq!(done.exit, Exit::Ok, "{}", done.err);
}
