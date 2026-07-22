use clap::{Parser, Subcommand};
use granary_server::{config::Config, connect, firefly_import, http, migrate};
use sqlx::{Connection, PgConnection};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(name = "granary-server", version, about = "Granary accounting server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Inspect a Firefly III PostgreSQL database without printing personal values.
    InspectFirefly {
        #[arg(long, env = "FIREFLY_SOURCE_DATABASE_URL")]
        source_database_url: String,
        #[arg(long)]
        compact: bool,
    },
    /// Run pending database migrations.
    Migrate,
    /// Serve the HTTP API.
    Serve,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .json()
        .init();

    let cli = Cli::parse();
    match cli.command {
        Command::InspectFirefly {
            source_database_url,
            compact,
        } => {
            let mut connection = PgConnection::connect(&source_database_url).await?;
            let inventory = firefly_import::inspect_firefly(&mut connection).await?;
            let output = if compact {
                serde_json::to_string(&inventory)?
            } else {
                serde_json::to_string_pretty(&inventory)?
            };
            println!("{output}");
        }
        Command::Migrate => {
            let config = Config::from_env()?;
            let pool = connect(&config.database_url, config.max_connections).await?;
            migrate(&pool).await?;
        }
        Command::Serve => {
            let config = Config::from_env()?;
            let pool = connect(&config.database_url, config.max_connections).await?;
            let listener = tokio::net::TcpListener::bind(config.listen_addr).await?;
            tracing::info!(address = %config.listen_addr, "granary-server listening");
            axum::serve(listener, http::router(pool, &config))
                .with_graceful_shutdown(shutdown_signal())
                .await?;
        }
    }

    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
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
