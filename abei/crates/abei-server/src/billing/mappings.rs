use std::collections::{BTreeMap, BTreeSet};

use axum::http::Method;
use serde_json::{Value, json};
use tokio_postgres::Transaction;

use super::Service;
use crate::ApiError;
use crate::firefly::{self, WriteError};

/// 映射已生效，可以拿来给流水盖账户。
const ACTIVE: &str = "active";
/// 映射指向 Firefly 里一个同名的既有账户，等用户点一次头才生效。
const PENDING_CONFIRMATION: &str = "pending_confirmation";
/// 这条映射是系统在入账时自己建的，不是人配的。
const SOURCE_AUTO: &str = "auto";

pub(crate) mod reasons {
    /// 渠道对应的账户在 Firefly 里已经有一个同名的，要用户点一次头才敢用。
    pub(crate) const CHANNEL_ACCOUNT_UNCONFIRMED: &str = "channel_account_unconfirmed";
    /// 这条待确认记录不存在，或者不属于这个用户。
    pub(crate) const CHANNEL_ACCOUNT_NOT_FOUND: &str = "channel_account_not_found";
    /// 干跑时发现渠道账户还不存在：真入账会自动新建，预览只报告不动手。
    pub(crate) const CHANNEL_ACCOUNT_AUTO_CREATE: &str = "channel_account_auto_create";
}

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
                        last_verified_at::text, created_at::text, updated_at::text,
                        state
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
                        && mapping.get::<_, String>(10) == ACTIVE
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
                    "state": unique.map(|mapping| mapping.get::<_, String>(10)),
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
                    "state": mapping.get::<_, String>(10),
                    "last_verified_at": mapping.get::<_, Option<String>>(7),
                    "created_at": mapping.get::<_, String>(8),
                    "updated_at": mapping.get::<_, String>(9),
                    "usage_count": 0,
                    "mapping_status": if mapping.get::<_, String>(10) == ACTIVE {
                        "mapped"
                    } else {
                        "pending_confirmation"
                    },
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
                    firefly_account_name, firefly_account_type, source, last_verified_at, state)
                 VALUES ($1,$2,$3,$4,$5,$6,'user',now(),'active')
                 ON CONFLICT (user_id, channel_key, account_hint) DO UPDATE SET
                   firefly_account_id = EXCLUDED.firefly_account_id,
                   firefly_account_name = EXCLUDED.firefly_account_name,
                   firefly_account_type = EXCLUDED.firefly_account_type,
                   source = 'user', last_verified_at = now(), updated_at = now(),
                   -- 人自己挑的账户就是最终答案，不用再确认一遍
                   state = 'active'
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

    /// 入账前替这一行把账户备好。
    ///
    /// 「渠道要先手工映射到一个 Firefly 资产账户才能入账」是新用户第一次入账必然撞上的
    /// 一堵墙：他还没有账户，也不知道该建哪个，界面却要他先去配。这里把这堵墙拆掉——
    /// 渠道没对上账户时，直接在 Firefly 建一个同名资产账户（渠道显示名，如「招商银行」），
    /// 写下映射，然后照常入账。
    ///
    /// 唯一不敢替用户做主的是重名：Firefly 里已经有一个叫「招商银行」的资产账户时，
    /// 那可能正是他一直在用的账户，也可能只是名字撞了。静默绑上去意味着一批账
    /// 可能记进了错的账户，而且事后看不出来。所以这种情况只落一条待确认的映射，
    /// 报错退出，由收件箱顶部那条横幅问一次；确认之后这一渠道就再也不问了。
    ///
    /// 关于干跑：`dry_run` 时不建账户也不落生效映射，只把「真入账会自动新建账户X」
    /// 作为一条自成一类的原因报出去（`channel_account_auto_create`），预览界面把它
    /// 算进可入账、不算进跳过。这样预览既不撒谎（那行确认后确实能入），也不留副作用
    /// （取消预览不会多出一个空账户）。重名撞车是例外：待确认映射照旧在干跑时就落，
    /// 那只是阿贝自己的一条状态，早落横幅早出现，用户点一次头之后干跑真跑都畅通。
    pub(crate) async fn ensure_channel_account(
        &self,
        user_id: i64,
        token: &str,
        row_id: i64,
        dry_run: bool,
    ) -> Result<(), ApiError> {
        let client = self.pool.get().await.map_err(ApiError::database)?;
        let row = client
            .query_opt(
                "SELECT d.channel_key, r.account_hint, r.signed_amount < 0,
                        r.source_account_id, r.destination_account_id
                 FROM abei_ai.bill_rows r
                 JOIN abei_ai.bill_documents d ON d.id = r.bill_document_id
                 WHERE r.user_id = $1 AND r.id = $2",
                &[&user_id, &row_id],
            )
            .await
            .map_err(ApiError::database)?;
        let Some(row) = row else {
            // 行不存在这件事由 prepare_import 报，那里的错误码更准。
            return Ok(());
        };
        let channel: String = row.get(0);
        let outgoing: bool = row.get(2);
        let own_side: Option<i64> = if outgoing { row.get(3) } else { row.get(4) };
        if own_side.is_some() {
            return Ok(());
        }
        let hint = row.get::<_, Option<String>>(1).unwrap_or_default();
        let hint = hint.trim().to_owned();
        if hint.is_empty() {
            // 没有账户提示就没有能挂映射的键。这种行本来就要人来填账户。
            return Ok(());
        }

        // 已经有映射却没盖到行上，多半是这条映射还在等确认，或者行是在映射之后落库的。
        let existing = client
            .query(
                "SELECT id, account_hint, state FROM abei_ai.bill_account_mappings
                 WHERE user_id = $1 AND channel_key = $2 ORDER BY id",
                &[&user_id, &channel],
            )
            .await
            .map_err(ApiError::database)?;
        let matched = existing
            .iter()
            .find(|mapping| hints_match(&hint, &mapping.get::<_, String>(1)));
        if let Some(mapping) = matched {
            if mapping.get::<_, String>(2) == PENDING_CONFIRMATION {
                return Err(unconfirmed_error(&channel));
            }
            // 已生效却没盖上：重跑一次盖账户这一步就够了。
            drop(client);
            return self.reapply_mappings(user_id, &channel).await;
        }

        let account_name = super::rows::channel_name(&channel).to_owned();
        drop(client);
        match self.find_asset_account(token, &account_name).await? {
            Some((account_id, account_type)) => {
                self.record_mapping(
                    user_id,
                    &channel,
                    &hint,
                    account_id,
                    &account_name,
                    account_type.as_deref(),
                    PENDING_CONFIRMATION,
                )
                .await?;
                Err(unconfirmed_error(&channel))
            }
            None => {
                if dry_run {
                    return Err(auto_create_notice(&channel));
                }
                let (account_id, account_type) =
                    self.create_asset_account(token, &account_name).await?;
                self.record_mapping(
                    user_id,
                    &channel,
                    &hint,
                    account_id,
                    &account_name,
                    account_type.as_deref(),
                    ACTIVE,
                )
                .await?;
                Ok(())
            }
        }
    }

    /// 还在等用户点头的渠道账户。收件箱顶部那条横幅读它。
    pub(crate) async fn pending_channel_accounts(&self, user_id: i64) -> Result<Value, ApiError> {
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT id, channel_key, account_hint, firefly_account_id, firefly_account_name
                 FROM abei_ai.bill_account_mappings
                 WHERE user_id = $1 AND state = $2 ORDER BY channel_key, id",
                &[&user_id, &PENDING_CONFIRMATION],
            )
            .await
            .map_err(ApiError::database)?;
        let data = rows
            .iter()
            .map(|row| {
                let channel: String = row.get(1);
                json!({
                    "id": row.get::<_, i64>(0).to_string(),
                    "type": "bill-channel-account",
                    "attributes": {
                        "channel_key": channel.clone(),
                        "channel_name": super::rows::channel_name(&channel),
                        "account_hint": row.get::<_, String>(2),
                        "firefly_account_id": row.get::<_, i64>(3).to_string(),
                        "firefly_account_name": row.get::<_, String>(4),
                    }
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "data": data }))
    }

    /// 用户在横幅上点了「就记进它」。之后这一渠道不再问。
    pub(crate) async fn confirm_channel_account(
        &self,
        user_id: i64,
        id: i64,
    ) -> Result<Value, ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let mapping = transaction
            .query_opt(
                "UPDATE abei_ai.bill_account_mappings
                 SET state = $3, last_verified_at = now(), updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND state = $4
                 RETURNING channel_key, firefly_account_name",
                &[&user_id, &id, &ACTIVE, &PENDING_CONFIRMATION],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| {
                ApiError::not_found("没有这条待确认的渠道账户。")
                    .with_reason(reasons::CHANNEL_ACCOUNT_NOT_FOUND)
            })?;
        let channel: String = mapping.get(0);
        refresh_pending_mappings(&transaction, user_id, &channel).await?;
        transaction.commit().await.map_err(ApiError::database)?;
        Ok(json!({ "data": {
            "id": id.to_string(),
            "type": "bill-channel-account",
            "attributes": {
                "channel_key": channel,
                "firefly_account_name": mapping.get::<_, String>(1),
                "state": ACTIVE,
            }
        } }))
    }

    /// 按名字在 Firefly 里找一个同名的资产类账户。找不到返回 None。
    ///
    /// 只认完全同名：模糊匹配会把「招商银行信用卡」当成「招商银行」，那是另一个账户。
    async fn find_asset_account(
        &self,
        token: &str,
        name: &str,
    ) -> Result<Option<(i64, Option<String>)>, ApiError> {
        let found = self
            .firefly
            .get_json(
                token,
                "/api/v1/search/accounts",
                &[
                    ("query", name.to_owned()),
                    ("field", "name".to_owned()),
                    ("type", "asset".to_owned()),
                ],
            )
            .await?;
        Ok(found["data"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|account| account["attributes"]["name"].as_str() == Some(name))
            .and_then(|account| {
                let id = account["id"]
                    .as_str()
                    .and_then(|value| value.parse::<i64>().ok())
                    .or_else(|| account["id"].as_i64())?;
                Some((
                    id,
                    account["attributes"]["type"].as_str().map(str::to_owned),
                ))
            }))
    }

    /// 在 Firefly 里建一个同名资产账户。
    async fn create_asset_account(
        &self,
        token: &str,
        name: &str,
    ) -> Result<(i64, Option<String>), ApiError> {
        let payload = json!({
            "name": name,
            "type": "asset",
            "account_role": "defaultAsset",
        });
        let (_, response) = self
            .firefly
            .send_json(token, Method::POST, "/api/v1/accounts", &payload)
            .await
            .map_err(|error| match error {
                WriteError::Http { status, body } => ApiError::upstream(format!(
                    "在 Firefly 建「{name}」账户失败：{}",
                    firefly::error_message(&body, status.as_u16())
                )),
                WriteError::Transport(error) => {
                    ApiError::upstream(format!("在 Firefly 建「{name}」账户没能完成：{error}"))
                }
                WriteError::InvalidResponse(error) => {
                    ApiError::upstream(format!("Firefly 建账户的回应读不懂：{error}"))
                }
            })?;
        let id = response["data"]["id"]
            .as_str()
            .and_then(|value| value.parse::<i64>().ok())
            .or_else(|| response["data"]["id"].as_i64())
            .filter(|id| *id > 0)
            .ok_or_else(|| ApiError::upstream("Firefly 建好了账户但没给 ID。"))?;
        Ok((
            id,
            response["data"]["attributes"]["type"]
                .as_str()
                .map(str::to_owned),
        ))
    }

    /// 落一条系统自己建的映射。同一渠道同一提示重复调用是幂等的。
    #[allow(
        clippy::too_many_arguments,
        reason = "映射就是这么多列，凑成结构体反而更绕"
    )]
    async fn record_mapping(
        &self,
        user_id: i64,
        channel_key: &str,
        account_hint: &str,
        firefly_account_id: i64,
        firefly_account_name: &str,
        firefly_account_type: Option<&str>,
        state: &str,
    ) -> Result<(), ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        transaction
            .execute(
                "INSERT INTO abei_ai.bill_account_mappings
                   (user_id, channel_key, account_hint, firefly_account_id,
                    firefly_account_name, firefly_account_type, source, last_verified_at, state)
                 VALUES ($1,$2,$3,$4,$5,$6,$8,now(),$7)
                 ON CONFLICT (user_id, channel_key, account_hint) DO NOTHING",
                &[
                    &user_id,
                    &channel_key,
                    &account_hint,
                    &firefly_account_id,
                    &firefly_account_name,
                    &firefly_account_type,
                    &state,
                    &SOURCE_AUTO,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        if state == ACTIVE {
            refresh_pending_mappings(&transaction, user_id, channel_key).await?;
        }
        transaction.commit().await.map_err(ApiError::database)
    }

    /// 把已生效的映射重新盖到这一渠道的待处理流水上。
    async fn reapply_mappings(&self, user_id: i64, channel: &str) -> Result<(), ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        refresh_pending_mappings(&transaction, user_id, channel).await?;
        transaction.commit().await.map_err(ApiError::database)
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
                        last_verified_at::text, created_at::text, updated_at::text,
                        state
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
                "state": row.get::<_, String>(10),
                "last_verified_at": row.get::<_, Option<String>>(7),
                "created_at": row.get::<_, String>(8),
                "updated_at": row.get::<_, String>(9),
            }
        } }))
    }
}

