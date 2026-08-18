//! 批量重归类的任务台账。
//!
//! 以前 apply 就是请求 handler 里的一个 `for` 循环：客户端超时断开，axum 把这个
//! future 丢掉，循环在半路蒸发。252 封只处理了 5 封，而且没有任何记录说这件事发生过——
//! 用户看到的是「abei-server 没有响应」，剩下的 247 封去哪了没人知道。
//!
//! 现在 apply 只负责开一条任务记录然后立刻返回，真正的处理放在 `tokio::spawn` 出去的
//! 任务里，进度逐封落库。连接断了任务照跑；进程真的没了，心跳会停在原地，读的时候
//! 就能看出这是「中断」而不是「还在跑」。

use deadpool_postgres::Pool;
use serde_json::{Value, json};

use crate::ApiError;

/// 心跳停多久就算这个任务中断了。
///
/// 处理一封邮件要连 IMAP 拉正文，慢的时候十几秒；60 秒是「肯定不只是慢」的界。
/// `make_interval(secs => ...)` 那头是 double precision，类型得对上。
const HEARTBEAT_STALE_SECS: f64 = 60.0;

/// 这条规则已经有一个 apply 在跑。
pub(crate) const APPLY_IN_FLIGHT: &str = "mail_rule_apply_in_flight";

/// 一次 apply 跑到一半的计数。
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct ApplyProgress {
    pub rerouted: i32,
    pub reparse_jobs: i32,
    pub failed: i32,
}

/// 开一条任务记录。同一条规则已经有在跑的就拒绝。
///
/// 先把心跳失联的旧任务收成 failed，否则一次进程崩溃会让这条规则永远开不了新任务——
/// 库里那个部分唯一索引认的是 `state = 'running'`，它不会自己过期。
pub(crate) async fn start_run(
    pool: &Pool,
    user_id: i64,
    rule_id: i64,
    scope: &str,
) -> Result<i64, ApiError> {
    let mut client = pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    transaction
        .execute(
            "UPDATE abei_ai.mail_rule_apply_runs
             SET state = 'failed',
                 error_message = '任务在处理途中失去心跳（多半是服务重启），已中断。',
                 finished_at = now(), updated_at = now()
             WHERE mail_rule_id = $1 AND state = 'running'
               AND heartbeat_at < now() - make_interval(secs => $2)",
            &[&rule_id, &HEARTBEAT_STALE_SECS],
        )
        .await
        .map_err(ApiError::database)?;
    let running = transaction
        .query_opt(
            "SELECT id FROM abei_ai.mail_rule_apply_runs
             WHERE mail_rule_id = $1 AND state = 'running' FOR UPDATE",
            &[&rule_id],
        )
        .await
        .map_err(ApiError::database)?;
    if running.is_some() {
        return Err(
            ApiError::conflict("这条规则已经有一次批量重归类在跑，等它跑完再发起。")
                .with_reason(APPLY_IN_FLIGHT),
        );
    }
    let id: i64 = transaction
        .query_one(
            "INSERT INTO abei_ai.mail_rule_apply_runs (user_id, mail_rule_id, scope)
             VALUES ($1, $2, $3) RETURNING id",
            &[&user_id, &rule_id, &scope],
        )
        .await
        .map_err(ApiError::database)?
        .get(0);
    transaction.commit().await.map_err(ApiError::database)?;
    Ok(id)
}

/// 候选扫完了，把「一共看了多少封、命中多少封」记下来。
pub(crate) async fn record_scan(
    pool: &Pool,
    run_id: i64,
    total_scanned: i32,
    matched: i32,
) -> Result<(), ApiError> {
    pool.get()
        .await
        .map_err(ApiError::database)?
        .execute(
            "UPDATE abei_ai.mail_rule_apply_runs
             SET total_scanned = $2, matched = $3, heartbeat_at = now(), updated_at = now()
             WHERE id = $1",
            &[&run_id, &total_scanned, &matched],
        )
        .await
        .map_err(ApiError::database)?;
    Ok(())
}

