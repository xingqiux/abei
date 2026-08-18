//! 「这批邮件到底怎么样了」——把收信、解析、产出三段拼成一份账。
//!
//! 收件箱本来只答得出「现在还剩多少行要处理」，答不出「这一批里有几封没解析出来、
//! 为什么」。于是解析失败对用户是黑的：他只会发现某个月的账没出来，然后回邮件工作台
//! 一封封翻——而「不用一条条看」正是这条产品线要给的东西。
//!
//! 这里不建表，全部从 `mail_sync_runs` / `parse_jobs` / `bill_documents` / `bill_rows`
//! 现场聚合。失败明细带上 parse job id，前端据此直接调重试。

use serde_json::{Value, json};

use super::Service;
use super::rows::{row_from, row_group_predicate};
use crate::ApiError;
use crate::states::{ParseJobStatus, SyncRunStatus, sql_list};

/// 默认回看多少天。一次月账单周期够用，又不至于让 parse_jobs 扫全表。
pub(crate) const DEFAULT_WINDOW_DAYS: i32 = 7;
const MIN_WINDOW_DAYS: i32 = 1;
const MAX_WINDOW_DAYS: i32 = 90;

/// 失败明细一次最多带回多少条。再多用户也不会一条条看，那是工作台的活。
const FAILURE_SAMPLE_LIMIT: i64 = 20;

pub(crate) fn validate_window(days: Option<i32>) -> Result<i32, ApiError> {
    let days = days.unwrap_or(DEFAULT_WINDOW_DAYS);
    if !(MIN_WINDOW_DAYS..=MAX_WINDOW_DAYS).contains(&days) {
        return Err(ApiError::invalid_params(format!(
            "days 要在 {MIN_WINDOW_DAYS} 到 {MAX_WINDOW_DAYS} 之间。"
        )));
    }
    Ok(days)
}

