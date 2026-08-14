use std::collections::BTreeSet;
use std::str::FromStr;

use rust_decimal::Decimal;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_postgres::{Row, Transaction};
use uuid::Uuid;

use super::Service;
use crate::ApiError;
use crate::reliability::ReliabilityConfig;
use crate::states::{ImportStatus, RowStatus};

const MAX_ERROR_CHARS: usize = 2_000;

#[derive(Debug)]
struct ImportRow {
    id: i64,
    status: String,
    duplicate_state: String,
    occurred_at: String,
    signed_amount: Decimal,
    currency_code: String,
    firefly_type: String,
    firefly_date: String,
    firefly_amount: Decimal,
    description: String,
    source_account_id: Option<i64>,
    source_name: Option<String>,
    destination_account_id: Option<i64>,
    destination_name: Option<String>,
    category_id: Option<i64>,
    category_name: Option<String>,
    tags: Vec<String>,
    notes: Option<String>,
    provider_transaction_id: Option<String>,
    transaction_group_id: Option<i64>,
    lifecycle: String,
    active_revision: bool,
}

#[derive(Debug)]
struct ImportSplit {
    part_index: i16,
    amount: Decimal,
    source_account_id: Option<i64>,
    source_name: Option<String>,
    destination_account_id: Option<i64>,
    destination_name: Option<String>,
    category_id: Option<i64>,
    category_name: Option<String>,
    description: String,
}

impl Service {
    pub(crate) async fn prepare_import(
        &self,
        user_id: i64,
        row_id: i64,
        dry_run: bool,
    ) -> Result<Value, ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let row = load_import_row(&transaction, user_id, row_id).await?;
        validate_import_row(&transaction, &row, &self.reliability).await?;
        let splits = load_splits(&transaction, user_id, row_id).await?;
        let external_id = format!("abei:bill-row:{row_id}");
        let payload = to_firefly_payload(&row, &splits, &external_id)?;
        let payload_hash = checksum(&payload)?;
        let account_ids = account_ids(&payload);

        let attempt_id = if dry_run {
            None
        } else {
            let attempt_no: i32 = transaction
                .query_one(
                    "SELECT COALESCE(max(attempt_no), 0)::integer + 1
                     FROM abei_ai.bill_import_attempts WHERE bill_row_id = $1",
                    &[&row_id],
                )
                .await
                .map_err(ApiError::database)?
                .get(0);
            let id = Uuid::new_v4().to_string();
            transaction
                .execute(
                    "INSERT INTO abei_ai.bill_import_attempts
                       (id, user_id, bill_row_id, attempt_no, status, external_id,
                        payload_hash, payload_snapshot)
                     VALUES ($1,$2,$3,$4,$8,$5,$6,$7)",
                    &[
                        &id,
                        &user_id,
                        &row_id,
                        &attempt_no,
                        &external_id,
                        &payload_hash,
                        &payload,
                        &ImportStatus::Prepared.as_str(),
                    ],
                )
                .await
                .map_err(import_constraint_error)?;
            Some(id)
        };
        transaction.commit().await.map_err(ApiError::database)?;

