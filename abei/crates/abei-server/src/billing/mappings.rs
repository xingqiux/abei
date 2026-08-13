use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};
use tokio_postgres::Transaction;

use super::Service;
use crate::ApiError;

/// 解析器给出的账户名称常带空格、全角标点或卡号后缀。保留原文展示，
/// 但查询映射时使用稳定候选；多个候选命中不同账户时由调用方阻塞并提示歧义。
pub(crate) fn hint_candidates(value: &str) -> Vec<String> {
    let raw = value.trim();
    if raw.is_empty() {
        return Vec::new();
    }
    let mut values = Vec::new();
    push_unique(&mut values, raw.to_owned());
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    push_unique(&mut values, collapsed.clone());
    let folded = fold_punctuation(&collapsed);
    push_unique(&mut values, folded.clone());
    push_unique(&mut values, folded.replace(' ', ""));
    let alias = raw
        .replace("微信零钱", "微信钱包")
        .replace("微信余额", "微信钱包");
    push_unique(&mut values, alias.clone());
    push_unique(&mut values, fold_punctuation(&alias));
    if let Some(index) = raw.find(['(', '（']) {
        let suffix = &raw[index..];
        if suffix.chars().any(|ch| ch.is_ascii_digit()) {
            push_unique(&mut values, raw[..index].trim().to_owned());
        }
    }
    values
}

pub(crate) fn hints_match(left: &str, right: &str) -> bool {
    let right = hint_candidates(right);
    hint_candidates(left)
        .iter()
        .any(|candidate| right.contains(candidate))
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.iter().any(|item| item == &value) {
        values.push(value);
    }
}

fn fold_punctuation(value: &str) -> String {
    value
        .chars()
        .map(|ch| match ch {
            '（' | '【' | '[' => '(',
            '）' | '】' | ']' => ')',
            '－' | '—' | '–' | '_' => '-',
            '，' | '、' => ',',
            other => other,
        })
        .collect()
}

impl Service {
    pub(crate) async fn list_account_mappings(
        &self,
        user_id: i64,
        channel: Option<&str>,
    ) -> Result<Value, ApiError> {
        let channel = channel.unwrap_or("").trim();
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let mappings = client
            .query(
                "SELECT id, channel_key, account_hint, firefly_account_id,
                        firefly_account_name, firefly_account_type, source,
                        last_verified_at::text, created_at::text, updated_at::text
                 FROM abei_ai.bill_account_mappings m
                 WHERE m.user_id = $1 AND ($2 = '' OR m.channel_key = $2)
                 ORDER BY m.channel_key, m.account_hint, m.id",
                &[&user_id, &channel],
            )
            .await
            .map_err(ApiError::database)?;
        let pending = client
            .query(
                "SELECT d.channel_key, r.account_hint, count(*)::bigint
                 FROM abei_ai.bill_rows r
                 JOIN abei_ai.bill_documents d ON d.id = r.bill_document_id
                 WHERE r.user_id = $1 AND r.status = 'pending'
                   AND d.lifecycle = 'active' AND d.active_revision = r.revision
                   AND r.account_hint IS NOT NULL AND btrim(r.account_hint) <> ''
                   AND ($2 = '' OR d.channel_key = $2)
                 GROUP BY d.channel_key, r.account_hint
                 ORDER BY d.channel_key, r.account_hint",
                &[&user_id, &channel],
            )
            .await
            .map_err(ApiError::database)?;
        let mut used = BTreeSet::new();
        let mut data = Vec::new();
        for pending_row in pending {
            let pending_channel: String = pending_row.get(0);
            let raw_hint: String = pending_row.get(1);
            let usage_count: i64 = pending_row.get(2);
            let candidates = hint_candidates(&raw_hint);
            let matched = mappings
                .iter()
                .filter(|mapping| {
                    mapping.get::<_, String>(1) == pending_channel
                        && hints_match(&raw_hint, &mapping.get::<_, String>(2))
                })
                .collect::<Vec<_>>();
            used.extend(matched.iter().map(|mapping| mapping.get::<_, i64>(0)));
            let accounts = matched
                .iter()
                .map(|mapping| mapping.get::<_, i64>(3))
                .collect::<BTreeSet<_>>();
            let unique = (accounts.len() == 1).then(|| matched[0]);
            let status = match accounts.len() {
                0 => "unmapped",
                1 => "mapped",
                _ => "ambiguous",
            };
            data.push(json!({
                "id": unique.map(|mapping| mapping.get::<_, i64>(0).to_string())
                    .unwrap_or_else(|| format!("pending:{pending_channel}:{raw_hint}")),
                "type": "bill-account-mapping",
                "attributes": {
                    "channel_key": pending_channel,
                    "account_hint": raw_hint,
                    "firefly_account_id": unique.map(|mapping| mapping.get::<_, i64>(3).to_string()),
                    "firefly_account_name": unique.map(|mapping| mapping.get::<_, String>(4)),
                    "firefly_account_type": unique.and_then(|mapping| mapping.get::<_, Option<String>>(5)),
                    "source": unique.map(|mapping| mapping.get::<_, String>(6)),
                    "last_verified_at": unique.and_then(|mapping| mapping.get::<_, Option<String>>(7)),
                    "created_at": unique.map(|mapping| mapping.get::<_, String>(8)),
                    "updated_at": unique.map(|mapping| mapping.get::<_, String>(9)),
                    "usage_count": usage_count,
                    "mapping_status": status,
                    "normalized_hints": candidates,
                    "candidate_mappings": matched.iter().map(|mapping| json!({
                        "id": mapping.get::<_, i64>(0).to_string(),
                        "account_hint": mapping.get::<_, String>(2),
                        "firefly_account_id": mapping.get::<_, i64>(3).to_string(),
                        "firefly_account_name": mapping.get::<_, String>(4),
                    })).collect::<Vec<_>>(),
                }
            }));
        }
        for mapping in mappings
            .iter()
            .filter(|mapping| !used.contains(&mapping.get::<_, i64>(0)))
        {
            let hint = mapping.get::<_, String>(2);
            data.push(json!({
                "id": mapping.get::<_, i64>(0).to_string(),
                "type": "bill-account-mapping",
                "attributes": {
                    "channel_key": mapping.get::<_, String>(1),
                    "account_hint": hint,
                    "firefly_account_id": mapping.get::<_, i64>(3).to_string(),
                    "firefly_account_name": mapping.get::<_, String>(4),
                    "firefly_account_type": mapping.get::<_, Option<String>>(5),
                    "source": mapping.get::<_, String>(6),
                    "last_verified_at": mapping.get::<_, Option<String>>(7),
                    "created_at": mapping.get::<_, String>(8),
                    "updated_at": mapping.get::<_, String>(9),
                    "usage_count": 0,
                    "mapping_status": "mapped",
                    "normalized_hints": hint_candidates(&hint),
                    "candidate_mappings": [],
                }
            }));
        }
        Ok(json!({ "data": data }))
    }

