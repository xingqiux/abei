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

    let config = ServerConfig::from_env()?;
    let pool = create_pool(config.database, config.pool_size)?;
    initialize(&pool).await?;
    let state = AppState::new(pool, config.github, config.mailbox);
    state.start_mailbox_scheduler();
    let listener = TcpListener::bind(config.address).await?;
    tracing::info!(address = %config.address, "abei-server 已启动");

    axum::serve(listener, build_app(state))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
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