/// 每处理完一封就写一次。心跳跟着走，任务停了看得出来。
pub(crate) async fn record_progress(
    pool: &Pool,
    run_id: i64,
    progress: ApplyProgress,
) -> Result<(), ApiError> {
    pool.get()
        .await
        .map_err(ApiError::database)?
        .execute(
            "UPDATE abei_ai.mail_rule_apply_runs
             SET rerouted = $2, reparse_jobs = $3, failed = $4,
                 heartbeat_at = now(), updated_at = now()
             WHERE id = $1",
            &[
                &run_id,
                &progress.rerouted,
                &progress.reparse_jobs,
                &progress.failed,
            ],
        )
        .await
        .map_err(ApiError::database)?;
    Ok(())
}

/// 收尾。`error` 有值就是整批没跑起来（规则读不出来、库连不上）。
pub(crate) async fn finish_run(
    pool: &Pool,
    run_id: i64,
    error: Option<&str>,
) -> Result<(), ApiError> {
    let state = if error.is_some() {
        "failed"
    } else {
        "succeeded"
    };
    pool.get()
        .await
        .map_err(ApiError::database)?
        .execute(
            "UPDATE abei_ai.mail_rule_apply_runs
             SET state = $2, error_message = $3, finished_at = now(),
                 heartbeat_at = now(), updated_at = now()
             WHERE id = $1",
            &[&run_id, &state, &error],
        )
        .await
        .map_err(ApiError::database)?;
    Ok(())
}

/// 这条规则最近一次 apply 的进度。没跑过就返回 `state = "idle"` 的空壳，
/// 而不是 404——「从来没跑过」是个正常答案，不是错误。
pub(crate) async fn latest_run(pool: &Pool, user_id: i64, rule_id: i64) -> Result<Value, ApiError> {
    let row = pool
        .get()
        .await
        .map_err(ApiError::database)?
        .query_opt(
            "SELECT id, state, scope, total_scanned, matched, rerouted, reparse_jobs, failed,
                    error_message, heartbeat_at < now() - make_interval(secs => $3),
                    created_at::text, finished_at::text
             FROM abei_ai.mail_rule_apply_runs
             WHERE user_id = $1 AND mail_rule_id = $2
             ORDER BY id DESC LIMIT 1",
            &[&user_id, &rule_id, &HEARTBEAT_STALE_SECS],
        )
        .await
        .map_err(ApiError::database)?;
    let Some(row) = row else {
        return Ok(json!({ "data": {
            "run_id": Value::Null,
            "state": "idle",
            "scope": Value::Null,
            "total_scanned": 0,
            "matched": 0,
            "rerouted": 0,
            "reparse_jobs": 0,
            "failed": 0,
            "error": Value::Null,
        }}));
    };
    Ok(json!({ "data": run_json(&row) }))
}

/// 一条任务记录的 JSON。
///
/// `state` 不直接抄库里那一列：一条 `running` 但心跳早停了的记录说的是「中断」，
/// 照抄就成了「还在跑」，客户端会一直轮询一个永远不动的进度。
pub(crate) fn run_json(row: &tokio_postgres::Row) -> Value {
    let state: String = row.get(1);
    let stale: bool = row.get(9);
    let state = if state == "running" && stale {
        "interrupted"
    } else {
        state.as_str()
    };
    json!({
        "run_id": row.get::<_, i64>(0).to_string(),
        "state": state,
        "scope": row.get::<_, String>(2),
        "total_scanned": row.get::<_, i32>(3),
        "matched": row.get::<_, i32>(4),
        "rerouted": row.get::<_, i32>(5),
        "reparse_jobs": row.get::<_, i32>(6),
        "failed": row.get::<_, i32>(7),
        "error": row.get::<_, Option<String>>(8),
        "created_at": row.get::<_, String>(10),
        "finished_at": row.get::<_, Option<String>>(11),
    })
}
