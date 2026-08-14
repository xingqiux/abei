use std::collections::BTreeMap;
use std::path::PathBuf;
use std::str::FromStr;

use rust_decimal::Decimal;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_postgres::Row;

use super::Service;
use super::mappings::hints_match;
use super::worker::ClaimedJob;
use crate::ApiError;
use crate::parser::model::{
    Artifact, ArtifactKind, BillRowDraft, Diagnostic, ParseOutput, Severity,
};
use crate::states::{ParseJobStatus, sql_list};

const FINGERPRINT_VERSION: i16 = 1;

impl Service {
    pub(crate) async fn enqueue_message(
        &self,
        user_id: i64,
        mail_message_id: i64,
    ) -> Result<Option<(i64, i64)>, String> {
        let mut client = self.pool.get().await.map_err(display)?;
        let transaction = client.transaction().await.map_err(display)?;
        transaction
            .query_one(
                "SELECT pg_advisory_xact_lock(
                    hashtextextended($1::bigint::text || ':' || $2::bigint::text, 0)
                 )",
                &[&user_id, &mail_message_id],
            )
            .await
            .map_err(display)?;
        if transaction
            .query_opt(
                "SELECT id FROM abei_ai.bill_documents
                 WHERE user_id = $1 AND mail_message_id = $2",
                &[&user_id, &mail_message_id],
            )
            .await
            .map_err(display)?
            .is_some()
        {
            transaction.commit().await.map_err(display)?;
            return Ok(None);
        }
        let routed = transaction
            .query_opt(
                "SELECT m.matched_rule_id, m.matched_rule_version, m.channel_key,
                        m.parser_flow_id, m.subject, m.received_at::text,
                        f.current_version, v.checksum
                 FROM abei_ai.mail_messages m
                 JOIN abei_ai.parser_flows f ON f.id = m.parser_flow_id
                 JOIN abei_ai.parser_flow_versions v
                   ON v.flow_id = f.id AND v.version = f.current_version
                 WHERE m.user_id = $1 AND m.id = $2 AND m.classification = 'matched'
                   AND m.content_state = 'cached' AND m.parser_flow_id IS NOT NULL
                   AND f.status = 'published'
                   AND (f.owner_user_id = $1 OR f.owner_user_id IS NULL)",
                &[&user_id, &mail_message_id],
            )
            .await
            .map_err(display)?;
        let Some(row) = routed else {
            transaction.commit().await.map_err(display)?;
            return Ok(None);
        };
        let flow_id: i64 = row.get(3);
        let flow_version: i32 = row.get(6);
        let document_id: i64 = transaction
            .query_one(
                "INSERT INTO abei_ai.bill_documents
                 (user_id, mail_message_id, mail_rule_id, mail_rule_version, channel_key,
                    parser_flow_id, parser_flow_version, summary, received_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text::timestamptz) RETURNING id",
                &[
                    &user_id,
                    &mail_message_id,
                    &row.get::<_, Option<i64>>(0),
                    &row.get::<_, Option<i32>>(1),
                    &row.get::<_, String>(2),
                    &flow_id,
                    &flow_version,
                    &row.get::<_, Option<String>>(4),
                    &row.get::<_, Option<String>>(5),
                ],
            )
            .await
            .map_err(display)?
            .get(0);
        let job_id: i64 = transaction
            .query_one(
                "INSERT INTO abei_ai.parse_jobs
                   (user_id, bill_document_id, target_revision, parser_flow_id,
                    parser_flow_version, definition_checksum, status, stage, progress)
                 VALUES ($1,$2,1,$3,$4,$5,$7,'route',$6) RETURNING id",
                &[
                    &user_id,
                    &document_id,
                    &flow_id,
                    &flow_version,
                    &row.get::<_, String>(7),
                    &json!({ "stage": "route", "mail_message_id": mail_message_id.to_string() }),
                    &ParseJobStatus::Queued.as_str(),
                ],
            )
            .await
            .map_err(display)?
            .get(0);
        transaction
            .execute(
                "UPDATE abei_ai.mail_messages SET raw_expires_at = NULL, updated_at = now()
                 WHERE user_id = $1 AND id = $2",
                &[&user_id, &mail_message_id],
            )
            .await
            .map_err(display)?;
        transaction.commit().await.map_err(display)?;
        self.notify.notify_one();
        Ok(Some((document_id, job_id)))
    }

    pub(super) async fn persist_output(
        &self,
        job: &ClaimedJob,
        definition_checksum: &str,
        raw_eml: &[u8],
        output: &ParseOutput,
    ) -> Result<(), String> {
        let mut totals = BTreeMap::<String, Decimal>::new();
        for row in &output.valid_rows {
            let amount = Decimal::from_str(&row.signed_amount)
                .map_err(|_| format!("金额无法持久化：{}", row.signed_amount))?;
            *totals
                .entry(row.currency_code.to_ascii_uppercase())
                .or_default() += amount;
        }
        let total_json = totals
            .iter()
            .map(|(currency, amount)| (currency.clone(), Value::String(amount.to_string())))
            .collect::<serde_json::Map<_, _>>();
        let statement_metadata = serde_json::to_value(&output.document).map_err(display)?;
        let invalid_rows = serde_json::to_value(&output.invalid_rows).map_err(display)?;
        let warnings = serde_json::to_value(&output.warnings).map_err(display)?;
        let metrics = serde_json::to_value(&output.metrics).map_err(display)?;
        let node_results = serde_json::to_value(&output.node_results).map_err(display)?;
        let raw_checksum = sha256(raw_eml);
        let mut stored_artifacts = Vec::with_capacity(output.artifacts.len());
        for artifact in &output.artifacts {
            let path = artifact_path(job, artifact);
            self.mail.write_generated(&path, &artifact.bytes).await?;
            stored_artifacts.push((artifact, path.to_string_lossy().into_owned()));
        }

        let mut client = self.pool.get().await.map_err(display)?;
        let transaction = client.transaction().await.map_err(display)?;
        let owns = transaction
            .query_opt(
                "SELECT 1 FROM abei_ai.parse_jobs
                 WHERE id = $1 AND worker_id = $2 AND status = $3 FOR UPDATE",
                &[&job.id, &job.worker_id, &ParseJobStatus::Running.as_str()],
            )
            .await
            .map_err(display)?
            .is_some();
        if !owns {
            return Err("ParseJob 已取消或租约所有者已变化。".to_owned());
        }
        transaction
            .execute(
                "INSERT INTO abei_ai.bill_document_revisions
                   (bill_document_id, revision, parse_job_id, parser_flow_id,
                    parser_flow_version, statement_metadata, valid_row_count,
                    invalid_row_count, amount_totals, invalid_rows, warnings, metrics, node_results)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
                &[
                    &job.document_id,
                    &job.target_revision,
                    &job.id,
                    &job.flow_id,
                    &job.flow_version,
                    &statement_metadata,
                    &(output.valid_rows.len() as i32),
                    &(output.invalid_rows.len() as i32),
                    &Value::Object(total_json),
                    &invalid_rows,
                    &warnings,
                    &metrics,
                    &node_results,
                ],
            )
            .await
            .map_err(display)?;
        let mail = transaction
            .query_one(
                "SELECT raw_path, subject FROM abei_ai.mail_messages
                 WHERE user_id = $1 AND id = $2",
                &[&job.user_id, &job.mail_message_id],
            )
            .await
            .map_err(display)?;
        transaction
            .execute(
                "INSERT INTO abei_ai.bill_artifacts
                   (user_id, bill_document_id, revision, kind, filename, path, checksum, size,
                    mime_type, generation_stage, metadata)
                 VALUES ($1,$2,$3,'eml','message.eml',$4,$5,$6,'message/rfc822','received',$7)
                 ON CONFLICT (bill_document_id, revision, checksum, filename) DO UPDATE SET
                   path = EXCLUDED.path, mime_type = EXCLUDED.mime_type,
                   generation_stage = EXCLUDED.generation_stage, metadata = EXCLUDED.metadata",
                &[
                    &job.user_id,
                    &job.document_id,
                    &job.target_revision,
                    &mail.get::<_, Option<String>>(0),
                    &raw_checksum,
                    &(raw_eml.len() as i64),
                    &json!({ "definition_checksum": definition_checksum }),
                ],
            )
            .await
            .map_err(display)?;

        let mut artifact_ids = BTreeMap::<String, i64>::new();
        for (artifact, path) in &stored_artifacts {
            let metadata = json!({
                "parser_artifact_id": artifact.reference.id,
                "parser_parent_id": artifact.reference.parent_id,
                "source": artifact.reference.source,
            });
            let id = transaction
                .query_one(
                    "INSERT INTO abei_ai.bill_artifacts
                       (user_id, bill_document_id, revision, kind, filename, path, checksum, size,
                        mime_type, generation_stage, metadata)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                     ON CONFLICT (bill_document_id, revision, checksum, filename) DO UPDATE SET
                       kind = EXCLUDED.kind, path = EXCLUDED.path,
                       mime_type = EXCLUDED.mime_type,
                       generation_stage = EXCLUDED.generation_stage,
                       metadata = EXCLUDED.metadata
                     RETURNING id",
                    &[
                        &job.user_id,
                        &job.document_id,
                        &job.target_revision,
                        &artifact_kind(artifact.reference.kind),
                        &artifact.reference.filename,
                        path,
                        &artifact.reference.sha256,
                        &(artifact.reference.size as i64),
                        &artifact.reference.mime,
                        &artifact_stage(artifact.reference.kind),
                        &metadata,
                    ],
                )
                .await
                .map_err(display)?
                .get(0);
            artifact_ids.insert(artifact.reference.id.clone(), id);
        }
        for (artifact, _) in &stored_artifacts {
            let Some(parent_parser_id) = artifact.reference.parent_id.as_ref() else {
                continue;
            };
            let (Some(parent_id), Some(id)) = (
                artifact_ids.get(parent_parser_id),
                artifact_ids.get(&artifact.reference.id),
            ) else {
                continue;
            };
            transaction
                .execute(
                    "UPDATE abei_ai.bill_artifacts SET parent_artifact_id = $1 WHERE id = $2",
                    &[parent_id, id],
                )
                .await
                .map_err(display)?;
        }

        for (index, draft) in output.valid_rows.iter().enumerate() {
            self.insert_row(
                &transaction,
                job,
                index + 1,
                draft,
                &output.document.channel_key,
            )
            .await?;
        }
        self.analyze_revision(&transaction, job).await?;
        let period_start = valid_date(output.document.period_start.as_deref());
        let period_end = valid_date(output.document.period_end.as_deref());
        let account_hint = output
            .document
            .account_hint
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty());
        transaction
            .execute(
                "UPDATE abei_ai.bill_documents SET active_revision = $3,
                   channel_key = COALESCE(NULLIF($4, ''), channel_key),
                   account_hint = COALESCE($5, account_hint), period_start = $6::text::date,
                   period_end = $7::text::date, summary = COALESCE(summary, $8), updated_at = now()
                 WHERE user_id = $1 AND id = $2",
                &[
                    &job.user_id,
                    &job.document_id,
                    &job.target_revision,
                    &output.document.channel_key,
                    &account_hint,
                    &period_start,
                    &period_end,
                    &mail.get::<_, Option<String>>(1),
                ],
            )
            .await
            .map_err(display)?;
        let progress = json!({
            "stage": "persist",
            "records_seen": output.metrics.records,
            "rows_valid": output.metrics.valid_rows,
            "rows_invalid": output.metrics.invalid_rows,
            "duration_ms": output.metrics.duration_ms,
            "updated_at": time::OffsetDateTime::now_utc().to_string(),
        });
        transaction
            .execute(
                "UPDATE abei_ai.parse_jobs SET status = $4, stage = 'finished',
                   progress = progress || $3, worker_id = NULL, lease_expires_at = NULL,
                   heartbeat_at = NULL, finished_at = now(), updated_at = now()
                 WHERE id = $1 AND worker_id = $2 AND status = $5",
                &[
                    &job.id,
                    &job.worker_id,
                    &progress,
                    &ParseJobStatus::Succeeded.as_str(),
                    &ParseJobStatus::Running.as_str(),
                ],
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
        transaction.commit().await.map_err(display)?;
        tracing::info!(
            job_id = job.id,
            document_id = job.document_id,
            revision = job.target_revision,
            rows = output.valid_rows.len(),
            "账单解析完成"
        );
        Ok(())
    }

    async fn insert_row(
        &self,
        transaction: &tokio_postgres::Transaction<'_>,
        job: &ClaimedJob,
        row_number: usize,
        draft: &BillRowDraft,
        channel_key: &str,
    ) -> Result<(), String> {
        let signed = Decimal::from_str(&draft.signed_amount)
            .map_err(|_| format!("第 {row_number} 行金额无效：{}", draft.signed_amount))?;
        let foreign = decimal_option(draft.foreign_amount.as_deref(), "外币金额", row_number)?;
        let balance = decimal_option(draft.balance_after.as_deref(), "余额", row_number)?;
        let currency = normalize_currency(&draft.currency_code)?;
        let account_hint = draft
            .account_hint
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty());
        let provider_id = draft
            .provider_transaction_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let fingerprint = fingerprint(job.user_id, channel_key, account_hint, draft, signed);
        let external_key = provider_id
            .map(|id| format!("provider:{channel_key}:{}:{id}", account_hint.unwrap_or("")))
            .unwrap_or_else(|| format!("fingerprint:v{FINGERPRINT_VERSION}:{fingerprint}"));
        let duplicates = transaction
            .query(
                "SELECT r.id FROM abei_ai.bill_rows r
                 JOIN abei_ai.bill_documents d ON d.id = r.bill_document_id
                 WHERE r.user_id = $1 AND r.bill_document_id <> $2
                   AND d.lifecycle = 'active' AND d.active_revision = r.revision
                   AND (r.external_key = $3 OR r.fingerprint = $4)
                 ORDER BY r.id LIMIT 2",
                &[&job.user_id, &job.document_id, &external_key, &fingerprint],
            )
            .await
            .map_err(display)?;
        let (duplicate_state, duplicate_of) = match duplicates.as_slice() {
            [] => ("unique", None),
            [row] => ("duplicate", Some(row.get::<_, i64>(0))),
            [row, ..] => ("conflict", Some(row.get::<_, i64>(0))),
        };
        let mappings = match account_hint {
            Some(hint) => transaction
                .query(
                    "SELECT account_hint, firefly_account_id, firefly_account_name
                     FROM abei_ai.bill_account_mappings
                     WHERE user_id = $1 AND channel_key = $2
                     ORDER BY id",
                    &[&job.user_id, &channel_key],
                )
                .await
                .map_err(display)?
                .into_iter()
                .filter(|mapping| hints_match(hint, &mapping.get::<_, String>(0)))
                .collect(),
            None => Vec::new(),
        };
        let mut mapping_accounts = mappings
            .iter()
            .map(|row| (row.get::<_, i64>(1), row.get::<_, String>(2)))
            .collect::<Vec<_>>();
        mapping_accounts.sort_by_key(|(id, _)| *id);
        mapping_accounts.dedup_by_key(|(id, _)| *id);
        let mapping = (mapping_accounts.len() == 1).then(|| mapping_accounts[0].clone());
        let mut issues = draft.issues.clone();
        issues.extend(draft.warnings.clone());
        if mapping_accounts.is_empty() {
            issues.push(Diagnostic {
                severity: Severity::Warning,
                code: "account_mapping_required".to_owned(),
                message: "入账前需要选择 Firefly 账户。".to_owned(),
                node_id: None,
                locator: Some(draft.source_locator.clone()),
            });
        } else if mapping_accounts.len() > 1 {
            issues.push(Diagnostic {
                severity: Severity::Warning,
                code: "account_mapping_ambiguous".to_owned(),
                message: "账户提示命中了多个不同的 Firefly 账户，请先明确选择。".to_owned(),
                node_id: None,
                locator: Some(draft.source_locator.clone()),
            });
        }
        if duplicate_state != "unique" {
            issues.push(Diagnostic {
                severity: Severity::Warning,
                code: format!("duplicate_{duplicate_state}"),
                message: if duplicate_state == "duplicate" {
                    "发现另一来源中的相同流水，请确认后再入账。".to_owned()
                } else {
                    "发现多个可能重复的流水，需要人工确认。".to_owned()
                },
                node_id: None,
                locator: Some(draft.source_locator.clone()),
            });
        }
        let firefly_type = if signed.is_sign_negative() {
            "withdrawal"
        } else {
            "deposit"
        };
        let account_id = mapping.as_ref().map(|row| row.0);
        let account_name = mapping.as_ref().map(|row| row.1.clone());
        let (source_account_id, source_name, destination_account_id, destination_name) =
            if signed.is_sign_negative() {
                (account_id, account_name, None, draft.counterparty.clone())
            } else {
                (None, draft.counterparty.clone(), account_id, account_name)
            };
        let firefly_date = valid_date(Some(&draft.occurred_at));
        transaction
            .execute(
                "INSERT INTO abei_ai.bill_rows
                   (user_id, bill_document_id, revision, row_number, source_locator, raw_fields,
                    occurred_at, posted_at, signed_amount, currency_code, foreign_amount,
                    foreign_currency_code, balance_after, counterparty, counterparty_account,
                    description, account_hint, payment_method, provider_transaction_id,
                    merchant_order_id, provider_category, provider_status, remark, external_key,
                    fingerprint, fingerprint_version, duplicate_of_row_id, duplicate_state,
                    issues, firefly_type, firefly_date, firefly_amount, firefly_description,
                    source_account_id, source_name, destination_account_id, destination_name)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text::numeric,$10,$11::text::numeric,$12,
                    $13::text::numeric,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,
                    $28,$29,$30,$31::text::date,$32::text::numeric,$33,$34,$35,$36,$37)",
                &[
                    &job.user_id,
                    &job.document_id,
                    &job.target_revision,
                    &(row_number as i32),
                    &serde_json::to_value(&draft.source_locator).map_err(display)?,
                    &serde_json::to_value(&draft.raw_fields).map_err(display)?,
                    &draft.occurred_at,
                    &draft.posted_at,
                    &signed.to_string(),
                    &currency,
                    &foreign.as_ref().map(ToString::to_string),
                    &draft
                        .foreign_currency_code
                        .as_deref()
                        .map(normalize_currency)
                        .transpose()?,
                    &balance.as_ref().map(ToString::to_string),
                    &draft.counterparty,
                    &draft.counterparty_account,
                    &draft.description,
                    &account_hint,
                    &draft.payment_method,
                    &draft.provider_transaction_id,
                    &draft.merchant_order_id,
                    &draft.provider_category,
                    &draft.provider_status,
                    &draft.remark,
                    &external_key,
                    &fingerprint,
                    &FINGERPRINT_VERSION,
                    &duplicate_of,
                    &duplicate_state,
                    &serde_json::to_value(&issues).map_err(display)?,
                    &firefly_type,
                    &firefly_date,
                    &signed.abs().to_string(),
                    &draft.description,
                    &source_account_id,
                    &source_name,
                    &destination_account_id,
                    &destination_name,
                ],
            )
            .await
            .map_err(display)?;
        Ok(())
    }

    pub(crate) async fn list_documents(
        &self,
        user_id: i64,
        source: Option<&str>,
        status: Option<&str>,
        page: u32,
        limit: u32,
    ) -> Result<Value, ApiError> {
        if page == 0 || !(1..=200).contains(&limit) {
            return Err(ApiError::invalid_params(
                "page 必须大于 0，limit 必须在 1 到 200 之间。",
            ));
        }
        let source = source.unwrap_or("").trim();
        let status = status.unwrap_or("").trim();
        let offset = i64::from(page.saturating_sub(1) * limit);
        let limit_i64 = i64::from(limit);
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let count: i64 = client
            .query_one(
                // CASE 左边是 parse_jobs 的状态，右边是对外的文档状态，两套词表不通用。
                &format!(
                    "SELECT count(*)::bigint FROM abei_ai.bill_documents d
                 LEFT JOIN LATERAL (
                   SELECT status FROM abei_ai.parse_jobs
                   WHERE bill_document_id = d.id ORDER BY id DESC LIMIT 1
                 ) j ON true
                 WHERE d.user_id = $1 AND ($2 = '' OR d.channel_key = $2)
                   AND ($3 = '' OR $3 = CASE
                     WHEN d.lifecycle = 'archived' THEN 'ignored'
                     WHEN j.status = '{waiting}' THEN 'needs_secret'
                     WHEN j.status = '{failed}' THEN 'failed'
                     WHEN j.status = '{succeeded}' THEN 'parsed'
                     WHEN j.status = '{running}' THEN 'ready'
                     ELSE 'received' END)",
                    waiting = ParseJobStatus::WaitingInput,
                    failed = ParseJobStatus::Failed,
                    succeeded = ParseJobStatus::Succeeded,
                    running = ParseJobStatus::Running,
                ),
                &[&user_id, &source, &status],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        let rows = client
            .query(
                &format!(
                    "{select} WHERE d.user_id = $1 AND ($2 = '' OR d.channel_key = $2)
                       AND ($3 = '' OR $3 = CASE
                         WHEN d.lifecycle = 'archived' THEN 'ignored'
                         WHEN j.status = '{waiting}' THEN 'needs_secret'
                         WHEN j.status = '{failed}' THEN 'failed'
                         WHEN j.status = '{succeeded}' THEN 'parsed'
                         WHEN j.status = '{running}' THEN 'ready'
                         ELSE 'received' END)
                     ORDER BY d.received_at DESC NULLS LAST, d.id DESC LIMIT $4 OFFSET $5",
                    select = document_select(),
                    waiting = ParseJobStatus::WaitingInput,
                    failed = ParseJobStatus::Failed,
                    succeeded = ParseJobStatus::Succeeded,
                    running = ParseJobStatus::Running,
                ),
                &[&user_id, &source, &status, &limit_i64, &offset],
            )
            .await
            .map_err(ApiError::database)?;
        let total_pages = if count == 0 {
            1
        } else {
            (count + limit_i64 - 1) / limit_i64
        };
        Ok(json!({
            "data": rows.iter().map(document_json).collect::<Vec<_>>(),
            "meta": { "pagination": {
                "total": count,
                "count": rows.len(),
                "per_page": limit,
                "current_page": page,
                "total_pages": total_pages,
            }}
        }))
    }

    pub(crate) async fn get_document(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                &format!("{} WHERE d.user_id = $1 AND d.id = $2", document_select()),
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("账单文档不存在。"))?;
        Ok(json!({ "data": document_json(&row) }))
    }

    pub(crate) async fn document_revisions(
        &self,
        user_id: i64,
        id: i64,
    ) -> Result<Value, ApiError> {
        self.assert_document(user_id, id).await?;
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT revision, parse_job_id, parser_flow_id, parser_flow_version,
                        statement_metadata, valid_row_count, invalid_row_count, amount_totals,
                        warnings, metrics, created_at::text
                 FROM abei_ai.bill_document_revisions WHERE bill_document_id = $1
                 ORDER BY revision DESC",
                &[&id],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(json!({ "data": rows.iter().map(|row| json!({
            "revision": row.get::<_, i32>(0),
            "parse_job_id": row.get::<_, i64>(1).to_string(),
            "parser_flow_id": row.get::<_, i64>(2).to_string(),
            "parser_flow_version": row.get::<_, i32>(3),
            "statement_metadata": row.get::<_, Value>(4),
            "valid_row_count": row.get::<_, i32>(5),
            "invalid_row_count": row.get::<_, i32>(6),
            "amount_totals": row.get::<_, Value>(7),
            "warnings": row.get::<_, Value>(8),
            "metrics": row.get::<_, Value>(9),
            "created_at": row.get::<_, String>(10),
        })).collect::<Vec<_>>() }))
    }

    pub(crate) async fn document_artifacts(
        &self,
        user_id: i64,
        id: i64,
    ) -> Result<Value, ApiError> {
        self.assert_document(user_id, id).await?;
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT id, revision, parent_artifact_id, kind, filename, checksum, size,
                        encrypted, metadata, mime_type, generation_stage, created_at::text
                 FROM abei_ai.bill_artifacts WHERE user_id = $1 AND bill_document_id = $2
                 ORDER BY revision DESC, id",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(json!({ "data": rows.iter().map(|row| {
            let artifact_id = row.get::<_, i64>(0);
            let attributes = json!({
                "bill_task_id": id.to_string(),
                "bill_document_id": id.to_string(),
                "revision": row.get::<_, i32>(1),
                "parent_artifact_id": row.get::<_, Option<i64>>(2).map(|v| v.to_string()),
                "kind": row.get::<_, String>(3),
                "filename": row.get::<_, String>(4),
                "checksum": row.get::<_, String>(5),
                "size": row.get::<_, i64>(6),
                "encrypted": row.get::<_, bool>(7),
                "metadata": row.get::<_, Value>(8),
                "mime_type": row.get::<_, String>(9),
                "generation_stage": row.get::<_, String>(10),
                "download_url": format!("/v1/bill-artifacts/{artifact_id}/download"),
                "created_at": row.get::<_, String>(11),
            });
            json!({
                "id": artifact_id.to_string(),
                "type": "bill-artifact",
                "attributes": attributes,
            })
        }).collect::<Vec<_>>() }))
    }

    pub(crate) async fn document_events(
        &self,
        user_id: i64,
        document_id: i64,
    ) -> Result<Value, ApiError> {
        self.assert_document(user_id, document_id).await?;
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT id, status, stage, progress, waiting_reason, error_code, error_message,
                        requested_at::text, started_at::text, finished_at::text, updated_at::text
                 FROM abei_ai.parse_jobs
                 WHERE user_id = $1 AND bill_document_id = $2
                 ORDER BY id DESC",
                &[&user_id, &document_id],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(json!({ "data": rows.iter().map(|row| {
            let status = row.get::<_, String>(1);
            let stage = row.get::<_, String>(2);
            let message = row.get::<_, Option<String>>(6)
                .or_else(|| row.get::<_, Option<String>>(4))
                .unwrap_or_else(|| format!("解析任务处于 {stage} 阶段。"));
            json!({
                "id": format!("parse-job-{}", row.get::<_, i64>(0)),
                "type": "bill-task-event",
                "attributes": {
                    "bill_task_id": document_id.to_string(),
                    "bill_document_id": document_id.to_string(),
                    "parse_job_id": row.get::<_, i64>(0).to_string(),
                    "event_type": format!("parse_job_{status}"),
                    "message": message,
                    "metadata": {
                        "status": status,
                        "stage": stage,
                        "progress": row.get::<_, Value>(3),
                        "waiting_reason": row.get::<_, Option<String>>(4),
                        "error_code": row.get::<_, Option<String>>(5),
                        "requested_at": row.get::<_, String>(7),
                        "started_at": row.get::<_, Option<String>>(8),
                        "finished_at": row.get::<_, Option<String>>(9),
                    },
                    "created_at": row.get::<_, String>(10),
                }
            })
        }).collect::<Vec<_>>() }))
    }

    pub(crate) async fn download_artifact(
        &self,
        user_id: i64,
        id: i64,
    ) -> Result<(Vec<u8>, String, String), ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT filename, mime_type, path FROM abei_ai.bill_artifacts
                 WHERE user_id = $1 AND id = $2",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("账单工件不存在。"))?;
        let path = row
            .get::<_, Option<String>>(2)
            .ok_or_else(|| ApiError::not_found("账单工件没有可下载内容。"))?;
        let bytes = self.mail.read_generated(&path).await?;
        Ok((bytes, row.get(0), row.get(1)))
    }

    pub(crate) async fn reparse_document(
        &self,
        user_id: i64,
        id: i64,
        version: Option<i32>,
    ) -> Result<Value, ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let row = transaction
            .query_opt(
                "SELECT parser_flow_id, parser_flow_version,
                        COALESCE((SELECT max(target_revision) FROM abei_ai.parse_jobs
                                  WHERE bill_document_id = d.id), 0) + 1
                 FROM abei_ai.bill_documents d
                 WHERE user_id = $1 AND id = $2 AND lifecycle = 'active' FOR UPDATE",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("可重新解析的账单文档不存在。"))?;
        let flow_id: i64 = row.get(0);
        let version = version.unwrap_or_else(|| row.get(1));
        let (_, checksum) = self
            .parser
            .published_definition(user_id, flow_id, version)
            .await?;
        let target_revision: i32 = row.get(2);
        let job_id: i64 = transaction
            .query_one(
                "INSERT INTO abei_ai.parse_jobs
                   (user_id, bill_document_id, target_revision, parser_flow_id,
                    parser_flow_version, definition_checksum, status, stage, progress)
                 VALUES ($1,$2,$3,$4,$5,$6,$8,'route',$7) RETURNING id",
                &[
                    &user_id,
                    &id,
                    &target_revision,
                    &flow_id,
                    &version,
                    &checksum,
                    &json!({ "stage": "route", "reparse": true }),
                    &ParseJobStatus::Queued.as_str(),
                ],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        transaction.commit().await.map_err(ApiError::database)?;
        self.notify.notify_one();
        Ok(
            json!({ "data": { "id": job_id.to_string(), "status": ParseJobStatus::Queued.as_str(), "target_revision": target_revision } }),
        )
    }

    pub(crate) async fn set_document_lifecycle(
        &self,
        user_id: i64,
        id: i64,
        lifecycle: &str,
    ) -> Result<Value, ApiError> {
        let updated = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "UPDATE abei_ai.bill_documents SET lifecycle = $3, updated_at = now()
                 WHERE user_id = $1 AND id = $2",
                &[&user_id, &id, &lifecycle],
            )
            .await
            .map_err(ApiError::database)?;
        if updated == 0 {
            return Err(ApiError::not_found("账单文档不存在。"));
        }
        self.get_document(user_id, id).await
    }

    pub(crate) async fn get_parse_job(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT id, bill_document_id, target_revision, parser_flow_id,
                        parser_flow_version, definition_checksum, status, stage, priority,
                        attempt, progress, waiting_reason, waiting_prompt, error_code,
                        error_message, requested_at::text, started_at::text, finished_at::text,
                        updated_at::text
                 FROM abei_ai.parse_jobs WHERE user_id = $1 AND id = $2",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("解析任务不存在。"))?;
        Ok(json!({ "data": parse_job_json(&row) }))
    }

    pub(crate) async fn retry_parse_job(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let updated = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                &format!(
                    "UPDATE abei_ai.parse_jobs SET status = '{queued}', stage = 'route',
                   attempt = attempt + 1, worker_id = NULL, lease_expires_at = NULL,
                   heartbeat_at = NULL, error_code = NULL, error_message = NULL,
                   finished_at = NULL, updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status IN ({retryable})
                   AND attempt < 20",
                    queued = ParseJobStatus::Queued,
                    retryable = sql_list(&[ParseJobStatus::Failed, ParseJobStatus::Cancelled]),
                ),
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?;
        if updated == 0 {
            return Err(ApiError::conflict("只有失败或已取消的解析任务可以重试。"));
        }
        self.notify.notify_one();
        self.get_parse_job(user_id, id).await
    }

    pub(crate) async fn cancel_parse_job(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let updated = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                &format!(
                    "UPDATE abei_ai.parse_jobs SET status = '{cancelled}', stage = 'finished',
                   worker_id = NULL, lease_expires_at = NULL, heartbeat_at = NULL,
                   finished_at = now(), updated_at = now()
                 WHERE user_id = $1 AND id = $2
                   AND status IN ({cancellable})",
                    cancelled = ParseJobStatus::Cancelled,
                    cancellable = sql_list(&[
                        ParseJobStatus::Queued,
                        ParseJobStatus::Running,
                        ParseJobStatus::WaitingInput,
                    ]),
                ),
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?;
        if updated == 0 {
            self.get_parse_job(user_id, id).await?;
        }
        self.get_parse_job(user_id, id).await
    }

    pub(crate) async fn submit_job_secret(
        &self,
        user_id: i64,
        id: i64,
        secret: &str,
    ) -> Result<Value, ApiError> {
        if secret.is_empty() || secret.len() > 1024 || secret.contains(['\r', '\n', '\0']) {
            return Err(ApiError::invalid_params(
                "密码必须是 1 到 1024 字节，且不能包含控制换行。",
            ));
        }
        let ciphertext = self
            .secret_cipher
            .encrypt(user_id, &format!("{id}\0{secret}"))
            .map_err(ApiError::internal)?;
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let state = transaction
            .query_opt(
                "SELECT status, COALESCE((SELECT attempts FROM abei_ai.parse_job_secrets
                                          WHERE parse_job_id = j.id), 0)
                 FROM abei_ai.parse_jobs j WHERE user_id = $1 AND id = $2 FOR UPDATE",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("解析任务不存在。"))?;
        if ParseJobStatus::from_str(&state.get::<_, String>(0))
            != Some(ParseJobStatus::WaitingInput)
        {
            return Err(ApiError::conflict("解析任务当前不在等待密码。"));
        }
        if state.get::<_, i32>(1) >= 5 {
            return Err(ApiError::conflict(
                "密码尝试次数已达上限，请新建重新解析任务。",
            ));
        }
        transaction
            .execute(
                "INSERT INTO abei_ai.parse_job_secrets
                   (parse_job_id, ciphertext, attempts, expires_at)
                 VALUES ($1,$2,1,now() + interval '15 minutes')
                 ON CONFLICT (parse_job_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                   attempts = parse_job_secrets.attempts + 1,
                   expires_at = EXCLUDED.expires_at, updated_at = now()",
                &[&id, &ciphertext],
            )
            .await
            .map_err(ApiError::database)?;
        transaction
            .execute(
                "UPDATE abei_ai.parse_jobs SET status = $3, stage = 'unlock',
                   waiting_reason = NULL, waiting_prompt = NULL, finished_at = NULL,
                   updated_at = now() WHERE user_id = $1 AND id = $2",
                &[&user_id, &id, &ParseJobStatus::Queued.as_str()],
            )
            .await
            .map_err(ApiError::database)?;
        transaction.commit().await.map_err(ApiError::database)?;
        self.notify.notify_one();
        self.get_parse_job(user_id, id).await
    }

    pub(crate) async fn latest_parse_job_id(
        &self,
        user_id: i64,
        document_id: i64,
    ) -> Result<i64, ApiError> {
        self.pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT j.id FROM abei_ai.parse_jobs j
                 JOIN abei_ai.bill_documents d ON d.id = j.bill_document_id
                 WHERE d.user_id = $1 AND d.id = $2 ORDER BY j.id DESC LIMIT 1",
                &[&user_id, &document_id],
            )
            .await
            .map_err(ApiError::database)?
            .map(|row| row.get(0))
            .ok_or_else(|| ApiError::not_found("账单文档还没有解析任务。"))
    }

    async fn assert_document(&self, user_id: i64, id: i64) -> Result<(), ApiError> {
        let exists: bool = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_one(
                "SELECT EXISTS(SELECT 1 FROM abei_ai.bill_documents WHERE user_id = $1 AND id = $2)",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        if exists {
            Ok(())
        } else {
            Err(ApiError::not_found("账单文档不存在。"))
        }
    }
}

