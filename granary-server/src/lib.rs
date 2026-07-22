pub mod access;
pub mod admin;
pub mod advanced_transactions;
pub mod api;
pub mod auth;
pub mod config;
pub mod firefly_import;
pub mod http;
pub mod instance;
pub mod invitation;
pub mod ledger;
pub mod mail;
pub mod mfa;
pub mod password_reset;
pub mod planning;
pub mod reconciliation;
pub mod reports;
pub mod transaction_links;

use sqlx::{PgPool, postgres::PgPoolOptions};

pub async fn connect(database_url: &str, max_connections: u32) -> Result<PgPool, sqlx::Error> {
    PgPoolOptions::new()
        .max_connections(max_connections)
        .connect(database_url)
        .await
}

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!().run(pool).await
}
