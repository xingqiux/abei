mod analysis;
pub(crate) mod api;
mod existing;
mod imports;
mod links;
mod mappings;
mod processing;
mod rows;
pub(crate) mod runner;
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
    /// 替用户写账本用。整条入账 saga 现在在这个进程里跑完，见 [`runner`]。
    pub(super) firefly: crate::firefly::Firefly,
}

impl Service {
    pub(crate) fn new(
        pool: Pool,
        mail: mail::Service,
        parser: parser::Service,
        secret_cipher: mailbox::SecretCipher,
        reliability: ReliabilityConfig,
        firefly: crate::firefly::Firefly,
    ) -> Self {
        Self {
            pool,
            mail,
            parser,
            secret_cipher,
            firefly,
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
