use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::json;
use tokio::time::{Instant, interval_at};

use super::Service;
use crate::parser::engine::{self, ParseContext};
use crate::parser::model::{Node, ParserFlowDefinition};

const CLAIM_INTERVAL: Duration = Duration::from_secs(5);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const LEASE_SECONDS: i32 = 90;

pub(super) fn start(service: Service) {
    for slot in 0..service.worker_count() {
        let worker = service.clone();
        tokio::spawn(async move { worker_loop(worker, slot).await });
    }
}

async fn worker_loop(service: Service, slot: usize) {
    loop {
        match service.claim(slot).await {
            Ok(Some(job)) => service.run_claimed(job).await,
            Ok(None) => {
                tokio::select! {
                    () = service.notify.notified() => {}
                    () = tokio::time::sleep(CLAIM_INTERVAL) => {}
                }
            }
            Err(error) => {
                tracing::error!(slot, %error, "ParseJob 领取失败");
                tokio::time::sleep(CLAIM_INTERVAL).await;
            }
        }
    }
}

#[derive(Debug)]
pub(super) struct ClaimedJob {
    pub(super) id: i64,
    pub(super) user_id: i64,
    pub(super) document_id: i64,
    pub(super) mail_message_id: i64,
    pub(super) target_revision: i32,
    pub(super) flow_id: i64,
    pub(super) flow_version: i32,
    pub(super) worker_id: String,
}

impl Service {
    async fn claim(&self, slot: usize) -> Result<Option<ClaimedJob>, String> {
        let worker_id = format!("{}-{slot}", self.worker_id);
        let mut client = self.pool.get().await.map_err(display)?;
        let transaction = client.transaction().await.map_err(display)?;
        let row = transaction
            .query_opt(
                "SELECT j.id, j.user_id, j.bill_document_id, d.mail_message_id,
                        j.target_revision, j.parser_flow_id, j.parser_flow_version,
                        j.status = 'running' AS recovered
                 FROM abei_ai.parse_jobs j
                 JOIN abei_ai.bill_documents d ON d.id = j.bill_document_id
                 WHERE j.status = 'queued'
                    OR (j.status = 'running' AND j.lease_expires_at < now() AND j.attempt < 20)
                 ORDER BY j.priority, j.requested_at, j.id
                 FOR UPDATE OF j SKIP LOCKED LIMIT 1",
                &[],
            )
            .await
            .map_err(display)?;
        let Some(row) = row else {
            transaction.commit().await.map_err(display)?;
            return Ok(None);
        };
        let id: i64 = row.get(0);
        let recovered: bool = row.get(7);
        transaction
            .execute(
                "UPDATE abei_ai.parse_jobs SET status = 'running', stage = 'select_input',
                   worker_id = $2, lease_expires_at = now() + make_interval(secs => $3::integer),
                   heartbeat_at = now(), started_at = COALESCE(started_at, now()),
                   attempt = attempt + CASE WHEN $4 THEN 1 ELSE 0 END,
                   waiting_reason = NULL, waiting_prompt = NULL,
                   error_code = NULL, error_message = NULL,
                   progress = progress || $5::jsonb, updated_at = now()
                 WHERE id = $1",
                &[
                    &id,
                    &worker_id,
                    &LEASE_SECONDS,
                    &recovered,
                    &json!({
                        "stage": "select_input",
                        "worker_slot": slot,
                        "recovered": recovered,
                        "updated_at": time::OffsetDateTime::now_utc().to_string(),
                    }),
                ],
            )
            .await
            .map_err(display)?;
        transaction.commit().await.map_err(display)?;
        Ok(Some(ClaimedJob {
            id,
            user_id: row.get(1),
            document_id: row.get(2),
            mail_message_id: row.get(3),
            target_revision: row.get(4),
            flow_id: row.get(5),
            flow_version: row.get(6),
            worker_id,
        }))
    }

    async fn run_claimed(&self, job: ClaimedJob) {
        let result = self.execute_claimed(&job).await;
        if let Err(error) = result
            && let Err(store_error) = self.fail_job(&job, "parse_failed", &error).await
        {
            tracing::error!(job_id = job.id, %store_error, "ParseJob 失败状态保存失败");
        }
    }

