use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use abei_core::Method;
use clap::Subcommand;
use reqwest::multipart::{Form, Part};
use serde_json::{Value, json};

use crate::client::Client;
use crate::config::Settings;
use crate::error::CliError;
use crate::io::Io;

const MAX_EML_BYTES: u64 = 25 * 1024 * 1024;
const MAX_YAML_BYTES: u64 = 256 * 1024;

#[derive(Debug, Subcommand)]
pub enum ParserCommand {
    /// 校验本地 ParserFlow YAML
    Validate {
        #[arg(value_name = "DEFINITION.yaml")]
        definition: PathBuf,
    },
    /// 用本地 EML 运行本地 ParserFlow
    Test {
        #[arg(value_name = "DEFINITION.yaml")]
        definition: PathBuf,
        #[arg(long, value_name = "MESSAGE.eml")]
        eml: PathBuf,
        #[arg(long = "secret", value_name = "KEY=VALUE")]
        secrets: Vec<String>,
    },
    /// 保存草稿并发布新版本
    Publish {
        #[arg(value_name = "FLOW_ID")]
        flow_id: i64,
        #[arg(long = "file", value_name = "DEFINITION.yaml")]
        definition: PathBuf,
        #[arg(long)]
        yes: bool,
    },
    /// 查看不可变版本
    Versions {
        #[arg(value_name = "FLOW_ID")]
        flow_id: i64,
    },
    /// 回滚到一个已发布版本
    Rollback {
        #[arg(value_name = "FLOW_ID")]
        flow_id: i64,
        #[arg(value_name = "VERSION")]
        version: i32,
        #[arg(long)]
        yes: bool,
    },
}

pub async fn run(
    io: &mut Io,
    settings: &Settings,
    command: &ParserCommand,
) -> Result<(), CliError> {
    let client = Client::new(
        &settings.api_url,
        Some(settings.require_token()?.to_owned()),
    )?;
    let response = match command {
        ParserCommand::Validate { definition } => {
            let source = read_text(definition, MAX_YAML_BYTES, "ParserFlow YAML")?;
            client
                .request(
                    Method::Post,
                    "/v1/parser-flows/validate",
                    &[],
                    Some(json!({ "source_yaml": source })),
                )
                .await?
        }
        ParserCommand::Test {
            definition,
            eml,
            secrets,
        } => {
            let source = read_text(definition, MAX_YAML_BYTES, "ParserFlow YAML")?;
            let eml_bytes = read_bytes(eml, MAX_EML_BYTES, "EML")?;
            let secrets = parse_secrets(secrets)?;
            let eml_name = eml
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("message.eml")
                .to_owned();
            let form = Form::new()
                .text("source_yaml", source)
                .text("timezone", "UTC")
                .text(
                    "secrets",
                    serde_json::to_string(&secrets)
                        .map_err(|error| CliError::Other(error.to_string()))?,
                )
                .part(
                    "eml",
                    Part::bytes(eml_bytes)
                        .file_name(eml_name)
                        .mime_str("message/rfc822")
                        .map_err(|error| CliError::Usage(error.to_string()))?,
                );
            client
                .post_multipart("/v1/parser-flows/test-eml", form)
                .await?
        }
        ParserCommand::Publish {
            flow_id,
            definition,
            yes,
        } => {
            require_positive(*flow_id, "FLOW_ID")?;
            require_yes(
                *yes,
                format!(
                    "abei parser publish {flow_id} --file {} --yes",
                    shell_path(definition)
                ),
            )?;
            let source = read_text(definition, MAX_YAML_BYTES, "ParserFlow YAML")?;
            client
                .request(
                    Method::Patch,
                    &format!("/v1/parser-flows/{flow_id}"),
                    &[],
                    Some(json!({ "source_yaml": source })),
                )
                .await?;
            client
                .request(
                    Method::Post,
                    &format!("/v1/parser-flows/{flow_id}/publish"),
                    &[("confirm".to_owned(), "true".to_owned())],
                    Some(json!({})),
                )
                .await?
        }
        ParserCommand::Versions { flow_id } => {
            require_positive(*flow_id, "FLOW_ID")?;
            client
                .request(
                    Method::Get,
                    &format!("/v1/parser-flows/{flow_id}/versions"),
                    &[],
                    None,
                )
                .await?
        }
        ParserCommand::Rollback {
            flow_id,
            version,
            yes,
        } => {
            require_positive(*flow_id, "FLOW_ID")?;
            if *version <= 0 {
                return Err(CliError::Usage("VERSION 必须是正整数。".to_owned()));
            }
            require_yes(
                *yes,
                format!("abei parser rollback {flow_id} {version} --yes"),
            )?;
            client
                .request(
                    Method::Post,
                    &format!("/v1/parser-flows/{flow_id}/rollback"),
                    &[("confirm".to_owned(), "true".to_owned())],
                    Some(json!({ "target_version": version })),
                )
                .await?
        }
    };
    write_json(io, &response)
}

