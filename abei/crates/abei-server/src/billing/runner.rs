//! 入账 saga：一条流水从「准备」到「Firefly 里有了这笔账」的完整过程。
//!
//! 这段编排以前在 abei-api 的 `routes/bill_imports.rs::import_one` 里，靠五次内部 HTTP
//! 调用推进 abei-server 的状态机。问题不在慢，在于**谁负责收尾**：abei-api 在
//! `mark-sending` 和 `complete` 之间挂掉，abei-server 只看到一条 `sending`，
//! 不知道 Firefly 那边发生了什么，也没有任何人会回来告诉它——只能等清扫器把它
//! 收成 `uncertain`，再等用户手动对账。saga 的中段横跨进程边界，就没有单一的归属者。
//!
//! 现在整条 saga 在 abei-server 进程内：写 Firefly 的那一步和它前后的状态迁移之间
//! 不再隔着网络，唯一还可能撕裂的点缩到「Firefly 已收到但我们没记下」这一个瞬间，
//! 而那个瞬间本来就有 `external_id` 对账兜底。
//!
//! abei-api 退成转发器：它仍然负责校验用户令牌（那是它的职责），然后把令牌交给这里。
//! 令牌只在调用栈上传递，不落库、不进日志。

use axum::http::{Method, StatusCode};
use serde_json::{Value, json};

use super::{Service, existing};
use crate::ApiError;
use crate::firefly::{self, WriteError};

/// 一次入账请求要的全部输入。
pub(crate) struct ImportRequest<'a> {
    pub user_id: i64,
    /// 用户的 Firefly 令牌，由 abei-api 校验过之后转交。
    pub token: &'a str,
    pub row_id: i64,
    /// 只预览不写。走完全部检查，但不建 attempt、不碰 Firefly。
    pub dry_run: bool,
    /// 结果里带上发给 Firefly 的原始 payload，调试用。
    pub include_payload: bool,
}