    async fn execute_claimed(&self, job: &ClaimedJob) -> Result<(), String> {
        let (definition, checksum) = self
            .parser
            .published_definition(job.user_id, job.flow_id, job.flow_version)
            .await
            .map_err(display)?;
        let secrets = self.load_job_secrets(job).await?;
        if let Some(key) = missing_secret(&definition, &secrets) {
            self.wait_for_secret(job, &key).await?;
            return Ok(());
        }
        let raw = self
            .mail
            .raw_message(job.user_id, job.mail_message_id)
            .await
            .map_err(display)?;
        self.update_stage(job, "extract", json!({ "eml_bytes": raw.len() }))
            .await?;

        let context = ParseContext {
            timezone: "Asia/Shanghai".to_owned(),
            secrets,
        };
        let used_secret = !context.secrets.is_empty();
        let execution = engine::execute(&definition, &raw, &context);
        tokio::pin!(execution);
        let mut heartbeat = interval_at(Instant::now() + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL);
        let output = loop {
            tokio::select! {
                result = &mut execution => match result {
                    Ok(output) => break output,
                    Err(error) if used_secret && engine::is_secret_rejected(&error) => {
                        self.reject_secret(job).await?;
                        return Ok(());
                    }
                    Err(error) => return Err(error),
                },
                _ = heartbeat.tick() => {
                    if !self.heartbeat(job).await? {
                        tracing::info!(job_id = job.id, "ParseJob 已取消或租约被回收，停止执行");
                        return Ok(());
                    }
                }
            }
        };
        self.persist_output(job, &checksum, &raw, &output).await?;
        Ok(())
    }

    async fn heartbeat(&self, job: &ClaimedJob) -> Result<bool, String> {
        let updated = self
            .pool
            .get()
            .await
            .map_err(display)?
            .execute(
                "UPDATE abei_ai.parse_jobs SET heartbeat_at = now(),
                   lease_expires_at = now() + make_interval(secs => $3::integer), updated_at = now()
                 WHERE id = $1 AND worker_id = $2 AND status = 'running'",
                &[&job.id, &job.worker_id, &LEASE_SECONDS],
            )
            .await
            .map_err(display)?;
        Ok(updated == 1)
    }

    async fn update_stage(
        &self,
        job: &ClaimedJob,
        stage: &str,
        details: serde_json::Value,
    ) -> Result<(), String> {
        let progress = json!({
            "stage": stage,
            "details": details,
            "updated_at": time::OffsetDateTime::now_utc().to_string(),
        });
        let updated = self
            .pool
            .get()
            .await
            .map_err(display)?
            .execute(
                "UPDATE abei_ai.parse_jobs SET stage = $3, progress = progress || $4,
                   updated_at = now() WHERE id = $1 AND worker_id = $2 AND status = 'running'",
                &[&job.id, &job.worker_id, &stage, &progress],
            )
            .await
            .map_err(display)?;
        if updated == 1 {
            Ok(())
        } else {
            Err("ParseJob 已取消或不再由当前 worker 持有。".to_owned())
        }
    }

    async fn wait_for_secret(&self, job: &ClaimedJob, key: &str) -> Result<(), String> {
        self.pool
            .get()
            .await
            .map_err(display)?
            .execute(
                "UPDATE abei_ai.parse_jobs SET status = 'waiting_input', stage = 'unlock',
                   waiting_reason = 'secret_required', waiting_prompt = $3,
                   worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                   progress = progress || $4, updated_at = now()
                 WHERE id = $1 AND worker_id = $2 AND status = 'running'",
                &[
                    &job.id,
                    &job.worker_id,
                    &format!("请输入解析此账单所需的密码（{key}）。"),
                    &json!({ "stage": "unlock", "secret_key": key }),
                ],
            )
            .await
            .map_err(display)?;
        Ok(())
    }

    async fn fail_job(&self, job: &ClaimedJob, code: &str, error: &str) -> Result<(), String> {
        self.pool
            .get()
            .await
            .map_err(display)?
            .execute(
                "UPDATE abei_ai.parse_jobs SET status = 'failed', stage = 'finished',
                   error_code = $3, error_message = $4, worker_id = NULL,
                   lease_expires_at = NULL, heartbeat_at = NULL,
                   finished_at = now(), updated_at = now()
                 WHERE id = $1 AND worker_id = $2 AND status = 'running'",
                &[&job.id, &job.worker_id, &code, &truncate(error, 2_000)],
            )
            .await
            .map_err(display)?;
        Ok(())
    }

