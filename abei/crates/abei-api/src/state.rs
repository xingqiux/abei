use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::firefly::{Firefly, VerifiedUser};
use crate::problem::Problem;

/// 令牌校验结果缓存的存活时间。短到撤销令牌很快生效，长到不会每个请求都打一次 Firefly。
const TOKEN_TTL: Duration = Duration::from_secs(60);
const SERVER_TIMEOUT: Duration = Duration::from_secs(30);
/// 缓存条数上限，超了就清一遍过期的。
const CACHE_LIMIT: usize = 256;

#[derive(Clone)]
struct CachedUser {
    checked_at: Instant,
    user: VerifiedUser,
}

#[derive(Clone)]
pub struct AppState {
    pub firefly: Arc<Firefly>,
    pub web_url: String,
    pub server_url: String,
    pub http: reqwest::Client,
    verified: Arc<Mutex<HashMap<String, CachedUser>>>,
}

impl AppState {
    pub fn new(config: &Config) -> Result<Self, reqwest::Error> {
        Ok(Self {
            firefly: Arc::new(Firefly::new(&config.firefly_url)?),
            web_url: config.web_url.clone(),
            server_url: config.server_url.clone(),
            http: reqwest::Client::builder().timeout(SERVER_TIMEOUT).build()?,
            verified: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// 校验令牌，命中缓存就不打 Firefly。
    pub async fn verify(&self, token: &str) -> Result<VerifiedUser, Problem> {
        if let Some(user) = self.cached(token) {
            return Ok(user);
        }
        let user = self.firefly.verify_token(token).await?;
        self.remember(token, user.clone());
        Ok(user)
    }

    fn cached(&self, token: &str) -> Option<VerifiedUser> {
        let now = Instant::now();
        let cache = self.verified.lock().expect("令牌缓存锁被毒化");
        cache
            .get(token)
            .filter(|cached| now.duration_since(cached.checked_at) < TOKEN_TTL)
            .map(|cached| cached.user.clone())
    }

    fn remember(&self, token: &str, user: VerifiedUser) {
        let now = Instant::now();
        let mut cache = self.verified.lock().expect("令牌缓存锁被毒化");
        if cache.len() >= CACHE_LIMIT {
            cache.retain(|_, cached| now.duration_since(cached.checked_at) < TOKEN_TTL);
        }
        cache.insert(
            token.to_owned(),
            CachedUser {
                checked_at: now,
                user,
            },
        );
    }
}
