use std::env;
use std::net::{IpAddr, Ipv4Addr};

#[derive(Debug, Clone)]
pub struct Config {
    pub host: IpAddr,
    pub port: u16,
    /// Firefly III 的地址，过渡期账本操作都委托给它。
    pub firefly_url: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} 的值不对：{1}")]
    Invalid(&'static str, String),
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 18002,
            firefly_url: "http://127.0.0.1:18001".to_owned(),
        }
    }
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let default = Self::default();

        let host = match env::var("ABEI_API_HOST") {
            Ok(raw) => raw
                .parse::<IpAddr>()
                .map_err(|_| ConfigError::Invalid("ABEI_API_HOST", raw))?,
            Err(_) => default.host,
        };

        let port = match env::var("ABEI_API_PORT") {
            Ok(raw) => raw
                .parse::<u16>()
                .map_err(|_| ConfigError::Invalid("ABEI_API_PORT", raw))?,
            Err(_) => default.port,
        };

        let firefly_url = env::var("FIREFLY_URL")
            .map(|raw| raw.trim_end_matches('/').to_owned())
            .unwrap_or(default.firefly_url);
        if firefly_url.is_empty() {
            return Err(ConfigError::Invalid("FIREFLY_URL", firefly_url));
        }

        Ok(Self {
            host,
            port,
            firefly_url,
        })
    }
}