impl Service {
    /// 跑完一条流水的入账。
    ///
    /// 不返回 `Result`：每一条流水的失败都是**这一条**的结果，要作为一行汇报给用户，
    /// 而不是让整批请求 500。真正的错误都编码在返回值的 `action` / `reason_code` 里。
    pub(crate) async fn run_import(&self, request: ImportRequest<'_>) -> Value {
        let ImportRequest {
            user_id,
            token,
            row_id,
            dry_run,
            include_payload,
        } = request;

        let prepared = match self.prepare_import(user_id, row_id, dry_run).await {
            Ok(value) => value,
            // 准备阶段的失败是「这条流水现在不能入账」，原因五花八门：账户没映射、金额非法、
            // 已经有在途尝试。整批请求不该因此失败，但也不能把原因糊成一个 import_excluded——
            // 前端要靠它决定是引导去配账户还是去人工确认，所以把具体机器码原样带出去。
            Err(error) => {
                return failed_row_with_reason(
                    row_id,
                    "skip",
                    error.detail(),
                    None,
                    error.reason(),
                    Some(error.detail()),
                );
            }
        };
        let data = &prepared["data"];
        let preview = data["preview"].clone();
        let payload = data["payload"].clone();
        let attempt_id = data["attempt_id"].as_str().map(str::to_owned);

        // 一、账户映射还指向存在且类型正确的 Firefly 账户吗。
        for account_id in data["account_ids"].as_array().into_iter().flatten() {
            let Some(account_id) = parse_positive_id(account_id) else {
                return self
                    .abandon(
                        user_id,
                        row_id,
                        attempt_id,
                        false,
                        "account_validation_failed",
                        "账户映射包含无效 ID。".to_owned(),
                        "failed",
                    )
                    .await;
            };
            if let Err(error) = self.verified_account(token, account_id).await {
                return self
                    .abandon(
                        user_id,
                        row_id,
                        attempt_id,
                        false,
                        "account_validation_failed",
                        error.detail(),
                        "failed",
                    )
                    .await;
            }
        }

        // 二、发送前最后一次查重。预览是很久以前生成的，这中间 Firefly 可能已经收到了同一笔。
        let existing_candidates =
            match existing::candidates_for_payload(&self.firefly, token, &payload).await {
                Ok(candidates) => candidates,
                Err(error) => {
                    let reason = error.detail();
                    if dry_run {
                        return excluded_row(
                            preview,
                            "existing_transaction_lookup_failed",
                            reason,
                            None,
                            include_payload.then_some(payload),
                        );
                    }
                    // 查不动就不敢发：宁可让用户重试，也不能在不知道有没有重复的情况下写账。
                    if let Some(attempt_id) = &attempt_id {
                        let _ = self
                            .fail_import(
                                user_id,
                                attempt_id,
                                true,
                                None,
                                "existing_transaction_lookup_failed",
                                &reason,
                            )
                            .await;
                    }
                    return failed_row_with_reason(
                        row_id,
                        "retryable",
                        reason,
                        attempt_id,
                        "existing_transaction_lookup_failed",
                        None,
                    );
                }
            };
        if existing::has_high_confidence(&existing_candidates) {
            let reason = "Firefly 中已有高置信匹配交易，必须人工确认后再处理。".to_owned();
            if let Some(attempt_id) = &attempt_id {
                let _ = self
                    .fail_import(
                        user_id,
                        attempt_id,
                        false,
                        None,
                        "existing_firefly_transaction",
                        &reason,
                    )
                    .await;
            }
            let mut result = excluded_row(
                preview,
                "existing_firefly_transaction",
                reason,
                attempt_id,
                include_payload.then_some(payload),
            );
            result["existing_transaction_candidates"] = Value::Array(existing_candidates);
            return result;
        }

        if dry_run {
            let mut result = preview;
            result["status"] = Value::String("pending".to_owned());
            result["action"] = Value::String("would_import".to_owned());
            result["attempt_id"] = Value::Null;
            result["existing_transaction_candidates"] = Value::Array(existing_candidates);
            if include_payload {
                result["payload"] = payload;
            }
            return result;
        }

        let Some(attempt_id) = attempt_id else {
            return failed_row(row_id, "failed", "没有创建导入尝试。".to_owned(), None);
        };

        // 三、宣布要发了。这一步之后我们对「账可能已经记上」负责。
        if let Err(error) = self.mark_import_sending(user_id, &attempt_id).await {
            return failed_row(row_id, "failed", error.detail(), Some(attempt_id));
        }

        // 四、真正写 Firefly。
        let sent = self
            .firefly
            .send_json(token, Method::POST, "/api/v1/transactions", &payload)
            .await;

        // 五、落定。这里每一个分支都必须让 attempt 离开 `sending`，否则就又漏出一个
        // 只能靠清扫器回收的悬挂状态。
        match sent {
            Ok((status, response)) => {
                self.settle_success(
                    user_id,
                    row_id,
                    &attempt_id,
                    status,
                    &response,
                    preview,
                    payload,
                    include_payload,
                )
                .await
            }
            Err(WriteError::Http { status, body }) => {
                // Firefly 明确拒绝了：账没记上。5xx 当可重试，4xx 是请求本身不合法。
                let retryable = status.is_server_error();
                let message = firefly::error_message(&body, status.as_u16());
                let _ = self
                    .fail_import(
                        user_id,
                        &attempt_id,
                        retryable,
                        Some(i32::from(status.as_u16())),
                        if retryable {
                            "firefly_5xx"
                        } else {
                            "firefly_rejected"
                        },
                        &message,
                    )
                    .await;
                failed_row(
                    row_id,
                    if retryable { "retryable" } else { "failed" },
                    message,
                    Some(attempt_id),
                )
            }
            // 这两种都是「不知道账记没记上」。绝不能当失败重发。
            Err(WriteError::Transport(error)) => {
                let message = format!("Firefly 请求结果不确定：{error}");
                let _ = self
                    .mark_import_uncertain(user_id, &attempt_id, &message)
                    .await;
                failed_row(row_id, "uncertain", message, Some(attempt_id))
            }
            Err(WriteError::InvalidResponse(error)) => {
                let message = format!("Firefly 响应无法确认：{error}");
                let _ = self
                    .mark_import_uncertain(user_id, &attempt_id, &message)
                    .await;
                failed_row(row_id, "uncertain", message, Some(attempt_id))
            }
        }
    }

