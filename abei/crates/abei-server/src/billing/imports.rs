use std::collections::BTreeSet;
use std::str::FromStr;

use rust_decimal::Decimal;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_postgres::{Row, Transaction};
use uuid::Uuid;

use super::Service;
use crate::ApiError;
use crate::firefly::{self, WriteError};
use crate::reliability::ReliabilityConfig;
use crate::states::{ImportStatus, RowStatus};

/// 入账路径的机器码，挂在 `ApiError.reason` 上。
///
/// 通用的八个 reason（Conflict、InvalidParams……）只说得清「这是个冲突」，说不清
/// 是哪一种冲突。前端要区分「去映射账户」和「去人工确认重复」这两个完全不同的动作，
/// 就只能去匹配中文 detail 文案——文案改一个字就悄悄失效。
///
/// 加码只加不改：HTTP 状态码和 detail 文案一个字都没动，老的字符串匹配照旧能跑，
/// 新的调用方可以改看 reason。
pub(crate) mod reasons {
    /// 流水没有映射到 Firefly 账户，用户要先去配账户映射。
    pub(crate) const ACCOUNT_UNMAPPED: &str = "account_unmapped";
    /// 转账两端选了同一个账户，或者少选了一端。
    pub(crate) const TRANSFER_ACCOUNTS_INVALID: &str = "transfer_accounts_invalid";
    /// 这条流水已经有在途或已成功的导入尝试，不能重复发。
    pub(crate) const IMPORT_IN_FLIGHT: &str = "import_in_flight";
    /// 金额缺失、非法或不是正数。
    pub(crate) const AMOUNT_INVALID: &str = "amount_invalid";
    /// 疑似重复或冲突，必须先人工确认。
    pub(crate) const DUPLICATE_UNRESOLVED: &str = "duplicate_unresolved";
    /// 流水不在待处理状态（已入账、已忽略，或不是当前 revision）。
    pub(crate) const ROW_NOT_IMPORTABLE: &str = "row_not_importable";
    /// 流水缺了入账必需的字段。
    pub(crate) const ROW_INCOMPLETE: &str = "row_incomplete";
    /// 导入尝试不存在，或者不属于这个用户。
    pub(crate) const ATTEMPT_NOT_FOUND: &str = "attempt_not_found";
    /// 流水不存在，或者不属于这个用户。
    pub(crate) const ROW_NOT_FOUND: &str = "row_not_found";
    /// firefly_type 不是 Firefly 认的那三种。
    pub(crate) const ROW_TYPE_UNSUPPORTED: &str = "row_type_unsupported";
    /// 拆分金额合计和入账金额对不上。
    pub(crate) const SPLIT_TOTAL_MISMATCH: &str = "split_total_mismatch";
    /// 当前状态不允许这一步状态迁移。
    pub(crate) const ATTEMPT_TRANSITION_INVALID: &str = "attempt_transition_invalid";
    /// 这个导入尝试已经绑定到别的 Firefly 交易组了。
    pub(crate) const ATTEMPT_ALREADY_BOUND: &str = "attempt_already_bound";
    /// 入账落库时发现这一行已经不是待处理了，本地和 Firefly 可能对不上，要人工核对。
    pub(crate) const ROW_STATE_CHANGED: &str = "row_state_changed";
    /// 对账要拿用户的 Firefly 令牌回查，没有令牌就不能判断账记没记上。
    pub(crate) const RECONCILE_TOKEN_REQUIRED: &str = "reconcile_token_required";
    /// 同一个 external_id 在 Firefly 里查到多条，系统不替用户选。
    pub(crate) const RECONCILE_AMBIGUOUS: &str = "reconcile_ambiguous";
    /// 撤销入账要拿用户的 Firefly 令牌去删交易，没有令牌就什么都不做。
    pub(crate) const UNDO_TOKEN_REQUIRED: &str = "undo_token_required";
}

/// 撤销一行入账的结局。逐行汇报，因为一批里每一行的下场可能都不一样。
mod undo_outcomes {
    /// 交易删掉了（或本来就不在），行已经回到待处理。
    pub(super) const UNDONE: &str = "undone";
    /// 这一行本来就不是已入账，什么都没动。
    pub(super) const NOT_IMPORTED: &str = "not_imported";
    /// 这一行不存在，或者不属于这个用户。
    pub(super) const NOT_FOUND: &str = "not_found";
    /// Firefly 没能删掉这笔交易，行原样停在已入账。
    pub(super) const FAILED: &str = "failed";
}

const MAX_ERROR_CHARS: usize = 2_000;

/// 一次撤销最多几行。撤销要逐行去 Firefly 删交易，比入账更慢也更该分批。
const MAX_UNDO_ROWS: usize = 500;

