//! abei-api 与 abei-server 之间的可信身份签名。
//!
//! abei-server 不自己验 Firefly token，它信任 abei-api 注入的三个身份头。
//! 只要有人能连上 abei-server 的端口，伪造这三个头就能冒充任意用户——所以这些头
//! 必须带一个只有 abei-api 知道的密钥算出的签名，abei-server 逐个请求验签。
//!
//! 签名头格式：`v1:<unix 秒>:<hex hmac-sha256>`；被签的内容是版本、时间戳和三个
//! 身份头的值，用换行连起来。带时间戳是为了让抓到的旧签名过期，窗口见 [`MAX_SKEW`]。

use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

/// abei-api 注入的调用者标识（Firefly 用户名）。
pub const ACTOR_HEADER: &str = "x-abei-authenticated-user";
/// abei-api 注入的角色，`owner` 表示 Firefly 站点属主。
pub const ROLE_HEADER: &str = "x-abei-authenticated-role";
/// abei-api 注入的 Firefly 用户 ID，abei-server 的数据按它隔离。
pub const USER_ID_HEADER: &str = "x-abei-authenticated-user-id";
/// 覆盖上面三个头的签名。
pub const SIGNATURE_HEADER: &str = "x-abei-internal-signature";

/// 用户的 Firefly 令牌，abei-api 校验通过后转交给 abei-server。
///
/// 只有入账 saga 用得上：abei-server 要替用户写账本，就得拿着用户自己的令牌。
/// 刻意**不**纳入 [`SIGNATURE_HEADER`] 的签名内容——签名保护的是「你是谁」这件事，
/// 令牌本身就是凭证，伪造一个没用，重放一个也只能重放持有者本来就能做的事。
/// abei-server 不存它、不记日志，只在一次请求的调用栈里传递。
pub const FIREFLY_TOKEN_HEADER: &str = "x-abei-firefly-token";

/// 签名允许的时间偏差。两个服务通常在同一台机器上，5 分钟足够容忍时钟漂移，
/// 又不至于让抓到的签名长期可重放。
pub const MAX_SKEW: u64 = 300;

/// 密钥的最短长度。太短的密钥可以直接爆破，不如不签。
pub const MIN_SECRET_LEN: usize = 32;

type HmacSha256 = Hmac<Sha256>;

/// 一次请求所携带的可信身份。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub actor: String,
    pub role: String,
    pub user_id: i64,
}

impl Identity {
    pub fn new(actor: impl Into<String>, role: impl Into<String>, user_id: i64) -> Self {
        Self {
            actor: actor.into(),
            role: role.into(),
            user_id,
        }
    }

    /// 是否是 Firefly 站点属主。影响全局配置的接口只认这个。
    pub fn is_owner(&self) -> bool {
        self.role == "owner"
    }
}

/// 验签失败的原因。对外一律回 401，这里区分只是为了日志能说清楚。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyError {
    /// 没有签名头。
    Missing,
    /// 签名头格式不对（版本、分段或时间戳解析不了）。
    Malformed,
    /// 时间戳超出 [`MAX_SKEW`]。
    Expired,
    /// 签名对不上：身份头被改过，或者密钥两边不一致。
    Mismatch,
}

impl VerifyError {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Missing => "缺少内部签名",
            Self::Malformed => "内部签名格式不对",
            Self::Expired => "内部签名已过期",
            Self::Mismatch => "内部签名对不上",
        }
    }
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// 检查密钥是否够用。两个服务启动时都调它，配置不合格就拒绝起服。
pub fn check_secret(secret: &str) -> Result<(), String> {
    if secret.trim().len() < MIN_SECRET_LEN {
        return Err(format!(
            "内部签名密钥至少要 {MIN_SECRET_LEN} 个字符，当前只有 {}。",
            secret.trim().len()
        ));
    }
    Ok(())
}

fn payload(timestamp: u64, identity: &Identity) -> String {
    format!(
        "v1\n{timestamp}\n{}\n{}\n{}",
        identity.actor, identity.role, identity.user_id
    )
}

fn digest(secret: &[u8], timestamp: u64, identity: &Identity) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC 接受任意长度的密钥");
    mac.update(payload(timestamp, identity).as_bytes());
    mac.finalize().into_bytes().to_vec()
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    bytes.iter().fold(String::new(), |mut text, byte| {
        let _ = write!(text, "{byte:02x}");
        text
    })
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).ok())
        .collect()
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default()
}

