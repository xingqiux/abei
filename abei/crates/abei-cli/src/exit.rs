//! 退出码分档。agent 不必读文本就能分流：3 改参重试、4 重新配对、5 等上游、6 补 --yes。

/// 退出码。数值是对外契约，不要重排。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exit {
    /// 成功。
    Ok = 0,
    /// 通用失败。
    Failure = 1,
    /// 被中断。
    Interrupted = 2,
    /// 参数或用法不对。clap 自己的用法错误也收编到这一档。
    InvalidUsage = 3,
    /// 没配对或令牌失效。
    Unauthenticated = 4,
    /// 上游连不上或报错。
    Upstream = 5,
    /// 是写操作但没给 --yes。
    ConfirmationRequired = 6,
}

impl Exit {
    pub fn code(self) -> u8 {
        self as u8
    }

    pub fn is_ok(self) -> bool {
        matches!(self, Exit::Ok)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 数值是对外契约。
    #[test]
    fn codes_are_stable() {
        assert_eq!(Exit::Ok.code(), 0);
        assert_eq!(Exit::Failure.code(), 1);
        assert_eq!(Exit::Interrupted.code(), 2);
        assert_eq!(Exit::InvalidUsage.code(), 3);
        assert_eq!(Exit::Unauthenticated.code(), 4);
        assert_eq!(Exit::Upstream.code(), 5);
        assert_eq!(Exit::ConfirmationRequired.code(), 6);
    }
}
