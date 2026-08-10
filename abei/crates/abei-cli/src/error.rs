//! 错误与退出码的对应。
//!
//! 服务端的 problem+json 原样收下：`reason` 决定退出码，`title`/`detail` 给人看，
//! `--json` 时把整个 problem 原样吐出去，不做二次翻译。

use serde_json::Value;

use crate::exit::Exit;

/// 服务端返回的 problem+json。
#[derive(Debug, Clone)]
pub struct ServerProblem {
    pub status: u16,
    pub reason: String,
    pub title: String,
    pub detail: Option<String>,
    pub raw: Value,
}

impl ServerProblem {
    pub fn parse(status: u16, body: &str) -> Option<Self> {
        let raw: Value = serde_json::from_str(body).ok()?;
        let reason = raw.get("reason")?.as_str()?.to_owned();
        Some(Self {
            status,
            title: raw
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("请求失败")
                .to_owned(),
            detail: raw.get("detail").and_then(Value::as_str).map(str::to_owned),
            reason,
            raw,
        })
    }

    /// reason 是封闭码表，退出码由它决定。
    pub fn exit(&self) -> Exit {
        match self.reason.as_str() {
            "MissingToken" | "InvalidToken" => Exit::Unauthenticated,
            "InvalidParams" | "InvalidDate" => Exit::InvalidUsage,
            "UpstreamUnavailable" | "UpstreamError" => Exit::Upstream,
            _ => Exit::Failure,
        }
    }

    /// 人话一行：标题 + 细节，末尾缀机读 reason。
    pub fn human(&self) -> String {
        let mut text = self.title.clone();
        if let Some(detail) = &self.detail {
            text.push('：');
            text.push_str(detail);
        }
        format!("{text} [{}]", self.reason)
    }
}

#[derive(Debug)]
pub enum CliError {
    /// 参数或用法不对。
    Usage(String),
    /// 没配对或令牌失效。
    Auth(String),
    /// 连不上 abei-api。
    Unreachable(String),
    /// 写操作缺 --yes；把补全后的命令一并给出。
    NeedsConfirmation { command: String },
    /// 服务端 problem+json。
    Server(Box<ServerProblem>),
    /// 其它。
    Other(String),
}

impl CliError {
    pub fn exit(&self) -> Exit {
        match self {
            Self::Usage(_) => Exit::InvalidUsage,
            Self::Auth(_) => Exit::Unauthenticated,
            Self::Unreachable(_) => Exit::Upstream,
            Self::NeedsConfirmation { .. } => Exit::ConfirmationRequired,
            Self::Server(problem) => problem.exit(),
            Self::Other(_) => Exit::Failure,
        }
    }

    pub fn human(&self) -> String {
        match self {
            Self::Usage(message) | Self::Auth(message) | Self::Other(message) => message.clone(),
            Self::Unreachable(message) => {
                format!(
                    "连不上 abei-api：{message}\n先确认服务在跑，或用 abei auth login --url 换地址。"
                )
            }
            Self::NeedsConfirmation { command } => {
                format!("这是写操作，补一个 --yes 再来：\n  {command}")
            }
            Self::Server(problem) => problem.human(),
        }
    }

    /// `--json` 时的机器可读形态。服务端来的原样透传，本地错误现造一个同形状的。
    ///
    /// 不管哪种，都补一个 `exit`：管道里拿不到进程退出码，agent 读这个字段就够分流了。
    pub fn to_json(&self) -> Value {
        let mut body = match self {
            Self::Server(problem) => problem.raw.clone(),
            other => serde_json::json!({
                "title": "命令没执行成功",
                "status": other.exit().code(),
                "reason": other.reason(),
                "detail": other.human(),
            }),
        };

        if let Some(object) = body.as_object_mut() {
            object.insert("exit".to_owned(), self.exit().code().into());
        } else {
            body = serde_json::json!({
                "title": "命令没执行成功",
                "reason": self.reason(),
                "detail": self.human(),
                "exit": self.exit().code(),
            });
        }
        body
    }

    fn reason(&self) -> &'static str {
        match self {
            Self::Usage(_) => "InvalidUsage",
            Self::Auth(_) => "Unauthenticated",
            Self::Unreachable(_) => "Unreachable",
            Self::NeedsConfirmation { .. } => "ConfirmationRequired",
            Self::Server(_) => "ServerProblem",
            Self::Other(_) => "Failure",
        }
    }
}

impl From<reqwest::Error> for CliError {
    fn from(error: reqwest::Error) -> Self {
        if error.is_connect() || error.is_timeout() {
            Self::Unreachable(error.to_string())
        } else {
            Self::Other(error.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_decides_exit_code() {
        let cases = [
            ("MissingToken", Exit::Unauthenticated),
            ("InvalidToken", Exit::Unauthenticated),
            ("InvalidParams", Exit::InvalidUsage),
            ("InvalidDate", Exit::InvalidUsage),
            ("UpstreamUnavailable", Exit::Upstream),
            ("UpstreamError", Exit::Upstream),
            ("NotFound", Exit::Failure),
        ];
        for (reason, expected) in cases {
            let body = format!(r#"{{"reason":"{reason}","title":"x","status":400}}"#);
            let problem = ServerProblem::parse(400, &body).unwrap();
            assert_eq!(problem.exit(), expected, "{reason}");
        }
    }

    #[test]
    fn local_errors_map_to_their_codes() {
        assert_eq!(CliError::Usage("x".into()).exit(), Exit::InvalidUsage);
        assert_eq!(CliError::Auth("x".into()).exit(), Exit::Unauthenticated);
        assert_eq!(CliError::Unreachable("x".into()).exit(), Exit::Upstream);
        assert_eq!(
            CliError::NeedsConfirmation {
                command: "abei bills import 1 --yes".into()
            }
            .exit(),
            Exit::ConfirmationRequired
        );
        assert_eq!(CliError::Other("x".into()).exit(), Exit::Failure);
    }

    /// 不是 problem+json 的响应体不该被硬认成 problem。
    #[test]
    fn non_problem_bodies_are_rejected() {
        assert!(ServerProblem::parse(500, "<html>oops</html>").is_none());
        assert!(ServerProblem::parse(500, r#"{"message":"boom"}"#).is_none());
    }

    #[test]
    fn human_message_carries_machine_reason() {
        let body = r#"{"reason":"InvalidDate","title":"日期格式不对","detail":"start 应该写成 YYYY-MM-DD。","status":400}"#;
        let problem = ServerProblem::parse(400, body).unwrap();
        let text = problem.human();
        assert!(text.contains("日期格式不对"));
        assert!(text.contains("start 应该写成"));
        assert!(text.contains("[InvalidDate]"));
    }

    /// 缺确认时要把补全后的命令给出来，agent 直接照抄就能重试。
    #[test]
    fn confirmation_error_shows_the_fixed_command() {
        let error = CliError::NeedsConfirmation {
            command: "abei bills import 42 --yes".into(),
        };
        assert!(error.human().contains("abei bills import 42 --yes"));
    }

    #[test]
    fn local_errors_have_json_shape() {
        let json = CliError::Usage("参数不对".into()).to_json();
        assert_eq!(json["reason"], "InvalidUsage");
        assert_eq!(json["status"], 3);
    }
}
