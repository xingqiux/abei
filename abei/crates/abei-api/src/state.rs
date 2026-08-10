use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::firefly::Firefly;
use crate::problem::Problem;

/// 令牌校验结果缓存的存活时间。短到撤销令牌很快生效，长到不会每个请求都打一次 Firefly。
const TOKEN_TTL: Duration = Duration::from_secs(60);
/// 缓存条数上限，超了就清一遍过期的。
const CACHE_LIMIT: usize = 256;

#[derive(Clone)]
pub struct AppState {
    pub firefly: Arc<Firefly>,
    verified: Arc<Mutex<HashMap<String, Instant>>>,
}

impl AppState {
    pub fn new(config: &Config) -> Result<Self, reqwest::Error> {
        Ok(Self {
            firefly: Arc::new(Firefly::new(&config.firefly_url)?),
            verified: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// 校验令牌，命中缓存就不打 Firefly。
    pub async fn verify(&self, token: &str) -> Result<(), Problem> {
        if self.cached(token) {
            return Ok(());
        }
        self.firefly.verify_token(token).await?;
        self.remember(token);
        Ok(())
    }

    fn cached(&self, token: &str) -> bool {
        let now = Instant::now();
        let cache = self.verified.lock().expect("令牌缓存锁被毒化");
        cache
            .get(token)
            .is_some_and(|checked_at| now.duration_since(*checked_at) < TOKEN_TTL)
    }

    fn remember(&self, token: &str) {
        let now = Instant::now();
        let mut cache = self.verified.lock().expect("令牌缓存锁被毒化");
        if cache.len() >= CACHE_LIMIT {
            cache.retain(|_, checked_at| now.duration_since(*checked_at) < TOKEN_TTL);
        }
        cache.insert(token.to_owned(), now);
    }
}