fn document_select() -> &'static str {
    "SELECT d.id, d.channel_key, d.parser_flow_id, d.parser_flow_version,
            d.active_revision, d.lifecycle, d.summary, d.account_hint,
            d.period_start::text, d.period_end::text, d.received_at::text,
            d.created_at::text, d.updated_at::text,
            m.subject AS mail_subject,
            j.id AS job_id, j.status AS job_status, j.stage AS job_stage,
            j.progress AS job_progress, j.waiting_reason, j.error_code, j.error_message,
            COALESCE(c.total, 0)::bigint AS row_total,
            COALESCE(c.pending, 0)::bigint AS row_pending,
            COALESCE(c.imported, 0)::bigint AS row_imported,
            COALESCE(c.duplicate, 0)::bigint AS row_duplicate,
            COALESCE(c.conflict, 0)::bigint AS row_conflict
     FROM abei_ai.bill_documents d
     LEFT JOIN abei_ai.mail_messages m
       ON m.id = d.mail_message_id AND m.user_id = d.user_id
     LEFT JOIN LATERAL (
       SELECT id, status, stage, progress, waiting_reason, error_code, error_message
       FROM abei_ai.parse_jobs WHERE bill_document_id = d.id ORDER BY id DESC LIMIT 1
     ) j ON true
     LEFT JOIN LATERAL (
       SELECT count(*) AS total,
              count(*) FILTER (WHERE status = 'pending') AS pending,
              count(*) FILTER (WHERE status = 'imported') AS imported,
              count(*) FILTER (WHERE duplicate_state = 'duplicate') AS duplicate,
              count(*) FILTER (WHERE duplicate_state = 'conflict') AS conflict
       FROM abei_ai.bill_rows
       WHERE bill_document_id = d.id AND revision = d.active_revision
     ) c ON true"
}