/// 用指定时间戳签名，返回 [`SIGNATURE_HEADER`] 的值。测试之外用 [`sign`]。
pub fn sign_at(secret: &[u8], identity: &Identity, timestamp: u64) -> String {
    format!(
        "v1:{timestamp}:{}",
        hex(&digest(secret, timestamp, identity))
    )
}

/// 按当前时间签名，返回 [`SIGNATURE_HEADER`] 的值。
pub fn sign(secret: &[u8], identity: &Identity) -> String {
    sign_at(secret, identity, now())
}

/// 用指定的“当前时间”验签。测试之外用 [`verify`]。
pub fn verify_at(
    secret: &[u8],
    identity: &Identity,
    signature: &str,
    current: u64,
) -> Result<(), VerifyError> {
    let mut parts = signature.splitn(3, ':');
    let version = parts.next().ok_or(VerifyError::Malformed)?;
    let timestamp = parts.next().ok_or(VerifyError::Malformed)?;
    let mac = parts.next().ok_or(VerifyError::Malformed)?;
    if version != "v1" {
        return Err(VerifyError::Malformed);
    }
    let timestamp: u64 = timestamp.parse().map_err(|_| VerifyError::Malformed)?;
    if current.abs_diff(timestamp) > MAX_SKEW {
        return Err(VerifyError::Expired);
    }
    let provided = unhex(mac).ok_or(VerifyError::Malformed)?;

    let mut hmac = HmacSha256::new_from_slice(secret).expect("HMAC 接受任意长度的密钥");
    hmac.update(payload(timestamp, identity).as_bytes());
    hmac.verify_slice(&provided)
        .map_err(|_| VerifyError::Mismatch)
}

/// 按当前时间验签。签名必须覆盖 `identity` 里的三个值。
pub fn verify(secret: &[u8], identity: &Identity, signature: &str) -> Result<(), VerifyError> {
    verify_at(secret, identity, signature, now())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"0123456789abcdef0123456789abcdef";

    fn identity() -> Identity {
        Identity::new("owner@example.com", "owner", 1)
    }

    #[test]
    fn a_fresh_signature_verifies() {
        let signature = sign(SECRET, &identity());
        assert_eq!(verify(SECRET, &identity(), &signature), Ok(()));
    }

    #[test]
    fn changing_any_signed_field_breaks_the_signature() {
        let signature = sign_at(SECRET, &identity(), 1_000);
        for forged in [
            Identity::new("someone@example.com", "owner", 1),
            Identity::new("owner@example.com", "user", 1),
            Identity::new("owner@example.com", "owner", 2),
        ] {
            assert_eq!(
                verify_at(SECRET, &forged, &signature, 1_000),
                Err(VerifyError::Mismatch),
                "改了身份还能验过：{forged:?}"
            );
        }
    }

    #[test]
    fn another_secret_does_not_verify() {
        let signature = sign_at(SECRET, &identity(), 1_000);
        let other = b"fedcba9876543210fedcba9876543210";
        assert_eq!(
            verify_at(other, &identity(), &signature, 1_000),
            Err(VerifyError::Mismatch)
        );
    }

    #[test]
    fn signatures_expire_outside_the_window() {
        let signature = sign_at(SECRET, &identity(), 1_000);
        assert_eq!(
            verify_at(SECRET, &identity(), &signature, 1_000 + MAX_SKEW),
            Ok(())
        );
        assert_eq!(
            verify_at(SECRET, &identity(), &signature, 1_000 + MAX_SKEW + 1),
            Err(VerifyError::Expired)
        );
        // 时钟往回跳也一样按偏差算。
        assert_eq!(
            verify_at(SECRET, &identity(), &signature, 1_000 - MAX_SKEW - 1),
            Err(VerifyError::Expired)
        );
    }

    #[test]
    fn malformed_signatures_are_rejected() {
        for text in ["", "v1", "v1:1000", "v2:1000:aa", "v1:abc:aa", "v1:1000:zz"] {
            assert_eq!(
                verify_at(SECRET, &identity(), text, 1_000),
                Err(VerifyError::Malformed),
                "这个签名不该被当成合法格式：{text}"
            );
        }
    }

    #[test]
    fn short_secrets_are_refused() {
        assert!(check_secret("太短了").is_err());
        assert!(check_secret("0123456789abcdef0123456789abcdef").is_ok());
    }
}
