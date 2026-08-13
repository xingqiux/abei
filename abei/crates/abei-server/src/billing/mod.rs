mod analysis;
pub(crate) mod api;
mod imports;
mod mappings;
mod rows;
mod store;
mod worker;

use std::sync::Arc;

use deadpool_postgres::Pool;
use tokio::sync::Notify;

use crate::{mail, mailbox, parser};

const DEFAULT_WORKERS: usize = 2;

#[derive(Clone)]
pub(crate) struct Service {
    pub(super) pool: Pool,
    pub(super) mail: mail::Service,
    pub(super) parser: parser::Service,
    pub(super) secret_cipher: mailbox::SecretCipher,
    pub(super) notify: Arc<Notify>,
    pub(super) worker_id: Arc<String>,
    pub(super) worker_count: usize,
}

impl Service {
    pub(crate) fn new(
        pool: Pool,
        mail: mail::Service,
        parser: parser::Service,
        secret_cipher: mailbox::SecretCipher,
    ) -> Self {
        let worker_count = std::env::var("ABEI_PARSE_WORKERS")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
            .filter(|value| (1..=16).contains(value))
            .unwrap_or(DEFAULT_WORKERS);
        Self {
            pool,
            mail,
            parser,
            secret_cipher,
            notify: Arc::new(Notify::new()),
            worker_id: Arc::new(format!(
                "{}-{}",
                std::process::id(),
                time::OffsetDateTime::now_utc().unix_timestamp_nanos()
            )),
            worker_count,
        }
    }

    pub(crate) fn start_workers(&self) {
        worker::start(self.clone());
    }
}