        Ok(json!({ "data": {
            "attempt_id": attempt_id,
            "row_id": row_id.to_string(),
            "external_id": external_id,
            "payload_hash": payload_hash,
            "payload": payload,
            "account_ids": account_ids.into_iter().map(|id| id.to_string()).collect::<Vec<_>>(),
            "preview": import_preview(&row),
        }}))
    }

    pub(crate) async fn mark_import_sending(
        &self,
        user_id: i64,
        attempt_id: &str,
    ) -> Result<Value, ApiError> {
        let updated = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "UPDATE abei_ai.bill_import_attempts SET status = $3, updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status = $4",
                &[
                    &user_id,
                    &attempt_id,
                    &ImportStatus::Sending.as_str(),
                    &ImportStatus::Prepared.as_str(),
                ],
            )
            .await
            .map_err(ApiError::database)?;
        if updated == 0 {
            return self
                .transition_conflict(user_id, attempt_id, "只有 prepared 导入尝试可以发送。")
                .await;
        }
        self.get_import_attempt(user_id, attempt_id).await
    }

    pub(crate) async fn complete_import(
        &self,
        user_id: i64,
        attempt_id: &str,
        transaction_group_id: i64,
        reconciled: bool,
    ) -> Result<Value, ApiError> {
        if transaction_group_id <= 0 {
            return Err(ApiError::invalid_params(
                "transaction_group_id 必须是正整数。",
            ));
        }
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let attempt = transaction
            .query_opt(
                "SELECT bill_row_id, status, transaction_group_id
                 FROM abei_ai.bill_import_attempts
                 WHERE user_id = $1 AND id = $2 FOR UPDATE",
                &[&user_id, &attempt_id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("导入尝试不存在。"))?;
        let row_id: i64 = attempt.get(0);
        let status: String = attempt.get(1);
        let existing_group: Option<i64> = attempt.get(2);
        let status = ImportStatus::from_str(&status)
            .ok_or_else(|| ApiError::internal("导入尝试的状态无法识别。"))?;
        let target_status = if reconciled {
            ImportStatus::Reconciled
        } else {
            ImportStatus::Succeeded
        };

        // 已经落定的尝试重复调用是幂等的：交易组一致就当成功返回，不一致才是真冲突。
        if ImportStatus::SETTLED.contains(&status) {
            if existing_group == Some(transaction_group_id) {
                transaction.commit().await.map_err(ApiError::database)?;
                return self.get_import_attempt(user_id, attempt_id).await;
            }
            return Err(ApiError::conflict(
                "该导入尝试已经绑定到另一个 Firefly 交易组。",
            ));
        }
        // 合不合法交给状态机判断，而不是在这里再抄一遍允许的来源状态。
        if !status.can_transition(target_status) {
            return Err(ApiError::conflict("当前导入尝试不能完成。"));
        }
        transaction
            .execute(
                "UPDATE abei_ai.bill_rows SET status = $4, transaction_group_id = $3,
                   last_import_error = NULL, updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status = $5",
                &[
                    &user_id,
                    &row_id,
                    &transaction_group_id,
                    &RowStatus::Imported.as_str(),
                    &RowStatus::Pending.as_str(),
                ],
            )
            .await
            .map_err(import_constraint_error)?;
        transaction
            .execute(
                "UPDATE abei_ai.bill_import_attempts SET status = $3,
                   transaction_group_id = $4, error_code = NULL, error_message = NULL,
                   retry_after = NULL, finished_at = now(), updated_at = now()
                 WHERE user_id = $1 AND id = $2",
                &[
                    &user_id,
                    &attempt_id,
                    &target_status.as_str(),
                    &transaction_group_id,
                ],
            )
            .await
            .map_err(import_constraint_error)?;
        transaction.commit().await.map_err(ApiError::database)?;
        self.get_import_attempt(user_id, attempt_id).await
    }

    pub(crate) async fn fail_import(
        &self,
        user_id: i64,
        attempt_id: &str,
        retryable: bool,
        firefly_status: Option<i32>,
        error_code: &str,
        error_message: &str,
    ) -> Result<Value, ApiError> {
        let target = if retryable {
            ImportStatus::Retryable
        } else {
            ImportStatus::Rejected
        };
        let target = target.as_str();
        let retry_delay = if retryable { 30 } else { 0 };
        let message = truncate(error_message, MAX_ERROR_CHARS);
        // 能标记失败的来源状态 = 状态机里能走到 retryable/rejected 的那些，这里直接问它。
        let sources = crate::states::sql_list(
            &ImportStatus::ALL
                .iter()
                .copied()
                .filter(|status| {
                    status.can_transition(ImportStatus::Retryable)
                        && status.can_transition(ImportStatus::Rejected)
                })
                .collect::<Vec<_>>(),
        );
        let updated = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                &format!(
                    "WITH changed AS (
                       UPDATE abei_ai.bill_import_attempts SET status = $3, firefly_status = $4,
                         error_code = $5, error_message = $6,
                         retry_after = CASE WHEN $7::integer > 0
                           THEN now() + make_interval(secs => $7::integer) ELSE NULL END,
                         finished_at = now(), updated_at = now()
                       WHERE user_id = $1 AND id = $2 AND status IN ({sources})
                       RETURNING bill_row_id
                     )
                     UPDATE abei_ai.bill_rows r SET last_import_error = $6, updated_at = now()
                     FROM changed WHERE r.user_id = $1 AND r.id = changed.bill_row_id"
                ),
                &[
                    &user_id,
                    &attempt_id,
                    &target,
                    &firefly_status,
                    &truncate(error_code, 100),
                    &message,
                    &retry_delay,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        if updated == 0 {
            return self
                .transition_conflict(user_id, attempt_id, "当前导入尝试不能标记失败。")
                .await;
        }
        self.get_import_attempt(user_id, attempt_id).await
    }

    pub(crate) async fn mark_import_uncertain(
        &self,
        user_id: i64,
        attempt_id: &str,
        error_message: &str,
    ) -> Result<Value, ApiError> {
        let message = truncate(error_message, MAX_ERROR_CHARS);
        let updated = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "WITH changed AS (
                   UPDATE abei_ai.bill_import_attempts SET status = $4,
                     error_code = 'firefly_result_uncertain', error_message = $3,
                     retry_after = now() + interval '30 seconds', updated_at = now()
                   WHERE user_id = $1 AND id = $2 AND status = $5
                   RETURNING bill_row_id
                 )
                 UPDATE abei_ai.bill_rows r SET last_import_error = $3, updated_at = now()
                 FROM changed WHERE r.user_id = $1 AND r.id = changed.bill_row_id",
                &[
                    &user_id,
                    &attempt_id,
                    &message,
                    &ImportStatus::Uncertain.as_str(),
                    &ImportStatus::Sending.as_str(),
                ],
            )
            .await
            .map_err(ApiError::database)?;
        if updated == 0 {
            return self
                .transition_conflict(user_id, attempt_id, "当前导入尝试不能标记为结果不确定。")
                .await;
        }
        self.get_import_attempt(user_id, attempt_id).await
    }

    pub(crate) async fn release_uncertain_import(
        &self,
        user_id: i64,
        attempt_id: &str,
    ) -> Result<Value, ApiError> {
        let updated = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .execute(
                "UPDATE abei_ai.bill_import_attempts SET status = $3,
                   error_code = 'reconcile_not_found',
                   error_message = '在 Firefly 中未找到对应 external_id，可以重新导入。',
                   finished_at = now(), updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status = $4
                   AND retry_after <= now()",
                &[
                    &user_id,
                    &attempt_id,
                    &ImportStatus::Retryable.as_str(),
                    &ImportStatus::Uncertain.as_str(),
                ],
            )
            .await
            .map_err(ApiError::database)?;
        if updated == 0 {
            return self
                .transition_conflict(
                    user_id,
                    attempt_id,
                    "对账等待窗口尚未结束，或该尝试已不再是不确定状态。",
                )
                .await;
        }
        self.get_import_attempt(user_id, attempt_id).await
    }

    pub(crate) async fn get_import_attempt(
        &self,
        user_id: i64,
        attempt_id: &str,
    ) -> Result<Value, ApiError> {
        let row = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT id, bill_row_id, attempt_no, status, external_id, payload_hash,
                        payload_snapshot, firefly_status, transaction_group_id, error_code,
                        error_message, retry_after::text, created_at::text, updated_at::text,
                        finished_at::text
                 FROM abei_ai.bill_import_attempts WHERE user_id = $1 AND id = $2",
                &[&user_id, &attempt_id],
            )
            .await
            .map_err(ApiError::database)?
            .ok_or_else(|| ApiError::not_found("导入尝试不存在。"))?;
        Ok(json!({ "data": import_attempt_json(&row) }))
    }

    async fn transition_conflict(
        &self,
        user_id: i64,
        attempt_id: &str,
        message: &str,
    ) -> Result<Value, ApiError> {
        self.get_import_attempt(user_id, attempt_id).await?;
        Err(ApiError::conflict(message))
    }
}