fn read_text(path: &Path, max_bytes: u64, label: &str) -> Result<String, CliError> {
    let bytes = read_bytes(path, max_bytes, label)?;
    String::from_utf8(bytes)
        .map_err(|_| CliError::Usage(format!("{label} 必须是 UTF-8 文件：{}", path.display())))
}

fn read_bytes(path: &Path, max_bytes: u64, label: &str) -> Result<Vec<u8>, CliError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        CliError::Usage(format!("无法读取 {label} {}：{error}", path.display()))
    })?;
    if metadata.len() == 0 || metadata.len() > max_bytes {
        return Err(CliError::Usage(format!(
            "{label} 必须非空且不能超过 {} MiB。",
            max_bytes / 1024 / 1024
        )));
    }
    std::fs::read(path)
        .map_err(|error| CliError::Usage(format!("无法读取 {label} {}：{error}", path.display())))
}

fn parse_secrets(values: &[String]) -> Result<BTreeMap<String, String>, CliError> {
    let mut secrets = BTreeMap::new();
    for value in values {
        let (key, secret) = value
            .split_once('=')
            .ok_or_else(|| CliError::Usage("--secret 必须写成 KEY=VALUE。".to_owned()))?;
        if key.trim().is_empty() || secret.is_empty() {
            return Err(CliError::Usage(
                "--secret 的 KEY 和 VALUE 都不能为空。".to_owned(),
            ));
        }
        secrets.insert(key.to_owned(), secret.to_owned());
    }
    Ok(secrets)
}

fn require_positive(value: i64, label: &str) -> Result<(), CliError> {
    if value > 0 {
        Ok(())
    } else {
        Err(CliError::Usage(format!("{label} 必须是正整数。")))
    }
}

fn require_yes(yes: bool, command: String) -> Result<(), CliError> {
    if yes {
        Ok(())
    } else {
        Err(CliError::NeedsConfirmation { command })
    }
}

fn shell_path(path: &Path) -> String {
    let value = path.display().to_string();
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"/._-".contains(&byte))
    {
        value
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn write_json(io: &mut Io, value: &Value) -> Result<(), CliError> {
    let text =
        serde_json::to_string_pretty(value).map_err(|error| CliError::Other(error.to_string()))?;
    io.line(&text)
        .map_err(|error| CliError::Other(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_require_key_value_pairs() {
        assert_eq!(
            parse_secrets(&["password=1234".to_owned()]).unwrap()["password"],
            "1234"
        );
        assert!(parse_secrets(&["missing".to_owned()]).is_err());
    }

    #[test]
    fn destructive_commands_require_yes() {
        assert!(matches!(
            require_yes(false, "abei parser rollback 1 2 --yes".to_owned()),
            Err(CliError::NeedsConfirmation { .. })
        ));
    }
}
