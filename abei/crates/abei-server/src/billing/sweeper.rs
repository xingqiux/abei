//! 全局清扫器：把超时卡住的流水和同步任务收回来。
//!
//! 这件事以前是「惰性」的——回收 SQL 藏在 `validate_import_row` 里，`WHERE bill_row_id = $1`
//! 只扫用户当下正在操作的那一行。于是一条卡在 `sending` 的流水，除非用户恰好再点它一次，
//! 否则界面上永远转圈。同步任务的残留也一样，要等这个用户下一轮 enqueue 才会被标记失败。
//!
//! 这里改成进程级的定时任务：不带 row_id、不带 user_id，到点就把所有超时的都收掉。

use super::Service;
use crate::states::{ImportStatus, SyncRunStatus};

pub(super) fn start(service: Service) {
    let interval = service.reliability.sweep_interval;
    tokio::spawn(async move {
        // 第一拍立刻到，这样进程刚起来就先收一次上次崩溃留下的残局。
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match sweep(&service).await {
                Ok(report) if report.is_empty() => {}
                Ok(report) => tracing::info!(
                    prepared = report.prepared_expired,
                    sending = report.sending_expired,
                    sync_runs = report.sync_runs_failed,
                    "清扫器回收了超时的流水与同步任务"
                ),
                Err(error) => tracing::error!(%error, "清扫器这一轮失败，等下一轮再试"),
            }
        }
    });
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct SweepReport {
    pub prepared_expired: u64,
    pub sending_expired: u64,
    pub sync_runs_failed: u64,
}

impl SweepReport {
    fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// 跑一轮清扫。返回各回收了多少条，方便测试断言和日志。
pub(super) async fn sweep(service: &Service) -> Result<SweepReport, String> {
    let client = service
        .pool
        .get()
        .await
        .map_err(|error| error.to_string())?;
    let config = &service.reliability;

    // 状态字面量都从 states.rs 的枚举渲染，改状态机时这里跟着走，不用满仓库搜字符串。
    let prepared_expired = client
        .execute(
            &format!(
                "UPDATE abei_ai.bill_import_attempts SET status = '{retryable}',
                   error_code = 'prepare_expired', error_message = '导入在发送前中断，可以重试。',
                   finished_at = now(), updated_at = now()
                 WHERE status = '{prepared}'
                   AND updated_at < now() - make_interval(secs => $1)",
                retryable = ImportStatus::Retryable,
                prepared = ImportStatus::Prepared,
            ),
            &[&config.prepare_lease_secs()],
        )
        .await
        .map_err(|error| error.to_string())?;

    let sending_expired = client
        .execute(
            &format!(
                "UPDATE abei_ai.bill_import_attempts SET status = '{uncertain}',
                   error_code = 'sending_lease_expired',
                   error_message = '发送过程失去响应，必须先按 external_id 对账。',
                   retry_after = now(), updated_at = now()
                 WHERE status = '{sending}'
                   AND updated_at < now() - make_interval(secs => $1)",
                uncertain = ImportStatus::Uncertain,
                sending = ImportStatus::Sending,
            ),
            &[&config.send_lease_secs()],
        )
        .await
        .map_err(|error| error.to_string())?;

    let sync_runs_failed = client
        .execute(
            &format!(
                "UPDATE abei_ai.mail_sync_runs SET status = '{failed}', stage = 'finished',
                   error_summary = '同步进程失去心跳，已由清扫器回收。',
                   finished_at = now(), updated_at = now()
                 WHERE status IN ({in_flight})
                   AND updated_at < now() - make_interval(secs => $1)",
                failed = SyncRunStatus::Failed,
                in_flight = SyncRunStatus::in_flight_sql(),
            ),
            &[&config.sync_heartbeat_timeout_secs()],
        )
        .await
        .map_err(|error| error.to_string())?;

    Ok(SweepReport {
        prepared_expired,
        sending_expired,
        sync_runs_failed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testdb;

    async fn service(pool: &deadpool_postgres::Pool) -> Service {
        let config = crate::mailbox::RuntimeConfig::test();
        let mail = crate::mail::Service::new(pool.clone(), config.storage_root().to_path_buf());
        let parser = crate::parser::Service::new(pool.clone(), mail.clone());
        Service::new(
            pool.clone(),
            mail,
            parser,
            config.job_secret_cipher(),
            config.reliability(),
            crate::firefly::Firefly::from_env(),
        )
    }

    #[tokio::test]
    async fn a_sending_attempt_nobody_touches_still_gets_reclaimed() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_010_i64;
        let fixture = testdb::seed(&client, user_id).await;

        // 一条早就超时的 sending 流水，而且没有人会再去点它——这正是以前「按行惰性清扫」
        // 够不到的情况：界面上永远显示发送中。
        let id = testdb::insert_attempt(&client, &fixture, "sending", 3600.0).await;

        // 清扫是全局的，并行跑的别的用例也会顺手把这条收走，所以只断言最终状态，
        // 不断言这一次扫到了几条。
        sweep(&service(&pool).await).await.unwrap();

        assert_eq!(
            testdb::attempt_status(&client, &id).await,
            "uncertain",
            "超时的 sending 应该被收成 uncertain"
        );
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_prepared_attempt_that_never_got_sent_becomes_retryable() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_013_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let id = testdb::insert_attempt(&client, &fixture, "prepared", 3600.0).await;

        sweep(&service(&pool).await).await.unwrap();

        assert_eq!(
            testdb::attempt_status(&client, &id).await,
            "retryable",
            "发送前就中断的流水应该能重试"
        );
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn an_attempt_still_inside_its_lease_is_left_alone() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_011_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let id = testdb::insert_attempt(&client, &fixture, "sending", 0.0).await;

        sweep(&service(&pool).await).await.unwrap();

        assert_eq!(
            testdb::attempt_status(&client, &id).await,
            "sending",
            "还在租约里的流水不该被动"
        );
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_sync_run_without_a_heartbeat_is_marked_failed() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_012_i64;
        testdb::seed(&client, user_id).await;
        let run_id: i64 = client
            .query_one(
                "INSERT INTO abei_ai.mail_sync_runs
                   (user_id, mailbox_user_id, kind, scope, status, stage, updated_at)
                 VALUES ($1, $1, 'incremental', '{}'::jsonb, 'running', 'fetching',
                         now() - interval '1 hour')
                 RETURNING id",
                &[&user_id],
            )
            .await
            .unwrap()
            .get(0);

        sweep(&service(&pool).await).await.unwrap();

        let status: String = client
            .query_one(
                "SELECT status FROM abei_ai.mail_sync_runs WHERE id = $1",
                &[&run_id],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(status, "failed", "失去心跳的同步应该被收成 failed");
        testdb::cleanup(&client, user_id).await;
    }
}