    /// Firefly 说写成功之后的收尾。
    #[allow(clippy::too_many_arguments)]
    async fn settle_success(
        &self,
        user_id: i64,
        row_id: i64,
        attempt_id: &str,
        status: StatusCode,
        response: &Value,
        preview: Value,
        payload: Value,
        include_payload: bool,
    ) -> Value {
        let Some(group_id) = parse_positive_id(&response["data"]["id"]) else {
            // 2xx 但没交易组 id：账多半记上了，我们却没有句柄能指向它。
            let message = "Firefly 已接受请求，但响应没有交易组 ID，正在按 external_id 对账。";
            let _ = self
                .mark_import_uncertain(user_id, attempt_id, message)
                .await;
            return failed_row(
                row_id,
                "uncertain",
                message.to_owned(),
                Some(attempt_id.to_owned()),
            );
        };
        match self
            .complete_import(user_id, attempt_id, group_id, false)
            .await
        {
            Ok(_) => {
                let mut result = preview;
                result["status"] = Value::String("imported".to_owned());
                result["action"] = Value::String("imported".to_owned());
                result["attempt_id"] = Value::String(attempt_id.to_owned());
                result["transaction_group_id"] = Value::String(group_id.to_string());
                result["firefly_status"] = Value::from(status.as_u16());
                if include_payload {
                    result["payload"] = payload;
                }
                result
            }
            Err(error) => {
                // 账记上了，本地却没记住。这是真正的撕裂，交给对账。
                let message = format!(
                    "Firefly 已返回交易组 {group_id}，但本地完成状态保存失败：{}",
                    error.detail()
                );
                let _ = self
                    .mark_import_uncertain(user_id, attempt_id, &message)
                    .await;
                failed_row(row_id, "uncertain", message, Some(attempt_id.to_owned()))
            }
        }
    }

    /// 还没发出去就放弃：把 attempt 标记掉，返回给用户的失败行。
    #[allow(clippy::too_many_arguments)]
    async fn abandon(
        &self,
        user_id: i64,
        row_id: i64,
        attempt_id: Option<String>,
        retryable: bool,
        error_code: &str,
        message: String,
        action: &str,
    ) -> Value {
        if let Some(attempt_id) = &attempt_id {
            let _ = self
                .fail_import(user_id, attempt_id, retryable, None, error_code, &message)
                .await;
        }
        failed_row(row_id, action, message, attempt_id)
    }

    /// 账户还在、类型也对吗。
    ///
    /// 挡住把账单记到收入/支出科目上——Firefly 会照收，但账本从此对不平。
    async fn verified_account(&self, token: &str, account_id: i64) -> Result<(), ApiError> {
        let account = self
            .firefly
            .get_json(token, &format!("/api/v1/accounts/{account_id}"), &[])
            .await?;
        let attributes = &account["data"]["attributes"];
        attributes["name"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| ApiError::upstream("Firefly 账户响应缺少名称。"))?;
        let kind = attributes["type"].as_str().unwrap_or_default();
        let normalized = kind.to_ascii_lowercase();
        if normalized.contains("expense") || normalized.contains("revenue") {
            return Err(ApiError::invalid_params(
                "账单账户映射必须指向资产、现金或负债账户，不能指向收入/支出科目。",
            )
            .with_reason(reasons::ACCOUNT_KIND_INVALID));
        }
        Ok(())
    }
}

/// 入账路径特有的机器码，补在 `ApiError.reason` 上。见 [`crate::firefly::reasons`]。
pub(crate) mod reasons {
    pub(crate) const ACCOUNT_KIND_INVALID: &str = "account_kind_invalid";
}

/// 把若干条流水的结果汇总成一次响应。字段和 abei-api 原来那份逐字一致。
pub(crate) fn import_response(rows: Vec<Value>, dry_run: bool) -> Value {
    let count = |action: &str| rows.iter().filter(|row| row["action"] == action).count();
    let mut response = json!({
        "summary": {
            "total": rows.len(),
            "imported": count("imported"),
            "skipped": count("skip"),
            "failed": count("failed"),
            "retryable": count("retryable"),
            "uncertain": count("uncertain"),
            "would_import": count("would_import"),
        },
        "rows": rows,
        "empty_reason": if rows.is_empty() {
            Some("没有可处理的待处理流水；请查看 bills review 或按 row_ids 预览具体排除原因。")
        } else {
            None
        },
        "balance_chain": [],
    });
    if dry_run {
        response["dry_run"] = Value::Bool(true);
    }
    response
}

fn failed_row(row_id: i64, action: &str, error: String, attempt_id: Option<String>) -> Value {
    let reason_code = match action {
        "skip" => "import_excluded",
        "retryable" => "import_retryable",
        "uncertain" => "import_uncertain",
        _ => "import_failed",
    };
    let exclusion_reason = (action == "skip").then(|| error.clone());
    failed_row_with_reason(
        row_id,
        action,
        error,
        attempt_id,
        reason_code,
        exclusion_reason,
    )
}