fn document_json(row: &Row) -> Value {
    let lifecycle: String = row.get("lifecycle");
    let job_state = row
        .get::<_, Option<String>>("job_status")
        .as_deref()
        .and_then(ParseJobStatus::from_str);
    let total: i64 = row.get("row_total");
    let imported: i64 = row.get("row_imported");
    let status = if lifecycle == "archived" {
        "ignored"
    } else if total > 0 && imported == total {
        "imported"
    } else {
        match job_state {
            Some(ParseJobStatus::WaitingInput) => "needs_secret",
            Some(ParseJobStatus::Failed) => "failed",
            Some(ParseJobStatus::Succeeded) => "parsed",
            Some(ParseJobStatus::Running) => "ready",
            _ => "received",
        }
    };
    json!({
        "id": row.get::<_, i64>("id").to_string(),
        "type": "bill-document",
        "attributes": {
            "source": row.get::<_, String>("channel_key"),
            "channel_key": row.get::<_, String>("channel_key"),
            "subject": row.get::<_, Option<String>>("mail_subject"),
            "profile_id": row.get::<_, i64>("parser_flow_id").to_string(),
            "parser_flow_id": row.get::<_, i64>("parser_flow_id").to_string(),
            "parser_flow_version": row.get::<_, i32>("parser_flow_version"),
            "active_revision": row.get::<_, Option<i32>>("active_revision"),
            "lifecycle": lifecycle,
            "status": status,
            "received_at": row.get::<_, Option<String>>("received_at"),
            "summary": row.get::<_, Option<String>>("summary"),
            "account_hint": row.get::<_, Option<String>>("account_hint"),
            "period_start": row.get::<_, Option<String>>("period_start"),
            "period_end": row.get::<_, Option<String>>("period_end"),
            "current_secret_challenge_id": if job_state == Some(ParseJobStatus::WaitingInput) {
                row.get::<_, Option<i64>>("job_id").map(|v| v.to_string())
            } else { None },
            "error_code": row.get::<_, Option<String>>("error_code"),
            "error_message": row.get::<_, Option<String>>("error_message"),
            "metadata": {
                "parse_job_id": row.get::<_, Option<i64>>("job_id").map(|v| v.to_string()),
                "parse_stage": row.get::<_, Option<String>>("job_stage"),
                "parse_progress": row.get::<_, Option<Value>>("job_progress"),
                "waiting_reason": row.get::<_, Option<String>>("waiting_reason"),
            },
            "row_counts": {
                "total": total,
                "pending": row.get::<_, i64>("row_pending"),
                "imported": imported,
                "duplicate": row.get::<_, i64>("row_duplicate"),
                "conflict": row.get::<_, i64>("row_conflict"),
            },
            "created_at": row.get::<_, String>("created_at"),
            "updated_at": row.get::<_, String>("updated_at"),
        }
    })
}