/// 撤销结果的一行。`outcome` 是给界面分支用的机器码，`error` 是给人看的那句话。
fn undo_row(row_id: i64, outcome: &str, group_id: Option<i64>, error: Option<&str>) -> Value {
    json!({
        "row_id": row_id.to_string(),
        "outcome": outcome,
        "transaction_group_id": group_id.map(|id| id.to_string()),
        "error": error,
    })
}

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
    /// `batch_id` = 「这一条是哪一次入账动作写进去的」。
    ///
    /// 由发起那一次批量入账的调用方生成一个，整批共用。界面靠它把已入账的行按批次
    /// 聚起来、整批撤回；没有它就只能按时间窗口猜哪几条算一批，而猜错要从账本里
    /// 删掉不该删的交易。单条重试（reconcile / retry）不属于任何一批，传 None。
    pub(crate) async fn prepare_import(
        &self,
        user_id: i64,
        row_id: i64,
        dry_run: bool,
        batch_id: Option<&str>,
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
                        payload_hash, payload_snapshot, batch_id)
                     -- 先钉成 text 再转 uuid：只写 $9::uuid 的话 Postgres 会把这个
                     -- 参数本身推断成 uuid，驱动这边送的是字符串，类型对不上直接报错。
                     VALUES ($1,$2,$3,$4,$8,$5,$6,$7,$9::text::uuid)",
                    &[
                        &id,
                        &user_id,
                        &row_id,
                        &attempt_no,
                        &external_id,
                        &payload_hash,
                        &payload,
                        &ImportStatus::Prepared.as_str(),
                        &batch_id,
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
            return Err(
                ApiError::invalid_params("transaction_group_id 必须是正整数。")
                    .with_reason(reasons::AMOUNT_INVALID),
            );
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
            .ok_or_else(|| {
                ApiError::not_found("导入尝试不存在。").with_reason(reasons::ATTEMPT_NOT_FOUND)
            })?;
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
            return Err(
                ApiError::conflict("该导入尝试已经绑定到另一个 Firefly 交易组。")
                    .with_reason(reasons::ATTEMPT_ALREADY_BOUND),
            );
        }
        // 合不合法交给状态机判断，而不是在这里再抄一遍允许的来源状态。
        if !status.can_transition(target_status) {
            return Err(ApiError::conflict("当前导入尝试不能完成。")
                .with_reason(reasons::ATTEMPT_TRANSITION_INVALID));
        }
        let row_updated = transaction
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
        // 这一行在发送途中被别处改掉了（另一个标签页确认重复、手动忽略、或者已经入过账）。
        // 账很可能已经在 Firefly 里，本地却没有一行认领它——这时候把 attempt 记成成功，
        // 就是把「Firefly 有账、本地没有」这件事永久掩埋。宁可停在一个明确的失败态上。
        if row_updated == 0
            && !row_already_settled_here(&transaction, user_id, row_id, transaction_group_id)
                .await?
        {
            return abandon_completion(transaction, user_id, attempt_id, row_id, status).await;
        }
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
        let retry_delay = if retryable { 30 } else { 0 };
        let message = truncate(error_message, MAX_ERROR_CHARS);
        // 能走到**这一个**目标状态的来源，才是这次的合法来源。取两个目标的交集会
        // 误伤只通向其中一个的合法路径——uncertain 能去 retryable、不能去 rejected，
        // 交集一算它就哪儿也去不了了。
        let sources = crate::states::sql_list(
            &ImportStatus::ALL
                .iter()
                .copied()
                .filter(|status| status.can_transition(target))
                .collect::<Vec<_>>(),
        );
        let target = target.as_str();
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

    /// 对账：拿这条 attempt 的 `external_id` 去 Firefly 里查，账到底记上了没有。
    ///
    /// 这是 uncertain 唯一的出口。以前这里不查证就直接写死「未找到，可以重新导入」，
    /// 等于把「不知道」当成「没有」——用户照着提示重发一次，账本上就多一笔。
    /// 现在只有真的查不到才放行；查到就地对账（attempt 落 reconciled，行落 imported）；
    /// 查到多条不替用户选。
    pub(crate) async fn reconcile_uncertain_import(
        &self,
        user_id: i64,
        attempt_id: &str,
        token: Option<&str>,
    ) -> Result<Value, ApiError> {
        let attempt = self.get_import_attempt(user_id, attempt_id).await?;
        let status = attempt["data"]["status"].as_str().unwrap_or_default();
        if status != ImportStatus::Uncertain.as_str() {
            return Err(ApiError::conflict("只有结果不确定的导入尝试需要对账。")
                .with_reason(reasons::ATTEMPT_TRANSITION_INVALID));
        }
        let external_id = attempt["data"]["external_id"]
            .as_str()
            .ok_or_else(|| ApiError::internal("导入尝试缺少 external_id。"))?;
        let Some(token) = token else {
            return Err(ApiError::unauthenticated(
                "对账要用用户的 Firefly 令牌回查，没有令牌不能判断这笔账记没记上。",
            )
            .with_reason(reasons::RECONCILE_TOKEN_REQUIRED));
        };

        match self.reconcile_lookup(token, external_id).await?.as_slice() {
            [group_id] => {
                self.complete_import(user_id, attempt_id, *group_id, true)
                    .await
            }
            [] => self.release_uncertain_import(user_id, attempt_id).await,
            group_ids => Err(ApiError::conflict(format!(
                "同一个 external_id 在 Firefly 中查到 {} 条交易，需要人工处理。",
                group_ids.len()
            ))
            .with_reason(reasons::RECONCILE_AMBIGUOUS)),
        }
    }

    /// 按 `external_id` 查 Firefly，返回去重后的交易组 id。
    ///
    /// 查不动就报错往上抛：查询本身失败和「确认没有」是两件事，混为一谈就又回到了
    /// 「把不知道当成没有」。
    async fn reconcile_lookup(&self, token: &str, external_id: &str) -> Result<Vec<i64>, ApiError> {
        let found = self
            .firefly
            .get_json(
                token,
                "/api/v1/search/transactions",
                &[
                    ("query", format!("external_id_is:\"{external_id}\"")),
                    ("limit", "10".to_owned()),
                ],
            )
            .await?;
        let mut group_ids = found["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| {
                item["id"]
                    .as_i64()
                    .or_else(|| item["id"].as_str()?.parse::<i64>().ok())
                    .filter(|id| *id > 0)
            })
            .collect::<Vec<_>>();
        group_ids.sort_unstable();
        group_ids.dedup();
        Ok(group_ids)
    }

    /// 确认 Firefly 里没有之后，把 uncertain 放回可重试。
    ///
    /// 私有：走到这里的前提是[`Self::reconcile_uncertain_import`]已经查证过。
    async fn release_uncertain_import(
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

    /// 撤销入账：把 Firefly 里那笔交易删掉，然后让这一行回到待处理。
    ///
    /// 以前撤销只有前端那半截——直接删 Firefly 的交易组，abei 这边一无所知。结果是
    /// 账本上那笔没了，收件箱却还说「已入账」，「查看交易」点开是一笔不存在的交易，
    /// 而且因为 succeeded 那条尝试还占着 `bill_import_attempts_success_row_idx`，
    /// 这一行连重新入账都不行。整件事只有从写状态的这一侧做才收得住口。
    ///
    /// 顺序是先删账本、后改本地：反过来的话中间崩一次，本地说「没入账」而 Firefly
    /// 里还留着那笔，用户再入一次就是双记。先删后改最坏只是本地滞后，下次撤销能补上。
    ///
    /// Firefly 回 404 按成功办：撤销要的是「那笔不在了」，本来就不在和这次删掉是同一个
    /// 结果。删不掉的行原样停在已入账并逐行报错——绝不能一边说撤销成功一边把账留在账本里。
    pub(crate) async fn undo_imports(
        &self,
        user_id: i64,
        row_ids: &[i64],
        token: Option<&str>,
    ) -> Result<Value, ApiError> {
        if row_ids.is_empty() || row_ids.len() > MAX_UNDO_ROWS {
            return Err(ApiError::invalid_params(format!(
                "row_ids 必须包含 1 到 {MAX_UNDO_ROWS} 条流水。"
            )));
        }
        let Some(token) = token else {
            return Err(ApiError::unauthenticated(
                "撤销入账要用用户的 Firefly 令牌去删这笔交易，没有令牌就什么都不做。",
            )
            .with_reason(reasons::UNDO_TOKEN_REQUIRED));
        };

        let mut rows = Vec::with_capacity(row_ids.len());
        for row_id in row_ids {
            rows.push(self.undo_one_import(user_id, *row_id, token).await?);
        }
        let count = |outcome: &str| rows.iter().filter(|row| row["outcome"] == outcome).count();
        Ok(json!({ "data": {
            "rows": rows,
            "summary": {
                "total": rows.len(),
                "undone": count(undo_outcomes::UNDONE),
                "not_imported": count(undo_outcomes::NOT_IMPORTED),
                "not_found": count(undo_outcomes::NOT_FOUND),
                "failed": count(undo_outcomes::FAILED),
            },
        }}))
    }

    /// 撤销一行。返回的是这一行的结局，不是 `Err`——一行删不掉不该让整批 500。
    /// 只有连库都连不上这种「整批都没跑」的情况才往上抛。
    async fn undo_one_import(
        &self,
        user_id: i64,
        row_id: i64,
        token: &str,
    ) -> Result<Value, ApiError> {
        let existing = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query_opt(
                "SELECT status, transaction_group_id FROM abei_ai.bill_rows
                 WHERE user_id = $1 AND id = $2",
                &[&user_id, &row_id],
            )
            .await
            .map_err(ApiError::database)?;
        let Some(existing) = existing else {
            return Ok(undo_row(
                row_id,
                undo_outcomes::NOT_FOUND,
                None,
                Some("账单流水不存在。"),
            ));
        };
        let status: String = existing.get(0);
        let group_id: Option<i64> = existing.get(1);
        if status != RowStatus::Imported.as_str() {
            return Ok(undo_row(
                row_id,
                undo_outcomes::NOT_IMPORTED,
                group_id,
                Some("只有已入账的流水可以撤销。"),
            ));
        }

        // 没有交易组 id 的已入账行指不出账本里的任何一笔，没有东西可删。直接回退，
        // 让这一行重新可用，比让它永远卡在一个指不出去的「已入账」上强。
        if let Some(group_id) = group_id
            && let Err(error) = self
                .firefly
                .delete(token, &format!("/api/v1/transactions/{group_id}"))
                .await
        {
            let message = match error {
                WriteError::Http { status, body } => format!(
                    "Firefly 没能删掉交易 {group_id}：{}",
                    firefly::error_message(&body, status.as_u16())
                ),
                WriteError::Transport(error) => {
                    format!("连不上 Firefly，交易 {group_id} 删没删掉不确定：{error}")
                }
                WriteError::InvalidResponse(error) => {
                    format!("Firefly 对删除交易 {group_id} 的回应读不懂：{error}")
                }
            };
            return Ok(undo_row(
                row_id,
                undo_outcomes::FAILED,
                Some(group_id),
                Some(&message),
            ));
        }

        self.release_imported_row(user_id, row_id, group_id).await
    }

    /// 账本那边已经干净了，把本地这一行和它的导入尝试收尾。
    async fn release_imported_row(
        &self,
        user_id: i64,
        row_id: i64,
        group_id: Option<i64>,
    ) -> Result<Value, ApiError> {
        const UNDO_NOTE: &str = "入账已撤销：Firefly 里的交易已删除，这一行放回待处理。";
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let released = transaction
            .execute(
                "UPDATE abei_ai.bill_rows SET status = $3, transaction_group_id = NULL,
                   last_import_error = NULL, updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status = $4",
                &[
                    &user_id,
                    &row_id,
                    &RowStatus::Pending.as_str(),
                    &RowStatus::Imported.as_str(),
                ],
            )
            .await
            .map_err(ApiError::database)?;
        // 刚才还是 imported，现在不是了——另一个标签页在这中间动过它。Firefly 那笔已经
        // 删掉了，本地却不知道该按哪个状态收。说清楚比蒙混过去强。
        if released == 0 {
            transaction.rollback().await.map_err(ApiError::database)?;
            return Ok(undo_row(
                row_id,
                undo_outcomes::FAILED,
                group_id,
                Some("Firefly 里的交易已删除，但这一行在撤销途中被改成了别的状态，需要人工核对。"),
            ));
        }
        // 尝试记录不删：删了就再也说不清「这一行入过账又被撤了」。它必须离开
        // succeeded/reconciled 这一组，否则那个部分唯一索引会一直挡着重新入账。
        let settled = crate::states::sql_list(ImportStatus::SETTLED);
        transaction
            .execute(
                &format!(
                    "UPDATE abei_ai.bill_import_attempts SET status = $3,
                       error_code = 'import_undone', error_message = $4,
                       finished_at = now(), updated_at = now()
                     WHERE user_id = $1 AND bill_row_id = $2 AND status IN ({settled})"
                ),
                &[
                    &user_id,
                    &row_id,
                    &ImportStatus::Undone.as_str(),
                    &UNDO_NOTE,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        transaction.commit().await.map_err(ApiError::database)?;
        Ok(undo_row(row_id, undo_outcomes::UNDONE, group_id, None))
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
        Err(ApiError::conflict(message).with_reason(reasons::ATTEMPT_TRANSITION_INVALID))
    }
}

/// 行已经是「入账到这同一个交易组」了吗。是的话 UPDATE 影响 0 行只是重复调用，不是撕裂。
async fn row_already_settled_here(
    transaction: &Transaction<'_>,
    user_id: i64,
    row_id: i64,
    transaction_group_id: i64,
) -> Result<bool, ApiError> {
    let row = transaction
        .query_opt(
            "SELECT status, transaction_group_id FROM abei_ai.bill_rows
             WHERE user_id = $1 AND id = $2",
            &[&user_id, &row_id],
        )
        .await
        .map_err(ApiError::database)?;
    Ok(row.is_some_and(|row| {
        row.get::<_, String>(0) == RowStatus::Imported.as_str()
            && row.get::<_, Option<i64>>(1) == Some(transaction_group_id)
    }))
}

/// 行状态变了之后的收尾：同一个事务里把 attempt 落到失败态并把原因写到行上，
/// 然后提交——「成功」那一组写入一个字都不留下，留下的只有这件事需要人来看。
async fn abandon_completion(
    transaction: deadpool_postgres::Transaction<'_>,
    user_id: i64,
    attempt_id: &str,
    row_id: i64,
    status: ImportStatus,
) -> Result<Value, ApiError> {
    const MESSAGE: &str =
        "Firefly 可能已经建好这笔交易，但本地流水在入账途中被改成了别的状态，需要人工核对。";
    let target = if status.can_transition(ImportStatus::Rejected) {
        ImportStatus::Rejected
    } else {
        return Err(ApiError::conflict("当前导入尝试不能完成。")
            .with_reason(reasons::ATTEMPT_TRANSITION_INVALID));
    };
    transaction
        .execute(
            "UPDATE abei_ai.bill_import_attempts SET status = $3,
               error_code = 'row_state_changed', error_message = $4,
               retry_after = NULL, finished_at = now(), updated_at = now()
             WHERE user_id = $1 AND id = $2",
            &[&user_id, &attempt_id, &target.as_str(), &MESSAGE],
        )
        .await
        .map_err(ApiError::database)?;
    transaction
        .execute(
            "UPDATE abei_ai.bill_rows SET last_import_error = $3, updated_at = now()
             WHERE user_id = $1 AND id = $2",
            &[&user_id, &row_id, &MESSAGE],
        )
        .await
        .map_err(ApiError::database)?;
    transaction.commit().await.map_err(ApiError::database)?;
    Err(ApiError::conflict(MESSAGE).with_reason(reasons::ROW_STATE_CHANGED))
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
        .ok_or_else(|| {
            ApiError::not_found("账单流水不存在。").with_reason(reasons::ROW_NOT_FOUND)
        })?;
    let occurred_at: String = row.get(3);
    let signed_amount = parse_decimal(row.get::<_, String>(4), "signed_amount")?;
    let firefly_amount = row
        .get::<_, Option<String>>(8)
        .ok_or_else(|| {
            ApiError::conflict("流水缺少 firefly_amount，不能入账。")
                .with_reason(reasons::ROW_INCOMPLETE)
        })
        .and_then(|value| parse_decimal(value, "firefly_amount"))?;
    let firefly_date = row.get::<_, Option<String>>(7).ok_or_else(|| {
        ApiError::conflict("流水缺少 firefly_date，不能入账。").with_reason(reasons::ROW_INCOMPLETE)
    })?;
    Ok(ImportRow {
        id: row.get(0),
        status: row.get(1),
        duplicate_state: row.get(2),
        occurred_at,
        signed_amount,
        currency_code: row.get(5),
        firefly_type: row.get::<_, Option<String>>(6).ok_or_else(|| {
            ApiError::invalid_params("流水缺少 firefly_type。").with_reason(reasons::ROW_INCOMPLETE)
        })?,
        firefly_date,
        firefly_amount,
        description: row
            .get::<_, Option<String>>(9)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                ApiError::invalid_params("流水缺少非空描述。").with_reason(reasons::ROW_INCOMPLETE)
            })?,
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
        return Err(ApiError::conflict("只能导入当前活动 revision 的流水。")
            .with_reason(reasons::ROW_NOT_IMPORTABLE));
    }
    if row.status != RowStatus::Pending.as_str() || row.transaction_group_id.is_some() {
        return Err(ApiError::conflict("只有尚未入账的待处理流水可以导入。")
            .with_reason(reasons::ROW_NOT_IMPORTABLE));
    }
    if row.duplicate_state != "unique" {
        return Err(ApiError::conflict("疑似重复或冲突的流水必须先人工确认。")
            .with_reason(reasons::DUPLICATE_UNRESOLVED));
    }
    if !matches!(
        row.firefly_type.as_str(),
        "withdrawal" | "deposit" | "transfer"
    ) {
        return Err(ApiError::invalid_params("firefly_type 不支持。")
            .with_reason(reasons::ROW_TYPE_UNSUPPORTED));
    }
    if row.firefly_amount <= Decimal::ZERO {
        return Err(
            ApiError::invalid_params("入账金额必须大于 0。").with_reason(reasons::AMOUNT_INVALID)
        );
    }
    match row.firefly_type.as_str() {
        "withdrawal" if row.source_account_id.is_none() => {
            return Err(ApiError::conflict("支出流水必须先映射付款 Firefly 账户。")
                .with_reason(reasons::ACCOUNT_UNMAPPED));
        }
        "deposit" if row.destination_account_id.is_none() => {
            return Err(ApiError::conflict("收入流水必须先映射收款 Firefly 账户。")
                .with_reason(reasons::ACCOUNT_UNMAPPED));
        }
        "transfer"
            if row.source_account_id.is_none()
                || row.destination_account_id.is_none()
                || row.source_account_id == row.destination_account_id =>
        {
            return Err(ApiError::conflict("转账必须选择两个不同的 Firefly 账户。")
                .with_reason(reasons::TRANSFER_ACCOUNTS_INVALID));
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
        return Err(
            ApiError::conflict(format!("这条流水已有 {status} 导入尝试，不能重复发送。"))
                .with_reason(reasons::IMPORT_IN_FLIGHT),
        );
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
            ))
            .with_reason(reasons::SPLIT_TOTAL_MISMATCH));
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
        return Err(
            ApiError::invalid_params("交易金额必须大于 0。").with_reason(reasons::AMOUNT_INVALID)
        );
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
        return Err(
            ApiError::invalid_params("交易描述不能为空。").with_reason(reasons::ROW_INCOMPLETE)
        );
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
    Decimal::from_str(&value).map_err(|_| {
        ApiError::invalid_params(format!("{field} 不是有效金额。"))
            .with_reason(reasons::AMOUNT_INVALID)
    })
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
            .with_reason(reasons::IMPORT_IN_FLIGHT)
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

/// 带库的用例：入账落库的幂等性，和 uncertain 的对账出口。
#[cfg(test)]
mod db_tests {
    use super::*;
    use crate::testdb::{self, FakeDelete, FakeSearch, FakeWrite};

    fn service(pool: &deadpool_postgres::Pool, firefly: crate::firefly::Firefly) -> Service {
        let config = crate::mailbox::RuntimeConfig::test();
        let mail = crate::mail::Service::new(pool.clone(), config.storage_root().to_path_buf());
        let parser = crate::parser::Service::new(pool.clone(), mail.clone());
        Service::new(
            pool.clone(),
            mail,
            parser,
            config.job_secret_cipher(),
            config.reliability(),
            firefly,
        )
    }

    /// 对账等待窗口调到已经过去，用例不用真的等 30 秒。
    async fn open_the_reconcile_window(client: &deadpool_postgres::Client, attempt_id: &str) {
        client
            .execute(
                "UPDATE abei_ai.bill_import_attempts
                 SET retry_after = now() - interval '1 minute' WHERE id = $1",
                &[&attempt_id],
            )
            .await
            .unwrap();
    }

    async fn row_state(
        client: &deadpool_postgres::Client,
        row_id: i64,
    ) -> (String, Option<i64>, Option<String>) {
        let row = client
            .query_one(
                "SELECT status, transaction_group_id, last_import_error
                 FROM abei_ai.bill_rows WHERE id = $1",
                &[&row_id],
            )
            .await
            .unwrap();
        (row.get(0), row.get(1), row.get(2))
    }

    #[tokio::test]
    async fn a_row_that_changed_underneath_us_must_not_end_up_as_a_successful_import() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_001_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "sending", 0.0).await;
        // 另一个标签页在这中间确认了重复，把这一行并掉了。
        client
            .execute(
                "UPDATE abei_ai.bill_rows SET status = 'dismissed',
                   dismissed_reason = 'duplicate_confirmed' WHERE id = $1",
                &[&fixture.row_id],
            )
            .await
            .unwrap();

        let failed = service(&pool, testdb::unreachable_firefly().await)
            .complete_import(user_id, &attempt_id, 5150, false)
            .await
            .expect_err("行已经不是待处理，不能宣布入账成功");

        assert_eq!(failed.reason(), reasons::ROW_STATE_CHANGED);
        // 关键的一条：attempt 不能是 succeeded，否则「Firefly 有账、本地没有」被永久掩埋。
        assert_eq!(
            testdb::attempt_status(&client, &attempt_id).await,
            "rejected"
        );
        let (status, group, error) = row_state(&client, fixture.row_id).await;
        assert_eq!(status, "dismissed", "失败的入账不能改动这一行的状态");
        assert_eq!(group, None, "没入成账就不该记住交易组");
        assert!(error.is_some(), "行上要留下一句能让人看懂的话");
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn completing_the_same_import_twice_is_idempotent_rather_than_a_conflict() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_002_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "sending", 0.0).await;
        let service = service(&pool, testdb::unreachable_firefly().await);

        service
            .complete_import(user_id, &attempt_id, 6100, false)
            .await
            .unwrap();
        // 重放同一次完成：行已经是 imported，UPDATE 影响 0 行，但这不是撕裂。
        service
            .complete_import(user_id, &attempt_id, 6100, false)
            .await
            .unwrap();

        assert_eq!(
            testdb::attempt_status(&client, &attempt_id).await,
            "succeeded"
        );
        assert_eq!(row_state(&client, fixture.row_id).await.0, "imported");
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn reconciling_finds_the_transaction_and_stops_the_row_from_being_imported_again() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_003_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "uncertain", 0.0).await;
        open_the_reconcile_window(&client, &attempt_id).await;
        let firefly =
            testdb::FakeFirefly::start_with_search(FakeWrite::Created(1), FakeSearch::One(7788))
                .await;

        service(&pool, firefly.client())
            .reconcile_uncertain_import(user_id, &attempt_id, Some("test-token"))
            .await
            .unwrap();

        // 账在 Firefly 里查到了：这条尝试就地落定，行跟着入账，绝不能放回可重试。
        assert_eq!(
            testdb::attempt_status(&client, &attempt_id).await,
            "reconciled"
        );
        let (status, group, _) = row_state(&client, fixture.row_id).await;
        assert_eq!(status, "imported");
        assert_eq!(group, Some(7788));
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn reconciling_only_releases_the_attempt_after_firefly_says_it_has_nothing() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_004_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "uncertain", 0.0).await;
        open_the_reconcile_window(&client, &attempt_id).await;
        let firefly =
            testdb::FakeFirefly::start_with_search(FakeWrite::Created(1), FakeSearch::Nothing)
                .await;

        service(&pool, firefly.client())
            .reconcile_uncertain_import(user_id, &attempt_id, Some("test-token"))
            .await
            .unwrap();

        assert_eq!(
            testdb::attempt_status(&client, &attempt_id).await,
            "retryable"
        );
        assert_eq!(row_state(&client, fixture.row_id).await.0, "pending");
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn without_a_token_nothing_gets_released_because_nothing_was_checked() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_005_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "uncertain", 0.0).await;
        open_the_reconcile_window(&client, &attempt_id).await;

        let refused = service(&pool, testdb::unreachable_firefly().await)
            .reconcile_uncertain_import(user_id, &attempt_id, None)
            .await
            .expect_err("没查证就不能放行");

        assert_eq!(refused.reason(), reasons::RECONCILE_TOKEN_REQUIRED);
        assert_eq!(
            testdb::attempt_status(&client, &attempt_id).await,
            "uncertain",
            "查不了就该原地待着，不能变成可重试"
        );
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_duplicated_external_id_is_handed_to_a_human_instead_of_being_guessed() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_006_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "uncertain", 0.0).await;
        open_the_reconcile_window(&client, &attempt_id).await;
        let firefly =
            testdb::FakeFirefly::start_with_search(FakeWrite::Created(1), FakeSearch::Many).await;

        let refused = service(&pool, firefly.client())
            .reconcile_uncertain_import(user_id, &attempt_id, Some("test-token"))
            .await
            .expect_err("查到多条不该自己挑一条");

        assert_eq!(refused.reason(), reasons::RECONCILE_AMBIGUOUS);
        assert_eq!(
            testdb::attempt_status(&client, &attempt_id).await,
            "uncertain"
        );
        testdb::cleanup(&client, user_id).await;
    }

    /// 撤销入账要一次做完两件事：账本里那笔没了，收件箱这一行回到待处理。
    /// 只做前一半正是这个缺陷本身——账没了，界面还说已入账。
    #[tokio::test]
    async fn undoing_an_import_deletes_the_transaction_and_puts_the_row_back_in_the_queue() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_010_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "sending", 0.0).await;
        let firefly = testdb::FakeFirefly::start_with_delete(FakeDelete::Gone).await;
        let service = service(&pool, firefly.client());
        service
            .complete_import(user_id, &attempt_id, 5501, false)
            .await
            .unwrap();

        let result = service
            .undo_imports(user_id, &[fixture.row_id], Some("test-token"))
            .await
            .unwrap();

        assert_eq!(result["data"]["summary"]["undone"], 1);
        assert_eq!(result["data"]["rows"][0]["outcome"], "undone");
        assert_eq!(firefly.delete_count(), 1, "账本里那笔必须真的去删");
        let (status, group, error) = row_state(&client, fixture.row_id).await;
        assert_eq!(status, "pending", "撤销之后这一行要回到待处理");
        assert_eq!(group, None, "交易都删了就不能再记着它的交易组");
        assert_eq!(error, None);
        // 记录不删，只是不再算数：删了就再也说不清这一行入过账又被撤了。
        assert_eq!(testdb::attempt_status(&client, &attempt_id).await, "undone");
        testdb::cleanup(&client, user_id).await;
    }

    /// 撤销之后必须能重新入账。succeeded 那条尝试要是还占着
    /// `bill_import_attempts_success_row_idx`，这一行就永远卡在「已有成功导入」上。
    #[tokio::test]
    async fn a_row_that_was_undone_can_be_imported_again() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_011_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "sending", 0.0).await;
        let firefly = testdb::FakeFirefly::start_with_delete(FakeDelete::Gone).await;
        let service = service(&pool, firefly.client());
        service
            .complete_import(user_id, &attempt_id, 5502, false)
            .await
            .unwrap();
        service
            .undo_imports(user_id, &[fixture.row_id], Some("test-token"))
            .await
            .unwrap();

        service
            .prepare_import(user_id, fixture.row_id, false, None)
            .await
            .expect("撤销之后这一行应该重新可以入账");

        testdb::cleanup(&client, user_id).await;
    }

    /// Firefly 说 404：那笔交易本来就不在了。撤销要的结果已经达成，行照样回队列。
    /// 把 404 当失败会让用户卡在一条永远撤不掉的记录上。
    #[tokio::test]
    async fn a_transaction_that_is_already_gone_still_releases_the_row() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_012_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "sending", 0.0).await;
        let firefly = testdb::FakeFirefly::start_with_delete(FakeDelete::Missing).await;
        let service = service(&pool, firefly.client());
        service
            .complete_import(user_id, &attempt_id, 5503, false)
            .await
            .unwrap();

        let result = service
            .undo_imports(user_id, &[fixture.row_id], Some("test-token"))
            .await
            .unwrap();

        assert_eq!(result["data"]["rows"][0]["outcome"], "undone");
        assert_eq!(row_state(&client, fixture.row_id).await.0, "pending");
        assert_eq!(testdb::attempt_status(&client, &attempt_id).await, "undone");
        testdb::cleanup(&client, user_id).await;
    }

    /// Firefly 删不掉：账还在账本里，这一行就必须原样停在已入账。
    /// 一边说撤销成功一边把账留在账本里，用户会照着收件箱再入一次，账本上就是两笔。
    #[tokio::test]
    async fn a_transaction_firefly_refuses_to_delete_leaves_the_row_imported() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_013_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "sending", 0.0).await;
        let firefly = testdb::FakeFirefly::start_with_delete(FakeDelete::Rejected(500)).await;
        let service = service(&pool, firefly.client());
        service
            .complete_import(user_id, &attempt_id, 5504, false)
            .await
            .unwrap();

        let result = service
            .undo_imports(user_id, &[fixture.row_id], Some("test-token"))
            .await
            .unwrap();

        assert_eq!(result["data"]["rows"][0]["outcome"], "failed");
        assert!(
            result["data"]["rows"][0]["error"].is_string(),
            "得说清为什么"
        );
        let (status, group, _) = row_state(&client, fixture.row_id).await;
        assert_eq!(status, "imported", "账还在账本里，这一行就不能说自己没入账");
        assert_eq!(group, Some(5504), "交易组还指得出去");
        assert_eq!(
            testdb::attempt_status(&client, &attempt_id).await,
            "succeeded"
        );
        testdb::cleanup(&client, user_id).await;
    }

    /// 没入过账的行不能撤销，而且一个字节都不该发给 Firefly。
    #[tokio::test]
    async fn undoing_a_row_that_was_never_imported_touches_nothing() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_014_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let firefly = testdb::FakeFirefly::start_with_delete(FakeDelete::Gone).await;

        let result = service(&pool, firefly.client())
            .undo_imports(user_id, &[fixture.row_id], Some("test-token"))
            .await
            .unwrap();

        assert_eq!(result["data"]["rows"][0]["outcome"], "not_imported");
        assert_eq!(firefly.delete_count(), 0, "没入过账就不该去动账本");
        assert_eq!(row_state(&client, fixture.row_id).await.0, "pending");
        testdb::cleanup(&client, user_id).await;
    }

    /// 没有令牌就删不了账本里那笔。这时候放行会把行放回队列、账却留在账本里——
    /// 用户再入一次就是双记。宁可明确拒绝。
    #[tokio::test]
    async fn without_a_token_no_row_is_released_because_nothing_can_be_deleted() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_015_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "sending", 0.0).await;
        let service = service(&pool, testdb::unreachable_firefly().await);
        service
            .complete_import(user_id, &attempt_id, 5505, false)
            .await
            .unwrap();

        let refused = service
            .undo_imports(user_id, &[fixture.row_id], None)
            .await
            .expect_err("没令牌就删不了账本，不能放行");

        assert_eq!(refused.reason(), reasons::UNDO_TOKEN_REQUIRED);
        assert_eq!(row_state(&client, fixture.row_id).await.0, "imported");
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn an_uncertain_attempt_can_still_be_marked_retryable_by_hand() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_112_007_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let attempt_id = testdb::insert_attempt(&client, &fixture, "uncertain", 0.0).await;

        // 状态机里 uncertain → retryable 一直是合法的，以前被「两个目标取交集」的
        // 过滤条件恒拒。
        service(&pool, testdb::unreachable_firefly().await)
            .fail_import(user_id, &attempt_id, true, None, "manual", "人工判定可重试")
            .await
            .unwrap();

        assert_eq!(
            testdb::attempt_status(&client, &attempt_id).await,
            "retryable"
        );
        testdb::cleanup(&client, user_id).await;
    }
}
