use std::env;
use std::net::{IpAddr, Ipv4Addr};

#[derive(Debug, Clone)]
pub struct Config {
    pub host: IpAddr,
    pub port: u16,
    /// 浏览器配对页所在的 web 地址。
    pub web_url: String,
    /// 反馈后端地址。
    pub server_url: String,
    /// Firefly III 的地址，过渡期账本操作都委托给它。
    pub firefly_url: String,
    /// 与 abei-server 之间的共享密钥，用来给可信身份头签名。
    pub internal_secret: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} 的值不对：{1}")]
    Invalid(&'static str, String),
    #[error("{0} 没有配置。{1}")]
    Missing(&'static str, String),
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 18002,
            web_url: "http://127.0.0.1:18004".to_owned(),
            server_url: "http://127.0.0.1:18005".to_owned(),
            firefly_url: "http://127.0.0.1:18001".to_owned(),
            // 没有默认密钥：`from_env` 必须从环境里读到一个，读不到就拒绝起服。
            internal_secret: String::new(),
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

        let web_url = env::var("ABEI_WEB_URL")
            .map(|raw| raw.trim_end_matches('/').to_owned())
            .unwrap_or(default.web_url);
        if web_url.is_empty() {
            return Err(ConfigError::Invalid("ABEI_WEB_URL", web_url));
        }

        let server_url = env::var("ABEI_SERVER_URL")
            .map(|raw| raw.trim_end_matches('/').to_owned())
            .unwrap_or(default.server_url);
        if server_url.is_empty() {
            return Err(ConfigError::Invalid("ABEI_SERVER_URL", server_url));
        }

        let internal_secret = env::var("ABEI_INTERNAL_SECRET").unwrap_or_default();
        if internal_secret.trim().is_empty() {
            return Err(ConfigError::Missing(
                "ABEI_INTERNAL_SECRET",
                "abei-api 用它给发往 abei-server 的身份头签名，两个服务必须配同一个值。".to_owned(),
            ));
        }
        abei_core::internal_auth::check_secret(&internal_secret)
            .map_err(|reason| ConfigError::Missing("ABEI_INTERNAL_SECRET", reason))?;

        Ok(Self {
            host,
            port,
            web_url,
            server_url,
            firefly_url,
            internal_secret: internal_secret.trim().to_owned(),
        })
    }
}