fn parse_job_json(row: &Row) -> Value {
    json!({
        "id": row.get::<_, i64>(0).to_string(),
        "bill_document_id": row.get::<_, i64>(1).to_string(),
        "target_revision": row.get::<_, i32>(2),
        "parser_flow_id": row.get::<_, i64>(3).to_string(),
        "parser_flow_version": row.get::<_, i32>(4),
        "definition_checksum": row.get::<_, String>(5),
        "status": row.get::<_, String>(6),
        "stage": row.get::<_, String>(7),
        "priority": row.get::<_, i32>(8),
        "attempt": row.get::<_, i32>(9),
        "progress": row.get::<_, Value>(10),
        "waiting_reason": row.get::<_, Option<String>>(11),
        "waiting_prompt": row.get::<_, Option<String>>(12),
        "error_code": row.get::<_, Option<String>>(13),
        "error_message": row.get::<_, Option<String>>(14),
        "requested_at": row.get::<_, String>(15),
        "started_at": row.get::<_, Option<String>>(16),
        "finished_at": row.get::<_, Option<String>>(17),
        "updated_at": row.get::<_, String>(18),
    })
}

fn decimal_option(raw: Option<&str>, label: &str, row: usize) -> Result<Option<Decimal>, String> {
    raw.map(Decimal::from_str)
        .transpose()
        .map_err(|_| format!("第 {row} 行{label}无效。"))
}

