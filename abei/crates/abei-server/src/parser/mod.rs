pub(crate) mod api;
mod builtins;
pub(crate) mod definition;
pub(crate) mod engine;
pub(crate) mod model;
pub(crate) mod script;
mod store;

pub(crate) use store::Service;

pub(crate) async fn install_builtins(
    pool: &deadpool_postgres::Pool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    store::install_builtins(pool).await
}
