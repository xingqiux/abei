//! 地址与令牌。
//!
//! 地址放 XDG 配置目录（`~/.config/abei/config.json`），令牌放系统钥匙串。
//! 两个环境变量可以整体绕开它们：`ABEI_API_URL`、`ABEI_TOKEN` —— agent 和 CI
//! 用环境变量就不会弹钥匙串授权框。

use std::fs;
use std::path::PathBuf;

use etcetera::BaseStrategy;
use serde::{Deserialize, Serialize};

use crate::error::CliError;

const SERVICE: &str = "abei";
const ACCOUNT: &str = "default";
const DEFAULT_URL: &str = "http://127.0.0.1:18002";

/// 一次运行要用的连接信息。
#[derive(Debug, Clone)]
pub struct Settings {
    pub api_url: String,
    pub token: Option<String>,
}

impl Settings {
    /// 测试和内嵌调用用：直接给定，不碰磁盘和钥匙串。
    pub fn new(api_url: impl Into<String>, token: Option<String>) -> Self {
        Self {
            api_url: api_url.into().trim_end_matches('/').to_owned(),
            token: token.filter(|t| !t.is_empty()),
        }
    }

    /// 环境变量优先，其次配置文件与钥匙串，最后默认值。
    pub fn resolve() -> Self {
        let stored = StoredConfig::load().unwrap_or_default();
        let api_url = std::env::var("ABEI_API_URL")
            .ok()
            .filter(|value| !value.is_empty())
            .or(stored.api_url)
            .unwrap_or_else(|| DEFAULT_URL.to_owned());

        let token = std::env::var("ABEI_TOKEN")
            .ok()
            .filter(|value| !value.is_empty())
            .or_else(|| read_token().ok().flatten());

        Self::new(api_url, token)
    }

    pub fn require_token(&self) -> Result<&str, CliError> {
        self.token.as_deref().ok_or_else(|| {
            CliError::Auth(
                "还没配对。跑一次：abei auth login --url <abei-api 地址> --token <Firefly 令牌>\n\
                 或者设环境变量 ABEI_TOKEN（agent 与 CI 用这个更省事）。"
                    .to_owned(),
            )
        })
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct StoredConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_url: Option<String>,
}

impl StoredConfig {
    pub fn load() -> Option<Self> {
        let text = fs::read_to_string(config_path()?).ok()?;
        serde_json::from_str(&text).ok()
    }

    pub fn save(&self) -> Result<PathBuf, CliError> {
        let path = config_path().ok_or_else(|| CliError::Other("找不到配置目录。".to_owned()))?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| CliError::Other(format!("建不了配置目录：{error}")))?;
        }
        let text = serde_json::to_string_pretty(self)
            .map_err(|error| CliError::Other(error.to_string()))?;
        fs::write(&path, text).map_err(|error| CliError::Other(format!("写不了配置：{error}")))?;
        Ok(path)
    }
}

pub fn config_path() -> Option<PathBuf> {
    let strategy = etcetera::choose_base_strategy().ok()?;
    Some(strategy.config_dir().join("abei").join("config.json"))
}

/// 钥匙串里没有这条记录不算错，返回 None。
pub fn read_token() -> Result<Option<String>, CliError> {
    match keyring::Entry::new(SERVICE, ACCOUNT) {
        Ok(entry) => match entry.get_password() {
            Ok(token) => Ok(Some(token)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(CliError::Other(format!("读不了钥匙串：{error}"))),
        },
        // 没有可用钥匙串（比如无桌面会话的服务器）不该让命令直接死掉，
        // 用 ABEI_TOKEN 照样能跑。
        Err(_) => Ok(None),
    }
}

pub fn write_token(token: &str) -> Result<(), CliError> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT)
        .map_err(|error| CliError::Other(format!("打不开钥匙串：{error}")))?;
    entry
        .set_password(token)
        .map_err(|error| CliError::Other(format!("存不进钥匙串：{error}")))
}

pub fn delete_token() -> Result<bool, CliError> {
    let entry = match keyring::Entry::new(SERVICE, ACCOUNT) {
        Ok(entry) => entry,
        Err(_) => return Ok(false),
    };
    match entry.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(CliError::Other(format!("删不掉钥匙串记录：{error}"))),
    }
}

/// 日志和 `auth status` 里显示令牌时一律脱敏。
pub fn mask(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    if chars.len() <= 8 {
        return "*".repeat(chars.len().max(1));
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trailing_slash_is_trimmed() {
        let settings = Settings::new("http://localhost:18002/", None);
        assert_eq!(settings.api_url, "http://localhost:18002");
    }

    #[test]
    fn empty_token_counts_as_absent() {
        let settings = Settings::new("http://x", Some(String::new()));
        assert!(settings.token.is_none());
        assert_eq!(
            settings.require_token().unwrap_err().exit(),
            crate::exit::Exit::Unauthenticated
        );
    }

    #[test]
    fn missing_token_tells_you_how_to_fix_it() {
        let settings = Settings::new("http://x", None);
        let message = settings.require_token().unwrap_err().human();
        assert!(message.contains("abei auth login"));
        assert!(message.contains("ABEI_TOKEN"));
    }

    #[test]
    fn masking_keeps_only_the_ends() {
        assert_eq!(mask("abcdefghijkl"), "abcd…ijkl");
        assert_eq!(mask("short"), "*****");
        assert_eq!(mask(""), "*");
    }

    #[test]
    fn config_path_lands_under_abei() {
        let path = config_path().expect("应该能算出配置路径");
        assert!(path.ends_with("abei/config.json"), "{path:?}");
    }
}