fn normalize_currency(value: &str) -> Result<String, String> {
    let value = value.trim().to_ascii_uppercase();
    if value.len() == 3 && value.bytes().all(|byte| byte.is_ascii_uppercase()) {
        Ok(value)
    } else {
        Err(format!("币种代码无效：{value}"))
    }
}

fn valid_date(value: Option<&str>) -> Option<String> {
    let candidate = value?.trim().get(..10)?;
    let format = time::format_description::parse_borrowed::<2>("[year]-[month]-[day]").ok()?;
    time::Date::parse(candidate, &format).ok()?;
    Some(candidate.to_owned())
}

fn fingerprint(
    user_id: i64,
    channel: &str,
    account_hint: Option<&str>,
    row: &BillRowDraft,
    amount: Decimal,
) -> String {
    let identity = format!(
        "v{FINGERPRINT_VERSION}\n{user_id}\n{}\n{}\n{}\n{}\n{}\n{}\n{}",
        normalize_text(channel),
        normalize_text(account_hint.unwrap_or("")),
        row.occurred_at.trim(),
        amount.normalize(),
        row.currency_code.trim().to_ascii_uppercase(),
        normalize_text(row.counterparty.as_deref().unwrap_or("")),
        normalize_text(&row.description),
    );
    sha256(identity.as_bytes())
}

fn normalize_text(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn artifact_path(job: &ClaimedJob, artifact: &Artifact) -> PathBuf {
    PathBuf::from("billing")
        .join(job.user_id.to_string())
        .join(job.document_id.to_string())
        .join(format!("revision-{}", job.target_revision))
        .join(format!(
            "{}-{}",
            artifact.reference.id, artifact.reference.filename
        ))
}

fn artifact_kind(kind: ArtifactKind) -> &'static str {
    match kind {
        ArtifactKind::TextBody => "text_body",
        ArtifactKind::HtmlBody => "html_body",
        ArtifactKind::Attachment => "attachment",
        ArtifactKind::ArchiveEntry => "archive_entry",
        ArtifactKind::Download => "download",
        ArtifactKind::DecodedText => "decoded_text",
        ArtifactKind::PdfText => "pdf_text",
    }
}

fn artifact_stage(kind: ArtifactKind) -> &'static str {
    match kind {
        ArtifactKind::TextBody | ArtifactKind::HtmlBody | ArtifactKind::Attachment => "received",
        ArtifactKind::Download => "downloaded",
        ArtifactKind::ArchiveEntry => "extracted",
        ArtifactKind::DecodedText | ArtifactKind::PdfText => "derived",
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}