    async fn reject_secret(&self, job: &ClaimedJob) -> Result<(), String> {
        let mut client = self.pool.get().await.map_err(display)?;
        let transaction = client.transaction().await.map_err(display)?;
        let attempts = transaction
            .query_opt(
                "SELECT attempts FROM abei_ai.parse_job_secrets
                 WHERE parse_job_id = $1 FOR UPDATE",
                &[&job.id],
            )
            .await
            .map_err(display)?
            .map(|row| row.get::<_, i32>(0))
            .unwrap_or(1);
        if attempts >= 5 {
            transaction
                .execute(
                    "UPDATE abei_ai.parse_jobs SET status = 'failed', stage = 'finished',
                       waiting_reason = NULL, waiting_prompt = NULL,
                       error_code = 'secret_attempts_exhausted',
                       error_message = '密码尝试次数已达上限，请重新发起解析。',
                       worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                       finished_at = now(), updated_at = now()
                     WHERE id = $1 AND worker_id = $2 AND status = 'running'",
                    &[&job.id, &job.worker_id],
                )
                .await
                .map_err(display)?;
            transaction
                .execute(
                    "DELETE FROM abei_ai.parse_job_secrets WHERE parse_job_id = $1",
                    &[&job.id],
                )
                .await
                .map_err(display)?;
        } else {
            transaction
                .execute(
                    "UPDATE abei_ai.parse_jobs SET status = 'waiting_input', stage = 'unlock',
                       waiting_reason = 'secret_rejected',
                       waiting_prompt = '密码不正确，请重新输入。',
                       error_code = NULL, error_message = NULL,
                       worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                       progress = progress || $3, updated_at = now()
                     WHERE id = $1 AND worker_id = $2 AND status = 'running'",
                    &[
                        &job.id,
                        &job.worker_id,
                        &json!({ "stage": "unlock", "secret_rejected": true, "attempts": attempts }),
                    ],
                )
                .await
                .map_err(display)?;
        }
        transaction.commit().await.map_err(display)?;
        Ok(())
    }

    async fn load_job_secrets(&self, job: &ClaimedJob) -> Result<BTreeMap<String, String>, String> {
        let client = self.pool.get().await.map_err(display)?;
        client
            .execute(
                "DELETE FROM abei_ai.parse_job_secrets
                 WHERE parse_job_id = $1 AND expires_at <= now()",
                &[&job.id],
            )
            .await
            .map_err(display)?;
        let row = client
            .query_opt(
                "SELECT ciphertext FROM abei_ai.parse_job_secrets
                 WHERE parse_job_id = $1 AND expires_at > now()",
                &[&job.id],
            )
            .await
            .map_err(display)?;
        let Some(row) = row else {
            return Ok(BTreeMap::new());
        };
        let encoded: String = row.get(0);
        let plaintext = self.secret_cipher.decrypt(job.user_id, &encoded)?;
        let prefix = format!("{}\0", job.id);
        let secret = plaintext
            .strip_prefix(&prefix)
            .ok_or_else(|| "ParseJob 密码绑定信息不正确。".to_owned())?;
        Ok(required_secret_keys_for(&self.parser, job, secret))
    }
}

fn required_secret_keys_for(
    _parser: &crate::parser::Service,
    _job: &ClaimedJob,
    secret: &str,
) -> BTreeMap<String, String> {
    // 同一份账单通常只有一个密码；把它提供给所有受控 secret key，流程仍决定是否使用。
    [
        "alipay_zip_password",
        "wechat_zip_password",
        "cmb_zip_password",
        "pdf_password",
    ]
    .into_iter()
    .map(|key| (key.to_owned(), secret.to_owned()))
    .collect()
}

fn missing_secret(
    definition: &ParserFlowDefinition,
    secrets: &BTreeMap<String, String>,
) -> Option<String> {
    definition
        .nodes
        .iter()
        .find_map(|node| match &node.operation {
            Node::Unzip {
                password_key: Some(key),
            }
            | Node::PdfToText {
                password_key: Some(key),
            } if !secrets.contains_key(key) => Some(key.clone()),
            _ => None,
        })
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}
