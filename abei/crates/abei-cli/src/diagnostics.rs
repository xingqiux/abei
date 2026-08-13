//! One bounded, privacy-safe snapshot of the most recent capability invocation.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::config;
use crate::error::CliError;

const SNAPSHOT_FILE: &str = "recent-invocation.json";
const SNAPSHOT_TTL_SECONDS: u64 = 30 * 60;
static KEY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct Snapshot {
    capability_id: String,
    request_id: Option<String>,
    result: String,
    error_reason: Option<String>,
    exit_code: u8,
    recorded_at: String,
    recorded_at_unix: u64,
}

/// Add only system-owned fields to `feedback create`.
pub fn enrich_feedback_create(params: &mut Map<String, Value>) -> Result<(), CliError> {
    normalize_choice(
        params,
        "kind",
        &[("1", "bug"), ("2", "experience"), ("3", "suggestion")],
    )?;
    if params.contains_key("target") {
        normalize_choice(
            params,
            "target",
            &[("1", "cli"), ("2", "app"), ("3", "web")],
        )?;
    } else {
        params.insert("target".to_owned(), Value::String("cli".to_owned()));
    }

    params.insert(
        "idempotency_key".to_owned(),
        Value::String(idempotency_key()),
    );
    params.insert("submitted_via".to_owned(), Value::String("cli".to_owned()));
    let mut context = json!({
        "cli_version": env!("CARGO_PKG_VERSION"),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "recorded_at": jiff::Timestamp::now().to_string(),
    });
    if let Some(snapshot) = read_recent() {
        context["recent"] = json!({
            "capability_id": snapshot.capability_id,
            "request_id": snapshot.request_id,
            "result": snapshot.result,
            "error_reason": snapshot.error_reason,
            "exit_code": snapshot.exit_code,
            "recorded_at": snapshot.recorded_at,
        });
    }
    params.insert("context".to_owned(), context);
    Ok(())
}

/// Best effort by design: a diagnostics write must never change command success.
pub fn record(
    capability_id: &str,
    request_id: Option<String>,
    result: &str,
    error_reason: Option<&str>,
    exit_code: u8,
) {
    let snapshot = Snapshot {
        capability_id: truncate(capability_id, 128),
        request_id: request_id.map(|value| truncate(&value, 128)),
        result: if result == "success" {
            "success"
        } else {
            "error"
        }
        .to_owned(),
        error_reason: error_reason.map(|value| truncate(value, 128)),
        exit_code,
        recorded_at: jiff::Timestamp::now().to_string(),
        recorded_at_unix: unix_seconds(),
    };
    if let Some(path) = snapshot_path() {
        let _ = write_snapshot(&path, &snapshot);
    }
}

fn read_recent() -> Option<Snapshot> {
    read_snapshot(&snapshot_path()?)
}

fn snapshot_path() -> Option<PathBuf> {
    Some(config::config_dir()?.join(SNAPSHOT_FILE))
}

fn read_snapshot(path: &Path) -> Option<Snapshot> {
    let snapshot: Snapshot = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    let age = unix_seconds().saturating_sub(snapshot.recorded_at_unix);
    (age <= SNAPSHOT_TTL_SECONDS).then_some(snapshot)
}

fn write_snapshot(path: &Path, snapshot: &Snapshot) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let bytes = serde_json::to_vec(snapshot).map_err(std::io::Error::other)?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
        file.write_all(&bytes)?;
    }
    #[cfg(not(unix))]
    fs::write(path, bytes)?;
    Ok(())
}

fn normalize_choice(
    params: &mut Map<String, Value>,
    field: &str,
    numeric: &[(&str, &str)],
) -> Result<(), CliError> {
    let raw = params
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| CliError::Usage(format!("--{field} 必须填写。")))?;
    let normalized = numeric
        .iter()
        .find_map(|(number, name)| {
            (raw == *number || raw.eq_ignore_ascii_case(name)).then_some(*name)
        })
        .ok_or_else(|| {
            CliError::Usage(format!(
                "--{field} 只能是 {}。",
                numeric
                    .iter()
                    .map(|(number, name)| format!("{number}/{name}"))
                    .collect::<Vec<_>>()
                    .join("、")
            ))
        })?;
    params.insert(field.to_owned(), Value::String(normalized.to_owned()));
    Ok(())
}

fn idempotency_key() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = KEY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("cli:{nanos}:{}:{sequence}", std::process::id())
}

fn unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("abei-diagnostics-{}-{name}", std::process::id()))
    }

    #[test]
    fn snapshot_is_owner_only_bounded_and_contains_no_payload() {
        let dir = scratch("safe");
        let path = dir.join(SNAPSHOT_FILE);
        let snapshot = Snapshot {
            capability_id: "bills.import".to_owned(),
            request_id: Some("request-1".to_owned()),
            result: "error".to_owned(),
            error_reason: Some("UpstreamUnavailable".to_owned()),
            exit_code: 5,
            recorded_at: "2026-08-11T00:00:00Z".to_owned(),
            recorded_at_unix: unix_seconds(),
        };
        write_snapshot(&path, &snapshot).unwrap();
        assert_eq!(read_snapshot(&path), Some(snapshot));
        let text = fs::read_to_string(&path).unwrap();
        for forbidden in ["argv", "params", "response", "token", "cwd", "prompt"] {
            assert!(!text.contains(forbidden), "{forbidden}");
        }
        assert!(text.len() < 2048);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn expired_snapshot_is_ignored() {
        let dir = scratch("expired");
        let path = dir.join(SNAPSHOT_FILE);
        let snapshot = Snapshot {
            capability_id: "bills.list".to_owned(),
            request_id: None,
            result: "success".to_owned(),
            error_reason: None,
            exit_code: 0,
            recorded_at: "2026-08-11T00:00:00Z".to_owned(),
            recorded_at_unix: unix_seconds().saturating_sub(SNAPSHOT_TTL_SECONDS + 1),
        };
        write_snapshot(&path, &snapshot).unwrap();
        assert!(read_snapshot(&path).is_none());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn feedback_input_is_normalized_and_enriched() {
        let mut params = json!({ "kind": "2", "message": "提示不清楚" })
            .as_object()
            .unwrap()
            .clone();
        enrich_feedback_create(&mut params).unwrap();
        assert_eq!(params["kind"], "experience");
        assert_eq!(params["target"], "cli");
        assert_eq!(params["submitted_via"], "cli");
        assert!(
            params["idempotency_key"]
                .as_str()
                .unwrap()
                .starts_with("cli:")
        );
        assert!(params["context"].get("cli_version").is_some());
    }
}
