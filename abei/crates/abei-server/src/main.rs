use abei_server::legacy_bills::{self, Options as LegacyBillOptions};
use abei_server::{AppState, ServerConfig, build_app, create_pool, initialize};
use tokio::net::TcpListener;
use tokio::signal;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("ABEI_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let command = command()?;
    let config = ServerConfig::from_env()?;
    let pool = create_pool(config.database, config.pool_size)?;
    initialize(&pool).await?;
    if let Some(options) = command {
        let report = legacy_bills::run(&pool, options)
            .await
            .map_err(std::io::Error::other)?;
        println!("{}", serde_json::to_string_pretty(&report)?);
        if !report.can_apply() {
            return Err("旧账单迁移存在阻断项，未写入任何数据。".into());
        }
        return Ok(());
    }
    let state = AppState::new(pool, config.mailbox);
    state.start_mailbox_scheduler();
    let listener = TcpListener::bind(config.address).await?;
    tracing::info!(address = %config.address, "abei-server 已启动");

    axum::serve(listener, build_app(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}

fn command() -> Result<Option<LegacyBillOptions>, Box<dyn std::error::Error + Send + Sync>> {
    let mut arguments = std::env::args().skip(1);
    let Some(command) = arguments.next() else {
        return Ok(None);
    };
    if matches!(command.as_str(), "-h" | "--help") {
        print_help();
        std::process::exit(0);
    }
    if command != "legacy-bills" {
        return Err(format!("未知命令：{command}。使用 --help 查看帮助。").into());
    }
    let mut options = LegacyBillOptions::default();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--apply" => options.apply = true,
            "--json" => {}
            "--max-differences" => {
                let value = arguments
                    .next()
                    .ok_or("--max-differences 后面必须有数量。")?;
                options.max_difference_samples = value.parse()?;
            }
            "-h" | "--help" => {
                print_help();
                std::process::exit(0);
            }
            _ => return Err(format!("未知参数：{argument}。使用 --help 查看帮助。").into()),
        }
    }
    Ok(Some(options))
}

fn print_help() {
    println!(
        "abei-server\n\n用法：\n  abei-server                     启动服务\n  abei-server legacy-bills        只预演旧账单迁移\n  abei-server legacy-bills --apply\n                                  幂等写入并执行字段级对拍\n\n选项：\n  --max-differences N             最多输出 N 条差异样本（默认 100）\n  --json                          兼容参数；报告始终输出 JSON\n"
    );
}

async fn shutdown() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("装不上 Ctrl+C 处理器");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("装不上 SIGTERM 处理器")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
}
