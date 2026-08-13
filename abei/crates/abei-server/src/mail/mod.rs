pub(crate) mod api;
pub(crate) mod rules;

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use deadpool_postgres::Pool;
use mail_parser::MessageParser;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio_postgres::Row;

use self::rules::{AttachmentFacts, Condition, Diagnostic, MailFacts, MetadataMatch};
use crate::ApiError;

const RAW_PREVIEW_LIMIT: usize = 512 * 1024;
const RAW_RETENTION_DAYS: i32 = 7;
const CLEANUP_INTERVAL_SECONDS: u64 = 60 * 60;

#[derive(Clone)]
pub(crate) struct Service {
    pool: Pool,
    storage_root: PathBuf,
}

impl Service {
    pub(crate) fn new(pool: Pool, storage_root: PathBuf) -> Self {
        Self { pool, storage_root }
    }

    pub(crate) fn start_cleanup_scheduler(&self) {
        let service = self.clone();
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(std::time::Duration::from_secs(CLEANUP_INTERVAL_SECONDS));
            loop {
                interval.tick().await;
                match service.cleanup_expired().await {
                    Ok(removed) if removed > 0 => {
                        tracing::info!(removed, "已清理到期邮件缓存");
                    }
                    Ok(_) => {}
                    Err(error) => tracing::warn!(%error, "邮件缓存到期清理失败"),
                }
            }
        });
    }

    async fn cleanup_expired(&self) -> Result<usize, String> {
        let client = self.pool.get().await.map_err(display)?;
        let rows = client
            .query(
                "SELECT m.id, m.raw_path
                 FROM abei_ai.mail_messages m
                 WHERE m.content_state = 'cached' AND m.raw_expires_at <= now()
                   AND m.raw_path IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM abei_ai.mail_samples s WHERE s.mail_message_id = m.id
                   )
                 ORDER BY m.raw_expires_at, m.id LIMIT 500",
                &[],
            )
            .await
            .map_err(display)?;
        let mut removed = 0;
        for row in rows {
            let id: i64 = row.get(0);
            let path: String = row.get(1);
            self.remove_generated(&path).await?;
            let updated = client
                .execute(
                    "UPDATE abei_ai.mail_messages SET content_state = 'expired', raw_path = NULL,
                       updated_at = now()
                     WHERE id = $1 AND raw_path = $2 AND raw_expires_at <= now()
                       AND NOT EXISTS (
                         SELECT 1 FROM abei_ai.mail_samples s WHERE s.mail_message_id = $1
                       )",
                    &[&id, &path],
                )
                .await
                .map_err(display)?;
            removed += updated as usize;
        }
        client
            .execute(
                "DELETE FROM abei_ai.mail_sync_runs
                 WHERE finished_at < now() - interval '30 days'",
                &[],
            )
            .await
            .map_err(display)?;
        Ok(removed)
    }

    pub(crate) async fn index_metadata(
        &self,
        input: IndexMetadata<'_>,
    ) -> Result<IndexOutcome, String> {
        let facts = MailFacts {
            from: input.from_address.map(str::to_owned),
            to: input.to_addresses.to_vec(),
            subject: input.subject.map(str::to_owned),
            folder: input.folder.to_owned(),
            headers: input.headers.clone(),
            attachments: input.attachments.to_vec(),
            ..MailFacts::default()
        };
        let (routing, needs_content) = self.route_metadata(input.user_id, &facts).await?;
        let headers = serde_json::to_string(&json!({
            "normalized": input.headers,
            "raw": truncate_chars(input.raw_headers, 64 * 1024),
        }))
        .map_err(display)?;
        let body_structure = serde_json::to_string(input.body_structure).map_err(display)?;
        let diagnostics = serde_json::to_string(&routing.diagnostics).map_err(display)?;
        let received_at = input.received_at.map(|value| value as f64);

        let mut client = self.pool.get().await.map_err(display)?;
        let transaction = client.transaction().await.map_err(display)?;
        let existing = transaction
            .query_opt(
                "SELECT id FROM abei_ai.mail_messages
                 WHERE user_id = $1 AND (
                   (mailbox_user_id = $1 AND folder = $2 AND uid_validity = $3 AND uid = $4)
                   OR ($5::text IS NOT NULL AND message_id = $5)
                 )
                 ORDER BY id LIMIT 1 FOR UPDATE",
                &[
                    &input.user_id,
                    &input.folder,
                    &(input.uid_validity as i64),
                    &(input.uid as i64),
                    &input.message_id,
                ],
            )
            .await
            .map_err(display)?;

        let id: i64 = if let Some(row) = existing {
            let id: i64 = row.get(0);
            transaction
                .execute(
                    "UPDATE abei_ai.mail_messages SET
                       mailbox_user_id = $1, folder = $2, uid_validity = $3, uid = $4,
                       message_id = $5,
                       from_address = $6, to_addresses = $7, subject = $8,
                       received_at = CASE WHEN $9::double precision IS NULL THEN NULL
                         ELSE to_timestamp($9) END,
                       headers = $10::text::jsonb, body_structure = $11::text::jsonb,
                       classification = $12, matched_rule_id = $13,
                       matched_rule_version = $14, channel_key = $15, parser_flow_id = $16,
                       match_diagnostics = $17::text::jsonb, updated_at = now()
                     WHERE id = $18",
                    &[
                        &input.user_id,
                        &input.folder,
                        &(input.uid_validity as i64),
                        &(input.uid as i64),
                        &input.message_id,
                        &input.from_address,
                        &input.to_addresses,
                        &input.subject,
                        &received_at,
                        &headers,
                        &body_structure,
                        &routing.classification,
                        &routing.rule_id,
                        &routing.rule_version,
                        &routing.channel_key,
                        &routing.parser_flow_id,
                        &diagnostics,
                        &id,
                    ],
                )
                .await
                .map_err(display)?;
            id
        } else {
            transaction
                .query_one(
                    "INSERT INTO abei_ai.mail_messages
                       (user_id, mailbox_user_id, folder, uid_validity, uid, message_id,
                        from_address, to_addresses, subject, received_at, headers, body_structure,
                        content_state, classification, matched_rule_id, matched_rule_version,
                        channel_key, parser_flow_id, match_diagnostics)
                     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,
                       CASE WHEN $9::double precision IS NULL THEN NULL ELSE to_timestamp($9) END,
                       $10::text::jsonb,$11::text::jsonb,'metadata_only',$12,$13,$14,$15,$16,
                       $17::text::jsonb)
                     RETURNING id",
                    &[
                        &input.user_id,
                        &input.folder,
                        &(input.uid_validity as i64),
                        &(input.uid as i64),
                        &input.message_id,
                        &input.from_address,
                        &input.to_addresses,
                        &input.subject,
                        &received_at,
                        &headers,
                        &body_structure,
                        &routing.classification,
                        &routing.rule_id,
                        &routing.rule_version,
                        &routing.channel_key,
                        &routing.parser_flow_id,
                        &diagnostics,
                    ],
                )
                .await
                .map_err(display)?
                .get(0)
        };
        transaction.commit().await.map_err(display)?;

        Ok(IndexOutcome {
            id,
            matched: routing.rule_id.is_some(),
            needs_content,
        })
    }

    pub(crate) async fn index(&self, input: IndexMessage<'_>) -> Result<IndexOutcome, String> {
        let checksum = sha256(input.raw);
        let relative = PathBuf::from("mail-workbench")
            .join(input.user_id.to_string())
            .join(&checksum)
            .join("message.eml");
        self.write_generated(&relative, input.raw).await?;

        let facts = MailFacts {
            from: input.from_address.map(str::to_owned),
            to: input.to_addresses.to_vec(),
            subject: input.subject.map(str::to_owned),
            folder: input.folder.to_owned(),
            headers: input.headers.clone(),
            body_text: input.body_text.map(str::to_owned),
            body_html: input.body_html.map(str::to_owned),
            attachments: input.attachments.to_vec(),
        };
        let routing = self.route(input.user_id, &facts).await?;
        let headers = serde_json::to_string(&json!({
            "normalized": input.headers,
            "raw": truncate_chars(input.raw_headers, 64 * 1024),
        }))
        .map_err(display)?;
        let body_structure = serde_json::to_string(input.body_structure).map_err(display)?;
        let diagnostics = serde_json::to_string(&routing.diagnostics).map_err(display)?;
        let received_at = input.received_at.map(|value| value as f64);
        let raw_path = relative_path(&relative)?;

        let mut client = self.pool.get().await.map_err(display)?;
        let transaction = client.transaction().await.map_err(display)?;
        let existing = transaction
            .query_opt(
                "SELECT id FROM abei_ai.mail_messages
                 WHERE user_id = $1 AND (
                   (mailbox_user_id = $1 AND folder = $2 AND uid_validity = $3 AND uid = $4)
                   OR ($5::text IS NOT NULL AND message_id = $5)
                   OR raw_checksum = $6
                 )
                 ORDER BY id LIMIT 1 FOR UPDATE",
                &[
                    &input.user_id,
                    &input.folder,
                    &(input.uid_validity as i64),
                    &(input.uid as i64),
                    &input.message_id,
                    &checksum,
                ],
            )
            .await
            .map_err(display)?;

        let params: &[&(dyn tokio_postgres::types::ToSql + Sync)] = &[
            &input.user_id,
            &input.folder,
            &(input.uid_validity as i64),
            &(input.uid as i64),
            &input.message_id,
            &input.from_address,
            &input.to_addresses,
            &input.subject,
            &received_at,
            &headers,
            &body_structure,
            &raw_path,
            &checksum,
            &routing.classification,
            &routing.rule_id,
            &routing.rule_version,
            &routing.channel_key,
            &routing.parser_flow_id,
            &input.legacy_channel_key,
            &diagnostics,
        ];

        let id: i64 = if let Some(row) = existing {
            let id: i64 = row.get(0);
            transaction
                .execute(
                    "UPDATE abei_ai.mail_messages SET
                       mailbox_user_id = $1, folder = $2, uid_validity = $3, uid = $4,
                       message_id = $5,
                       from_address = $6, to_addresses = $7, subject = $8,
                       received_at = CASE WHEN $9::double precision IS NULL THEN NULL
                         ELSE to_timestamp($9) END,
                       headers = $10::text::jsonb, body_structure = $11::text::jsonb,
                       content_state = 'cached', raw_path = $12, raw_checksum = $13,
                       raw_expires_at = now() + make_interval(days => $21),
                       classification = $14, matched_rule_id = $15,
                       matched_rule_version = $16, channel_key = $17, parser_flow_id = $18,
                       legacy_channel_key = $19, match_diagnostics = $20::text::jsonb,
                       updated_at = now()
                     WHERE id = $22",
                    &[
                        params[0],
                        params[1],
                        params[2],
                        params[3],
                        params[4],
                        params[5],
                        params[6],
                        params[7],
                        params[8],
                        params[9],
                        params[10],
                        params[11],
                        params[12],
                        params[13],
                        params[14],
                        params[15],
                        params[16],
                        params[17],
                        params[18],
                        params[19],
                        &RAW_RETENTION_DAYS,
                        &id,
                    ],
                )
                .await
                .map_err(display)?;
            id
        } else {
            transaction
                .query_one(
                    "INSERT INTO abei_ai.mail_messages
                       (user_id, mailbox_user_id, folder, uid_validity, uid, message_id,
                        from_address, to_addresses, subject, received_at, headers, body_structure,
                        content_state, raw_path, raw_checksum, raw_expires_at, classification,
                        matched_rule_id, matched_rule_version, channel_key, parser_flow_id,
                        legacy_channel_key, match_diagnostics)
                     VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,
                       CASE WHEN $9::double precision IS NULL THEN NULL ELSE to_timestamp($9) END,
                       $10::text::jsonb,$11::text::jsonb,'cached',$12,$13,
                       now() + make_interval(days => $21),$14,$15,$16,$17,$18,$19,
                       $20::text::jsonb)
                     RETURNING id",
                    &[
                        params[0],
                        params[1],
                        params[2],
                        params[3],
                        params[4],
                        params[5],
                        params[6],
                        params[7],
                        params[8],
                        params[9],
                        params[10],
                        params[11],
                        params[12],
                        params[13],
                        params[14],
                        params[15],
                        params[16],
                        params[17],
                        params[18],
                        params[19],
                        &RAW_RETENTION_DAYS,
                    ],
                )
                .await
                .map_err(display)?
                .get(0)
        };
        transaction.commit().await.map_err(display)?;

        Ok(IndexOutcome {
            id,
            matched: routing.rule_id.is_some(),
            needs_content: false,
        })
    }

    pub(crate) async fn list_messages(
        &self,
        user_id: i64,
        query: &MessageQuery,
    ) -> Result<Value, ApiError> {
        query.validate()?;
        let classification = query.classification.as_deref().unwrap_or("");
        let search = query.search.as_deref().unwrap_or("").trim();
        let limit = i64::from(query.limit.unwrap_or(50));
        let offset = i64::from(query.offset.unwrap_or(0));
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let count: i64 = client
            .query_one(
                "SELECT count(*)::bigint FROM abei_ai.mail_messages
                 WHERE user_id = $1
                   AND ($2 = '' OR classification = $2)
                   AND ($3 = '' OR from_address ILIKE '%' || $3 || '%'
                     OR subject ILIKE '%' || $3 || '%'
                     OR message_id ILIKE '%' || $3 || '%'
                     OR body_structure::text ILIKE '%' || $3 || '%')",
                &[&user_id, &classification, &search],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        let rows = client
            .query(
                "SELECT id, folder, uid_validity, uid, message_id, from_address, to_addresses,
                        subject, received_at::text, body_structure::text, content_state,
                        classification, matched_rule_id, matched_rule_version, channel_key,
                        parser_flow_id, legacy_channel_key, created_at::text, updated_at::text
                 FROM abei_ai.mail_messages
                 WHERE user_id = $1
                   AND ($2 = '' OR classification = $2)
                   AND ($3 = '' OR from_address ILIKE '%' || $3 || '%'
                     OR subject ILIKE '%' || $3 || '%'
                     OR message_id ILIKE '%' || $3 || '%'
                     OR body_structure::text ILIKE '%' || $3 || '%')
                 ORDER BY received_at DESC NULLS LAST, id DESC LIMIT $4 OFFSET $5",
                &[&user_id, &classification, &search, &limit, &offset],
            )
            .await
            .map_err(ApiError::database)?;
        let data = rows.iter().map(message_summary).collect::<Vec<_>>();
        Ok(json!({
            "data": data,
            "meta": { "pagination": { "total": count, "limit": limit, "offset": offset } }
        }))
    }

    pub(crate) async fn get_message(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let row = self.load_message_row(user_id, id).await?;
        let raw_path: Option<String> = row.get("raw_path");
        let preview = match raw_path.as_deref() {
            Some(path) => self
                .preview(path)
                .await
                .unwrap_or_else(|_| json!({ "available": false })),
            None => json!({ "available": false }),
        };
        Ok(json!({
            "data": {
                "id": row.get::<_, i64>("id").to_string(),
                "type": "mail-message",
                "attributes": {
                    "folder": row.get::<_, String>("folder"),
                    "uid_validity": row.get::<_, i64>("uid_validity"),
                    "uid": row.get::<_, i64>("uid"),
                    "message_id": row.get::<_, Option<String>>("message_id"),
                    "from_address": row.get::<_, Option<String>>("from_address"),
                    "to_addresses": row.get::<_, Vec<String>>("to_addresses"),
                    "subject": row.get::<_, Option<String>>("subject"),
                    "received_at": row.get::<_, Option<String>>("received_at"),
                    "headers": parse_json(row.get::<_, String>("headers"), json!({})),
                    "body_structure": parse_json(row.get::<_, String>("body_structure"), json!({})),
                    "content_state": row.get::<_, String>("content_state"),
                    "classification": row.get::<_, String>("classification"),
                    "matched_rule_id": row.get::<_, Option<i64>>("matched_rule_id").map(|value| value.to_string()),
                    "matched_rule_version": row.get::<_, Option<i32>>("matched_rule_version"),
                    "channel_key": row.get::<_, Option<String>>("channel_key"),
                    "parser_flow_id": row.get::<_, Option<i64>>("parser_flow_id").map(|value| value.to_string()),
                    "legacy_channel_key": row.get::<_, Option<String>>("legacy_channel_key"),
                    "match_diagnostics": parse_json(row.get::<_, String>("match_diagnostics"), json!([])),
                    "preview": preview,
                    "created_at": row.get::<_, String>("created_at"),
                    "updated_at": row.get::<_, String>("updated_at"),
                }
            }
        }))
    }

    pub(crate) async fn raw_message(&self, user_id: i64, id: i64) -> Result<Vec<u8>, ApiError> {
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let row = client
            .query_opt(
                "SELECT raw_path, content_state,
                        raw_expires_at IS NULL OR raw_expires_at > now() AS usable
                 FROM abei_ai.mail_messages
                 WHERE user_id = $1 AND id = $2",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("邮件不存在。"))?;
        let path = row
            .get::<_, Option<String>>(0)
            .filter(|_| row.get::<_, String>(1) == "cached" && row.get::<_, bool>(2))
            .ok_or_else(|| ApiError::conflict("这封邮件的原始内容当前没有缓存。"))?;
        self.read_generated(&path).await
    }

    pub(crate) async fn reroute(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let row = self.load_message_row(user_id, id).await?;
        let facts = self.facts_from_row(&row).await?;
        let routing = self
            .route(user_id, &facts)
            .await
            .map_err(ApiError::database)?;
        let diagnostics = serde_json::to_string(&routing.diagnostics)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        self.pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "UPDATE abei_ai.mail_messages SET classification = $3,
                   matched_rule_id = $4, matched_rule_version = $5, channel_key = $6,
                   parser_flow_id = $7, match_diagnostics = $8::text::jsonb, updated_at = now()
                 WHERE user_id = $1 AND id = $2",
                &[
                    &user_id,
                    &id,
                    &routing.classification,
                    &routing.rule_id,
                    &routing.rule_version,
                    &routing.channel_key,
                    &routing.parser_flow_id,
                    &diagnostics,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        self.get_message(user_id, id).await
    }

    pub(crate) async fn test_condition(
        &self,
        user_id: i64,
        condition: &Condition,
        message_ids: &[i64],
        limit: usize,
    ) -> Result<Value, ApiError> {
        condition.validate().map_err(ApiError::invalid_params)?;
        if limit == 0 || limit > 500 {
            return Err(ApiError::invalid_params("limit 必须在 1 到 500 之间。"));
        }
        if message_ids.len() > 500 {
            return Err(ApiError::invalid_params("一次最多指定 500 封邮件。"));
        }
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let limit = i64::try_from(limit).map_err(|_| ApiError::invalid_params("limit 不合法。"))?;
        let rows = if message_ids.is_empty() {
            client
                .query(
                    &format!(
                        "SELECT {} FROM abei_ai.mail_messages WHERE user_id = $1
                         ORDER BY received_at DESC NULLS LAST, id DESC LIMIT $2",
                        MESSAGE_DETAIL_COLUMNS
                    ),
                    &[&user_id, &limit],
                )
                .await
                .map_err(ApiError::database)?
        } else {
            client
                .query(
                    &format!(
                        "SELECT {} FROM abei_ai.mail_messages
                         WHERE user_id = $1 AND id = ANY($2) ORDER BY received_at DESC NULLS LAST, id DESC
                         LIMIT $3",
                        MESSAGE_DETAIL_COLUMNS
                    ),
                    &[&user_id, &message_ids, &limit],
                )
                .await
                .map_err(ApiError::database)?
        };
        let mut matched = Vec::new();
        let mut diagnostics = Vec::with_capacity(rows.len());
        for row in &rows {
            let facts = self.facts_from_row(row).await?;
            let diagnostic = condition.evaluate(&facts);
            let id: i64 = row.get("id");
            if diagnostic.matched && matched.len() < 20 {
                matched.push(json!({
                    "id": id.to_string(),
                    "subject": row.get::<_, Option<String>>("subject"),
                    "from_address": row.get::<_, Option<String>>("from_address"),
                    "received_at": row.get::<_, Option<String>>("received_at"),
                }));
            }
            diagnostics.push(json!({ "message_id": id.to_string(), "diagnostic": diagnostic }));
        }
        let matched_count = diagnostics
            .iter()
            .filter(|item| item["diagnostic"]["matched"] == true)
            .count();
        Ok(json!({
            "data": {
                "tested": rows.len(),
                "matched": matched_count,
                "requires_body": condition.requires_body(),
                "samples": matched,
                "diagnostics": diagnostics,
            }
        }))
    }

    pub(crate) async fn list_rules(&self, user_id: i64) -> Result<Value, ApiError> {
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT r.id, r.name, r.enabled, r.position, r.current_version,
                        r.draft_conditions::text, r.draft_channel_key, r.draft_parser_flow_id,
                        v.conditions::text, v.channel_key, v.parser_flow_id, v.checksum,
                        r.created_at::text, r.updated_at::text
                 FROM abei_ai.mail_rules r
                 LEFT JOIN abei_ai.mail_rule_versions v
                   ON v.rule_id = r.id AND v.version = r.current_version
                 WHERE r.user_id = $1 ORDER BY r.position, r.id",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        let data = rows.iter().map(rule_json).collect::<Vec<_>>();
        Ok(json!({ "data": data }))
    }

    pub(crate) async fn create_rule(
        &self,
        user_id: i64,
        input: &RuleInput,
    ) -> Result<Value, ApiError> {
        input.validate()?;
        self.validate_parser_binding(user_id, &input.channel_key, input.parser_flow_id)
            .await?;
        let conditions = serde_json::to_string(&input.conditions)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_one(
                "INSERT INTO abei_ai.mail_rules
                   (user_id, name, enabled, position, draft_conditions, draft_channel_key,
                    draft_parser_flow_id)
                 VALUES ($1,$2,$3,$4,$5::text::jsonb,$6,$7)
                 RETURNING id",
                &[
                    &user_id,
                    &input.name.trim(),
                    &input.enabled,
                    &input.position,
                    &conditions,
                    &input.channel_key.trim(),
                    &input.parser_flow_id,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        self.get_rule(user_id, row.get(0)).await
    }

    pub(crate) async fn update_rule(
        &self,
        user_id: i64,
        id: i64,
        input: &RuleInput,
    ) -> Result<Value, ApiError> {
        input.validate()?;
        self.validate_parser_binding(user_id, &input.channel_key, input.parser_flow_id)
            .await?;
        let conditions = serde_json::to_string(&input.conditions)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let updated = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "UPDATE abei_ai.mail_rules SET name = $3, enabled = $4, position = $5,
                   draft_conditions = $6::text::jsonb, draft_channel_key = $7,
                   draft_parser_flow_id = $8, updated_at = now()
                 WHERE user_id = $1 AND id = $2",
                &[
                    &user_id,
                    &id,
                    &input.name.trim(),
                    &input.enabled,
                    &input.position,
                    &conditions,
                    &input.channel_key.trim(),
                    &input.parser_flow_id,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        if updated == 0 {
            return Err(ApiError::not_found("邮件规则不存在。"));
        }
        self.get_rule(user_id, id).await
    }

    pub(crate) async fn publish_rule(
        &self,
        user_id: i64,
        id: i64,
        actor: &str,
    ) -> Result<Value, ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let row = transaction
            .query_opt(
                "SELECT draft_conditions::text, draft_channel_key, draft_parser_flow_id,
                        COALESCE((SELECT max(version) FROM abei_ai.mail_rule_versions
                                  WHERE rule_id = r.id), 0)
                 FROM abei_ai.mail_rules r WHERE user_id = $1 AND id = $2 FOR UPDATE",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("邮件规则不存在。"))?;
        let raw: String = row.get(0);
        let condition: Condition = serde_json::from_str(&raw)
            .map_err(|error| ApiError::invalid_params(format!("规则条件无法解析：{error}")))?;
        condition.validate().map_err(ApiError::invalid_params)?;
        let channel: String = row.get(1);
        validate_channel(&channel)?;
        let parser_flow_id: Option<i64> = row.get(2);
        if parser_flow_id.is_none() {
            return Err(ApiError::invalid_params(
                "发布邮件规则前必须绑定一个已发布的解析流程。",
            ));
        }
        self.validate_parser_binding(user_id, &channel, parser_flow_id)
            .await?;
        let version = row.get::<_, i32>(3) + 1;
        let checksum =
            sha256(format!("{raw}\n{channel}\n{}", parser_flow_id.unwrap_or_default()).as_bytes());
        transaction
            .execute(
                "INSERT INTO abei_ai.mail_rule_versions
                   (rule_id, version, conditions, channel_key, parser_flow_id, checksum, created_by)
                 VALUES ($1,$2,$3::text::jsonb,$4,$5,$6,$7)",
                &[
                    &id,
                    &version,
                    &raw,
                    &channel,
                    &parser_flow_id,
                    &checksum,
                    &actor,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        transaction
            .execute(
                "UPDATE abei_ai.mail_rules SET current_version = $3, updated_at = now()
                 WHERE user_id = $1 AND id = $2",
                &[&user_id, &id, &version],
            )
            .await
            .map_err(ApiError::database)?;
        transaction.commit().await.map_err(ApiError::database)?;
        self.get_rule(user_id, id).await
    }

    pub(crate) async fn rollback_rule(
        &self,
        user_id: i64,
        id: i64,
        target_version: i32,
        actor: &str,
    ) -> Result<Value, ApiError> {
        if target_version < 1 {
            return Err(ApiError::invalid_params("target_version 必须是正整数。"));
        }
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        transaction
            .query_opt(
                "SELECT 1 FROM abei_ai.mail_rules WHERE user_id = $1 AND id = $2 FOR UPDATE",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("邮件规则不存在。"))?;
        let target = transaction
            .query_opt(
                "SELECT conditions::text, channel_key, parser_flow_id
                 FROM abei_ai.mail_rule_versions WHERE rule_id = $1 AND version = $2",
                &[&id, &target_version],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("目标规则版本不存在。"))?;
        let raw: String = target.get(0);
        let channel: String = target.get(1);
        let parser_flow_id: Option<i64> = target.get(2);
        if parser_flow_id.is_none() {
            return Err(ApiError::invalid_params(
                "目标规则版本没有绑定解析流程，不能恢复为生产路由。",
            ));
        }
        self.validate_parser_binding(user_id, &channel, parser_flow_id)
            .await?;
        let version: i32 = transaction
            .query_one(
                "SELECT COALESCE(max(version), 0) + 1 FROM abei_ai.mail_rule_versions WHERE rule_id = $1",
                &[&id],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        let checksum =
            sha256(format!("{raw}\n{channel}\n{}", parser_flow_id.unwrap_or_default()).as_bytes());
        transaction
            .execute(
                "INSERT INTO abei_ai.mail_rule_versions
                   (rule_id, version, conditions, channel_key, parser_flow_id, checksum, created_by)
                 VALUES ($1,$2,$3::text::jsonb,$4,$5,$6,$7)",
                &[
                    &id,
                    &version,
                    &raw,
                    &channel,
                    &parser_flow_id,
                    &checksum,
                    &actor,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        transaction
            .execute(
                "UPDATE abei_ai.mail_rules SET current_version = $3,
                   draft_conditions = $4::text::jsonb, draft_channel_key = $5,
                   draft_parser_flow_id = $6, updated_at = now()
                 WHERE user_id = $1 AND id = $2",
                &[&user_id, &id, &version, &raw, &channel, &parser_flow_id],
            )
            .await
            .map_err(ApiError::database)?;
        transaction.commit().await.map_err(ApiError::database)?;
        self.get_rule(user_id, id).await
    }

    pub(crate) async fn list_samples(&self, user_id: i64) -> Result<Value, ApiError> {
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT s.id, s.name, s.purpose, s.pinned_at::text, m.id AS message_id,
                        m.subject, m.from_address, m.received_at::text
                 FROM abei_ai.mail_samples s JOIN abei_ai.mail_messages m ON m.id = s.mail_message_id
                 WHERE s.user_id = $1 ORDER BY s.pinned_at DESC, s.id DESC",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(json!({
            "data": rows.iter().map(|row| json!({
                "id": row.get::<_, i64>("id").to_string(),
                "name": row.get::<_, String>("name"),
                "purpose": row.get::<_, String>("purpose"),
                "pinned_at": row.get::<_, String>("pinned_at"),
                "message": {
                    "id": row.get::<_, i64>("message_id").to_string(),
                    "subject": row.get::<_, Option<String>>("subject"),
                    "from_address": row.get::<_, Option<String>>("from_address"),
                    "received_at": row.get::<_, Option<String>>("received_at"),
                }
            })).collect::<Vec<_>>()
        }))
    }

    pub(crate) async fn create_sample(
        &self,
        user_id: i64,
        input: &SampleInput,
    ) -> Result<Value, ApiError> {
        input.validate()?;
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let owns: bool = transaction
            .query_one(
                "SELECT EXISTS(SELECT 1 FROM abei_ai.mail_messages WHERE user_id = $1 AND id = $2)",
                &[&user_id, &input.mail_message_id],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        if !owns {
            return Err(ApiError::not_found("邮件不存在。"));
        }
        let id: i64 = transaction
            .query_one(
                "INSERT INTO abei_ai.mail_samples (user_id, mail_message_id, name, purpose)
                 VALUES ($1,$2,$3,$4)
                 ON CONFLICT (user_id, mail_message_id, purpose) DO UPDATE SET
                   name = EXCLUDED.name, pinned_at = now()
                 RETURNING id",
                &[
                    &user_id,
                    &input.mail_message_id,
                    &input.name.trim(),
                    &input.purpose,
                ],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        transaction
            .execute(
                "UPDATE abei_ai.mail_messages SET raw_expires_at = NULL, updated_at = now()
                 WHERE user_id = $1 AND id = $2",
                &[&user_id, &input.mail_message_id],
            )
            .await
            .map_err(ApiError::database)?;
        transaction.commit().await.map_err(ApiError::database)?;
        Ok(json!({ "data": { "id": id.to_string() } }))
    }

    pub(crate) async fn delete_sample(&self, user_id: i64, id: i64) -> Result<(), ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let row = transaction
            .query_opt(
                "DELETE FROM abei_ai.mail_samples WHERE user_id = $1 AND id = $2
                 RETURNING mail_message_id",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("邮件样本不存在。"))?;
        let message_id: i64 = row.get(0);
        transaction
            .execute(
                "UPDATE abei_ai.mail_messages SET raw_expires_at = now() + make_interval(days => $3),
                   updated_at = now()
                 WHERE user_id = $1 AND id = $2
                   AND NOT EXISTS (SELECT 1 FROM abei_ai.mail_samples WHERE mail_message_id = $2)",
                &[&user_id, &message_id, &RAW_RETENTION_DAYS],
            )
            .await
            .map_err(ApiError::database)?;
        transaction.commit().await.map_err(ApiError::database)?;
        Ok(())
    }

    pub(crate) async fn get_sync_run(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT id, kind, scope::text, status, stage, scanned, fetched, matched,
                        unclassified, failed, progress::text, error_summary,
                        requested_at::text, started_at::text, finished_at::text, updated_at::text
                 FROM abei_ai.mail_sync_runs WHERE user_id = $1 AND id = $2",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("邮箱同步运行不存在。"))?;
        Ok(json!({ "data": sync_run_json(&row) }))
    }

    pub(crate) async fn list_sync_runs(&self, user_id: i64, limit: u32) -> Result<Value, ApiError> {
        if !(1..=100).contains(&limit) {
            return Err(ApiError::invalid_params("limit 必须在 1 到 100 之间。"));
        }
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT id, kind, scope::text, status, stage, scanned, fetched, matched,
                        unclassified, failed, progress::text, error_summary,
                        requested_at::text, started_at::text, finished_at::text, updated_at::text
                 FROM abei_ai.mail_sync_runs WHERE user_id = $1
                 ORDER BY requested_at DESC, id DESC LIMIT $2",
                &[&user_id, &i64::from(limit)],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(json!({ "data": rows.iter().map(sync_run_json).collect::<Vec<_>>() }))
    }

    async fn route(&self, user_id: i64, facts: &MailFacts) -> Result<Routing, String> {
        let rows = self
            .pool
            .get()
            .await
            .map_err(display)?
            .query(
                "SELECT r.id, r.name, r.current_version, v.conditions::text,
                        v.channel_key, v.parser_flow_id
                 FROM abei_ai.mail_rules r
                 JOIN abei_ai.mail_rule_versions v
                   ON v.rule_id = r.id AND v.version = r.current_version
                 WHERE r.user_id = $1 AND r.enabled = true
                 ORDER BY r.position, r.id",
                &[&user_id],
            )
            .await
            .map_err(display)?;
        let mut routing = Routing::default();
        for row in rows {
            let id: i64 = row.get(0);
            let name: String = row.get(1);
            let version: i32 = row.get(2);
            let condition = serde_json::from_str::<Condition>(&row.get::<_, String>(3));
            let diagnostic = match condition {
                Ok(condition) => match condition.validate() {
                    Ok(()) => condition.evaluate(facts),
                    Err(error) => invalid_diagnostic(error),
                },
                Err(error) => invalid_diagnostic(format!("规则版本无法解析：{error}")),
            };
            let matched = diagnostic.matched;
            routing.diagnostics.push(RuleDiagnostic {
                rule_id: id.to_string(),
                rule_name: name,
                version,
                selected: matched && routing.rule_id.is_none(),
                diagnostic,
            });
            if matched && routing.rule_id.is_none() {
                routing.classification = "matched".to_owned();
                routing.rule_id = Some(id);
                routing.rule_version = Some(version);
                routing.channel_key = Some(row.get(4));
                routing.parser_flow_id = row.get(5);
            }
        }
        Ok(routing)
    }

    async fn route_metadata(
        &self,
        user_id: i64,
        facts: &MailFacts,
    ) -> Result<(Routing, bool), String> {
        let rows = self
            .pool
            .get()
            .await
            .map_err(display)?
            .query(
                "SELECT r.id, r.name, r.current_version, v.conditions::text,
                        v.channel_key, v.parser_flow_id
                 FROM abei_ai.mail_rules r
                 JOIN abei_ai.mail_rule_versions v
                   ON v.rule_id = r.id AND v.version = r.current_version
                 WHERE r.user_id = $1 AND r.enabled = true
                 ORDER BY r.position, r.id",
                &[&user_id],
            )
            .await
            .map_err(display)?;
        let mut routing = Routing::default();
        let mut needs_content = false;
        for row in rows {
            let id: i64 = row.get(0);
            let name: String = row.get(1);
            let version: i32 = row.get(2);
            let condition = serde_json::from_str::<Condition>(&row.get::<_, String>(3));
            let (metadata_match, diagnostic) = match condition {
                Ok(condition) => match condition.validate() {
                    Ok(()) => {
                        let metadata_match = condition.metadata_match(facts);
                        let diagnostic = if metadata_match == MetadataMatch::NeedsContent {
                            Diagnostic {
                                kind: "pending_content",
                                matched: false,
                                reason: "需要读取邮件正文后才能确定".to_owned(),
                                children: Vec::new(),
                            }
                        } else {
                            condition.evaluate(facts)
                        };
                        (metadata_match, diagnostic)
                    }
                    Err(error) => (MetadataMatch::Unmatched, invalid_diagnostic(error)),
                },
                Err(error) => (
                    MetadataMatch::Unmatched,
                    invalid_diagnostic(format!("规则版本无法解析：{error}")),
                ),
            };

            let can_select = routing.rule_id.is_none() && !needs_content;
            let selected = can_select && metadata_match == MetadataMatch::Matched;
            routing.diagnostics.push(RuleDiagnostic {
                rule_id: id.to_string(),
                rule_name: name,
                version,
                selected,
                diagnostic,
            });
            if selected {
                routing.classification = "matched".to_owned();
                routing.rule_id = Some(id);
                routing.rule_version = Some(version);
                routing.channel_key = Some(row.get(4));
                routing.parser_flow_id = row.get(5);
            } else if can_select && metadata_match == MetadataMatch::NeedsContent {
                needs_content = true;
            }
        }
        Ok((routing, needs_content))
    }

    async fn get_rule(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT r.id, r.name, r.enabled, r.position, r.current_version,
                        r.draft_conditions::text, r.draft_channel_key, r.draft_parser_flow_id,
                        v.conditions::text, v.channel_key, v.parser_flow_id, v.checksum,
                        r.created_at::text, r.updated_at::text
                 FROM abei_ai.mail_rules r
                 LEFT JOIN abei_ai.mail_rule_versions v
                   ON v.rule_id = r.id AND v.version = r.current_version
                 WHERE r.user_id = $1 AND r.id = $2",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("邮件规则不存在。"))?;
        Ok(json!({ "data": rule_json(&row) }))
    }

    async fn validate_parser_binding(
        &self,
        user_id: i64,
        channel_key: &str,
        parser_flow_id: Option<i64>,
    ) -> Result<(), ApiError> {
        let Some(flow_id) = parser_flow_id else {
            return Ok(());
        };
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT f.status, f.current_version, v.definition->>'channel_key'
                 FROM abei_ai.parser_flows f
                 LEFT JOIN abei_ai.parser_flow_versions v
                   ON v.flow_id = f.id AND v.version = f.current_version
                 WHERE f.id = $1 AND (f.owner_user_id IS NULL OR f.owner_user_id = $2)",
                &[&flow_id, &user_id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::invalid_params("选择的解析流程不存在或当前用户无权使用。"))?;
        if row.get::<_, String>(0) != "published" || row.get::<_, Option<i32>>(1).is_none() {
            return Err(ApiError::invalid_params(
                "邮件规则只能绑定已发布的解析流程。",
            ));
        }
        let flow_channel: Option<String> = row.get(2);
        if flow_channel.as_deref() != Some(channel_key.trim()) {
            return Err(ApiError::invalid_params(format!(
                "邮件规则渠道 {} 与解析流程渠道 {} 不一致。",
                channel_key.trim(),
                flow_channel.as_deref().unwrap_or("（未设置）")
            )));
        }
        Ok(())
    }

    async fn load_message_row(&self, user_id: i64, id: i64) -> Result<Row, ApiError> {
        self.pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                &format!(
                    "SELECT {} FROM abei_ai.mail_messages WHERE user_id = $1 AND id = $2",
                    MESSAGE_DETAIL_COLUMNS
                ),
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("邮件不存在。"))
    }

    pub(crate) async fn message_locator(
        &self,
        user_id: i64,
        id: i64,
    ) -> Result<MailLocator, ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT folder, uid_validity, uid FROM abei_ai.mail_messages
                 WHERE user_id = $1 AND id = $2",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("邮件不存在。"))?;
        Ok(MailLocator {
            folder: row.get(0),
            uid_validity: u32::try_from(row.get::<_, i64>(1))
                .map_err(|_| ApiError::internal("邮件 UIDVALIDITY 不合法。"))?,
            uid: u32::try_from(row.get::<_, i64>(2))
                .map_err(|_| ApiError::internal("邮件 UID 不合法。"))?,
        })
    }

    async fn facts_from_row(&self, row: &Row) -> Result<MailFacts, ApiError> {
        let headers = parse_json(row.get::<_, String>("headers"), json!({}));
        let body_structure = parse_json(row.get::<_, String>("body_structure"), json!({}));
        let mut facts = MailFacts {
            from: row.get("from_address"),
            to: row.get("to_addresses"),
            subject: row.get("subject"),
            folder: row.get("folder"),
            headers: headers["normalized"]
                .as_object()
                .map(|object| {
                    object
                        .iter()
                        .map(|(key, value)| {
                            let values = value
                                .as_array()
                                .map(|items| {
                                    items
                                        .iter()
                                        .filter_map(Value::as_str)
                                        .map(str::to_owned)
                                        .collect()
                                })
                                .unwrap_or_default();
                            (key.to_ascii_lowercase(), values)
                        })
                        .collect()
                })
                .unwrap_or_default(),
            attachments: body_structure["attachments"]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|value| serde_json::from_value(value.clone()).ok())
                        .collect()
                })
                .unwrap_or_default(),
            ..MailFacts::default()
        };
        if let Some(path) = row.get::<_, Option<String>>("raw_path")
            && let Ok(raw) = self.read_generated(&path).await
            && let Some(message) = MessageParser::default().parse(&raw)
        {
            facts.body_text = message.body_text(0).map(|body| body.into_owned());
            facts.body_html = message.body_html(0).map(|body| body.into_owned());
        }
        Ok(facts)
    }

    async fn preview(&self, path: &str) -> Result<Value, ApiError> {
        let raw = self.read_generated(path).await?;
        let message = MessageParser::default()
            .parse(&raw)
            .ok_or_else(|| ApiError::internal("缓存的 EML/MIME 无法解析。"))?;
        let text = message
            .body_text(0)
            .map(|body| truncate_chars(&body, RAW_PREVIEW_LIMIT));
        let html = message
            .body_html(0)
            .map(|body| truncate_chars(&body, RAW_PREVIEW_LIMIT));
        Ok(json!({
            "available": true,
            "text": text,
            "html": html,
            "truncated": raw.len() > RAW_PREVIEW_LIMIT,
        }))
    }

    pub(crate) async fn write_generated(
        &self,
        relative: &Path,
        bytes: &[u8],
    ) -> Result<(), String> {
        validate_relative(relative).map_err(display)?;
        let path = self.storage_root.join(relative);
        let parent = path
            .parent()
            .ok_or_else(|| "邮件缓存路径没有父目录。".to_owned())?;
        fs::create_dir_all(parent).await.map_err(display)?;
        fs::write(path, bytes).await.map_err(display)
    }

    pub(crate) async fn read_generated(&self, relative: &str) -> Result<Vec<u8>, ApiError> {
        let relative = Path::new(relative);
        validate_relative(relative).map_err(ApiError::internal)?;
        let root = fs::canonicalize(&self.storage_root)
            .await
            .map_err(|_| ApiError::not_found("邮件缓存目录不存在。"))?;
        let path = fs::canonicalize(self.storage_root.join(relative))
            .await
            .map_err(|_| ApiError::not_found("邮件缓存已经过期或不存在。"))?;
        if !path.starts_with(&root) {
            return Err(ApiError::forbidden("邮件缓存路径越界。"));
        }
        fs::read(path)
            .await
            .map_err(|_| ApiError::not_found("邮件缓存已经过期或不可读。"))
    }

    async fn remove_generated(&self, relative: &str) -> Result<(), String> {
        let relative = Path::new(relative);
        validate_relative(relative)?;
        let root = match fs::canonicalize(&self.storage_root).await {
            Ok(root) => root,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(display(error)),
        };
        let path = match fs::canonicalize(self.storage_root.join(relative)).await {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(display(error)),
        };
        if !path.starts_with(root) {
            return Err("邮件缓存路径越界。".to_owned());
        }
        fs::remove_file(path).await.map_err(display)
    }
}

pub(crate) struct MailLocator {
    pub folder: String,
    pub uid_validity: u32,
    pub uid: u32,
}

pub(crate) struct IndexMetadata<'a> {
    pub user_id: i64,
    pub folder: &'a str,
    pub uid_validity: u32,
    pub uid: u32,
    pub message_id: Option<&'a str>,
    pub from_address: Option<&'a str>,
    pub to_addresses: &'a [String],
    pub subject: Option<&'a str>,
    pub received_at: Option<i64>,
    pub headers: &'a BTreeMap<String, Vec<String>>,
    pub raw_headers: &'a str,
    pub attachments: &'a [AttachmentFacts],
    pub body_structure: &'a Value,
}

pub(crate) struct IndexMessage<'a> {
    pub user_id: i64,
    pub folder: &'a str,
    pub uid_validity: u32,
    pub uid: u32,
    pub message_id: Option<&'a str>,
    pub from_address: Option<&'a str>,
    pub to_addresses: &'a [String],
    pub subject: Option<&'a str>,
    pub received_at: Option<i64>,
    pub headers: &'a BTreeMap<String, Vec<String>>,
    pub raw_headers: &'a str,
    pub body_text: Option<&'a str>,
    pub body_html: Option<&'a str>,
    pub attachments: &'a [AttachmentFacts],
    pub body_structure: &'a Value,
    pub raw: &'a [u8],
    pub legacy_channel_key: Option<&'a str>,
}

pub(crate) struct IndexOutcome {
    pub id: i64,
    pub matched: bool,
    pub needs_content: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct MessageQuery {
    pub classification: Option<String>,
    pub search: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
}

impl MessageQuery {
    fn validate(&self) -> Result<(), ApiError> {
        if let Some(classification) = &self.classification
            && !["unclassified", "matched", "ignored", "error"].contains(&classification.as_str())
        {
            return Err(ApiError::invalid_params("classification 不支持。"));
        }
        if !(1..=100).contains(&self.limit.unwrap_or(50)) {
            return Err(ApiError::invalid_params("limit 必须在 1 到 100 之间。"));
        }
        if self.offset.unwrap_or(0) > 100_000 {
            return Err(ApiError::invalid_params("offset 不能超过 100000。"));
        }
        if self
            .search
            .as_ref()
            .is_some_and(|value| value.chars().count() > 200)
        {
            return Err(ApiError::invalid_params("search 最多 200 个字符。"));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuleInput {
    pub name: String,
    pub enabled: bool,
    pub position: i32,
    pub channel_key: String,
    pub parser_flow_id: Option<i64>,
    pub conditions: Condition,
}

impl RuleInput {
    pub(crate) fn validate(&self) -> Result<(), ApiError> {
        if self.name.trim().is_empty() || self.name.chars().count() > 120 {
            return Err(ApiError::invalid_params("name 必须是 1 到 120 个字符。"));
        }
        if !(0..=10_000).contains(&self.position) {
            return Err(ApiError::invalid_params(
                "position 必须在 0 到 10000 之间。",
            ));
        }
        validate_channel(&self.channel_key)?;
        if self.parser_flow_id.is_some_and(|value| value <= 0) {
            return Err(ApiError::invalid_params("parser_flow_id 必须是正整数。"));
        }
        self.conditions.validate().map_err(ApiError::invalid_params)
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RuleTestInput {
    pub conditions: Condition,
    #[serde(default)]
    pub message_ids: Vec<i64>,
    #[serde(default = "default_test_limit")]
    pub limit: usize,
}

fn default_test_limit() -> usize {
    100
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RollbackInput {
    pub target_version: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SampleInput {
    pub mail_message_id: i64,
    pub name: String,
    pub purpose: String,
}

impl SampleInput {
    fn validate(&self) -> Result<(), ApiError> {
        if self.mail_message_id <= 0 {
            return Err(ApiError::invalid_params("mail_message_id 必须是正整数。"));
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 120 {
            return Err(ApiError::invalid_params("name 必须是 1 到 120 个字符。"));
        }
        if !["rule", "parser", "negative"].contains(&self.purpose.as_str()) {
            return Err(ApiError::invalid_params("purpose 不支持。"));
        }
        Ok(())
    }
}

#[derive(Default)]
struct Routing {
    classification: String,
    rule_id: Option<i64>,
    rule_version: Option<i32>,
    channel_key: Option<String>,
    parser_flow_id: Option<i64>,
    diagnostics: Vec<RuleDiagnostic>,
}

impl Routing {
    fn default() -> Self {
        Self {
            classification: "unclassified".to_owned(),
            rule_id: None,
            rule_version: None,
            channel_key: None,
            parser_flow_id: None,
            diagnostics: Vec::new(),
        }
    }
}

#[derive(Serialize)]
struct RuleDiagnostic {
    rule_id: String,
    rule_name: String,
    version: i32,
    selected: bool,
    diagnostic: Diagnostic,
}

const MESSAGE_DETAIL_COLUMNS: &str = "id, folder, uid_validity, uid, message_id, from_address,
    to_addresses, subject, received_at::text AS received_at, headers::text AS headers,
    body_structure::text AS body_structure, content_state, raw_path, classification,
    matched_rule_id, matched_rule_version, channel_key, parser_flow_id, legacy_channel_key,
    match_diagnostics::text AS match_diagnostics, created_at::text AS created_at,
    updated_at::text AS updated_at";

fn message_summary(row: &Row) -> Value {
    json!({
        "id": row.get::<_, i64>("id").to_string(),
        "type": "mail-message",
        "attributes": {
            "folder": row.get::<_, String>("folder"),
            "uid_validity": row.get::<_, i64>("uid_validity"),
            "uid": row.get::<_, i64>("uid"),
            "message_id": row.get::<_, Option<String>>("message_id"),
            "from_address": row.get::<_, Option<String>>("from_address"),
            "to_addresses": row.get::<_, Vec<String>>("to_addresses"),
            "subject": row.get::<_, Option<String>>("subject"),
            "received_at": row.get::<_, Option<String>>("received_at"),
            "body_structure": parse_json(row.get::<_, String>("body_structure"), json!({})),
            "content_state": row.get::<_, String>("content_state"),
            "classification": row.get::<_, String>("classification"),
            "matched_rule_id": row.get::<_, Option<i64>>("matched_rule_id").map(|value| value.to_string()),
            "matched_rule_version": row.get::<_, Option<i32>>("matched_rule_version"),
            "channel_key": row.get::<_, Option<String>>("channel_key"),
            "parser_flow_id": row.get::<_, Option<i64>>("parser_flow_id").map(|value| value.to_string()),
            "legacy_channel_key": row.get::<_, Option<String>>("legacy_channel_key"),
            "created_at": row.get::<_, String>("created_at"),
            "updated_at": row.get::<_, String>("updated_at"),
        }
    })
}

fn rule_json(row: &Row) -> Value {
    let published_conditions = row
        .get::<_, Option<String>>("conditions")
        .map(|value| parse_json(value, Value::Null))
        .unwrap_or(Value::Null);
    json!({
        "id": row.get::<_, i64>("id").to_string(),
        "type": "mail-rule",
        "attributes": {
            "name": row.get::<_, String>("name"),
            "enabled": row.get::<_, bool>("enabled"),
            "position": row.get::<_, i32>("position"),
            "current_version": row.get::<_, Option<i32>>("current_version"),
            "draft": {
                "conditions": parse_json(row.get::<_, String>("draft_conditions"), json!({})),
                "channel_key": row.get::<_, String>("draft_channel_key"),
                "parser_flow_id": row.get::<_, Option<i64>>("draft_parser_flow_id").map(|value| value.to_string()),
            },
            "published": {
                "conditions": published_conditions,
                "channel_key": row.get::<_, Option<String>>("channel_key"),
                "parser_flow_id": row.get::<_, Option<i64>>("parser_flow_id").map(|value| value.to_string()),
                "checksum": row.get::<_, Option<String>>("checksum"),
            },
            "created_at": row.get::<_, String>("created_at"),
            "updated_at": row.get::<_, String>("updated_at"),
        }
    })
}

fn sync_run_json(row: &Row) -> Value {
    json!({
        "id": row.get::<_, i64>("id").to_string(),
        "kind": row.get::<_, String>("kind"),
        "scope": parse_json(row.get::<_, String>("scope"), json!({})),
        "status": row.get::<_, String>("status"),
        "stage": row.get::<_, String>("stage"),
        "counts": {
            "scanned": row.get::<_, i32>("scanned"),
            "fetched": row.get::<_, i32>("fetched"),
            "matched": row.get::<_, i32>("matched"),
            "unclassified": row.get::<_, i32>("unclassified"),
            "failed": row.get::<_, i32>("failed"),
        },
        "progress": parse_json(row.get::<_, String>("progress"), json!({})),
        "error_summary": row.get::<_, Option<String>>("error_summary"),
        "requested_at": row.get::<_, String>("requested_at"),
        "started_at": row.get::<_, Option<String>>("started_at"),
        "finished_at": row.get::<_, Option<String>>("finished_at"),
        "updated_at": row.get::<_, String>("updated_at"),
    })
}

fn invalid_diagnostic(error: String) -> Diagnostic {
    Diagnostic {
        kind: "invalid",
        matched: false,
        reason: error,
        children: Vec::new(),
    }
}

fn validate_channel(value: &str) -> Result<(), ApiError> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 80
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'_'
        })
    {
        return Err(ApiError::invalid_params(
            "channel_key 只能使用小写字母、数字、中划线和下划线，最多 80 个字符。",
        ));
    }
    Ok(())
}

fn validate_relative(path: &Path) -> Result<(), String> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("邮件缓存路径不合法。".to_owned());
    }
    Ok(())
}

fn relative_path(path: &Path) -> Result<String, String> {
    validate_relative(path)?;
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "邮件缓存路径不是有效 UTF-8。".to_owned())
}

fn parse_json(raw: String, fallback: Value) -> Value {
    serde_json::from_str(&raw).unwrap_or(fallback)
}

fn truncate_chars(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

fn sha256(content: &[u8]) -> String {
    Sha256::digest(content)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn rules_checksum(raw: &str, channel: &str, parser_flow_id: Option<i64>) -> String {
    sha256(format!("{raw}\n{channel}\n{}", parser_flow_id.unwrap_or_default()).as_bytes())
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_storage_paths_cannot_escape_the_root() {
        assert!(validate_relative(Path::new("mail-workbench/1/a/message.eml")).is_ok());
        assert!(validate_relative(Path::new("../secret")).is_err());
        assert!(validate_relative(Path::new("/tmp/secret")).is_err());
    }

    #[test]
    fn message_query_has_bounded_pagination_and_known_states() {
        assert!(MessageQuery::default().validate().is_ok());
        assert!(
            MessageQuery {
                limit: Some(101),
                ..MessageQuery::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            MessageQuery {
                classification: Some("maybe".to_owned()),
                ..MessageQuery::default()
            }
            .validate()
            .is_err()
        );
    }
}
