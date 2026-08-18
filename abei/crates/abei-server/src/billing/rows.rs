use std::collections::BTreeMap;
use std::str::FromStr;

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_postgres::Row;

use super::Service;
use crate::ApiError;

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct RowUpdate {
    pub firefly_type: Option<String>,
    pub firefly_date: Option<String>,
    pub firefly_amount: Option<String>,
    pub firefly_description: Option<String>,
    pub source_name: Option<String>,
    pub source_account_id: Option<i64>,
    pub destination_name: Option<String>,
    pub destination_account_id: Option<i64>,
    pub category_name: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<Vec<String>>,
    pub as_suggestion: bool,
}

impl RowUpdate {
    pub(crate) fn validate(&self) -> Result<(), ApiError> {
        if self.firefly_type.is_none()
            && self.firefly_date.is_none()
            && self.firefly_amount.is_none()
            && self.firefly_description.is_none()
            && self.source_name.is_none()
            && self.source_account_id.is_none()
            && self.destination_name.is_none()
            && self.destination_account_id.is_none()
            && self.category_name.is_none()
            && self.notes.is_none()
            && self.tags.is_none()
        {
            return Err(ApiError::invalid_params("至少要更新一个账本字段。"));
        }
        if let Some(kind) = self.firefly_type.as_deref()
            && !["withdrawal", "deposit", "transfer"].contains(&kind)
        {
            return Err(ApiError::invalid_params("firefly_type 不支持。"));
        }
        if let Some(amount) = self.firefly_amount.as_deref() {
            let value = Decimal::from_str(amount)
                .map_err(|_| ApiError::invalid_params("firefly_amount 必须是金额。"))?;
            if value <= Decimal::ZERO {
                return Err(ApiError::invalid_params("firefly_amount 必须大于 0。"));
            }
        }
        for (name, value) in [
            ("source_account_id", self.source_account_id),
            ("destination_account_id", self.destination_account_id),
        ] {
            if value.is_some_and(|value| value <= 0) {
                return Err(ApiError::invalid_params(format!("{name} 必须是正整数。")));
            }
        }
        if self
            .tags
            .as_ref()
            .is_some_and(|tags| tags.len() > 50 || tags.iter().any(|tag| tag.chars().count() > 100))
        {
            return Err(ApiError::invalid_params(
                "tags 最多 50 个，每个最多 100 个字符。",
            ));
        }
        for (name, value) in [
            ("firefly_description", self.firefly_description.as_deref()),
            ("source_name", self.source_name.as_deref()),
            ("destination_name", self.destination_name.as_deref()),
            ("category_name", self.category_name.as_deref()),
            ("notes", self.notes.as_deref()),
        ] {
            if value.is_some_and(|value| value.chars().count() > 4_000) {
                return Err(ApiError::invalid_params(format!(
                    "{name} 不能超过 4000 个字符。"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SplitPart {
    pub amount: String,
    pub description: String,
    #[serde(default)]
    pub payment_method: Option<String>,
    #[serde(default)]
    pub source_name: Option<String>,
    #[serde(default)]
    pub destination_name: Option<String>,
    #[serde(default)]
    pub category_name: Option<String>,
}

impl Service {
    pub(crate) async fn list_rows(
        &self,
        user_id: i64,
        group: Option<&str>,
        channel: Option<&str>,
        document_id: Option<i64>,
        page: u32,
        limit: u32,
    ) -> Result<Value, ApiError> {
        if page == 0 || !(1..=500).contains(&limit) {
            return Err(ApiError::invalid_params(
                "page 必须大于 0，limit 必须在 1 到 500 之间。",
            ));
        }
        let group = group.unwrap_or("");
        if !group.is_empty()
            && !["importable", "attention", "dismissed", "imported"].contains(&group)
        {
            return Err(ApiError::invalid_params("group 不支持。"));
        }
        let channel = channel.unwrap_or("");
        let document_id = document_id.unwrap_or(0);
        let offset = i64::from(page.saturating_sub(1)) * i64::from(limit);
        let limit_i64 = i64::from(limit);
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let predicate = row_group_predicate();
        // 归档文档的行不在收件箱里出现：入账时 validate 本来就会拒，留在列表里只会
        // 让用户勾一批然后被整批 skip。点名要某一份文档时例外——那是「打开这封邮件
        // 看它解析成什么样」，归档了也得看得见。
        let count_sql = format!(
            "SELECT count(*)::bigint {} WHERE r.user_id = $1 AND d.active_revision = r.revision
               AND (d.lifecycle = 'active' OR d.id = $3::bigint)
               AND ($2 = '' OR d.channel_key = $2)
               AND ($3::bigint = 0 OR d.id = $3::bigint)
               AND ($4 = '' OR $4 = {predicate})",
            row_from()
        );
        let count: i64 = client
            .query_one(&count_sql, &[&user_id, &channel, &document_id, &group])
            .await
            .map_err(ApiError::database)?
            .get(0);
        let sql = format!(
            "{} WHERE r.user_id = $1 AND d.active_revision = r.revision
               AND (d.lifecycle = 'active' OR d.id = $3::bigint)
               AND ($2 = '' OR d.channel_key = $2)
               AND ($3::bigint = 0 OR d.id = $3::bigint)
               AND ($4 = '' OR $4 = {predicate})
             ORDER BY r.occurred_at DESC, r.id DESC LIMIT $5 OFFSET $6",
            row_select()
        );
        let rows = client
            .query(
                &sql,
                &[
                    &user_id,
                    &channel,
                    &document_id,
                    &group,
                    &limit_i64,
                    &offset,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        let total_pages = if count == 0 {
            1
        } else {
            (count + limit_i64 - 1) / limit_i64
        };
        Ok(json!({
            "data": rows.iter().map(row_json).collect::<Vec<_>>(),
            "meta": { "pagination": {
                "total": count, "count": rows.len(), "per_page": limit,
                "current_page": page, "total_pages": total_pages,
            }}
        }))
    }

    pub(crate) async fn get_row(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                &format!("{} WHERE r.user_id = $1 AND r.id = $2", row_select()),
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("账单流水不存在。"))?;
        Ok(json!({ "data": row_json(&row) }))
    }

    pub(crate) async fn update_row(
        &self,
        user_id: i64,
        id: i64,
        input: &RowUpdate,
    ) -> Result<Value, ApiError> {
        input.validate()?;
        let firefly_date = input
            .firefly_date
            .as_deref()
            .map(validate_date)
            .transpose()?;
        let firefly_amount = input
            .firefly_amount
            .as_deref()
            .map(|value| Decimal::from_str(value).map(|value| value.to_string()))
            .transpose()
            .map_err(|_| ApiError::invalid_params("firefly_amount 必须是金额。"))?;
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let existing = client
            .query_opt(
                "SELECT issues, user_modified_at IS NOT NULL, status
                 FROM abei_ai.bill_rows WHERE user_id = $1 AND id = $2",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("账单流水不存在。"))?;
        if existing.get::<_, String>(2) != "pending" {
            return Err(ApiError::conflict("只有待处理流水可以修改。"));
        }
        if input.as_suggestion && existing.get::<_, bool>(1) {
            return Err(ApiError::conflict(
                "这条流水已经由用户修改，AI 建议不能覆盖人工值。",
            ));
        }
        let mut issues: Value = existing.get(0);
        if (input.source_account_id.is_some() || input.destination_account_id.is_some())
            && let Some(values) = issues.as_array_mut()
        {
            values.retain(|issue| {
                !matches!(
                    issue["code"].as_str(),
                    Some("account_mapping_required" | "account_mapping_ambiguous")
                )
            });
        }
        let suggested_by = input.as_suggestion.then_some("ai");
        let updated = client
            .execute(
                "UPDATE abei_ai.bill_rows SET
                   firefly_type = COALESCE($3, firefly_type),
                   firefly_date = COALESCE($4::text::date, firefly_date),
                   firefly_amount = COALESCE($5::text::numeric, firefly_amount),
                   firefly_description = COALESCE($6, firefly_description),
                   source_name = COALESCE($7, source_name),
                   source_account_id = COALESCE($8, source_account_id),
                   destination_name = COALESCE($9, destination_name),
                   destination_account_id = COALESCE($10, destination_account_id),
                   category_name = COALESCE($11, category_name),
                   notes = COALESCE($12, notes), tags = COALESCE($13, tags),
                   issues = $14, suggested_by = $15,
                   suggested_at = CASE WHEN $16 THEN now() ELSE NULL END,
                   user_modified_at = CASE WHEN $16 THEN user_modified_at ELSE now() END,
                   last_import_error = CASE WHEN $16 THEN last_import_error ELSE NULL END,
                   updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status = 'pending'",
                &[
                    &user_id,
                    &id,
                    &input.firefly_type,
                    &firefly_date,
                    &firefly_amount,
                    &input.firefly_description,
                    &input.source_name,
                    &input.source_account_id,
                    &input.destination_name,
                    &input.destination_account_id,
                    &input.category_name,
                    &input.notes,
                    &input.tags,
                    &issues,
                    &suggested_by,
                    &input.as_suggestion,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        if updated == 0 {
            return Err(ApiError::not_found("账单流水不存在。"));
        }
        self.get_row(user_id, id).await
    }

    pub(crate) async fn dismiss_rows(
        &self,
        user_id: i64,
        row_ids: &[i64],
        machine_duplicates: bool,
        reason: Option<&str>,
    ) -> Result<Value, ApiError> {
        if !machine_duplicates && (row_ids.is_empty() || row_ids.len() > 500) {
            return Err(ApiError::invalid_params(
                "row_ids 必须包含 1 到 500 条流水。",
            ));
        }
        let reason = reason
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or("user");
        if reason.len() > 500 {
            return Err(ApiError::invalid_params("dismiss reason 最多 500 字符。"));
        }
        let processed = if machine_duplicates {
            self.pool
                .get()
                .await
                .map_err(ApiError::database)?
                .execute(
                    "UPDATE abei_ai.bill_rows SET status = 'dismissed',
                       dismissed_reason = 'duplicate_auto', dismissed_at = now(), updated_at = now()
                     WHERE user_id = $1 AND status = 'pending' AND duplicate_state = 'duplicate'",
                    &[&user_id],
                )
                .await
                .map_err(ApiError::database)?
        } else {
            self.pool
                .get()
                .await
                .map_err(ApiError::database)?
                .execute(
                    "UPDATE abei_ai.bill_rows SET status = 'dismissed',
                       dismissed_reason = $3, dismissed_at = now(), updated_at = now()
                     WHERE user_id = $1 AND id = ANY($2) AND status = 'pending'",
                    &[&user_id, &row_ids, &reason],
                )
                .await
                .map_err(ApiError::database)?
        };
        Ok(
            json!({ "processed": processed, "affected_count": processed, "reason": if machine_duplicates { "duplicate_auto" } else { reason } }),
        )
    }

    pub(crate) async fn preview_dismiss_rows(
        &self,
        user_id: i64,
        row_ids: &[i64],
        machine_duplicates: bool,
    ) -> Result<Value, ApiError> {
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let rows = if machine_duplicates {
            client
                .query("SELECT id FROM abei_ai.bill_rows WHERE user_id = $1 AND status = 'pending' AND duplicate_state = 'duplicate' ORDER BY id", &[&user_id])
                .await
                .map_err(ApiError::database)?
        } else {
            client
                .query("SELECT id FROM abei_ai.bill_rows WHERE user_id = $1 AND id = ANY($2) AND status = 'pending' ORDER BY id", &[&user_id, &row_ids])
                .await
                .map_err(ApiError::database)?
        };
        let affected = rows
            .iter()
            .map(|row| row.get::<_, i64>(0).to_string())
            .collect::<Vec<_>>();
        Ok(
            json!({ "dry_run": true, "would": { "row_ids": affected, "affected_count": affected.len(), "machine_duplicates": machine_duplicates } }),
        )
    }

    pub(crate) async fn restore_rows(
        &self,
        user_id: i64,
        row_ids: &[i64],
    ) -> Result<Value, ApiError> {
        if row_ids.is_empty() || row_ids.len() > 500 {
            return Err(ApiError::invalid_params(
                "row_ids 必须包含 1 到 500 条流水。",
            ));
        }
        let processed = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                // 被「确认重复」并掉的行不从这里放回来：那是一条配对的结论，放回它得撤回
                // 那条配对（撤回会同时把两边的待确认标记复原）。从这里绕过去放回，
                // 界面上会同时出现两笔同样的钱，两笔都能入账。
                "UPDATE abei_ai.bill_rows SET status = 'pending', dismissed_reason = NULL,
                   dismissed_at = NULL, updated_at = now()
                 WHERE user_id = $1 AND id = ANY($2) AND status = 'dismissed'
                   AND dismissed_reason IS DISTINCT FROM $3",
                &[&user_id, &row_ids, &super::links::DUPLICATE_CONFIRMED],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(json!({ "processed": processed, "affected_count": processed }))
    }

    pub(crate) async fn preview_restore_rows(
        &self,
        user_id: i64,
        row_ids: &[i64],
    ) -> Result<Value, ApiError> {
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT id FROM abei_ai.bill_rows WHERE user_id = $1 AND id = ANY($2)
               AND status = 'dismissed' AND dismissed_reason IS DISTINCT FROM $3 ORDER BY id",
                &[&user_id, &row_ids, &super::links::DUPLICATE_CONFIRMED],
            )
            .await
            .map_err(ApiError::database)?;
        let affected = rows
            .iter()
            .map(|row| row.get::<_, i64>(0).to_string())
            .collect::<Vec<_>>();
        Ok(
            json!({ "dry_run": true, "would": { "row_ids": affected, "affected_count": affected.len() } }),
        )
    }

    pub(crate) async fn update_rows_many(
        &self,
        user_id: i64,
        row_ids: &[i64],
        input: &RowUpdate,
    ) -> Result<Value, ApiError> {
        input.validate()?;
        if row_ids.is_empty() || row_ids.len() > 500 {
            return Err(ApiError::invalid_params(
                "row_ids 必须包含 1 到 500 条流水。",
            ));
        }
        let firefly_date = input
            .firefly_date
            .as_deref()
            .map(validate_date)
            .transpose()?;
        let firefly_amount = input
            .firefly_amount
            .as_deref()
            .map(|value| Decimal::from_str(value).map(|value| value.to_string()))
            .transpose()
            .map_err(|_| ApiError::invalid_params("firefly_amount 必须是金额。"))?;
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let candidates = transaction
            .query(
                "SELECT id, issues FROM abei_ai.bill_rows
                 WHERE user_id = $1 AND id = ANY($2) AND status = 'pending'
                   AND (NOT $3 OR user_modified_at IS NULL)
                 ORDER BY id FOR UPDATE",
                &[&user_id, &row_ids, &input.as_suggestion],
            )
            .await
            .map_err(ApiError::database)?;
        let suggested_by = input.as_suggestion.then_some("ai");
        let mut updated_ids = Vec::with_capacity(candidates.len());
        for row in candidates {
            let id: i64 = row.get(0);
            let mut issues: Value = row.get(1);
            if (input.source_account_id.is_some() || input.destination_account_id.is_some())
                && let Some(values) = issues.as_array_mut()
            {
                values.retain(|issue| {
                    !matches!(
                        issue["code"].as_str(),
                        Some("account_mapping_required" | "account_mapping_ambiguous")
                    )
                });
            }
            transaction
                .execute(
                    "UPDATE abei_ai.bill_rows SET
                       firefly_type = COALESCE($3, firefly_type),
                       firefly_date = COALESCE($4::text::date, firefly_date),
                       firefly_amount = COALESCE($5::text::numeric, firefly_amount),
                       firefly_description = COALESCE($6, firefly_description),
                       source_name = COALESCE($7, source_name),
                       source_account_id = COALESCE($8, source_account_id),
                       destination_name = COALESCE($9, destination_name),
                       destination_account_id = COALESCE($10, destination_account_id),
                       category_name = COALESCE($11, category_name),
                       notes = COALESCE($12, notes), tags = COALESCE($13, tags),
                       issues = $14, suggested_by = $15,
                       suggested_at = CASE WHEN $16 THEN now() ELSE NULL END,
                       user_modified_at = CASE WHEN $16 THEN user_modified_at ELSE now() END,
                       last_import_error = CASE WHEN $16 THEN last_import_error ELSE NULL END,
                       updated_at = now()
                     WHERE user_id = $1 AND id = $2 AND status = 'pending'",
                    &[
                        &user_id,
                        &id,
                        &input.firefly_type,
                        &firefly_date,
                        &firefly_amount,
                        &input.firefly_description,
                        &input.source_name,
                        &input.source_account_id,
                        &input.destination_name,
                        &input.destination_account_id,
                        &input.category_name,
                        &input.notes,
                        &input.tags,
                        &issues,
                        &suggested_by,
                        &input.as_suggestion,
                    ],
                )
                .await
                .map_err(ApiError::database)?;
            updated_ids.push(id);
        }
        transaction.commit().await.map_err(ApiError::database)?;
        let rows = if updated_ids.is_empty() {
            Vec::new()
        } else {
            let client = self.pool.get().await.map_err(ApiError::database)?;
            client
                .query(
                    &format!(
                        "{} WHERE r.user_id = $1 AND r.id = ANY($2) ORDER BY r.id",
                        row_select()
                    ),
                    &[&user_id, &updated_ids],
                )
                .await
                .map_err(ApiError::database)?
                .iter()
                .map(row_json)
                .collect::<Vec<_>>()
        };
        Ok(json!({
            "data": rows,
            "affected_count": updated_ids.len(),
            "skipped": row_ids.len().saturating_sub(updated_ids.len()),
        }))
    }

    pub(crate) async fn preview_update_rows(
        &self,
        user_id: i64,
        row_ids: &[i64],
        input: &RowUpdate,
    ) -> Result<Value, ApiError> {
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let rows = client.query(
            "SELECT id, status, user_modified_at IS NOT NULL FROM abei_ai.bill_rows WHERE user_id = $1 AND id = ANY($2) ORDER BY id",
            &[&user_id, &row_ids],
        ).await.map_err(ApiError::database)?;
        let eligible = rows
            .iter()
            .filter(|row| {
                row.get::<_, String>(1) == "pending"
                    && !(input.as_suggestion && row.get::<_, bool>(2))
            })
            .map(|row| row.get::<_, i64>(0).to_string())
            .collect::<Vec<_>>();
        Ok(
            json!({ "dry_run": true, "would": { "row_ids": eligible, "affected_count": eligible.len(), "skipped": row_ids.len() - eligible.len() } }),
        )
    }

    pub(crate) async fn mark_row_unique(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let row = client
            .query_opt(
                "SELECT issues FROM abei_ai.bill_rows WHERE user_id = $1 AND id = $2",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("账单流水不存在。"))?;
        let mut issues: Value = row.get(0);
        if let Some(values) = issues.as_array_mut() {
            values.retain(|issue| {
                !matches!(
                    issue["code"].as_str(),
                    Some("duplicate_duplicate" | "duplicate_conflict")
                )
            });
        }
        client
            .execute(
                "UPDATE abei_ai.bill_rows SET duplicate_state = 'unique',
                   duplicate_of_row_id = NULL, issues = $3, user_modified_at = now(),
                   updated_at = now() WHERE user_id = $1 AND id = $2",
                &[&user_id, &id, &issues],
            )
            .await
            .map_err(ApiError::database)?;
        self.get_row(user_id, id).await
    }

    pub(crate) async fn split_row(
        &self,
        user_id: i64,
        id: i64,
        actor: &str,
        splits: &[SplitPart],
    ) -> Result<Value, ApiError> {
        if !(2..=20).contains(&splits.len()) {
            return Err(ApiError::invalid_params("拆分必须包含 2 到 20 笔。"));
        }
        let mut amounts = Vec::with_capacity(splits.len());
        for (index, split) in splits.iter().enumerate() {
            if split.description.trim().is_empty() || split.description.chars().count() > 500 {
                return Err(ApiError::invalid_params(format!(
                    "第 {} 笔 description 不合法。",
                    index + 1
                )));
            }
            let amount = Decimal::from_str(&split.amount).map_err(|_| {
                ApiError::invalid_params(format!("第 {} 笔 amount 不合法。", index + 1))
            })?;
            if amount <= Decimal::ZERO {
                return Err(ApiError::invalid_params("拆分金额必须大于 0。"));
            }
            amounts.push(amount);
        }
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let row = transaction
            .query_opt(
                "SELECT signed_amount::text, status FROM abei_ai.bill_rows
                 WHERE user_id = $1 AND id = $2 FOR UPDATE",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("账单流水不存在。"))?;
        if row.get::<_, String>(1) != "pending" {
            return Err(ApiError::conflict("只有待处理流水可以拆分。"));
        }
        let expected = Decimal::from_str(&row.get::<_, String>(0))
            .map_err(|_| ApiError::internal("账单金额损坏。"))?
            .abs();
        let actual: Decimal = amounts.iter().copied().sum();
        if actual != expected {
            return Err(ApiError::invalid_params(format!(
                "拆分合计 {actual} 必须等于原金额 {expected}。"
            )));
        }
        transaction
            .execute(
                "DELETE FROM abei_ai.bill_row_splits WHERE bill_row_id = $1",
                &[&id],
            )
            .await
            .map_err(ApiError::database)?;
        for (index, (split, amount)) in splits.iter().zip(amounts).enumerate() {
            transaction
                .execute(
                    "INSERT INTO abei_ai.bill_row_splits
                       (user_id, bill_row_id, part_index, amount, payment_method, source_name,
                        destination_name, category_name, description, created_by)
                     VALUES ($1,$2,$3,$4::text::numeric,$5,$6,$7,$8,$9,$10)",
                    &[
                        &user_id,
                        &id,
                        &((index + 1) as i16),
                        &amount.to_string(),
                        &split.payment_method,
                        &split.source_name,
                        &split.destination_name,
                        &split.category_name,
                        &split.description.trim(),
                        &actor,
                    ],
                )
                .await
                .map_err(ApiError::database)?;
        }
        transaction.commit().await.map_err(ApiError::database)?;
        let parent = self.get_row(user_id, id).await?;
        Ok(json!({
            "parent": parent["data"],
            "data": [],
            "split_count": splits.len(),
        }))
    }

    pub(crate) async fn document_review(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let document = self.get_document(user_id, id).await?;
        // 审阅摘要必须覆盖整份账单，否则第二页之后的流水会在人工确认时静默漏掉。
        let mut page = 1_u32;
        let mut row_values = Vec::new();
        loop {
            let page_rows = self
                .list_rows(user_id, None, None, Some(id), page, 500)
                .await?;
            row_values.extend(page_rows["data"].as_array().cloned().unwrap_or_default());
            let total_pages = page_rows["meta"]["pagination"]["total_pages"]
                .as_u64()
                .unwrap_or(page as u64);
            if page as u64 >= total_pages {
                break;
            }
            page = page.saturating_add(1);
        }
        let mut groups = serde_json::Map::new();
        for name in ["importable", "attention", "dismissed", "imported"] {
            groups.insert(
                name.to_owned(),
                Value::Array(
                    row_values
                        .iter()
                        .filter(|row| row["attributes"]["group"] == name)
                        .cloned()
                        .collect(),
                ),
            );
        }
        let links = self.review_links(user_id, id).await?;
        let mut matches = BTreeMap::<String, Vec<Value>>::new();
        let mut refund_pairs = Vec::new();
        for link in links {
            let relation = link["relation"].as_str().unwrap_or_default();
            if relation == "refund_candidate" {
                refund_pairs.push(link.clone());
            }
            if let Some(row_id) = link["row_id"].as_str() {
                matches
                    .entry(row_id.to_owned())
                    .or_default()
                    .push(link["match"].clone());
            }
        }
        let candidates = |predicate: &dyn Fn(&Value) -> bool, reason: &str| {
            row_values
                .iter()
                .filter(|row| predicate(row))
                .map(|row| {
                    let mut candidate = review_candidate(row, reason);
                    if let Some(row_id) = candidate["row_id"].as_str()
                        && let Some(found) = matches.get(row_id)
                    {
                        candidate["cross_source_matches"] = json!(found);
                    }
                    candidate
                })
                .collect::<Vec<_>>()
        };
        let importable = candidates(&|row| row_group(row) == "importable", "new");
        let attention = candidates(&|row| row_group(row) == "attention", "attention");
        let dismissed = candidates(&|row| row_group(row) == "dismissed", "dismissed");
        let imported = candidates(&|row| row_group(row) == "imported", "existing");
        // 下发的 issue code 已经统一成对外那套词表，这里跟着认 pair_suggested。
        let cross_source = candidates(&|row| has_issue(row, "pair_suggested"), "pair_suggested");
        let duplicate = candidates(
            &|row| row["attributes"]["duplicate_state"] == "duplicate",
            "duplicate",
        );
        let conflict = candidates(
            &|row| row["attributes"]["duplicate_state"] == "conflict",
            "conflict",
        );
        let user_edits = candidates(
            &|row| !row["attributes"]["user_modified_at"].is_null(),
            "user_modified",
        );
        let transfer = candidates(
            &|row| row["attributes"]["firefly_type"] == "transfer" || transfer_like_row(row),
            "transfer",
        );
        let needs_note = candidates(
            &|row| {
                row_group(row) == "attention"
                    && (row["attributes"]["firefly_type"].is_null()
                        || transfer_like_row(row)
                        || row["attributes"]["source_name"].is_null()
                        || row["attributes"]["destination_name"].is_null())
            },
            "needs_user_note",
        );
        let balance_chain = row_values
            .iter()
            .filter(|row| has_issue(row, "balance_chain_gap"))
            .map(|row| review_candidate(row, "balance_chain_gap"))
            .collect::<Vec<_>>();
        let summary = json!({
            "total": row_values.len(),
            "new": importable.len(),
            "attention": attention.len(),
            "dismissed": dismissed.len(),
            "imported": imported.len(),
        });
        Ok(json!({
            "summary": summary,
            "new_candidates": importable,
            "existing_candidates": imported,
            "cross_source_candidates": cross_source,
            "duplicate_candidates": duplicate,
            "conflict_candidates": conflict,
            "preserved_user_edits": user_edits,
            "skip_candidates": dismissed,
            "transfer_candidates": transfer,
            "refund_pairs": refund_pairs,
            "needs_user_note": needs_note,
            "balance_chain": balance_chain,
            "data": {
            "document": document["data"],
            "task": document["data"],
            "groups": groups,
            "rows": row_values,
        }}))
    }

    async fn review_links(&self, user_id: i64, document_id: i64) -> Result<Vec<Value>, ApiError> {
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT
                   CASE WHEN ld.id = $2 THEN l.left_row_id ELSE l.right_row_id END,
                   CASE WHEN ld.id = $2 THEN l.right_row_id ELSE l.left_row_id END,
                   l.relation, l.confidence::text, l.evidence,
                   CASE WHEN ld.id = $2 THEN rr.occurred_at ELSE lr.occurred_at END,
                   CASE WHEN ld.id = $2 THEN rr.signed_amount::text ELSE lr.signed_amount::text END,
                   CASE WHEN ld.id = $2 THEN rr.description ELSE lr.description END,
                   CASE WHEN ld.id = $2 THEN rr.source_name ELSE lr.source_name END,
                   CASE WHEN ld.id = $2 THEN rr.destination_name ELSE lr.destination_name END
                 FROM abei_ai.bill_row_links l
                 JOIN abei_ai.bill_rows lr ON lr.id = l.left_row_id
                 JOIN abei_ai.bill_rows rr ON rr.id = l.right_row_id
                 JOIN abei_ai.bill_documents ld ON ld.id = lr.bill_document_id
                 JOIN abei_ai.bill_documents rd ON rd.id = rr.bill_document_id
                 WHERE l.user_id = $1 AND (ld.id = $2 OR rd.id = $2)
                   AND ((ld.id = $2 AND ld.active_revision = lr.revision)
                     OR (rd.id = $2 AND rd.active_revision = rr.revision))
                 ORDER BY l.confidence DESC, l.id",
                &[&user_id, &document_id],
            )
            .await
            .map_err(ApiError::database)?;
        Ok(rows
            .iter()
            .map(|row| {
                let confidence: String = row.get(3);
                let confidence_value = Decimal::from_str(&confidence).unwrap_or_default();
                json!({
                    "row_id": row.get::<_, i64>(0).to_string(),
                    "related_row_id": row.get::<_, i64>(1).to_string(),
                    "relation": row.get::<_, String>(2),
                    "confidence": confidence,
                    "evidence": row.get::<_, Value>(4),
                    "match": {
                        "confidence": if confidence_value >= Decimal::new(90, 2) { "high" } else { "medium" },
                        "matched_on": row.get::<_, Value>(4)["matched_on"],
                        "existing": {
                            "date": row.get::<_, String>(5),
                            "amount": row.get::<_, String>(6),
                            "description": row.get::<_, String>(7),
                            "source_name": row.get::<_, Option<String>>(8),
                            "destination_name": row.get::<_, Option<String>>(9),
                        }
                    }
                })
            })
            .collect())
    }

    pub(crate) async fn inbox_summary(&self, user_id: i64) -> Result<Value, ApiError> {
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let predicate = row_group_predicate();
        let counts = client
            .query_one(
                &format!(
                    "SELECT count(*) FILTER (WHERE {predicate} = 'importable')::bigint,
                            count(*) FILTER (WHERE {predicate} = 'attention')::bigint,
                            count(*) FILTER (WHERE {predicate} = 'dismissed')::bigint,
                            count(*) FILTER (WHERE {predicate} = 'imported')::bigint
                     {from} WHERE r.user_id = $1 AND d.active_revision = r.revision
                       AND d.lifecycle = 'active'",
                    from = row_from()
                ),
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        let unclassified_mail: i64 = client
            .query_one(
                "SELECT count(*)::bigint FROM abei_ai.mail_messages
                 WHERE user_id = $1 AND classification = 'unclassified'",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        // 渠道条要的东西一次查完：邮件侧的状态（等密码 / 处理中 / 失败）和流水侧的
        // 四分组。以前这是两条 SQL，一条带 lifecycle 过滤一条不带，同一个响应里
        // 「这个渠道有几笔待入账」能给出两个不同的数。
        let channels = client
            .query(
                &format!(
                    "SELECT d.channel_key, max(d.received_at)::text,
                            count(DISTINCT d.id) FILTER (WHERE j.status = 'waiting_input')::bigint,
                            count(DISTINCT d.id) FILTER (WHERE j.status IN ('queued','running'))::bigint,
                            count(DISTINCT d.id) FILTER (WHERE j.status = 'failed')::bigint,
                            count(DISTINCT d.id) FILTER (WHERE d.active_revision IS NOT NULL)::bigint,
                            count(r.id) FILTER (WHERE {predicate} = 'importable')::bigint,
                            (array_agg(j.status ORDER BY d.received_at DESC NULLS LAST, d.id DESC))[1],
                            count(r.id) FILTER (WHERE {predicate} = 'attention')::bigint,
                            count(r.id) FILTER (WHERE {predicate} = 'dismissed')::bigint,
                            count(r.id) FILTER (WHERE {predicate} = 'imported')::bigint
                     FROM abei_ai.bill_documents d
                     LEFT JOIN abei_ai.bill_rows r
                       ON r.bill_document_id = d.id AND r.revision = d.active_revision
                     LEFT JOIN LATERAL (
                       SELECT status FROM abei_ai.bill_import_attempts
                       WHERE user_id = r.user_id AND bill_row_id = r.id
                       ORDER BY attempt_no DESC LIMIT 1
                     ) ia ON true
                     LEFT JOIN LATERAL (
                       SELECT status FROM abei_ai.parse_jobs
                       WHERE bill_document_id = d.id ORDER BY id DESC LIMIT 1
                     ) j ON true
                     WHERE d.user_id = $1 AND d.lifecycle = 'active'
                     GROUP BY d.channel_key ORDER BY d.channel_key"
                ),
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        // 邮件侧三个数按「文档的最新一条解析任务」算，和渠道条逐渠道加起来严格相等。
        // 以前这里是在 LIMIT 20 的展示用列表上 count，50 封等密码只会显示 20。
        let job_counts = client
            .query_one(
                "SELECT count(*) FILTER (WHERE j.status = 'waiting_input')::bigint,
                        count(*) FILTER (WHERE j.status IN ('queued','running'))::bigint,
                        count(*) FILTER (WHERE j.status = 'failed')::bigint
                 FROM abei_ai.bill_documents d
                 JOIN LATERAL (
                   SELECT status FROM abei_ai.parse_jobs
                   WHERE bill_document_id = d.id ORDER BY id DESC LIMIT 1
                 ) j ON true
                 WHERE d.user_id = $1 AND d.lifecycle = 'active'",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        let jobs = client
            .query(
                "SELECT id, bill_document_id, status, stage, progress, waiting_reason,
                        error_code, error_message, updated_at::text
                 FROM abei_ai.parse_jobs WHERE user_id = $1
                   AND status IN ('queued','running','waiting_input','failed')
                 ORDER BY updated_at DESC LIMIT 20",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        let sync = client
            .query_opt(
                "SELECT id, status, stage, scanned, fetched, matched, unclassified, failed,
                        error_summary, requested_at::text, started_at::text, finished_at::text,
                        updated_at::text
                 FROM abei_ai.mail_sync_runs WHERE user_id = $1
                 ORDER BY requested_at DESC, id DESC LIMIT 1",
                &[&user_id],
            )
            .await
            .map_err(ApiError::database)?;
        let importable = counts.get::<_, i64>(0);
        let attention = counts.get::<_, i64>(1);
        let dismissed = counts.get::<_, i64>(2);
        let imported = counts.get::<_, i64>(3);
        let needs_code: i64 = job_counts.get(0);
        let unprocessed: i64 = job_counts.get(1);
        let failed: i64 = job_counts.get(2);
        let stuck_tasks = needs_code + failed;
        let mailbox_sync = sync
            .map(|row| {
                let status: String = row.get(1);
                let scanned: i32 = row.get(3);
                let fetched: i32 = row.get(4);
                let matched: i32 = row.get(5);
                let unclassified: i32 = row.get(6);
                let sync_failed: i32 = row.get(7);
                json!({
                    "id": row.get::<_, i64>(0).to_string(),
                    "status": if status == "cancelled" { "failed" } else { &status },
                    "stage": row.get::<_, String>(2),
                    "requested_at": row.get::<_, String>(9),
                    "started_at": row.get::<_, Option<String>>(10),
                    "finished_at": row.get::<_, Option<String>>(11),
                    "result": if matches!(status.as_str(), "succeeded" | "failed" | "cancelled") {
                        Some(json!({
                            "scanned": scanned,
                            "fetched": fetched,
                            "matched": matched,
                            "unclassified": unclassified,
                            "created": matched,
                            "ignored": unclassified,
                            "duplicates": 0,
                            "failed": sync_failed,
                            "processed": matched,
                            "process_failed": 0,
                            "errors": [],
                        }))
                    } else { None },
                    "error_message": row.get::<_, Option<String>>(8),
                    "updated_at": row.get::<_, String>(12),
                })
            })
            .unwrap_or_else(|| {
                json!({
                    "status": "idle",
                    "requested_at": null,
                    "started_at": null,
                    "finished_at": null,
                    "result": null,
                    "error_message": null,
                })
            });
        Ok(json!({
            "pending_total": importable + attention,
            "needs_code": needs_code,
            "unprocessed": unprocessed,
            "failed": failed,
            "unclassified_mail": unclassified_mail,
            "channels": channels.iter().map(|row| {
                let key = row.get::<_, String>(0);
                json!({
                    "name": channel_name(&key),
                    "key": key,
                    "last_received_at": row.get::<_, Option<String>>(1),
                    "needs_code": row.get::<_, i64>(2),
                    "unprocessed": row.get::<_, i64>(3),
                    "failed": row.get::<_, i64>(4),
                    "parsed": row.get::<_, i64>(5),
                    "to_store": row.get::<_, i64>(6),
                    "last_status": row.get::<_, Option<String>>(7),
                    // 渠道条按 tab 取这里的数，不再每渠道发一次 limit=1 的探测请求。
                    "counts": {
                        "importable": row.get::<_, i64>(6),
                        "attention": row.get::<_, i64>(8),
                        "dismissed": row.get::<_, i64>(9),
                        "imported": row.get::<_, i64>(10),
                    },
                })
            }).collect::<Vec<_>>(),
            "todo": {
                "importable": importable,
                "attention": attention,
                "stuck_tasks": stuck_tasks,
                "total": importable + attention + stuck_tasks,
            },
            "counts": {
                "importable": importable,
                "attention": attention,
                "dismissed": dismissed,
                "imported": imported,
            },
            "parse_jobs": jobs.iter().map(|row| json!({
                "id": row.get::<_, i64>(0).to_string(),
                "bill_document_id": row.get::<_, i64>(1).to_string(),
                "status": row.get::<_, String>(2),
                "stage": row.get::<_, String>(3),
                "progress": row.get::<_, Value>(4),
                "waiting_reason": row.get::<_, Option<String>>(5),
                "error_code": row.get::<_, Option<String>>(6),
                "error_message": row.get::<_, Option<String>>(7),
                "updated_at": row.get::<_, String>(8),
            })).collect::<Vec<_>>(),
            "mailbox_sync": mailbox_sync,
        }))
    }
}

fn row_select() -> String {
    format!(
        "SELECT r.id, r.bill_document_id, r.status, r.occurred_at, r.counterparty,
            r.signed_amount::text, r.currency_code::text, r.duplicate_state,
            r.duplicate_of_row_id, r.firefly_type, r.firefly_date::text,
            r.firefly_amount::text, r.firefly_description, r.source_name,
            r.destination_name, r.category_name, r.notes, r.tags,
            r.transaction_group_id, r.last_import_error, r.suggested_by,
            r.user_modified_at::text, r.dismissed_reason, r.dismissed_at::text,
            r.issues, r.source_locator, r.raw_fields, r.description,
            d.channel_key, d.summary, d.received_at::text, r.row_number,
            {group} AS review_group,
            r.account_hint, ia.id, ia.status, ia.error_code, ia.error_message,
            ia.retry_after::text, ia.transaction_group_id, ia.updated_at::text,
            r.source_account_id, r.destination_account_id,
            {kind} AS attention_kind,
            pl.link_id, pl.relation, pl.link_state, pl.decided_by,
            pl.other_id, pl.other_status, pl.other_occurred_at,
            pl.other_signed_amount, pl.other_currency_code, pl.other_description,
            pl.other_counterparty, pl.other_channel_key,
            dup.dup_id, dup.dup_status, dup.dup_occurred_at, dup.dup_signed_amount,
            dup.dup_currency_code, dup.dup_description, dup.dup_counterparty,
            dup.dup_source_name, dup.dup_destination_name, dup.dup_channel_key,
            ia.batch_id::text
     FROM abei_ai.bill_rows r
     JOIN abei_ai.bill_documents d ON d.id = r.bill_document_id
     LEFT JOIN LATERAL (
       SELECT id, status, error_code, error_message, retry_after,
              transaction_group_id, updated_at, batch_id
       FROM abei_ai.bill_import_attempts
       WHERE user_id = r.user_id AND bill_row_id = r.id
       ORDER BY attempt_no DESC LIMIT 1
     ) ia ON true
     LEFT JOIN LATERAL (
       SELECT l.id AS link_id, l.relation, l.state AS link_state, l.decided_by,
              o.id AS other_id, o.status AS other_status,
              o.occurred_at::text AS other_occurred_at,
              o.signed_amount::text AS other_signed_amount,
              o.currency_code::text AS other_currency_code,
              o.description AS other_description, o.counterparty AS other_counterparty,
              od.channel_key AS other_channel_key
       FROM abei_ai.bill_row_links l
       JOIN abei_ai.bill_rows o
         ON o.id = CASE WHEN l.left_row_id = r.id THEN l.right_row_id ELSE l.left_row_id END
       JOIN abei_ai.bill_documents od ON od.id = o.bill_document_id
       WHERE l.user_id = r.user_id AND (l.left_row_id = r.id OR l.right_row_id = r.id)
         AND l.state <> 'rejected'
       ORDER BY (l.state = 'confirmed') DESC, l.confidence DESC, l.id
       LIMIT 1
     ) pl ON true
     LEFT JOIN LATERAL (
       SELECT dr.id AS dup_id, dr.status AS dup_status,
              dr.occurred_at::text AS dup_occurred_at,
              dr.signed_amount::text AS dup_signed_amount,
              dr.currency_code::text AS dup_currency_code,
              dr.description AS dup_description, dr.counterparty AS dup_counterparty,
              dr.source_name AS dup_source_name, dr.destination_name AS dup_destination_name,
              dd.channel_key AS dup_channel_key
       FROM abei_ai.bill_rows dr
       JOIN abei_ai.bill_documents dd ON dd.id = dr.bill_document_id
       WHERE dr.id = r.duplicate_of_row_id AND dr.user_id = r.user_id
       LIMIT 1
     ) dup ON true",
        group = row_group_predicate(),
        kind = attention_kind_sql(),
    )
}

/// 一行身上挂着的配对：另一笔在哪个渠道、多少钱、是建议还是已合并。
///
/// 以前这份数据只有 `/bill-rows/{id}/links` 拿得到，于是「这一笔已经和另一笔
/// 自动合并了」在列表里根本看不出来——用户看到的是一条普通待入账，
/// 合并这件事只有点开某一行的展开层才浮出来。列表要能一眼看见，就得随行下发。
fn pair_json(row: &Row) -> Value {
    let Some(link_id) = row.get::<_, Option<i64>>(44) else {
        return Value::Null;
    };
    json!({
        "link_id": link_id.to_string(),
        "relation": row.get::<_, Option<String>>(45),
        "state": row.get::<_, Option<String>>(46),
        // 'auto' = 强证据（订单号/交易号完全对得上）系统自己合的。界面靠它把
        // 「系统替我做的」和「我自己确认过的」分开说，也才知道要不要给拆开的出口。
        "decided_by": row.get::<_, Option<String>>(47),
        "other": {
            "id": row.get::<_, Option<i64>>(48).map(|v| v.to_string()),
            "status": row.get::<_, Option<String>>(49),
            "occurred_at": row.get::<_, Option<String>>(50),
            "signed_amount": row.get::<_, Option<String>>(51),
            "currency_code": row.get::<_, Option<String>>(52),
            "description": row.get::<_, Option<String>>(53),
            "counterparty": row.get::<_, Option<String>>(54),
            "channel_key": row.get::<_, Option<String>>(55),
        },
    })
}

/// 判重指向的那一笔长什么样。
///
/// 以前行上只有一个 `duplicate_of_row_id`，界面上只能写「和已有交易很像」，
/// 像在哪儿一个字都说不出来——用户没有任何依据能判断这是不是重复。
fn duplicate_of_json(row: &Row) -> Value {
    let Some(id) = row.get::<_, Option<i64>>(56) else {
        return Value::Null;
    };
    json!({
        "id": id.to_string(),
        "status": row.get::<_, Option<String>>(57),
        "occurred_at": row.get::<_, Option<String>>(58),
        "signed_amount": row.get::<_, Option<String>>(59),
        "currency_code": row.get::<_, Option<String>>(60),
        "description": row.get::<_, Option<String>>(61),
        "counterparty": row.get::<_, Option<String>>(62),
        "source_name": row.get::<_, Option<String>>(63),
        "destination_name": row.get::<_, Option<String>>(64),
        "channel_key": row.get::<_, Option<String>>(65),
    })
}

/// 列表和计数共用的 FROM。
///
/// 这里带着「最新一条入账尝试」的 LATERAL，和 [`row_select`] 里那个是同一份语义：
/// 分组判定只看最新一条尝试。以前计数那边用的是 `EXISTS` 扫全部历史尝试，于是一行
/// 「以前重试过、最新一条已经 rejected」在列表里算 importable、在 tab 计数里算 attention，
/// 同一个数在两个位置对不上。
pub(super) fn row_from() -> &'static str {
    "FROM abei_ai.bill_rows r
     JOIN abei_ai.bill_documents d ON d.id = r.bill_document_id
     LEFT JOIN LATERAL (
       SELECT status FROM abei_ai.bill_import_attempts
       WHERE user_id = r.user_id AND bill_row_id = r.id
       ORDER BY attempt_no DESC LIMIT 1
     ) ia ON true"
}

/// 「这一行要不要人来看」的唯一判定。分组、attention 原因、计数全从这里长出来。
fn needs_attention_sql() -> &'static str {
    // 支出/收入缺账户不再进「要判断的」：渠道账户由入账那一步自动建好并写下映射，
    // 用户不需要为此先做一件配置。转账仍然要人管——它是人手动改出来的类型，
    // 系统猜不出另一端是哪个账户。
    "r.last_import_error IS NOT NULL
       OR ia.status IN ('prepared','sending','uncertain','retryable')
       OR r.duplicate_state <> 'unique' OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(r.issues) issue
          WHERE issue->>'code' <> 'account_mapping_required')
       OR r.firefly_type IS NULL OR r.firefly_date IS NULL
       OR r.firefly_amount IS NULL
       OR btrim(COALESCE(r.firefly_description, r.description, '')) = ''
       OR (r.firefly_type = 'transfer' AND
           (r.source_account_id IS NULL OR r.destination_account_id IS NULL OR
            r.source_account_id = r.destination_account_id))"
}

/// 四分组。要求 FROM 里有 [`row_from`] 或 [`row_select`] 提供的 `ia` 别名。
pub(super) fn row_group_predicate() -> String {
    format!(
        "CASE
           WHEN r.status = 'imported' THEN 'imported'
           WHEN r.status = 'dismissed' THEN 'dismissed'
           WHEN {attention} THEN 'attention'
           ELSE 'importable' END",
        attention = needs_attention_sql()
    )
}

/// 待确认的行为什么要人看。非待确认的行是 NULL。
///
/// 前端按这个字段分节，不再拿 reasons 的中文做子串匹配。判定顺序就是优先级：
/// 入账已经出过事的排最前，纯粹缺字段的排最后。
fn attention_kind_sql() -> String {
    format!(
        "CASE
           WHEN r.status IN ('imported','dismissed') THEN NULL::text
           WHEN NOT ({attention}) THEN NULL::text
           WHEN r.last_import_error IS NOT NULL OR ia.status = 'retryable'
             THEN 'import_failed'
           WHEN ia.status IN ('prepared','sending','uncertain') THEN 'import_pending'
           WHEN r.duplicate_state <> 'unique' OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(r.issues) issue
                  WHERE issue->>'code' IN ('duplicate_duplicate','duplicate_conflict'))
             THEN 'duplicate_suspect'
           WHEN EXISTS (
                  SELECT 1 FROM jsonb_array_elements(r.issues) issue
                  WHERE issue->>'code' IN ('cross_source_candidate','refund_candidate'))
             THEN 'pairing_suggested'
           WHEN EXISTS (
                  SELECT 1 FROM jsonb_array_elements(r.issues) issue
                  WHERE issue->>'code' LIKE 'account_mapping_%')
             OR (r.firefly_type = 'transfer' AND
                 (r.source_account_id IS NULL OR r.destination_account_id IS NULL OR
                  r.source_account_id = r.destination_account_id))
             THEN 'account_unmapped'
           ELSE 'needs_fix' END",
        attention = needs_attention_sql()
    )
}

/// 渠道 key 到中文显示名。认不出来的 key 原样返回，界面上至少不会是空白。
pub(super) fn channel_name(key: &str) -> &str {
    match key {
        "cmb" => "招商银行",
        "alipay" => "支付宝",
        "wechat" => "微信支付",
        "boc" => "中国银行",
        other => other,
    }
}

fn row_json(row: &Row) -> Value {
    let signed = Decimal::from_str(&row.get::<_, String>(5)).unwrap_or_default();
    let issues = public_issues(row);
    let import_attempt = row.get::<_, Option<String>>(34).map(|id| {
        json!({
            "id": id,
            "status": row.get::<_, Option<String>>(35),
            "error_code": row.get::<_, Option<String>>(36),
            "error_message": row.get::<_, Option<String>>(37),
            "retry_after": row.get::<_, Option<String>>(38),
            "transaction_group_id": row.get::<_, Option<i64>>(39).map(|v| v.to_string()),
            "updated_at": row.get::<_, Option<String>>(40),
            // 「这一条是哪一次入账动作写进去的」。新列排在 SELECT 末尾而不是插在
            // 中间：这一串取值全靠下标，插一列会把它后面每一个字段都错开一位。
            "batch_id": row.get::<_, Option<String>>(66),
        })
    });
    let reasons = issues
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|issue| issue["message"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let task = json!({
        "id": row.get::<_, i64>(1).to_string(),
        "source": row.get::<_, String>(28),
        "summary": row.get::<_, Option<String>>(29),
        "received_at": row.get::<_, Option<String>>(30),
    });
    // 属性单独拼一次：serde_json 的 json! 是按键递归展开的，这个对象的键足够多，
    // 塞在外层对象里会顶到宏的递归上限。
    let attributes = json!({
            "bill_task_id": row.get::<_, i64>(1).to_string(),
            "bill_document_id": row.get::<_, i64>(1).to_string(),
            "row_number": row.get::<_, i32>(31),
            "status": row.get::<_, String>(2),
            "occurred_at": row.get::<_, String>(3),
            "counterparty": row.get::<_, Option<String>>(4),
            "direction": if signed.is_sign_negative() { "out" } else { "in" },
            "amount": signed.abs().to_string(),
            "signed_amount": signed.to_string(),
            "currency_code": row.get::<_, String>(6),
            "duplicate_state": row.get::<_, String>(7),
            "duplicate_of_row_id": row.get::<_, Option<i64>>(8).map(|v| v.to_string()),
            "firefly_type": row.get::<_, Option<String>>(9),
            "firefly_date": row.get::<_, Option<String>>(10),
            "firefly_amount": row.get::<_, Option<String>>(11),
            "firefly_description": row.get::<_, Option<String>>(12),
            "source_name": row.get::<_, Option<String>>(13),
            "destination_name": row.get::<_, Option<String>>(14),
            "category_name": row.get::<_, Option<String>>(15),
            "notes": row.get::<_, Option<String>>(16),
            "tags": row.get::<_, Option<Vec<String>>>(17),
            "transaction_group_id": row.get::<_, Option<i64>>(18).map(|v| v.to_string()),
            "error_message": row.get::<_, Option<String>>(19),
            "suggested_by": row.get::<_, Option<String>>(20),
            "user_modified_at": row.get::<_, Option<String>>(21),
            "dismissed_reason": row.get::<_, Option<String>>(22),
            "dismissed_at": row.get::<_, Option<String>>(23),
            "issues": issues,
            "source_locator": row.get::<_, Value>(25),
            "raw_fields": row.get::<_, Value>(26),
            "description": row.get::<_, String>(27),
            "group": row.get::<_, String>(32),
            "attention_kind": row.get::<_, Option<String>>(43),
            "reasons": reasons,
            "task": task,
            "account_hint": row.get::<_, Option<String>>(33),
            "source_account_id": row.get::<_, Option<i64>>(41).map(|v| v.to_string()),
            "destination_account_id": row.get::<_, Option<i64>>(42).map(|v| v.to_string()),
            "import_attempt": import_attempt,
            "pair": pair_json(row),
            "duplicate_of": duplicate_of_json(row),
    });
    json!({
        "id": row.get::<_, i64>(0).to_string(),
        "type": "bill-row",
        "attributes": attributes,
    })
}

/// 库里存的 issue code 和对外下发的 code 不是一套词。库里按「谁写下的」命名
/// （`duplicate_duplicate`、`cross_source_candidate`），对外按「用户要做什么」命名。
/// 三端契约认对外这一套，翻译只在这里做一次。
fn public_issue_code(code: &str) -> &str {
    match code {
        "duplicate_duplicate" | "duplicate_conflict" => "duplicate_suspect",
        "cross_source_candidate" | "refund_candidate" => "pair_suggested",
        other => other,
    }
}

/// 一行的 issue 列表，保证每个元素都有 `code` 和 `message`。
///
/// 除了库里存着的，还按当前字段现补几条：进了待确认却一条 issue 都没有的行，
/// 界面上只能显示「有问题」三个字，用户没有任何可点的下一步。缺什么补什么，
/// 补出来的 code 和存下来的走同一套词表。
fn public_issues(row: &Row) -> Value {
    let mut issues = row
        .get::<_, Value>(24)
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|issue| {
                    let mut issue = issue.clone();
                    let code = issue["code"].as_str().unwrap_or("unknown").to_owned();
                    let message = issue["message"]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| format!("这条流水有一处需要确认（{code}）。"));
                    if let Some(object) = issue.as_object_mut() {
                        object.insert("code".to_owned(), json!(public_issue_code(&code)));
                        object.insert("message".to_owned(), json!(message));
                    }
                    issue
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let mut push = |code: &str, message: String| {
        if !issues.iter().any(|issue| issue["code"] == code) {
            issues.push(json!({ "severity": "warning", "code": code, "message": message }));
        }
    };
    let firefly_type = row.get::<_, Option<String>>(9);
    if firefly_type.is_none() {
        push(
            "missing_type",
            "还不知道这笔是支出、收入还是转账。".to_owned(),
        );
    }
    if row.get::<_, Option<String>>(10).is_none() {
        push(
            "invalid_date",
            format!("日期格式无法识别：{}", row.get::<_, String>(3)),
        );
    }
    if row.get::<_, Option<String>>(11).is_none() {
        push("missing_amount", "这笔没有可入账的金额。".to_owned());
    }
    let description = row
        .get::<_, Option<String>>(12)
        .unwrap_or_else(|| row.get::<_, String>(27));
    if description.trim().is_empty() {
        push("missing_description", "这笔还没有摘要。".to_owned());
    }
    if row.get::<_, String>(7) != "unique" {
        push(
            "duplicate_suspect",
            "发现可能重复的流水，确认之后才能入账。".to_owned(),
        );
    }
    if let Some(error) = row.get::<_, Option<String>>(19) {
        push("import_failed", format!("上次入账没成：{error}"));
    }
    // 支出/收入缺账户不再报问题：入账时系统会替用户把渠道账户建好。转账是人手动改出来的
    // 类型，系统猜不出另一端是谁，只能还给人。
    let source_account_id = row.get::<_, Option<i64>>(41);
    let destination_account_id = row.get::<_, Option<i64>>(42);
    if firefly_type.as_deref() == Some("transfer")
        && (source_account_id.is_none()
            || destination_account_id.is_none()
            || source_account_id == destination_account_id)
    {
        push(
            "transfer_accounts_required",
            "转账要选两个不同的 Firefly 账户。".to_owned(),
        );
    }
    Value::Array(issues)
}

fn row_group(row: &Value) -> &str {
    row["attributes"]["group"].as_str().unwrap_or_default()
}

fn has_issue(row: &Value, code: &str) -> bool {
    row["attributes"]["issues"]
        .as_array()
        .is_some_and(|issues| issues.iter().any(|issue| issue["code"] == code))
}

fn transfer_like_row(row: &Value) -> bool {
    [
        "description",
        "counterparty",
        "source_name",
        "destination_name",
        "account_hint",
    ]
    .iter()
    .filter_map(|field| row["attributes"][field].as_str())
    .map(str::to_ascii_lowercase)
    .any(|value| {
        [
            "转账", "提现", "取现", "充值", "atm", "transfer", "withdraw",
        ]
        .iter()
        .any(|keyword| value.contains(keyword))
    })
}

fn review_candidate(row: &Value, reason: &str) -> Value {
    let attributes = &row["attributes"];
    json!({
        "row_id": row["id"],
        "reason": reason,
        "row_number": attributes["row_number"],
        "status": attributes["status"],
        "occurred_at": attributes["occurred_at"],
        "direction": attributes["direction"],
        "amount": attributes["amount"],
        "firefly_amount": attributes["firefly_amount"],
        "currency_code": attributes["currency_code"],
        "counterparty": attributes["counterparty"],
        "description_preview": attributes["description"],
        "firefly_type": attributes["firefly_type"],
        "source_name": attributes["source_name"],
        "destination_name": attributes["destination_name"],
        "category_name": attributes["category_name"],
        "issues": attributes["issues"],
    })
}

fn validate_date(value: &str) -> Result<String, ApiError> {
    let format = time::format_description::parse_borrowed::<2>("[year]-[month]-[day]")
        .map_err(|error| ApiError::internal(error.to_string()))?;
    time::Date::parse(value, &format)
        .map_err(|_| ApiError::invalid_params("firefly_date 必须是 YYYY-MM-DD。"))?;
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_updates_reject_non_positive_account_ids() {
        for update in [
            RowUpdate {
                source_account_id: Some(0),
                ..RowUpdate::default()
            },
            RowUpdate {
                destination_account_id: Some(-1),
                ..RowUpdate::default()
            },
        ] {
            assert!(
                update
                    .validate()
                    .unwrap_err()
                    .to_string()
                    .contains("必须是正整数")
            );
        }
    }

    #[tokio::test]
    async fn list_rows_accepts_an_i64_document_filter_in_postgres() {
        let Ok(url) = std::env::var("ABEI_TEST_DATABASE_URL") else {
            return;
        };
        let pool = crate::create_pool(url.parse().unwrap(), 2).unwrap();
        crate::initialize(&pool).await.unwrap();
        let config = crate::mailbox::RuntimeConfig::test();
        let mail = crate::mail::Service::new(pool.clone(), config.storage_root().to_path_buf());
        let parser = crate::parser::Service::new(pool.clone(), mail.clone());
        let service = Service::new(
            pool,
            mail,
            parser,
            config.job_secret_cipher(),
            config.reliability(),
            crate::firefly::Firefly::from_env(),
        );

        let response = service
            .list_rows(i64::MAX, None, None, None, 1, 20)
            .await
            .unwrap();
        assert_eq!(response["meta"]["pagination"]["total"], 0);
    }

    #[tokio::test]
    async fn row_edits_and_splits_accept_text_backed_dates_and_amounts_in_postgres() {
        let Ok(url) = std::env::var("ABEI_TEST_DATABASE_URL") else {
            return;
        };
        let pool = crate::create_pool(url.parse().unwrap(), 2).unwrap();
        crate::initialize(&pool).await.unwrap();
        let user_id = 8_110_002_i64;
        let client = pool.get().await.unwrap();
        crate::ensure_test_user(&client, user_id).await;
        let flow = client
            .query_one(
                "SELECT f.id, f.current_version, v.checksum
                 FROM abei_ai.parser_flows f
                 JOIN abei_ai.parser_flow_versions v
                   ON v.flow_id = f.id AND v.version = f.current_version
                 WHERE f.owner_user_id IS NULL AND f.slug = 'cmb-credit-card-daily'",
                &[],
            )
            .await
            .unwrap();
        let flow_id: i64 = flow.get(0);
        let flow_version: i32 = flow.get(1);
        let checksum: String = flow.get(2);
        client
            .execute(
                "INSERT INTO abei_ai.mailboxes (user_id, provider, host, port, encryption)
                 VALUES ($1, 'imap', 'imap.example.com', 993, 'ssl')
                 ON CONFLICT (user_id) DO NOTHING",
                &[&user_id],
            )
            .await
            .unwrap();
        let message_id: i64 = client
            .query_one(
                "INSERT INTO abei_ai.mail_messages
                   (user_id, mailbox_user_id, folder, uid_validity, uid, message_id,
                    content_state, classification, channel_key, parser_flow_id)
                 VALUES ($1,$1,'INBOX',1,1,$2,'cached','matched','cmb',$3)
                 RETURNING id",
                &[
                    &user_id,
                    &format!("row-write-regression-{user_id}@example.com"),
                    &flow_id,
                ],
            )
            .await
            .unwrap()
            .get(0);
        let document_id: i64 = client
            .query_one(
                "INSERT INTO abei_ai.bill_documents
                   (user_id, mail_message_id, channel_key, parser_flow_id, parser_flow_version)
                 VALUES ($1,$2,'cmb',$3,$4) RETURNING id",
                &[&user_id, &message_id, &flow_id, &flow_version],
            )
            .await
            .unwrap()
            .get(0);
        let job_id: i64 = client
            .query_one(
                "INSERT INTO abei_ai.parse_jobs
                   (user_id, bill_document_id, target_revision, parser_flow_id,
                    parser_flow_version, definition_checksum, status, stage, finished_at)
                 VALUES ($1,$2,1,$3,$4,$5,'succeeded','finished',now()) RETURNING id",
                &[&user_id, &document_id, &flow_id, &flow_version, &checksum],
            )
            .await
            .unwrap()
            .get(0);
        client
            .execute(
                "INSERT INTO abei_ai.bill_document_revisions
                   (bill_document_id, revision, parse_job_id, parser_flow_id, parser_flow_version)
                 VALUES ($1,1,$2,$3,$4)",
                &[&document_id, &job_id, &flow_id, &flow_version],
            )
            .await
            .unwrap();
        client
            .execute(
                "UPDATE abei_ai.bill_documents SET active_revision = 1 WHERE id = $1",
                &[&document_id],
            )
            .await
            .unwrap();
        let row_id: i64 = client
            .query_one(
                "INSERT INTO abei_ai.bill_rows
                   (user_id, bill_document_id, revision, row_number, occurred_at,
                    signed_amount, currency_code, description, external_key, fingerprint,
                    firefly_type, firefly_date, firefly_amount)
                 VALUES ($1,$2,1,1,'2026-08-11 08:30:00',-12.34,'CNY','测试商户',
                         'row-write-regression',$3,'withdrawal','2026-08-11',12.34)
                 RETURNING id",
                &[&user_id, &document_id, &"b".repeat(64)],
            )
            .await
            .unwrap()
            .get(0);
        drop(client);

        let config = crate::mailbox::RuntimeConfig::test();
        let mail = crate::mail::Service::new(pool.clone(), config.storage_root().to_path_buf());
        let parser = crate::parser::Service::new(pool.clone(), mail.clone());
        let service = Service::new(
            pool.clone(),
            mail,
            parser,
            config.job_secret_cipher(),
            config.reliability(),
            crate::firefly::Firefly::from_env(),
        );
        let updated = service
            .update_row(
                user_id,
                row_id,
                &RowUpdate {
                    firefly_date: Some("2026-08-12".to_owned()),
                    firefly_amount: Some("12.35".to_owned()),
                    ..RowUpdate::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated["data"]["attributes"]["firefly_date"], "2026-08-12");
        assert_eq!(
            updated["data"]["attributes"]["firefly_amount"],
            "12.35000000"
        );

        service
            .split_row(
                user_id,
                row_id,
                "test",
                &[
                    SplitPart {
                        amount: "5.00".to_owned(),
                        description: "部分一".to_owned(),
                        payment_method: None,
                        source_name: None,
                        destination_name: None,
                        category_name: None,
                    },
                    SplitPart {
                        amount: "7.34".to_owned(),
                        description: "部分二".to_owned(),
                        payment_method: None,
                        source_name: None,
                        destination_name: None,
                        category_name: None,
                    },
                ],
            )
            .await
            .unwrap();
        let split = pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT count(*)::bigint, sum(amount)::text
                 FROM abei_ai.bill_row_splits WHERE bill_row_id = $1",
                &[&row_id],
            )
            .await
            .unwrap();
        assert_eq!(split.get::<_, i64>(0), 2);
        assert_eq!(
            Decimal::from_str(&split.get::<_, String>(1)).unwrap(),
            Decimal::from_str("12.34").unwrap()
        );

        crate::remove_test_user(&pool.get().await.unwrap(), user_id).await;
    }

    #[tokio::test]
    async fn batch_edits_and_account_mapping_refresh_preserve_row_ownership_in_postgres() {
        let Ok(url) = std::env::var("ABEI_TEST_DATABASE_URL") else {
            return;
        };
        let pool = crate::create_pool(url.parse().unwrap(), 2).unwrap();
        crate::initialize(&pool).await.unwrap();
        let user_id = 8_110_003_i64;
        let client = pool.get().await.unwrap();
        crate::ensure_test_user(&client, user_id).await;
        let flow = client
            .query_one(
                "SELECT f.id, f.current_version, v.checksum
                 FROM abei_ai.parser_flows f
                 JOIN abei_ai.parser_flow_versions v
                   ON v.flow_id = f.id AND v.version = f.current_version
                 WHERE f.owner_user_id IS NULL AND f.slug = 'cmb-credit-card-daily'",
                &[],
            )
            .await
            .unwrap();
        let flow_id: i64 = flow.get(0);
        let flow_version: i32 = flow.get(1);
        let checksum: String = flow.get(2);
        client
            .execute(
                "INSERT INTO abei_ai.mailboxes (user_id, provider, host, port, encryption)
                 VALUES ($1, 'imap', 'imap.example.com', 993, 'ssl')
                 ON CONFLICT (user_id) DO NOTHING",
                &[&user_id],
            )
            .await
            .unwrap();
        let message_id: i64 = client
            .query_one(
                "INSERT INTO abei_ai.mail_messages
                   (user_id, mailbox_user_id, folder, uid_validity, uid, message_id,
                    content_state, classification, channel_key, parser_flow_id)
                 VALUES ($1,$1,'INBOX',1,1,$2,'cached','matched','cmb',$3)
                 RETURNING id",
                &[
                    &user_id,
                    &format!("row-batch-mapping-regression-{user_id}@example.com"),
                    &flow_id,
                ],
            )
            .await
            .unwrap()
            .get(0);
        let document_id: i64 = client
            .query_one(
                "INSERT INTO abei_ai.bill_documents
                   (user_id, mail_message_id, channel_key, parser_flow_id, parser_flow_version)
                 VALUES ($1,$2,'cmb',$3,$4) RETURNING id",
                &[&user_id, &message_id, &flow_id, &flow_version],
            )
            .await
            .unwrap()
            .get(0);
        let job_id: i64 = client
            .query_one(
                "INSERT INTO abei_ai.parse_jobs
                   (user_id, bill_document_id, target_revision, parser_flow_id,
                    parser_flow_version, definition_checksum, status, stage, finished_at)
                 VALUES ($1,$2,1,$3,$4,$5,'succeeded','finished',now()) RETURNING id",
                &[&user_id, &document_id, &flow_id, &flow_version, &checksum],
            )
            .await
            .unwrap()
            .get(0);
        client
            .execute(
                "INSERT INTO abei_ai.bill_document_revisions
                   (bill_document_id, revision, parse_job_id, parser_flow_id, parser_flow_version)
                 VALUES ($1,1,$2,$3,$4)",
                &[&document_id, &job_id, &flow_id, &flow_version],
            )
            .await
            .unwrap();
        client
            .execute(
                "UPDATE abei_ai.bill_documents SET active_revision = 1 WHERE id = $1",
                &[&document_id],
            )
            .await
            .unwrap();
        let mapping_issue = json!([{
            "severity": "warning",
            "code": "account_mapping_required",
            "message": "mapping required",
            "node_id": null,
            "locator": null
        }, {
            "severity": "warning",
            "code": "keep_me",
            "message": "unrelated",
            "node_id": null,
            "locator": null
        }]);
        let rows = client
            .query(
                "INSERT INTO abei_ai.bill_rows
                   (user_id, bill_document_id, revision, row_number, occurred_at,
                    signed_amount, currency_code, description, account_hint, external_key,
                    fingerprint, status, issues, firefly_type, firefly_date, firefly_amount,
                    category_name, user_modified_at)
                 VALUES
                   ($1,$2,1,1,'2026-08-11 08:30:00',-10,'CNY','pending row',
                    '招商银行储蓄卡(8705)','batch-pending',repeat('c',64),'pending',
                    $3,'withdrawal','2026-08-11',10,'pending-original',NULL),
                   ($1,$2,1,2,'2026-08-11 08:31:00',-20,'CNY','imported row',NULL,
                    'batch-imported',repeat('d',64),'imported','[]',
                    'withdrawal','2026-08-11',20,'imported-original',NULL),
                   ($1,$2,1,3,'2026-08-11 08:32:00',-30,'CNY','dismissed row',NULL,
                    'batch-dismissed',repeat('e',64),'dismissed','[]',
                    'withdrawal','2026-08-11',30,'dismissed-original',NULL),
                   ($1,$2,1,4,'2026-08-11 08:33:00',-40,'CNY','manual row',NULL,
                    'batch-manual',repeat('f',64),'pending','[]',
                    'withdrawal','2026-08-11',40,'manual-original',now())
                 RETURNING id, row_number",
                &[&user_id, &document_id, &mapping_issue],
            )
            .await
            .unwrap();
        let row_ids = rows
            .iter()
            .map(|row| row.get::<_, i64>(0))
            .collect::<Vec<_>>();
        let pending_row_id = rows
            .iter()
            .find(|row| row.get::<_, i32>(1) == 1)
            .unwrap()
            .get::<_, i64>(0);
        drop(client);

        let config = crate::mailbox::RuntimeConfig::test();
        let mail = crate::mail::Service::new(pool.clone(), config.storage_root().to_path_buf());
        let parser = crate::parser::Service::new(pool.clone(), mail.clone());
        let service = Service::new(
            pool.clone(),
            mail,
            parser,
            config.job_secret_cipher(),
            config.reliability(),
            crate::firefly::Firefly::from_env(),
        );

        let updated = service
            .update_rows_many(
                user_id,
                &row_ids,
                &RowUpdate {
                    category_name: Some("AI category".to_owned()),
                    as_suggestion: true,
                    ..RowUpdate::default()
                },
            )
            .await
            .unwrap();
        assert_eq!(updated["affected_count"], 1);
        assert_eq!(updated["skipped"], 3);
        let categories = pool
            .get()
            .await
            .unwrap()
            .query(
                "SELECT row_number, category_name, suggested_by
                 FROM abei_ai.bill_rows WHERE user_id = $1 ORDER BY row_number",
                &[&user_id],
            )
            .await
            .unwrap()
            .into_iter()
            .map(|row| {
                (
                    row.get::<_, i32>(0),
                    row.get::<_, Option<String>>(1),
                    row.get::<_, Option<String>>(2),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            categories,
            vec![
                (1, Some("AI category".to_owned()), Some("ai".to_owned())),
                (2, Some("imported-original".to_owned()), None),
                (3, Some("dismissed-original".to_owned()), None),
                (4, Some("manual-original".to_owned()), None),
            ]
        );

        let first = service
            .upsert_account_mapping(
                user_id,
                "cmb",
                "招商银行储蓄卡(8705)",
                101,
                "招商银行储蓄卡",
                Some("asset"),
            )
            .await
            .unwrap();
        let first_id = first["data"]["id"]
            .as_str()
            .unwrap()
            .parse::<i64>()
            .unwrap();
        assert_mapping_state(
            &pool,
            pending_row_id,
            Some(101),
            Some("招商银行储蓄卡"),
            None,
        )
        .await;

        let second = service
            .upsert_account_mapping(
                user_id,
                "cmb",
                "招商银行储蓄卡",
                202,
                "招商银行信用卡",
                Some("credit"),
            )
            .await
            .unwrap();
        let second_id = second["data"]["id"]
            .as_str()
            .unwrap()
            .parse::<i64>()
            .unwrap();
        assert_mapping_state(
            &pool,
            pending_row_id,
            None,
            None,
            Some("account_mapping_ambiguous"),
        )
        .await;

        service
            .delete_account_mapping(user_id, second_id)
            .await
            .unwrap();
        assert_mapping_state(
            &pool,
            pending_row_id,
            Some(101),
            Some("招商银行储蓄卡"),
            None,
        )
        .await;

        service
            .delete_account_mapping(user_id, first_id)
            .await
            .unwrap();
        // 映射删光之后账户被摘掉，但这不再是一条要人处理的问题：入账那一步会替用户
        // 把渠道账户建回来。留在行上的只有本来就无关的那条 keep_me。
        assert_mapping_state(&pool, pending_row_id, None, None, None).await;

        let listed = service
            .list_account_mappings(user_id, Some("cmb"))
            .await
            .unwrap();
        assert_eq!(listed["data"][0]["id"], "pending:cmb:招商银行储蓄卡(8705)");
        assert_eq!(
            listed["data"][0]["attributes"]["mapping_status"],
            "unmapped"
        );

        let dismissed = service
            .dismiss_rows(user_id, &[pending_row_id], false, Some("manual review"))
            .await
            .unwrap();
        assert_eq!(dismissed["affected_count"], 1);
        assert_eq!(dismissed["reason"], "manual review");
        let dismissed_state = pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT status, dismissed_reason, dismissed_at IS NOT NULL
                 FROM abei_ai.bill_rows WHERE id = $1",
                &[&pending_row_id],
            )
            .await
            .unwrap();
        assert_eq!(dismissed_state.get::<_, String>(0), "dismissed");
        assert_eq!(
            dismissed_state.get::<_, Option<String>>(1).as_deref(),
            Some("manual review")
        );
        assert!(dismissed_state.get::<_, bool>(2));

        let restored = service
            .restore_rows(user_id, &[pending_row_id])
            .await
            .unwrap();
        assert_eq!(restored["affected_count"], 1);
        let restored_state = pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT status, dismissed_reason, dismissed_at
                 FROM abei_ai.bill_rows WHERE id = $1",
                &[&pending_row_id],
            )
            .await
            .unwrap();
        assert_eq!(restored_state.get::<_, String>(0), "pending");
        assert_eq!(restored_state.get::<_, Option<String>>(1), None);
        assert_eq!(
            restored_state.get::<_, Option<std::time::SystemTime>>(2),
            None
        );

        let transfer_row_id: i64 = pool
            .get()
            .await
            .unwrap()
            .query_one(
                "INSERT INTO abei_ai.bill_rows
                   (user_id, bill_document_id, revision, row_number, occurred_at,
                    signed_amount, currency_code, description, external_key, fingerprint,
                    status, issues, firefly_date, firefly_amount, firefly_description)
                 VALUES ($1,$2,1,5,'2026-08-11 08:34:00',-2952.95,'CNY','微信零钱提现',
                         'missing-transfer-type',repeat('a',64),'pending','[]',
                         '2026-08-11',2952.95,'微信零钱提现')
                 RETURNING id",
                &[&user_id, &document_id],
            )
            .await
            .unwrap()
            .get(0);
        let review = service.document_review(user_id, document_id).await.unwrap();
        let has_row = |path: &str| {
            review
                .pointer(path)
                .and_then(Value::as_array)
                .is_some_and(|rows| {
                    rows.iter().any(|row| {
                        row.get("id")
                            .or_else(|| row.get("row_id"))
                            .and_then(Value::as_str)
                            .is_some_and(|id| id == transfer_row_id.to_string())
                    })
                })
        };
        assert!(has_row("/data/groups/attention"));
        assert!(!has_row("/data/groups/importable"));
        assert!(has_row("/transfer_candidates"));
        assert!(has_row("/needs_user_note"));

        crate::remove_test_user(&pool.get().await.unwrap(), user_id).await;
    }

    async fn assert_mapping_state(
        pool: &deadpool_postgres::Pool,
        row_id: i64,
        expected_account_id: Option<i64>,
        expected_account_name: Option<&str>,
        expected_mapping_issue: Option<&str>,
    ) {
        let row = pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT source_account_id, source_name, issues
                 FROM abei_ai.bill_rows WHERE id = $1",
                &[&row_id],
            )
            .await
            .unwrap();
        assert_eq!(row.get::<_, Option<i64>>(0), expected_account_id);
        assert_eq!(
            row.get::<_, Option<String>>(1).as_deref(),
            expected_account_name
        );
        let issues: Value = row.get(2);
        let codes = issues
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|issue| issue["code"].as_str())
            .collect::<Vec<_>>();
        assert!(codes.contains(&"keep_me"));
        assert_eq!(
            codes
                .iter()
                .copied()
                .find(|code| code.starts_with("account_mapping_")),
            expected_mapping_issue
        );
    }

    fn test_service(pool: &deadpool_postgres::Pool) -> Service {
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

    /// 取出这一行在列表里的 attributes。
    fn attributes_of(list: &Value, row_id: i64) -> Value {
        let wanted = row_id.to_string();
        list["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"].as_str() == Some(wanted.as_str()))
            .unwrap_or_else(|| panic!("列表里没有 {row_id}"))["attributes"]
            .clone()
    }

    /// 列表要能一眼看出「这一笔和另一笔是一件事」，配对和判重的对侧就得随行下发。
    ///
    /// 以前这两样都只有 id：配对得再发一趟 `/links` 才知道另一笔长什么样，判重
    /// 更是只有一句「和已有交易很像」。界面于是既标不出「已合并」，也摆不出对比。
    #[tokio::test]
    async fn a_row_carries_the_other_side_of_its_pairing_and_of_its_duplicate() {
        let Some(pool) = crate::testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_026_i64;
        let fixture = crate::testdb::seed(&client, user_id).await;

        let other_row_id: i64 = client
            .query_one(
                "INSERT INTO abei_ai.bill_rows
                   (user_id, bill_document_id, revision, row_number, occurred_at,
                    signed_amount, currency_code, description, external_key, fingerprint,
                    counterparty, status, issues, firefly_type, firefly_date, firefly_amount,
                    firefly_description)
                 VALUES ($1,$2,1,7,'2026-08-11 08:30:00',-12.34,'CNY','微信支付-测试商户',
                         $3,$4,'测试商户','pending','[]','withdrawal','2026-08-11',12.34,
                         '测试商户')
                 RETURNING id",
                &[
                    &user_id,
                    &fixture.document_id,
                    &format!("pair-{user_id}"),
                    &format!("{:064x}", user_id + 1),
                ],
            )
            .await
            .unwrap()
            .get(0);
        let (left, right) = if fixture.row_id < other_row_id {
            (fixture.row_id, other_row_id)
        } else {
            (other_row_id, fixture.row_id)
        };
        client
            .execute(
                "INSERT INTO abei_ai.bill_row_links
                   (user_id, left_row_id, right_row_id, relation, confidence, evidence,
                    state, decided_by, decided_at, merged_row_id)
                 VALUES ($1,$2,$3,'cross_source_candidate',0.9900,'{}'::jsonb,
                         'confirmed','auto',now(),$3)",
                &[&user_id, &left, &right],
            )
            .await
            .unwrap();
        client
            .execute(
                "UPDATE abei_ai.bill_rows
                 SET duplicate_state = 'duplicate', duplicate_of_row_id = $2
                 WHERE id = $1",
                &[&fixture.row_id, &other_row_id],
            )
            .await
            .unwrap();

        let service = test_service(&pool);
        let list = service
            .list_rows(user_id, None, None, None, 1, 50)
            .await
            .unwrap();
        let attributes = attributes_of(&list, fixture.row_id);

        let pair = &attributes["pair"];
        assert_eq!(pair["state"], "confirmed");
        assert_eq!(pair["decided_by"], "auto", "自动合并要认得出是系统做的");
        assert_eq!(pair["other"]["id"], other_row_id.to_string());
        assert_eq!(pair["other"]["channel_key"], "cmb");
        // numeric::text 带着列上的小数位，和行自己的 signed_amount 是同一套格式
        assert_eq!(
            pair["other"]["signed_amount"]
                .as_str()
                .and_then(|value| value.parse::<f64>().ok()),
            Some(-12.34)
        );

        let dup = &attributes["duplicate_of"];
        assert_eq!(dup["id"], other_row_id.to_string());
        assert_eq!(dup["description"], "微信支付-测试商户");
        assert_eq!(dup["counterparty"], "测试商户");

        // 没有配对、没有判重的行两个字段都是 null，前端据此不渲染任何标记。
        let plain = attributes_of(&list, other_row_id);
        assert!(plain["duplicate_of"].is_null());

        crate::remove_test_user(&pool.get().await.unwrap(), user_id).await;
    }

    /// 分组判定只能有一份。以前列表里的 CASE 看最新一条尝试、tab 计数那边用 EXISTS
    /// 扫全部历史，于是「以前重试过、最新一条已经 rejected」的行在两处对不上号。
    #[tokio::test]
    async fn one_row_lands_in_the_same_group_in_the_list_and_in_the_counts() {
        let Some(pool) = crate::testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_020_i64;
        let fixture = crate::testdb::seed(&client, user_id).await;

        // 第一次重试过，第二次被明确拒绝——历史里有 retryable，最新一条不是。
        for (attempt_no, status) in [(1_i32, "retryable"), (2, "rejected")] {
            client
                .execute(
                    "INSERT INTO abei_ai.bill_import_attempts
                       (id, user_id, bill_row_id, attempt_no, status, external_id,
                        payload_hash, payload_snapshot)
                     VALUES ($1,$2,$3,$4,$5,$1, repeat('0',64), '{}'::jsonb)",
                    &[
                        &uuid::Uuid::new_v4().to_string(),
                        &user_id,
                        &fixture.row_id,
                        &attempt_no,
                        &status,
                    ],
                )
                .await
                .unwrap();
        }

        let service = test_service(&pool);
        let list = service
            .list_rows(user_id, None, None, None, 1, 50)
            .await
            .unwrap();
        let attributes = attributes_of(&list, fixture.row_id);
        let group = attributes["group"].as_str().unwrap().to_owned();
        assert_eq!(group, "importable", "最新一条是 rejected，不该再算待确认");
        assert!(
            attributes["attention_kind"].is_null(),
            "不是待确认的行，attention_kind 必须是 null"
        );

        // 同一行在概览计数里必须落进同一个分组。
        let summary = service.inbox_summary(user_id).await.unwrap();
        assert_eq!(summary["counts"][&group], 1, "计数口径要和列表一致");
        assert_eq!(summary["counts"]["attention"], 0);

        // 逐渠道加起来等于总数，而且渠道条带中文名。
        let channel = &summary["channels"].as_array().unwrap()[0];
        assert_eq!(channel["key"], "cmb");
        assert_eq!(channel["name"], "招商银行");
        assert_eq!(channel["counts"][&group], 1);

        // 按分组过滤拿到的行，自己报的分组也得是这个。
        for name in ["importable", "attention", "dismissed", "imported"] {
            let filtered = service
                .list_rows(user_id, Some(name), None, None, 1, 50)
                .await
                .unwrap();
            for item in filtered["data"].as_array().unwrap() {
                assert_eq!(item["attributes"]["group"], name, "过滤和 CASE 必须同源");
            }
        }

        crate::testdb::cleanup(&client, user_id).await;
    }

    /// 归档过的文档不该再出现在收件箱里，但点名看它的时候还得看得见。
    #[tokio::test]
    async fn archived_documents_leave_the_inbox_but_stay_readable_by_id() {
        let Some(pool) = crate::testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_021_i64;
        let fixture = crate::testdb::seed(&client, user_id).await;
        client
            .execute(
                "UPDATE abei_ai.bill_documents SET lifecycle = 'archived' WHERE id = $1",
                &[&fixture.document_id],
            )
            .await
            .unwrap();

        let service = test_service(&pool);
        let all = service
            .list_rows(user_id, None, None, None, 1, 50)
            .await
            .unwrap();
        assert_eq!(
            all["meta"]["pagination"]["total"], 0,
            "归档的不该还在列表里"
        );

        let named = service
            .list_rows(user_id, None, None, Some(fixture.document_id), 1, 50)
            .await
            .unwrap();
        assert_eq!(named["meta"]["pagination"]["total"], 1, "点名要看得见");

        let summary = service.inbox_summary(user_id).await.unwrap();
        for name in ["importable", "attention", "dismissed", "imported"] {
            assert_eq!(summary["counts"][name], 0, "归档的不该再计数");
        }

        crate::testdb::cleanup(&client, user_id).await;
    }

    /// 日期读不出来的行必须带一条能读懂的 issue，前端才有话可说。
    #[tokio::test]
    async fn a_row_with_an_unreadable_date_says_so_with_a_code() {
        let Some(pool) = crate::testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_022_i64;
        let fixture = crate::testdb::seed(&client, user_id).await;
        client
            .execute(
                "UPDATE abei_ai.bill_rows
                 SET occurred_at = '八月十一号', firefly_date = NULL WHERE id = $1",
                &[&fixture.row_id],
            )
            .await
            .unwrap();

        let list = test_service(&pool)
            .list_rows(user_id, None, None, None, 1, 50)
            .await
            .unwrap();
        let attributes = attributes_of(&list, fixture.row_id);
        assert_eq!(attributes["group"], "attention");
        assert_eq!(attributes["attention_kind"], "needs_fix");
        let issue = attributes["issues"]
            .as_array()
            .unwrap()
            .iter()
            .find(|issue| issue["code"] == "invalid_date")
            .expect("日期读不出来要有 invalid_date")
            .clone();
        assert!(
            issue["message"].as_str().unwrap().contains("八月十一号"),
            "提示里要带上原文，用户才知道是哪一行的哪个字段"
        );

        crate::testdb::cleanup(&client, user_id).await;
    }
}