fn failed_row_with_reason(
    row_id: i64,
    action: &str,
    error: String,
    attempt_id: Option<String>,
    reason_code: &str,
    exclusion_reason: Option<String>,
) -> Value {
    json!({
        "row_id": row_id.to_string(),
        "status": action,
        "action": action,
        "attempt_id": attempt_id,
        "error": error,
        "reason_code": reason_code,
        "exclusion_reason": exclusion_reason,
    })
}

fn excluded_row(
    mut preview: Value,
    reason_code: &str,
    reason: String,
    attempt_id: Option<String>,
    payload: Option<Value>,
) -> Value {
    preview["status"] = Value::String("attention".to_owned());
    preview["action"] = Value::String("skip".to_owned());
    preview["attempt_id"] = attempt_id.map(Value::String).unwrap_or(Value::Null);
    preview["reason_code"] = Value::String(reason_code.to_owned());
    preview["exclusion_reason"] = Value::String(reason.clone());
    preview["error"] = Value::String(reason);
    if let Some(payload) = payload {
        preview["payload"] = payload;
    }
    preview
}

fn parse_positive_id(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str()?.parse::<i64>().ok())
        .filter(|value| *value > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_summary_keeps_uncertain_separate_from_failed() {
        // uncertain 和 failed 合并统计是危险的：failed 可以放心重试，
        // uncertain 必须先对账，界面要能区分。
        let value = import_response(
            vec![
                failed_row(1, "uncertain", "timeout".to_owned(), Some("a".repeat(36))),
                failed_row(2, "failed", "422".to_owned(), None),
                failed_row(4, "retryable", "503".to_owned(), Some("b".repeat(36))),
                json!({ "row_id": "3", "action": "imported" }),
            ],
            false,
        );
        assert_eq!(value["summary"]["total"], 4);
        assert_eq!(value["summary"]["imported"], 1);
        assert_eq!(value["summary"]["failed"], 1);
        assert_eq!(value["summary"]["uncertain"], 1);
        assert_eq!(value["summary"]["retryable"], 1);
        assert!(value["dry_run"].is_null());
    }

    #[test]
    fn an_empty_run_explains_itself_instead_of_returning_a_bare_zero() {
        let value = import_response(Vec::new(), true);
        assert_eq!(value["summary"]["total"], 0);
        assert!(value["empty_reason"].is_string());
        assert_eq!(value["dry_run"], true);
    }

    #[test]
    fn firefly_ids_arrive_as_strings_and_must_still_be_positive() {
        assert_eq!(parse_positive_id(&json!("42")), Some(42));
        assert_eq!(parse_positive_id(&json!(42)), Some(42));
        assert_eq!(parse_positive_id(&json!("0")), None);
        assert_eq!(parse_positive_id(&json!(-1)), None);
        assert_eq!(parse_positive_id(&json!("abc")), None);
        assert_eq!(parse_positive_id(&Value::Null), None);
    }

    #[test]
    fn a_skipped_row_carries_its_reason_in_both_fields_the_ui_reads() {
        let row = failed_row(7, "skip", "已经有了".to_owned(), None);
        assert_eq!(row["action"], "skip");
        assert_eq!(row["reason_code"], "import_excluded");
        assert_eq!(row["exclusion_reason"], "已经有了");
        assert_eq!(row["error"], "已经有了");
        // 非 skip 的行没有 exclusion_reason，别让界面把重试当成排除。
        let row = failed_row(7, "retryable", "503".to_owned(), None);
        assert_eq!(row["reason_code"], "import_retryable");
        assert!(row["exclusion_reason"].is_null());
    }
}

#[cfg(test)]
mod saga_tests {
    use super::*;
    use crate::testdb::{self, FakeWrite};

    /// 用指定的 Firefly 客户端造一个 billing::Service。
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

    /// 读一条流水最新的导入尝试状态。
    async fn latest_attempt(client: &deadpool_postgres::Client, row_id: i64) -> Option<String> {
        client
            .query_opt(
                "SELECT status FROM abei_ai.bill_import_attempts
                 WHERE bill_row_id = $1 ORDER BY attempt_no DESC LIMIT 1",
                &[&row_id],
            )
            .await
            .unwrap()
            .map(|row| row.get(0))
    }