    pub(crate) async fn upsert_account_mapping(
        &self,
        user_id: i64,
        channel_key: &str,
        account_hint: &str,
        firefly_account_id: i64,
        firefly_account_name: &str,
        firefly_account_type: Option<&str>,
    ) -> Result<Value, ApiError> {
        let channel_key = channel_key.trim();
        let account_hint = account_hint.trim();
        let account_name = firefly_account_name.trim();
        if channel_key.is_empty() || channel_key.len() > 80 {
            return Err(ApiError::invalid_params(
                "channel_key 必须是 1 到 80 字节。",
            ));
        }
        if account_hint.is_empty() || account_hint.len() > 255 {
            return Err(ApiError::invalid_params(
                "account_hint 必须是 1 到 255 字节。",
            ));
        }
        if firefly_account_id <= 0 || account_name.is_empty() || account_name.len() > 255 {
            return Err(ApiError::invalid_params("Firefly 账户信息不完整。"));
        }
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let id: i64 = transaction
            .query_one(
                "INSERT INTO abei_ai.bill_account_mappings
                   (user_id, channel_key, account_hint, firefly_account_id,
                    firefly_account_name, firefly_account_type, source, last_verified_at)
                 VALUES ($1,$2,$3,$4,$5,$6,'user',now())
                 ON CONFLICT (user_id, channel_key, account_hint) DO UPDATE SET
                   firefly_account_id = EXCLUDED.firefly_account_id,
                   firefly_account_name = EXCLUDED.firefly_account_name,
                   firefly_account_type = EXCLUDED.firefly_account_type,
                   source = 'user', last_verified_at = now(), updated_at = now()
                 RETURNING id",
                &[
                    &user_id,
                    &channel_key,
                    &account_hint,
                    &firefly_account_id,
                    &account_name,
                    &firefly_account_type,
                ],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        refresh_pending_mappings(&transaction, user_id, channel_key).await?;
        transaction.commit().await.map_err(ApiError::database)?;
        self.get_account_mapping(user_id, id).await
    }

    pub(crate) async fn delete_account_mapping(
        &self,
        user_id: i64,
        id: i64,
    ) -> Result<Value, ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let mapping = transaction
            .query_opt(
                "DELETE FROM abei_ai.bill_account_mappings
                 WHERE user_id = $1 AND id = $2
                 RETURNING channel_key, account_hint, firefly_account_id",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("账户映射不存在。"))?;
        let channel: String = mapping.get(0);
        refresh_pending_mappings(&transaction, user_id, &channel).await?;
        transaction.commit().await.map_err(ApiError::database)?;
        Ok(json!({ "deleted": true, "id": id.to_string() }))
    }

    async fn get_account_mapping(&self, user_id: i64, id: i64) -> Result<Value, ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT id, channel_key, account_hint, firefly_account_id,
                        firefly_account_name, firefly_account_type, source,
                        last_verified_at::text, created_at::text, updated_at::text
                 FROM abei_ai.bill_account_mappings WHERE user_id = $1 AND id = $2",
                &[&user_id, &id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("账户映射不存在。"))?;
        Ok(json!({ "data": {
            "id": row.get::<_, i64>(0).to_string(),
            "type": "bill-account-mapping",
            "attributes": {
                "channel_key": row.get::<_, String>(1),
                "account_hint": row.get::<_, String>(2),
                "firefly_account_id": row.get::<_, i64>(3).to_string(),
                "firefly_account_name": row.get::<_, String>(4),
                "firefly_account_type": row.get::<_, Option<String>>(5),
                "source": row.get::<_, String>(6),
                "last_verified_at": row.get::<_, Option<String>>(7),
                "created_at": row.get::<_, String>(8),
                "updated_at": row.get::<_, String>(9),
            }
        } }))
    }
}