async fn load_import_row(
    transaction: &Transaction<'_>,
    user_id: i64,
    row_id: i64,
) -> Result<ImportRow, ApiError> {
    let row = transaction
        .query_opt(
            "SELECT r.id, r.status, r.duplicate_state, r.occurred_at,
                    r.signed_amount::text, r.currency_code::text, r.firefly_type,
                    r.firefly_date::text, r.firefly_amount::text,
                    COALESCE(NULLIF(r.firefly_description, ''), NULLIF(r.description, ''),
                             NULLIF(r.counterparty, '')),
                    r.source_account_id, r.source_name, r.destination_account_id,
                    r.destination_name, r.category_id, r.category_name, r.tags, r.notes,
                    r.provider_transaction_id, r.transaction_group_id, d.lifecycle,
                    d.active_revision = r.revision
             FROM abei_ai.bill_rows r
             JOIN abei_ai.bill_documents d ON d.id = r.bill_document_id
             WHERE r.user_id = $1 AND r.id = $2 FOR UPDATE OF r",
            &[&user_id, &row_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found("账单流水不存在。"))?;
    let occurred_at: String = row.get(3);
    let signed_amount = parse_decimal(row.get::<_, String>(4), "signed_amount")?;
    let firefly_amount = row
        .get::<_, Option<String>>(8)
        .ok_or_else(|| ApiError::conflict("流水缺少 firefly_amount，不能入账。"))
        .and_then(|value| parse_decimal(value, "firefly_amount"))?;
    let firefly_date = row
        .get::<_, Option<String>>(7)
        .ok_or_else(|| ApiError::conflict("流水缺少 firefly_date，不能入账。"))?;
    Ok(ImportRow {
        id: row.get(0),
        status: row.get(1),
        duplicate_state: row.get(2),
        occurred_at,
        signed_amount,
        currency_code: row.get(5),
        firefly_type: row
            .get::<_, Option<String>>(6)
            .ok_or_else(|| ApiError::invalid_params("流水缺少 firefly_type。"))?,
        firefly_date,
        firefly_amount,
        description: row
            .get::<_, Option<String>>(9)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| ApiError::invalid_params("流水缺少非空描述。"))?,
        source_account_id: row.get(10),
        source_name: row.get(11),
        destination_account_id: row.get(12),
        destination_name: row.get(13),
        category_id: row.get(14),
        category_name: row.get(15),
        tags: row.get::<_, Option<Vec<String>>>(16).unwrap_or_default(),
        notes: row.get(17),
        provider_transaction_id: row.get(18),
        transaction_group_id: row.get(19),
        lifecycle: row.get(20),
        active_revision: row.get(21),
    })
}