    async fn row_status(client: &deadpool_postgres::Client, row_id: i64) -> (String, Option<i64>) {
        let row = client
            .query_one(
                "SELECT status, transaction_group_id FROM abei_ai.bill_rows WHERE id = $1",
                &[&row_id],
            )
            .await
            .unwrap();
        (row.get(0), row.get(1))
    }

    fn request(fixture: &testdb::Fixture) -> ImportRequest<'static> {
        ImportRequest {
            user_id: fixture.user_id,
            token: "test-token",
            row_id: fixture.row_id,
            dry_run: false,
            include_payload: false,
        }
    }

    #[tokio::test]
    async fn a_successful_write_settles_the_attempt_and_marks_the_row_imported() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_100_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let firefly = testdb::FakeFirefly::start(FakeWrite::Created(4242)).await;

        let result = service(&pool, firefly.client())
            .run_import(request(&fixture))
            .await;

        assert_eq!(result["action"], "imported");
        assert_eq!(result["transaction_group_id"], "4242");
        assert_eq!(
            latest_attempt(&client, fixture.row_id).await.as_deref(),
            Some("succeeded")
        );
        assert_eq!(
            row_status(&client, fixture.row_id).await,
            ("imported".to_owned(), Some(4242)),
            "入账成功后流水要落到 imported 并记住交易组"
        );
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_firefly_rejection_leaves_the_row_untouched_so_it_can_be_fixed() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_101_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let firefly = testdb::FakeFirefly::start(FakeWrite::Rejected(422)).await;

        let result = service(&pool, firefly.client())
            .run_import(request(&fixture))
            .await;

        // 422 是我们发的东西不合法，账没记上，重发也还是不合法。
        assert_eq!(result["action"], "failed");
        assert_eq!(
            latest_attempt(&client, fixture.row_id).await.as_deref(),
            Some("rejected")
        );
        assert_eq!(
            row_status(&client, fixture.row_id).await,
            ("pending".to_owned(), None),
            "被拒之后流水必须还留在待处理里，不能算已入账"
        );
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_firefly_outage_is_retryable_not_uncertain() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_102_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let firefly = testdb::FakeFirefly::start(FakeWrite::Rejected(503)).await;

        let result = service(&pool, firefly.client())
            .run_import(request(&fixture))
            .await;

        // 5xx 是 Firefly 明确回的，说明它收到了并且拒绝处理——账没记上，可以放心重试。
        assert_eq!(result["action"], "retryable");
        assert_eq!(
            latest_attempt(&client, fixture.row_id).await.as_deref(),
            Some("retryable")
        );
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_success_without_a_group_id_goes_to_uncertain_instead_of_being_retried() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_103_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let firefly = testdb::FakeFirefly::start(FakeWrite::CreatedWithoutId).await;

        let result = service(&pool, firefly.client())
            .run_import(request(&fixture))
            .await;

        // Firefly 说成功了但没给 id：账很可能已经记上。当失败重发就会记两笔。
        assert_eq!(result["action"], "uncertain");
        assert_eq!(
            latest_attempt(&client, fixture.row_id).await.as_deref(),
            Some("uncertain")
        );
        assert_eq!(
            row_status(&client, fixture.row_id).await.0,
            "pending",
            "结果不确定时不能宣布已入账"
        );
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_connection_dropped_mid_write_goes_to_uncertain_because_it_may_have_landed() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_104_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let firefly = testdb::FakeFirefly::start(FakeWrite::ConnectionDropped).await;

        let result = service(&pool, firefly.client())
            .run_import(request(&fixture))
            .await;

        // 请求已经送到（假 Firefly 数到了这一次写），回话却没了。账记没记上分不清，
        // 只能进 uncertain 等按 external_id 对账——当失败重发就会记两笔。
        assert_eq!(firefly.write_count(), 1);
        assert_eq!(result["action"], "uncertain");
        assert_eq!(
            latest_attempt(&client, fixture.row_id).await.as_deref(),
            Some("uncertain")
        );
        assert_eq!(row_status(&client, fixture.row_id).await.0, "pending");
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_reply_we_cannot_parse_goes_to_uncertain_rather_than_being_assumed_failed() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_108_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let firefly = testdb::FakeFirefly::start(FakeWrite::UnreadableBody).await;

        let result = service(&pool, firefly.client())
            .run_import(request(&fixture))
            .await;

        // 反代插了一页 HTML 之类的情况：状态码说成功，内容读不懂。仍然算不确定。
        assert_eq!(result["action"], "uncertain");
        assert_eq!(
            latest_attempt(&client, fixture.row_id).await.as_deref(),
            Some("uncertain")
        );
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_firefly_we_cannot_reach_at_all_fails_before_anything_is_sent() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_109_i64;
        let fixture = testdb::seed(&client, user_id).await;

        let result = service(&pool, testdb::unreachable_firefly().await)
            .run_import(request(&fixture))
            .await;

        // 完全连不上时第一个倒下的是账户校验，那时候还什么都没发出去。这种要明确算失败，
        // 不能算不确定——不确定意味着「可能已经记上了」，会白白让用户去对一笔不存在的账。
        assert_eq!(result["action"], "failed");
        assert_eq!(
            latest_attempt(&client, fixture.row_id).await.as_deref(),
            Some("rejected")
        );
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn an_already_imported_row_cannot_be_sent_a_second_time() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_105_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let firefly = testdb::FakeFirefly::start(FakeWrite::Created(777)).await;
        let service = service(&pool, firefly.client());

        let first = service.run_import(request(&fixture)).await;
        assert_eq!(first["action"], "imported");

        let second = service.run_import(request(&fixture)).await;

        // 第二次必须在写 Firefly 之前就被挡住，否则用户账本上会多一笔。
        assert_eq!(second["action"], "skip");
        assert_eq!(firefly.write_count(), 1, "重复入账不能再往 Firefly 发一次");
        assert_eq!(
            row_status(&client, fixture.row_id).await,
            ("imported".to_owned(), Some(777))
        );
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_dry_run_checks_everything_but_writes_nothing() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_106_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let firefly = testdb::FakeFirefly::start(FakeWrite::Created(1)).await;

        let result = service(&pool, firefly.client())
            .run_import(ImportRequest {
                dry_run: true,
                ..request(&fixture)
            })
            .await;

        assert_eq!(result["action"], "would_import");
        assert_eq!(firefly.write_count(), 0, "预览不能写 Firefly");
        assert!(
            latest_attempt(&client, fixture.row_id).await.is_none(),
            "预览不该留下导入尝试"
        );
        assert_eq!(row_status(&client, fixture.row_id).await.0, "pending");
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_row_that_was_dismissed_is_not_importable() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_107_i64;
        let fixture = testdb::seed(&client, user_id).await;
        client
            .execute(
                "UPDATE abei_ai.bill_rows SET status = 'dismissed' WHERE id = $1",
                &[&fixture.row_id],
            )
            .await
            .unwrap();
        let firefly = testdb::FakeFirefly::start(FakeWrite::Created(1)).await;

        let result = service(&pool, firefly.client())
            .run_import(request(&fixture))
            .await;

        assert_eq!(result["action"], "skip");
        assert_eq!(firefly.write_count(), 0);
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_row_without_an_account_mapping_says_so_in_a_machine_readable_code() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_110_i64;
        let fixture = testdb::seed(&client, user_id).await;
        // 夹具默认给了付款账户，这里把它拿掉，回到用户还没配映射的状态。
        client
            .execute(
                "UPDATE abei_ai.bill_rows SET source_account_id = NULL WHERE id = $1",
                &[&fixture.row_id],
            )
            .await
            .unwrap();
        let firefly = testdb::FakeFirefly::start(FakeWrite::Created(1)).await;

        let result = service(&pool, firefly.client())
            .run_import(request(&fixture))
            .await;

        // 前端要靠这个码把用户领到账户映射页去，而不是让它去猜中文提示的意思。
        assert_eq!(result["reason_code"], "account_unmapped");
        assert_eq!(result["error"], "支出流水必须先映射付款 Firefly 账户。");
        assert_eq!(firefly.write_count(), 0, "映射没配好之前不该写 Firefly");
        testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_second_import_of_the_same_row_is_told_apart_from_other_refusals() {
        let Some(pool) = testdb::pool().await else {
            return;
        };
        let client = pool.get().await.unwrap();
        let user_id = 8_110_111_i64;
        let fixture = testdb::seed(&client, user_id).await;
        let firefly = testdb::FakeFirefly::start(FakeWrite::Created(31)).await;
        let service = service(&pool, firefly.client());

        service.run_import(request(&fixture)).await;
        let second = service.run_import(request(&fixture)).await;

        // 「已经入过了」和「账户没配好」都是 skip，但用户该做的事完全不同。
        assert_eq!(second["reason_code"], "row_not_importable");
        assert_eq!(firefly.write_count(), 1);
        testdb::cleanup(&client, user_id).await;
    }
}