async fn refresh_pending_mappings(
    transaction: &Transaction<'_>,
    user_id: i64,
    channel: &str,
) -> Result<(), ApiError> {
    let mappings = transaction
        .query(
            "SELECT account_hint, firefly_account_id, firefly_account_name
             FROM abei_ai.bill_account_mappings
             WHERE user_id = $1 AND channel_key = $2 ORDER BY id",
            &[&user_id, &channel],
        )
        .await
        .map_err(ApiError::database)?;
    let rows = transaction
        .query(
            "SELECT r.id, r.account_hint, r.signed_amount < 0, r.issues
             FROM abei_ai.bill_rows r
             JOIN abei_ai.bill_documents d ON d.id = r.bill_document_id
             WHERE r.user_id = $1 AND d.channel_key = $2 AND r.status = 'pending'
               AND d.lifecycle = 'active' AND d.active_revision = r.revision
               AND r.account_hint IS NOT NULL AND btrim(r.account_hint) <> ''
             FOR UPDATE OF r",
            &[&user_id, &channel],
        )
        .await
        .map_err(ApiError::database)?;
    for row in rows {
        let row_id: i64 = row.get(0);
        let hint: String = row.get(1);
        let outgoing: bool = row.get(2);
        let accounts = mappings
            .iter()
            .filter(|mapping| hints_match(&hint, &mapping.get::<_, String>(0)))
            .map(|mapping| (mapping.get::<_, i64>(1), mapping.get::<_, String>(2)))
            .collect::<BTreeMap<_, _>>();
        let mapping = (accounts.len() == 1)
            .then(|| {
                accounts
                    .first_key_value()
                    .map(|(id, name)| (*id, name.clone()))
            })
            .flatten();
        let mut issues: Value = row.get(3);
        let issue_values = issues
            .as_array_mut()
            .ok_or_else(|| ApiError::internal("流水 issues 损坏。"))?;
        issue_values.retain(|issue| {
            !matches!(
                issue["code"].as_str(),
                Some("account_mapping_required" | "account_mapping_ambiguous")
            )
        });
        if mapping.is_none() {
            let (code, message) = if accounts.is_empty() {
                ("account_mapping_required", "入账前需要选择 Firefly 账户。")
            } else {
                (
                    "account_mapping_ambiguous",
                    "账户提示命中了多个不同的 Firefly 账户，请先明确选择。",
                )
            };
            issue_values.push(json!({
                "severity": "warning", "code": code, "message": message,
                "node_id": null, "locator": null,
            }));
        }
        let (account_id, account_name) = mapping
            .map(|(id, name)| (Some(id), Some(name)))
            .unwrap_or((None, None));
        transaction
            .execute(
                "UPDATE abei_ai.bill_rows SET
                   source_account_id = CASE WHEN $3 THEN $4 ELSE source_account_id END,
                   source_name = CASE WHEN $3 THEN $5 ELSE source_name END,
                   destination_account_id = CASE WHEN NOT $3 THEN $4 ELSE destination_account_id END,
                   destination_name = CASE WHEN NOT $3 THEN $5 ELSE destination_name END,
                   issues = $6, updated_at = now()
                 WHERE user_id = $1 AND id = $2",
                &[&user_id, &row_id, &outgoing, &account_id, &account_name, &issues],
            )
            .await
            .map_err(ApiError::database)?;
    }
    Ok(())
}
