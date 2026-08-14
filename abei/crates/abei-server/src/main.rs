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

    check_arguments()?;
    let config = ServerConfig::from_env()?;
    let pool = create_pool(config.database, config.pool_size)?;
    initialize(&pool).await?;
    let state = AppState::new(pool, config.mailbox, config.internal_secret);
    state.start_mailbox_scheduler();
    let listener = TcpListener::bind(config.address).await?;
    tracing::info!(address = %config.address, "abei-server 已启动");

    axum::serve(listener, build_app(state.clone()))
        .with_graceful_shutdown(shutdown())
        .await?;
    // HTTP 收完了不等于活干完了：邮箱同步是后台任务，进程这时候直接退会把它们从中间砍断，
    // 库里留下一批 running 记录。这里等它们收尾（超时就算了，清扫器会回收）。
    state.drain().await;
    Ok(())
}

/// 这个二进制只会起服务，没有子命令。多给的参数一律报错，免得 `legacy-bills`
/// 这种已经删掉的老命令被静默当成「正常启动」。
fn check_arguments() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let Some(argument) = std::env::args().nth(1) else {
        return Ok(());
    };
    if matches!(argument.as_str(), "-h" | "--help") {
        println!("abei-server\n\n用法：\n  abei-server    启动服务（没有子命令）\n");
        std::process::exit(0);
    }
    Err(format!("abei-server 没有子命令，不认识 {argument}。").into())
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
