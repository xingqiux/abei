//! 后台任务的时间与并发参数。
//!
//! 这些数字原先散在各处：租约写在 SQL 字面量里（`interval '5 minutes'`），重试上限写在
//! worker 的 `attempt < 20` 里，worker 数量在 `billing::Service::new` 里直接读环境变量。
//! 结果是改一个超时要翻三个文件，而且没有一处能让人一眼看全「这套后台到底按什么节奏跑」。
//! 全部收到这里，SQL 那边改成把秒数当参数传进去。

use std::time::Duration;

/// 单位是秒，方便直接喂给 `make_interval(secs => $n)`。
#[derive(Debug, Clone, Copy)]
pub struct ReliabilityConfig {
    /// 全局清扫器多久跑一轮。
    pub sweep_interval: Duration,
    /// `prepared` 停留多久算「发送前就中断了」，回收成 `retryable`。
    pub prepare_lease: Duration,
    /// `sending` 停留多久算「发送途中失联」，回收成 `uncertain`。
    pub send_lease: Duration,
    /// 同步任务多久没有心跳算死，回收成 `failed`。
    pub sync_heartbeat_timeout: Duration,
    /// 同时最多几个用户在同步。
    pub sync_concurrency: usize,
    /// 关停时最多等在跑的同步任务多久。
    pub shutdown_grace: Duration,
    /// 同一个邮箱连续失败后的退避上限。
    pub sync_backoff_max: Duration,
    /// 解析 worker 的数量。
    pub parse_workers: usize,
}

impl Default for ReliabilityConfig {
    fn default() -> Self {
        Self {
            sweep_interval: Duration::from_secs(60),
            prepare_lease: Duration::from_secs(5 * 60),
            send_lease: Duration::from_secs(2 * 60),
            sync_heartbeat_timeout: Duration::from_secs(3 * 60),
            sync_concurrency: 4,
            shutdown_grace: Duration::from_secs(30),
            sync_backoff_max: Duration::from_secs(60 * 60),
            parse_workers: 2,
        }
    }
}

impl ReliabilityConfig {
    pub fn from_env() -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let default = Self::default();
        let config = Self {
            sweep_interval: secs("ABEI_SWEEP_INTERVAL", default.sweep_interval)?,
            prepare_lease: secs("ABEI_IMPORT_PREPARE_LEASE", default.prepare_lease)?,
            send_lease: secs("ABEI_IMPORT_SEND_LEASE", default.send_lease)?,
            sync_heartbeat_timeout: secs(
                "ABEI_SYNC_HEARTBEAT_TIMEOUT",
                default.sync_heartbeat_timeout,
            )?,
            sync_concurrency: count("ABEI_SYNC_CONCURRENCY", default.sync_concurrency, 1..=64)?,
            shutdown_grace: secs("ABEI_SHUTDOWN_GRACE", default.shutdown_grace)?,
            sync_backoff_max: secs("ABEI_SYNC_BACKOFF_MAX", default.sync_backoff_max)?,
            parse_workers: count("ABEI_PARSE_WORKERS", default.parse_workers, 1..=16)?,
        };
        Ok(config)
    }

    /// 供测试用：把等待压到最短，免得用例要真等一分钟。
    #[cfg(test)]
    pub(crate) fn test() -> Self {
        Self {
            sweep_interval: Duration::from_millis(50),
            shutdown_grace: Duration::from_secs(2),
            ..Self::default()
        }
    }

    pub(crate) fn prepare_lease_secs(&self) -> f64 {
        self.prepare_lease.as_secs_f64()
    }

    pub(crate) fn send_lease_secs(&self) -> f64 {
        self.send_lease.as_secs_f64()
    }

    pub(crate) fn sync_heartbeat_timeout_secs(&self) -> f64 {
        self.sync_heartbeat_timeout.as_secs_f64()
    }
}

fn secs(
    name: &'static str,
    default: Duration,
) -> Result<Duration, Box<dyn std::error::Error + Send + Sync>> {
    let Ok(raw) = std::env::var(name) else {
        return Ok(default);
    };
    let seconds: u64 = raw
        .trim()
        .parse()
        .map_err(|_| format!("{name} 必须是秒数（整数），现在是 {raw:?}"))?;
    if seconds == 0 {
        return Err(format!("{name} 必须大于 0").into());
    }
    Ok(Duration::from_secs(seconds))
}

fn count(
    name: &'static str,
    default: usize,
    allowed: std::ops::RangeInclusive<usize>,
) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {
    let Ok(raw) = std::env::var(name) else {
        return Ok(default);
    };
    let value: usize = raw
        .trim()
        .parse()
        .map_err(|_| format!("{name} 必须是整数，现在是 {raw:?}"))?;
    if !allowed.contains(&value) {
        return Err(format!(
            "{name} 必须在 {}..={} 之间，现在是 {value}",
            allowed.start(),
            allowed.end()
        )
        .into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_numbers_the_sql_used_to_hardcode() {
        let config = ReliabilityConfig::default();
        assert_eq!(config.prepare_lease_secs(), 300.0);
        assert_eq!(config.send_lease_secs(), 120.0);
        assert_eq!(config.sync_heartbeat_timeout_secs(), 180.0);
    }

    #[test]
    fn a_zero_duration_is_rejected_rather_than_spinning_the_sweeper() {
        unsafe { std::env::set_var("ABEI_TEST_ZERO_SECS", "0") };
        let error = secs("ABEI_TEST_ZERO_SECS", Duration::from_secs(60)).unwrap_err();
        unsafe { std::env::remove_var("ABEI_TEST_ZERO_SECS") };
        assert!(error.to_string().contains("必须大于 0"));
    }

    #[test]
    fn an_out_of_range_count_is_rejected() {
        unsafe { std::env::set_var("ABEI_TEST_COUNT", "999") };
        let error = count("ABEI_TEST_COUNT", 2, 1..=16).unwrap_err();
        unsafe { std::env::remove_var("ABEI_TEST_COUNT") };
        assert!(error.to_string().contains("必须在 1..=16 之间"));
    }
}
