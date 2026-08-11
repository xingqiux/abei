//! 地址与令牌。
//!
//! 都放配置目录（默认 XDG 的 `~/.config/abei/`）：地址在 `config.json`，令牌在
//! `token` 文件（权限 0600，只有本人可读）。`ABEI_CONFIG_DIR` 可整体改放目录；
//! `ABEI_API_URL`、`ABEI_TOKEN` 两个环境变量可以整体绕开磁盘——agent 和 CI 用
//! 环境变量最省事。
//!
//! 不用系统钥匙串：钥匙串授权绑定二进制哈希，本地每次重编译都要重新弹窗授权，
//! 开发节奏下不可用。

use std::fs;
use std::path::{Path, PathBuf};

use etcetera::BaseStrategy;
use serde::{Deserialize, Serialize};

use crate::error::CliError;

const DEFAULT_URL: &str = "http://127.0.0.1:18002";

/// 一次运行要用的连接信息。
#[derive(Debug, Clone)]
pub struct Settings {
    pub api_url: String,
    pub token: Option<String>,
}

impl Settings {
    /// 测试和内嵌调用用：直接给定，不碰磁盘。
    pub fn new(api_url: impl Into<String>, token: Option<String>) -> Self {
        Self {
            api_url: api_url.into().trim_end_matches('/').to_owned(),
            token: token.filter(|t| !t.is_empty()),
        }
    }

    /// 环境变量优先，其次配置目录里的文件，最后默认值。
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

/// 配置目录：`ABEI_CONFIG_DIR` 指哪用哪（测试与多环境用），默认 XDG 下的 `abei/`。
pub fn config_dir() -> Option<PathBuf> {
    config_dir_from(std::env::var("ABEI_CONFIG_DIR").ok().as_deref())
}

fn config_dir_from(env_override: Option<&str>) -> Option<PathBuf> {
    if let Some(dir) = env_override.filter(|dir| !dir.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let strategy = etcetera::choose_base_strategy().ok()?;
    Some(strategy.config_dir().join("abei"))
}

pub fn config_path() -> Option<PathBuf> {
    Some(config_dir()?.join("config.json"))
}

fn token_path() -> Option<PathBuf> {
    Some(config_dir()?.join("token"))
}

/// 没有令牌文件不算错，返回 None。
pub fn read_token() -> Result<Option<String>, CliError> {
    match token_path() {
        Some(path) => read_token_at(&path),
        None => Ok(None),
    }
}

pub fn write_token(token: &str) -> Result<(), CliError> {
    let path = token_path().ok_or_else(|| CliError::Other("找不到配置目录。".to_owned()))?;
    write_token_at(&path, token)
}

pub fn delete_token() -> Result<bool, CliError> {
    match token_path() {
        Some(path) => delete_token_at(&path),
        None => Ok(false),
    }
}

fn read_token_at(path: &Path) -> Result<Option<String>, CliError> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let token = text.trim();
            Ok((!token.is_empty()).then(|| token.to_owned()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(CliError::Other(format!("读不了令牌文件：{error}"))),
    }
}

fn write_token_at(path: &Path, token: &str) -> Result<(), CliError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| CliError::Other(format!("建不了配置目录：{error}")))?;
    }
    let content = format!("{token}\n");
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|error| CliError::Other(format!("写不了令牌文件：{error}")))?;
        // mode 只管新建；文件已经存在（比如权限被改宽过）也拧回 0600。
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|error| CliError::Other(format!("改不了令牌文件权限：{error}")))?;
        file.write_all(content.as_bytes())
            .map_err(|error| CliError::Other(format!("写不了令牌文件：{error}")))?;
    }
    #[cfg(not(unix))]
    fs::write(path, &content)
        .map_err(|error| CliError::Other(format!("写不了令牌文件：{error}")))?;
    Ok(())
}

fn delete_token_at(path: &Path) -> Result<bool, CliError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(CliError::Other(format!("删不掉令牌文件：{error}"))),
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
        let path = config_dir_from(None).expect("应该能算出配置目录");
        assert!(path.ends_with("abei"), "{path:?}");
    }

    #[test]
    fn env_override_wins_and_empty_is_ignored() {
        assert_eq!(
            config_dir_from(Some("/tmp/abei-x")),
            Some(PathBuf::from("/tmp/abei-x"))
        );
        // 空值等同没设，回落到默认目录。
        assert_eq!(config_dir_from(Some("")), config_dir_from(None));
    }

    /// 临时目录，每个测试独立一份，跑完删掉。
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("abei-config-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn token_file_roundtrip_trims_and_deletes() {
        let dir = scratch("roundtrip");
        let path = dir.join("token");
        assert_eq!(read_token_at(&path).unwrap(), None);
        write_token_at(&path, "tok-123").unwrap();
        // 写入带换行、读取去空白，令牌本体不变。
        assert_eq!(read_token_at(&path).unwrap().as_deref(), Some("tok-123"));
        assert!(delete_token_at(&path).unwrap());
        assert!(!delete_token_at(&path).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("perms");
        let path = dir.join("token");
        write_token_at(&path, "tok").unwrap();
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        // 权限被改宽过的旧文件，重写后也要拧回 0600。
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write_token_at(&path, "tok2").unwrap();
        assert_eq!(mode(&path), 0o600);
        assert_eq!(read_token_at(&path).unwrap().as_deref(), Some("tok2"));
        let _ = fs::remove_dir_all(&dir);
    }
}
