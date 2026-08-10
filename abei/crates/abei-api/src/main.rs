use std::net::SocketAddr;

use abei_api::config::Config;
use abei_api::state::AppState;
use tokio::net::TcpListener;
use tokio::signal;
use tracing_subscriber::EnvFilter;

/// `--dump-openapi [路径]`：把 OpenAPI 文档写到磁盘，不起服务。
///
/// web 端的代码生成不该要求「服务正在跑」——生成物签进仓库，靠 `openapi.rs` 里的
/// 防漂移测试保证它和代码一致。不带路径时写到 stdout。
fn dump_openapi(target: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
    let text = abei_api::openapi::document_text();
    match target {
        None | Some("-") => print!("{text}"),
        Some(path) => {
            std::fs::write(path, &text)?;
            eprintln!("已写出 {path}（{} 字节）", text.len());
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|arg| arg == "--dump-openapi") {
        return dump_openapi(args.get(1).map(String::as_str));
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("ABEI_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = Config::from_env()?;
    let state = AppState::new(&config)?;
    let app = abei_api::build_app(state);

    let address = SocketAddr::new(config.host, config.port);
    let listener = TcpListener::bind(address).await?;
    tracing::info!(%address, firefly = %config.firefly_url, "abei-api 已启动");

    axum::serve(listener, app)
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

    tracing::info!("收到停机信号，正在退出");
}