async fn validate_import_row(
    transaction: &Transaction<'_>,
    row: &ImportRow,
    reliability: &ReliabilityConfig,
) -> Result<(), ApiError> {
    if row.lifecycle != "active" || !row.active_revision {
        return Err(ApiError::conflict("只能导入当前活动 revision 的流水。"));
    }
    if row.status != RowStatus::Pending.as_str() || row.transaction_group_id.is_some() {
        return Err(ApiError::conflict("只有尚未入账的待处理流水可以导入。"));
    }
    if row.duplicate_state != "unique" {
        return Err(ApiError::conflict("疑似重复或冲突的流水必须先人工确认。"));
    }
    if !matches!(
        row.firefly_type.as_str(),
        "withdrawal" | "deposit" | "transfer"
    ) {
        return Err(ApiError::invalid_params("firefly_type 不支持。"));
    }
    if row.firefly_amount <= Decimal::ZERO {
        return Err(ApiError::invalid_params("入账金额必须大于 0。"));
    }
    match row.firefly_type.as_str() {
        "withdrawal" if row.source_account_id.is_none() => {
            return Err(ApiError::conflict("支出流水必须先映射付款 Firefly 账户。"));
        }
        "deposit" if row.destination_account_id.is_none() => {
            return Err(ApiError::conflict("收入流水必须先映射收款 Firefly 账户。"));
        }
        "transfer"
            if row.source_account_id.is_none()
                || row.destination_account_id.is_none()
                || row.source_account_id == row.destination_account_id =>
        {
            return Err(ApiError::conflict("转账必须选择两个不同的 Firefly 账户。"));
        }
        _ => {}
    }
    // 全局清扫器（billing::sweeper）每分钟会把所有超时流水收一遍，这里再按行收一次，
    // 是为了让用户刚点的这一行立刻可用，不用等下一轮清扫。两处用同一套租约参数。
    transaction
        .execute(
            "UPDATE abei_ai.bill_import_attempts SET status = $3,
               error_code = 'prepare_expired', error_message = '导入在发送前中断，可以重试。',
               finished_at = now(), updated_at = now()
             WHERE bill_row_id = $1 AND status = $4
               AND updated_at < now() - make_interval(secs => $2)",
            &[
                &row.id,
                &reliability.prepare_lease_secs(),
                &ImportStatus::Retryable.as_str(),
                &ImportStatus::Prepared.as_str(),
            ],
        )
        .await
        .map_err(ApiError::database)?;
    transaction
        .execute(
            "UPDATE abei_ai.bill_import_attempts SET status = $3,
               error_code = 'sending_lease_expired',
               error_message = '发送过程失去响应，必须先按 external_id 对账。',
               retry_after = now(), updated_at = now()
             WHERE bill_row_id = $1 AND status = $4
               AND updated_at < now() - make_interval(secs => $2)",
            &[
                &row.id,
                &reliability.send_lease_secs(),
                &ImportStatus::Uncertain.as_str(),
                &ImportStatus::Sending.as_str(),
            ],
        )
        .await
        .map_err(ApiError::database)?;
    // 挡住重复发送的两组状态：在途的（还占着这一行）和已落定的（账已经在 Firefly 里）。
    // 它们和库里那两个部分唯一索引是同一组定义，states.rs 里有用例锁着。
    let blocking = crate::states::sql_list(&[ImportStatus::ACTIVE, ImportStatus::SETTLED].concat());
    let active = transaction
        .query_opt(
            &format!(
                "SELECT status FROM abei_ai.bill_import_attempts
                 WHERE bill_row_id = $1 AND status IN ({blocking})
                 ORDER BY attempt_no DESC LIMIT 1"
            ),
            &[&row.id],
        )
        .await
        .map_err(ApiError::database)?;
    if let Some(active) = active {
        let status: String = active.get(0);
        return Err(ApiError::conflict(format!(
            "这条流水已有 {status} 导入尝试，不能重复发送。"
        )));
    }
    Ok(())
}