impl Service {
    /// 一个用户在最近 `days` 天里的处理结果。
    pub(crate) async fn processing_summary(
        &self,
        user_id: i64,
        days: i32,
    ) -> Result<Value, ApiError> {
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let window = f64::from(days) * 86_400.0;

        let mail = client
            .query_one(
                &format!(
                    "SELECT count(*)::bigint,
                            coalesce(sum(scanned), 0)::bigint,
                            coalesce(sum(fetched), 0)::bigint,
                            coalesce(sum(matched), 0)::bigint,
                            coalesce(sum(unclassified), 0)::bigint,
                            count(*) FILTER (WHERE status = $3)::bigint,
                            count(*) FILTER (WHERE status IN ({}))::bigint
                     FROM abei_ai.mail_sync_runs
                     WHERE user_id = $1
                       AND requested_at >= now() - make_interval(secs => $2)",
                    sql_list(SyncRunStatus::IN_FLIGHT)
                ),
                &[&user_id, &window, &SyncRunStatus::Failed.as_str()],
            )
            .await
            .map_err(ApiError::database)?;

        let last_run = client
            .query_opt(
                "SELECT id, status, stage, error_summary,
                        requested_at::text, finished_at::text
                 FROM abei_ai.mail_sync_runs
                 WHERE user_id = $1
                 ORDER BY requested_at DESC, id DESC
                 LIMIT 1",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;

        let parse = client
            .query_one(
                &format!(
                    "SELECT count(*)::bigint,
                            count(*) FILTER (WHERE status = $3)::bigint,
                            count(*) FILTER (WHERE status = $4)::bigint,
                            count(*) FILTER (WHERE status = $5)::bigint,
                            count(*) FILTER (WHERE status IN ({}))::bigint
                     FROM abei_ai.parse_jobs
                     WHERE user_id = $1
                       AND requested_at >= now() - make_interval(secs => $2)",
                    sql_list(&[ParseJobStatus::Queued, ParseJobStatus::Running])
                ),
                &[
                    &user_id,
                    &window,
                    &ParseJobStatus::Succeeded.as_str(),
                    &ParseJobStatus::Failed.as_str(),
                    &ParseJobStatus::WaitingInput.as_str(),
                ],
            )
            .await
            .map_err(ApiError::database)?;

        // 失败和等补码都要人动手，一起带明细：前者给重试，后者给补密码。
        let stuck = client
            .query(
                &format!(
                    "SELECT j.id, j.bill_document_id, j.status, j.error_code, j.error_message,
                            j.waiting_reason, j.updated_at::text,
                            d.channel_key, d.summary
                     FROM abei_ai.parse_jobs j
                     JOIN abei_ai.bill_documents d ON d.id = j.bill_document_id
                     WHERE j.user_id = $1
                       AND j.requested_at >= now() - make_interval(secs => $2)
                       AND j.status IN ({})
                     ORDER BY j.updated_at DESC, j.id DESC
                     LIMIT {FAILURE_SAMPLE_LIMIT}",
                    sql_list(&[ParseJobStatus::Failed, ParseJobStatus::WaitingInput])
                ),
                &[&user_id, &window],
            )
            .await
            .map_err(ApiError::database)?;

        // 产出的行按窗口算「这批产出了多少」，待办数不设窗口——用户要的是现在还剩几条。
        let produced: i64 = client
            .query_one(
                "SELECT count(*)::bigint FROM abei_ai.bill_rows r
                 JOIN abei_ai.bill_documents d ON d.id = r.bill_document_id
                 WHERE r.user_id = $1 AND d.active_revision = r.revision
                   AND d.lifecycle = 'active'
                   AND r.created_at >= now() - make_interval(secs => $2)",
                &[&user_id, &window],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);

        let pending = client
            .query_one(
                &format!(
                    "SELECT count(*) FILTER (WHERE {predicate} = 'importable')::bigint,
                            count(*) FILTER (WHERE {predicate} = 'attention')::bigint
                     {from} WHERE r.user_id = $1 AND d.active_revision = r.revision
                       AND d.lifecycle = 'active'",
                    predicate = row_group_predicate(),
                    from = row_from()
                ),
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;

        Ok(json!({
            "window_days": days,
            "mail": {
                "runs": mail.get::<_, i64>(0),
                "scanned": mail.get::<_, i64>(1),
                "fetched": mail.get::<_, i64>(2),
                "matched": mail.get::<_, i64>(3),
                "unclassified": mail.get::<_, i64>(4),
                "failed_runs": mail.get::<_, i64>(5),
                "running_runs": mail.get::<_, i64>(6),
                "last_run": last_run.map(|row| json!({
                    "id": row.get::<_, i64>(0).to_string(),
                    "status": row.get::<_, String>(1),
                    "stage": row.get::<_, String>(2),
                    "error_summary": row.get::<_, Option<String>>(3),
                    "requested_at": row.get::<_, String>(4),
                    "finished_at": row.get::<_, Option<String>>(5),
                })),
            },
            "parse": {
                "total": parse.get::<_, i64>(0),
                "succeeded": parse.get::<_, i64>(1),
                "failed": parse.get::<_, i64>(2),
                "waiting_input": parse.get::<_, i64>(3),
                "running": parse.get::<_, i64>(4),
                "stuck": stuck.iter().map(|row| json!({
                    "job_id": row.get::<_, i64>(0).to_string(),
                    "document_id": row.get::<_, i64>(1).to_string(),
                    "status": row.get::<_, String>(2),
                    "error_code": row.get::<_, Option<String>>(3),
                    "error_message": row.get::<_, Option<String>>(4),
                    "waiting_reason": row.get::<_, Option<String>>(5),
                    "updated_at": row.get::<_, String>(6),
                    "channel_key": row.get::<_, String>(7),
                    "summary": row.get::<_, Option<String>>(8),
                })).collect::<Vec<_>>(),
            },
            "rows": {
                "produced": produced,
                "importable": pending.get::<_, i64>(0),
                "attention": pending.get::<_, i64>(1),
            },
        }))
    }

    /// 同一份账的管理视角：按用户和邮箱铺开，谁卡住了一眼看得见。
    pub(crate) async fn admin_processing_summary(&self, days: i32) -> Result<Value, ApiError> {
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let window = f64::from(days) * 86_400.0;

        let rows = client
            .query(
                "SELECT m.user_id,
                            u.email AS user_email,
                            m.email AS mailbox_email,
                            m.enabled,
                            coalesce(s.runs, 0)::bigint,
                            coalesce(s.failed_runs, 0)::bigint,
                            coalesce(s.matched, 0)::bigint,
                            coalesce(p.total, 0)::bigint,
                            coalesce(p.failed, 0)::bigint,
                            coalesce(p.waiting_input, 0)::bigint,
                            s.last_requested_at::text,
                            s.last_status
                     FROM abei_ai.mailboxes m
                     JOIN public.users u ON u.id = m.user_id
                     LEFT JOIN LATERAL (
                       SELECT count(*) AS runs,
                              count(*) FILTER (WHERE status = $2) AS failed_runs,
                              coalesce(sum(matched), 0) AS matched,
                              max(requested_at) AS last_requested_at,
                              (array_agg(status ORDER BY requested_at DESC, id DESC))[1] AS last_status
                       FROM abei_ai.mail_sync_runs
                       WHERE user_id = m.user_id
                         AND requested_at >= now() - make_interval(secs => $1)
                     ) s ON true
                     LEFT JOIN LATERAL (
                       SELECT count(*) AS total,
                              count(*) FILTER (WHERE status = $3) AS failed,
                              count(*) FILTER (WHERE status = $4) AS waiting_input
                       FROM abei_ai.parse_jobs
                       WHERE user_id = m.user_id
                         AND requested_at >= now() - make_interval(secs => $1)
                     ) p ON true
                     ORDER BY coalesce(p.failed, 0) DESC, m.user_id
                     LIMIT 200",
                &[
                    &window,
                    &SyncRunStatus::Failed.as_str(),
                    &ParseJobStatus::Failed.as_str(),
                    &ParseJobStatus::WaitingInput.as_str(),
                ],
            )
            .await
            .map_err(ApiError::database)?;

        Ok(json!({
            "window_days": days,
            "mailboxes": rows.iter().map(|row| json!({
                "user_id": row.get::<_, i64>(0).to_string(),
                "user_email": row.get::<_, Option<String>>(1),
                "mailbox_email": row.get::<_, Option<String>>(2),
                "enabled": row.get::<_, bool>(3),
                "runs": row.get::<_, i64>(4),
                "failed_runs": row.get::<_, i64>(5),
                "matched": row.get::<_, i64>(6),
                "parse_total": row.get::<_, i64>(7),
                "parse_failed": row.get::<_, i64>(8),
                "parse_waiting_input": row.get::<_, i64>(9),
                "last_requested_at": row.get::<_, Option<String>>(10),
                "last_status": row.get::<_, Option<String>>(11),
            })).collect::<Vec<_>>(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_defaults_to_a_week_and_refuses_silly_values() {
        assert_eq!(validate_window(None).unwrap(), DEFAULT_WINDOW_DAYS);
        assert_eq!(validate_window(Some(1)).unwrap(), 1);
        assert_eq!(validate_window(Some(90)).unwrap(), 90);
        assert!(validate_window(Some(0)).is_err());
        assert!(validate_window(Some(-7)).is_err());
        assert!(validate_window(Some(365)).is_err());
    }
}
