mod analysis;
pub(crate) mod api;
mod imports;
mod mappings;
mod rows;
mod store;
mod sweeper;
mod worker;

use std::sync::Arc;

use deadpool_postgres::Pool;
use tokio::sync::Notify;

use crate::reliability::ReliabilityConfig;
use crate::{mail, mailbox, parser};

#[derive(Clone)]
pub(crate) struct Service {
    pub(super) pool: Pool,
    pub(super) mail: mail::Service,
    pub(super) parser: parser::Service,
    pub(super) secret_cipher: mailbox::SecretCipher,
    pub(super) notify: Arc<Notify>,
    pub(super) worker_id: Arc<String>,
    pub(super) reliability: ReliabilityConfig,
}

impl Service {
    pub(crate) fn new(
        pool: Pool,
        mail: mail::Service,
        parser: parser::Service,
        secret_cipher: mailbox::SecretCipher,
        reliability: ReliabilityConfig,
    ) -> Self {
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
            reliability,
        }
    }

    pub(crate) fn worker_count(&self) -> usize {
        self.reliability.parse_workers
    }

    pub(crate) fn start_workers(&self) {
        worker::start(self.clone());
        sweeper::start(self.clone());
    }
}