/// 渠道账户还等着确认时，入账这一步该说的话。文案和横幅上那句对得上。
fn unconfirmed_error(channel: &str) -> ApiError {
    let name = super::rows::channel_name(channel);
    ApiError::conflict(format!(
        "你的 Firefly 里已经有一个「{name}」账户，先在收件箱顶部确认要不要记进它。"
    ))
    .with_reason(reasons::CHANNEL_ACCOUNT_UNCONFIRMED)
}

/// 干跑撞见「账户还不存在」时该说的话。语气是预告不是拦路：这行确认后照样入。
fn auto_create_notice(channel: &str) -> ApiError {
    let name = super::rows::channel_name(channel);
    ApiError::conflict(format!("会自动新建资产账户「{name}」并把这一渠道记进它"))
        .with_reason(reasons::CHANNEL_ACCOUNT_AUTO_CREATE)
}

async fn refresh_pending_mappings(
    transaction: &Transaction<'_>,
    user_id: i64,
    channel: &str,
) -> Result<(), ApiError> {
    // 只认已生效的映射。等用户确认的那些（`pending_confirmation`）还不能盖到流水上：
    // 它们指向的是 Firefly 里一个同名的既有账户，绑没绑对还没人点过头。
    let mappings = transaction
        .query(
            "SELECT account_hint, firefly_account_id, firefly_account_name
             FROM abei_ai.bill_account_mappings
             WHERE user_id = $1 AND channel_key = $2 AND state = 'active' ORDER BY id",
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
        // 「一个映射都没有」不再是待办：入账那一步会替用户把账户建好（见
        // [`Service::ensure_channel_account`]）。留下来要人管的只有一种——提示同时命中了
        // 几个不同账户，那是脏数据，系统替不了人选。
        if mapping.is_none() && !accounts.is_empty() {
            issue_values.push(json!({
                "severity": "warning",
                "code": "account_mapping_ambiguous",
                "message": "账户提示命中了多个不同的 Firefly 账户，请先明确选择。",
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
