//! 配对。一条 `auth login` 搞定，不再有第二条语义重叠的命令。

use clap::Subcommand;

use crate::client::Client;
use crate::config::{self, Settings};
use crate::error::CliError;
use crate::io::Io;

#[derive(Debug, Subcommand)]
pub enum AuthCommand {
    /// 配对：验一次地址和令牌，通过了才存
    ///
    /// 地址和令牌走全局的 --url / --token：
    ///   abei auth login --token <令牌>
    ///   abei auth login --url http://127.0.0.1:18002 --token -
    Login,
    /// 看当前配对状态
    Status,
    /// 删掉本机保存的令牌
    Logout,
}

pub async fn run(io: &mut Io, settings: &Settings, command: &AuthCommand) -> Result<(), CliError> {
    match command {
        AuthCommand::Login => login(io, settings).await,
        AuthCommand::Status => status(io),
        AuthCommand::Logout => logout(io),
    }
}

async fn login(io: &mut Io, settings: &Settings) -> Result<(), CliError> {
    let raw = settings.token.as_deref().ok_or_else(|| {
        CliError::Usage(
            "配对要有令牌：abei auth login --token <Firefly 个人访问令牌>\n\
             不想让令牌进 shell 历史就写 --token - 从标准输入读。"
                .to_owned(),
        )
    })?;
    let token = read_token(raw)?;
    let url = settings.api_url.trim_end_matches('/').to_owned();

    // 先确认服务在，再确认令牌能用；两关都过才落盘，免得存一份用不了的配置。
    let client = Client::new(&url, None)?;
    client
        .request(abei_core::Method::Get, "/health", &[], None)
        .await
        .map_err(|error| match error {
            CliError::Unreachable(message) => CliError::Unreachable(format!(
                "{url} 上没有 abei-api（{message}）。确认它在跑，或换个 --url。"
            )),
            other => other,
        })?;

    let authorized = Client::new(&url, Some(token.clone()))?;
    authorized
        .request(abei_core::Method::Get, "/v1/catalog", &[], None)
        .await?;

    config::write_token(&token)?;
    let stored = config::StoredConfig {
        api_url: Some(url.clone()),
    };
    let path = stored.save()?;

    io.line(&format!("配对成功：{url}"))
        .map_err(|error| CliError::Other(error.to_string()))?;
    io.line(&format!("令牌进了系统钥匙串，地址写在 {}", path.display()))
        .map_err(|error| CliError::Other(error.to_string()))?;
    Ok(())
}

/// `--token -` 从标准输入读，避免令牌落进 shell 历史。
fn read_token(raw: &str) -> Result<String, CliError> {
    if raw != "-" {
        return Ok(raw.to_owned());
    }
    let mut buffer = String::new();
    std::io::Read::read_to_string(&mut std::io::stdin(), &mut buffer)
        .map_err(|error| CliError::Usage(format!("从标准输入读令牌失败：{error}")))?;
    let token = buffer.trim().to_owned();
    if token.is_empty() {
        return Err(CliError::Usage("标准输入里没有令牌。".to_owned()));
    }
    Ok(token)
}

fn status(io: &mut Io) -> Result<(), CliError> {
    let settings = Settings::resolve();
    let line = |io: &mut Io, text: &str| io.line(text).map_err(|e| CliError::Other(e.to_string()));

    line(io, &format!("地址：{}", settings.api_url))?;
    match &settings.token {
        Some(token) => {
            let source = if std::env::var("ABEI_TOKEN").is_ok() {
                "环境变量 ABEI_TOKEN"
            } else {
                "系统钥匙串"
            };
            line(
                io,
                &format!("令牌：{}（来自{source}）", config::mask(token)),
            )?;
        }
        None => {
            line(io, "令牌：没有。跑 abei auth login 配对。")?;
        }
    }
    Ok(())
}

fn logout(io: &mut Io) -> Result<(), CliError> {
    let removed = config::delete_token()?;
    let text = if removed {
        "已删掉钥匙串里的令牌。"
    } else {
        "钥匙串里本来就没有令牌。"
    };
    io.line(text)
        .map_err(|error| CliError::Other(error.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `--token -` 之外的值原样用。
    #[test]
    fn plain_tokens_pass_through() {
        assert_eq!(read_token("abc123").unwrap(), "abc123");
    }
}