async fn load_splits(
    transaction: &Transaction<'_>,
    user_id: i64,
    row_id: i64,
) -> Result<Vec<ImportSplit>, ApiError> {
    transaction
        .query(
            "SELECT part_index, amount::text, source_account_id, source_name,
                    destination_account_id, destination_name, category_id, category_name,
                    description
             FROM abei_ai.bill_row_splits
             WHERE user_id = $1 AND bill_row_id = $2 ORDER BY part_index",
            &[&user_id, &row_id],
        )
        .await
        .map_err(ApiError::database)?
        .into_iter()
        .map(|row| {
            Ok(ImportSplit {
                part_index: row.get(0),
                amount: parse_decimal(row.get::<_, String>(1), "split amount")?,
                source_account_id: row.get(2),
                source_name: row.get(3),
                destination_account_id: row.get(4),
                destination_name: row.get(5),
                category_id: row.get(6),
                category_name: row.get(7),
                description: row.get(8),
            })
        })
        .collect()
}

fn to_firefly_payload(
    row: &ImportRow,
    splits: &[ImportSplit],
    external_id: &str,
) -> Result<Value, ApiError> {
    let transactions = if splits.is_empty() {
        vec![transaction_payload(row, None, external_id)?]
    } else {
        let total: Decimal = splits.iter().map(|split| split.amount).sum();
        if total != row.firefly_amount {
            return Err(ApiError::conflict(format!(
                "拆分合计 {total} 与入账金额 {} 不一致。",
                row.firefly_amount
            )));
        }
        splits
            .iter()
            .map(|split| {
                transaction_payload(
                    row,
                    Some(split),
                    &format!("{external_id}:part:{}", split.part_index),
                )
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    Ok(json!({
        "group_title": if splits.is_empty() { Value::Null } else { Value::String(row.description.clone()) },
        "error_if_duplicate_hash": true,
        "apply_rules": true,
        "fire_webhooks": true,
        "transactions": transactions,
    }))
}

fn transaction_payload(
    row: &ImportRow,
    split: Option<&ImportSplit>,
    external_id: &str,
) -> Result<Value, ApiError> {
    let amount = split
        .map(|value| value.amount)
        .unwrap_or(row.firefly_amount);
    if amount <= Decimal::ZERO {
        return Err(ApiError::invalid_params("交易金额必须大于 0。"));
    }
    let source_id = split
        .and_then(|value| value.source_account_id)
        .or(row.source_account_id);
    let source_name = split
        .and_then(|value| value.source_name.clone())
        .or_else(|| row.source_name.clone());
    let destination_id = split
        .and_then(|value| value.destination_account_id)
        .or(row.destination_account_id);
    let destination_name = split
        .and_then(|value| value.destination_name.clone())
        .or_else(|| row.destination_name.clone());
    let category_id = split
        .and_then(|value| value.category_id)
        .or(row.category_id);
    let category_name = split
        .and_then(|value| value.category_name.clone())
        .or_else(|| row.category_name.clone());
    let description = split
        .map(|value| value.description.clone())
        .unwrap_or_else(|| row.description.clone());
    if description.trim().is_empty() {
        return Err(ApiError::invalid_params("交易描述不能为空。"));
    }
    Ok(json!({
        "type": row.firefly_type,
        "date": row.firefly_date,
        "amount": amount.to_string(),
        "currency_code": row.currency_code,
        "description": description,
        "source_id": source_id,
        "source_name": source_name,
        "destination_id": destination_id,
        "destination_name": destination_name,
        "category_id": category_id,
        "category_name": category_name,
        "tags": row.tags,
        "notes": row.notes,
        "internal_reference": row.provider_transaction_id,
        "external_id": external_id,
        "reconciled": false,
    }))
}

fn import_preview(row: &ImportRow) -> Value {
    json!({
        "row_id": row.id.to_string(),
        "occurred_at": row.occurred_at,
        "direction": if row.signed_amount.is_sign_negative() { "out" } else { "in" },
        "amount": row.signed_amount.abs().to_string(),
        "firefly_type": row.firefly_type,
            "firefly_amount": row.firefly_amount.to_string(),
            "firefly_date": row.firefly_date,
        "currency_code": row.currency_code,
        "description_preview": row.description,
        "source_name": row.source_name,
        "source_account_id": row.source_account_id.map(|id| id.to_string()),
        "destination_name": row.destination_name,
        "destination_account_id": row.destination_account_id.map(|id| id.to_string()),
        "category_name": row.category_name,
        "duplicate_state": row.duplicate_state,
    })
}

fn account_ids(payload: &Value) -> BTreeSet<i64> {
    payload["transactions"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|transaction| {
            [
                transaction["source_id"].as_i64(),
                transaction["destination_id"].as_i64(),
            ]
        })
        .flatten()
        .collect()
}

fn checksum(payload: &Value) -> Result<String, ApiError> {
    let bytes =
        serde_json::to_vec(payload).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn parse_decimal(value: String, field: &str) -> Result<Decimal, ApiError> {
    Decimal::from_str(&value)
        .map_err(|_| ApiError::invalid_params(format!("{field} 不是有效金额。")))
}

fn import_attempt_json(row: &Row) -> Value {
    json!({
        "id": row.get::<_, String>(0),
        "bill_row_id": row.get::<_, i64>(1).to_string(),
        "attempt_no": row.get::<_, i32>(2),
        "status": row.get::<_, String>(3),
        "external_id": row.get::<_, String>(4),
        "payload_hash": row.get::<_, String>(5),
        "payload": row.get::<_, Value>(6),
        "firefly_status": row.get::<_, Option<i32>>(7),
        "transaction_group_id": row.get::<_, Option<i64>>(8).map(|id| id.to_string()),
        "error_code": row.get::<_, Option<String>>(9),
        "error_message": row.get::<_, Option<String>>(10),
        "retry_after": row.get::<_, Option<String>>(11),
        "created_at": row.get::<_, String>(12),
        "updated_at": row.get::<_, String>(13),
        "finished_at": row.get::<_, Option<String>>(14),
    })
}

fn import_constraint_error(error: tokio_postgres::Error) -> ApiError {
    if error
        .as_db_error()
        .is_some_and(|db| db.code() == &tokio_postgres::error::SqlState::UNIQUE_VIOLATION)
    {
        ApiError::conflict("这条流水已有活动或成功的导入尝试。")
    } else {
        ApiError::database(error)
    }
}

fn truncate(value: &str, max: usize) -> String {
    value.chars().take(max).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(kind: &str, signed: &str) -> ImportRow {
        ImportRow {
            id: 7,
            status: "pending".to_owned(),
            duplicate_state: "unique".to_owned(),
            occurred_at: "2026-08-11T10:00:00+08:00".to_owned(),
            signed_amount: Decimal::from_str(signed).unwrap(),
            currency_code: "CNY".to_owned(),
            firefly_type: kind.to_owned(),
            firefly_date: "2026-08-11".to_owned(),
            firefly_amount: Decimal::from_str(signed).unwrap().abs(),
            description: "午餐".to_owned(),
            source_account_id: Some(10),
            source_name: Some("招行卡".to_owned()),
            destination_account_id: None,
            destination_name: Some("餐厅".to_owned()),
            category_id: None,
            category_name: Some("餐饮".to_owned()),
            tags: vec!["账单".to_owned()],
            notes: None,
            provider_transaction_id: Some("bank-1".to_owned()),
            transaction_group_id: None,
            lifecycle: "active".to_owned(),
            active_revision: true,
        }
    }

    #[test]
    fn withdrawal_payload_uses_positive_amount_and_stable_external_id() {
        let payload =
            to_firefly_payload(&row("withdrawal", "-12.50"), &[], "abei:bill-row:7").unwrap();
        let transaction = &payload["transactions"][0];
        assert_eq!(transaction["type"], "withdrawal");
        assert_eq!(transaction["amount"], "12.50");
        assert_eq!(transaction["source_id"], 10);
        assert_eq!(transaction["external_id"], "abei:bill-row:7");
        assert_eq!(payload["error_if_duplicate_hash"], true);
    }

    #[test]
    fn split_payload_is_one_group_with_one_transaction_per_part() {
        let splits = vec![
            ImportSplit {
                part_index: 1,
                amount: Decimal::from_str("5.00").unwrap(),
                source_account_id: None,
                source_name: None,
                destination_account_id: None,
                destination_name: Some("咖啡店".to_owned()),
                category_id: None,
                category_name: Some("餐饮".to_owned()),
                description: "咖啡".to_owned(),
            },
            ImportSplit {
                part_index: 2,
                amount: Decimal::from_str("7.50").unwrap(),
                source_account_id: None,
                source_name: None,
                destination_account_id: None,
                destination_name: Some("便利店".to_owned()),
                category_id: None,
                category_name: Some("日用".to_owned()),
                description: "日用品".to_owned(),
            },
        ];
        let payload =
            to_firefly_payload(&row("withdrawal", "-12.50"), &splits, "abei:bill-row:7").unwrap();
        assert_eq!(payload["transactions"].as_array().unwrap().len(), 2);
        assert_eq!(
            payload["transactions"][1]["external_id"],
            "abei:bill-row:7:part:2"
        );
    }

    #[test]
    fn split_total_must_equal_parent_amount() {
        let split = ImportSplit {
            part_index: 1,
            amount: Decimal::ONE,
            source_account_id: None,
            source_name: None,
            destination_account_id: None,
            destination_name: None,
            category_id: None,
            category_name: None,
            description: "一部分".to_owned(),
        };
        assert!(to_firefly_payload(&row("withdrawal", "-12.50"), &[split], "x").is_err());
    }
}
