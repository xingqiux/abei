use std::{env, net::SocketAddr};

use base64::{Engine, engine::general_purpose::STANDARD};
use thiserror::Error;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub listen_addr: SocketAddr,
    pub max_connections: u32,
    pub cookie_secure: bool,
    pub allowed_origin: String,
    pub secret_key: [u8; 32],
    pub smtp_host: String,
    pub smtp_port: u16,
    pub smtp_username: String,
    pub smtp_password: String,
    pub mail_from: String,
    pub public_url: String,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("required environment variable {0} is missing")]
    Missing(&'static str),
    #[error("invalid GRANARY_LISTEN_ADDR: {0}")]
    ListenAddr(#[from] std::net::AddrParseError),
    #[error("invalid GRANARY_DB_MAX_CONNECTIONS: {0}")]
    MaxConnections(#[from] std::num::ParseIntError),
    #[error("GRANARY_COOKIE_SECURE must be true or false")]
    CookieSecure,
    #[error("GRANARY_SECRET_KEY must be base64 for exactly 32 bytes")]
    SecretKey,
    #[error("invalid GRANARY_SMTP_PORT: {0}")]
    SmtpPort(std::num::ParseIntError),
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let database_url = env::var("GRANARY_DATABASE_URL")
            .map_err(|_| ConfigError::Missing("GRANARY_DATABASE_URL"))?;
        let listen_addr = env::var("GRANARY_LISTEN_ADDR")
            .unwrap_or_else(|_| "0.0.0.0:8080".to_owned())
            .parse()?;
        let max_connections = env::var("GRANARY_DB_MAX_CONNECTIONS")
            .unwrap_or_else(|_| "10".to_owned())
            .parse()?;
        let cookie_secure = match env::var("GRANARY_COOKIE_SECURE")
            .unwrap_or_else(|_| "true".to_owned())
            .as_str()
        {
            "true" => true,
            "false" => false,
            _ => return Err(ConfigError::CookieSecure),
        };
        let allowed_origin = env::var("GRANARY_ALLOWED_ORIGIN")
            .unwrap_or_else(|_| "http://localhost:18002".to_owned());
        let secret_key = env::var("GRANARY_SECRET_KEY")
            .map_err(|_| ConfigError::Missing("GRANARY_SECRET_KEY"))?;
        let secret_key: [u8; 32] = STANDARD
            .decode(secret_key)
            .map_err(|_| ConfigError::SecretKey)?
            .try_into()
            .map_err(|_| ConfigError::SecretKey)?;
        let smtp_host = env::var("GRANARY_SMTP_HOST").unwrap_or_else(|_| "mail".to_owned());
        let smtp_port = env::var("GRANARY_SMTP_PORT")
            .unwrap_or_else(|_| "3025".to_owned())
            .parse()
            .map_err(ConfigError::SmtpPort)?;
        let smtp_username = env::var("GRANARY_SMTP_USERNAME").unwrap_or_default();
        let smtp_password = env::var("GRANARY_SMTP_PASSWORD").unwrap_or_default();
        let mail_from = env::var("GRANARY_MAIL_FROM")
            .unwrap_or_else(|_| "Granary <no-reply@granary.local>".to_owned());
        let public_url = env::var("GRANARY_PUBLIC_URL").unwrap_or_else(|_| allowed_origin.clone());

        Ok(Self {
            database_url,
            listen_addr,
            max_connections,
            cookie_secure,
            allowed_origin,
            secret_key,
            smtp_host,
            smtp_port,
            smtp_username,
            smtp_password,
            mail_from,
            public_url,
        })
    }
}
