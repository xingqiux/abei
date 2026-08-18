use std::collections::BTreeMap;
use std::str::FromStr;

use rust_decimal::Decimal;
use serde_json::{Value, json};
use tokio_postgres::{Row, Transaction};

use super::Service;
use super::worker::ClaimedJob;

#[derive(Debug)]
struct BalancePoint {
    id: i64,
    account_hint: String,
    currency: String,
    signed_amount: Decimal,
    balance_after: Decimal,
}

#[derive(Debug)]
struct LinkCandidate {
    left_id: i64,
    right_id: i64,
    days_apart: i32,
    left_amount: Decimal,
    right_amount: Decimal,
    left_channel: String,
    right_channel: String,
    left_account: Option<String>,
    right_account: Option<String>,
    left_source: Option<String>,
    right_source: Option<String>,
    left_destination: Option<String>,
    right_destination: Option<String>,
    left_counterparty: Option<String>,
    right_counterparty: Option<String>,
    left_description: String,
    right_description: String,
    left_provider_id: Option<String>,
    right_provider_id: Option<String>,
    left_merchant_id: Option<String>,
    right_merchant_id: Option<String>,
}

#[derive(Debug, PartialEq)]
struct LinkScore {
    relation: &'static str,
    confidence: Decimal,
    matched_on: Vec<&'static str>,
}

impl Service {
    pub(super) async fn analyze_revision(
        &self,
        transaction: &Transaction<'_>,
        job: &ClaimedJob,
    ) -> Result<(), String> {
        self.analyze_balance_chain(transaction, job).await?;
        self.analyze_cross_source_links(transaction, job).await
    }

    async fn analyze_balance_chain(
        &self,
        transaction: &Transaction<'_>,
        job: &ClaimedJob,
    ) -> Result<(), String> {
        let rows = transaction
            .query(
                "SELECT id, account_hint, currency_code::text, signed_amount::text,
                        balance_after::text
                 FROM abei_ai.bill_rows
                 WHERE bill_document_id = $1 AND revision = $2
                   AND account_hint IS NOT NULL AND balance_after IS NOT NULL
                 ORDER BY account_hint, currency_code, occurred_at, row_number, id",
                &[&job.document_id, &job.target_revision],
            )
            .await
            .map_err(display)?;
        let mut previous = BTreeMap::<(String, String), Decimal>::new();
        for row in rows {
            let point = balance_point(&row)?;
            let key = (point.account_hint.clone(), point.currency.clone());
            if let Some(before) = previous.get(&key)
                && let Some(difference) =
                    balance_difference(*before, point.signed_amount, point.balance_after)
            {
                let expected = *before + point.signed_amount;
                append_issue(
                    transaction,
                    point.id,
                    "balance_chain_gap",
                    json!({
                        "severity": "warning",
                        "code": "balance_chain_gap",
                        "message": "账单逐笔余额不连续，请核对是否漏行或金额方向错误。",
                        "expected_balance": expected.to_string(),
                        "statement_balance": point.balance_after.to_string(),
                        "difference": difference.to_string(),
                    }),
                )
                .await?;
            }
            previous.insert(key, point.balance_after);
        }
        Ok(())
    }

    async fn analyze_cross_source_links(
        &self,
        transaction: &Transaction<'_>,
        job: &ClaimedJob,
    ) -> Result<(), String> {
        let rows = transaction
            .query(
                "SELECT n.id, o.id, abs(o.firefly_date - n.firefly_date)::int,
                        n.signed_amount::text, o.signed_amount::text,
                        nd.channel_key, od.channel_key,
                        n.account_hint, o.account_hint, n.source_name, o.source_name,
                        n.destination_name, o.destination_name,
                        n.counterparty, o.counterparty, n.description, o.description,
                        n.provider_transaction_id, o.provider_transaction_id,
                        n.merchant_order_id, o.merchant_order_id
                 FROM abei_ai.bill_rows n
                 JOIN abei_ai.bill_documents nd ON nd.id = n.bill_document_id
                 JOIN abei_ai.bill_rows o ON o.user_id = n.user_id
                 JOIN abei_ai.bill_documents od ON od.id = o.bill_document_id
                 WHERE n.bill_document_id = $1 AND n.revision = $2
                   AND o.bill_document_id <> n.bill_document_id
                   AND od.active_revision = o.revision AND od.lifecycle = 'active'
                   AND n.firefly_date IS NOT NULL AND o.firefly_date IS NOT NULL
                   AND abs(o.firefly_date - n.firefly_date) <= 90
                   AND abs(o.signed_amount) = abs(n.signed_amount)
                   AND o.currency_code = n.currency_code
                   AND n.status = 'pending' AND o.status IN ('pending', 'imported')",
                &[&job.document_id, &job.target_revision],
            )
            .await
            .map_err(display)?;
        for row in rows {
            let candidate = link_candidate(&row)?;
            let Some(score) = score_link(&candidate) else {
                continue;
            };
            let (left_id, right_id) = if candidate.left_id < candidate.right_id {
                (candidate.left_id, candidate.right_id)
            } else {
                (candidate.right_id, candidate.left_id)
            };
            let evidence = json!({
                "matched_on": score.matched_on,
                "days_apart": candidate.days_apart,
                "channels": [candidate.left_channel, candidate.right_channel],
            });
            let confidence = score.confidence.to_string();
            transaction
                .execute(
                    "INSERT INTO abei_ai.bill_row_links
                       (user_id, left_row_id, right_row_id, relation, confidence, evidence)
                     VALUES ($1,$2,$3,$4,$5::text::numeric,$6)
                     ON CONFLICT (left_row_id, right_row_id, relation) DO UPDATE SET
                       confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence,
                       updated_at = now()
                     WHERE abei_ai.bill_row_links.state = 'suggested'",
                    &[
                        &job.user_id,
                        &left_id,
                        &right_id,
                        &score.relation,
                        &confidence,
                        &evidence,
                    ],
                )
                .await
                .map_err(display)?;
            // 最高置信档（两边订单号/交易号对得上）的跨渠道重复直接替用户合掉：
            // 这一档没有判断余地，把它摆进待办只是让人一条条点「是」。合并有据可查
            // （decided_by = 'auto'），「已完成」层里每一条都能一键撤回。
            //
            // 退款关系不在此列。它不是重复，确认它并不合并任何一行，只是替用户断言
            // 「这两笔是一件事」——那是个结论，不是一件重复劳动，仍旧留给人。
            if score.relation == "cross_source_candidate"
                && score.confidence == AUTO_CONFIRM
                && auto_confirm_link(transaction, job.user_id, left_id, right_id, score.relation)
                    .await?
            {
                continue;
            }

            let code = score.relation;
            let message = if code == "refund_candidate" {
                "发现可能对应的原交易或退款，请确认关联关系。"
            } else {
                "发现另一来源的相似流水，请确认是否为同一笔交易。"
            };
            append_issue(
                transaction,
                candidate.left_id,
                code,
                json!({
                    "severity": "warning",
                    "code": code,
                    "message": message,
                    "related_row_id": candidate.right_id.to_string(),
                    "confidence": score.confidence.to_string(),
                }),
            )
            .await?;
            append_issue(
                transaction,
                candidate.right_id,
                code,
                json!({
                    "severity": "warning",
                    "code": code,
                    "message": message,
                    "related_row_id": candidate.left_id.to_string(),
                    "confidence": score.confidence.to_string(),
                }),
            )
            .await?;
        }
        Ok(())
    }
}

/// 自动确认走到哪一档为止。和 [`score_link`] 里那个「订单号对得上」的分数逐字对应。
const AUTO_CONFIRM: Decimal = Decimal::from_parts(98, 0, 0, false, 2);

/// 替用户把这条最高置信的重复合掉。真的合成了返回 true。
///
/// 两种情况不合，各有各的理由：
///
/// - 这条配对已经有人做过决定了（confirmed / rejected）——重跑打分不该掀翻人的结论。
///   返回 true：不用再挂 issue，事情已经定了。
/// - 该并掉的那一行不是待处理（已入账、已被别处忽略）——账已经在别处，动不了它。
///   返回 false：退回人工那条路。
///
/// 幂等：状态和忽略两步都带 `WHERE`，重放一遍不会并第二行，也不会把已确认的再确认一次。
async fn auto_confirm_link(
    transaction: &Transaction<'_>,
    user_id: i64,
    left_row_id: i64,
    right_row_id: i64,
    relation: &str,
) -> Result<bool, String> {
    let link = transaction
        .query_opt(
            "SELECT id, state FROM abei_ai.bill_row_links
             WHERE user_id = $1 AND left_row_id = $2 AND right_row_id = $3 AND relation = $4
             FOR UPDATE",
            &[&user_id, &left_row_id, &right_row_id, &relation],
        )
        .await
        .map_err(display)?;
    let Some(link) = link else {
        return Ok(false);
    };
    let link_id: i64 = link.get(0);
    if link.get::<_, String>(1) != "suggested" {
        return Ok(true);
    }

    // 留下已经入账的那一行（账在 Firefly 里，动它没意义），都没入账就留先来的那条。
    // 和 links::resolve_keep_row 是同一条规矩。
    let imported = transaction
        .query_opt(
            "SELECT id FROM abei_ai.bill_rows
             WHERE id = ANY($1) AND status = 'imported' ORDER BY id LIMIT 1",
            &[&vec![left_row_id, right_row_id]],
        )
        .await
        .map_err(display)?
        .map(|row| row.get::<_, i64>(0));
    let keep = imported.unwrap_or(left_row_id);
    let merged = if keep == left_row_id {
        right_row_id
    } else {
        left_row_id
    };

    let dismissed = transaction
        .execute(
            "UPDATE abei_ai.bill_rows SET status = 'dismissed', dismissed_reason = $3,
               dismissed_at = now(), updated_at = now()
             WHERE user_id = $1 AND id = $2 AND status = 'pending'",
            &[&user_id, &merged, &super::links::DUPLICATE_CONFIRMED],
        )
        .await
        .map_err(display)?;
    if dismissed == 0 {
        return Ok(false);
    }
    transaction
        .execute(
            "UPDATE abei_ai.bill_row_links
             SET state = 'confirmed', decided_by = 'auto', decided_at = now(),
                 merged_row_id = $3, updated_at = now()
             WHERE user_id = $1 AND id = $2 AND state = 'suggested'",
            &[&user_id, &link_id, &merged],
        )
        .await
        .map_err(display)?;
    Ok(true)
}

async fn append_issue(
    transaction: &Transaction<'_>,
    row_id: i64,
    code: &str,
    issue: Value,
) -> Result<(), String> {
    transaction
        .execute(
            "UPDATE abei_ai.bill_rows SET issues = issues || $2::jsonb, updated_at = now()
             WHERE id = $1 AND status = 'pending'
               AND NOT EXISTS (
                 SELECT 1 FROM jsonb_array_elements(issues) item WHERE item->>'code' = $3
               )",
            &[&row_id, &json!([issue]), &code],
        )
        .await
        .map_err(display)?;
    Ok(())
}

fn balance_point(row: &Row) -> Result<BalancePoint, String> {
    Ok(BalancePoint {
        id: row.get(0),
        account_hint: row.get(1),
        currency: row.get::<_, String>(2).trim().to_owned(),
        signed_amount: decimal(row.get(3), "账单金额")?,
        balance_after: decimal(row.get(4), "账单余额")?,
    })
}

fn balance_difference(before: Decimal, signed: Decimal, after: Decimal) -> Option<Decimal> {
    let difference = (before + signed - after).abs();
    (difference > Decimal::new(1, 2)).then_some(difference)
}

fn link_candidate(row: &Row) -> Result<LinkCandidate, String> {
    Ok(LinkCandidate {
        left_id: row.get(0),
        right_id: row.get(1),
        days_apart: row.get(2),
        left_amount: decimal(row.get(3), "候选金额")?,
        right_amount: decimal(row.get(4), "关联金额")?,
        left_channel: row.get(5),
        right_channel: row.get(6),
        left_account: row.get(7),
        right_account: row.get(8),
        left_source: row.get(9),
        right_source: row.get(10),
        left_destination: row.get(11),
        right_destination: row.get(12),
        left_counterparty: row.get(13),
        right_counterparty: row.get(14),
        left_description: row.get(15),
        right_description: row.get(16),
        left_provider_id: row.get(17),
        right_provider_id: row.get(18),
        left_merchant_id: row.get(19),
        right_merchant_id: row.get(20),
    })
}

fn score_link(candidate: &LinkCandidate) -> Option<LinkScore> {
    let opposite =
        candidate.left_amount.is_sign_negative() != candidate.right_amount.is_sign_negative();
    let (left_identifiers, right_identifiers) = identifiers(candidate);
    let order_match = left_identifiers
        .iter()
        .any(|left| right_identifiers.contains(left));
    let merchant = merchant_match(candidate);
    let account = account_match(candidate);
    if opposite {
        let refund_word = [
            candidate.left_description.as_str(),
            candidate.right_description.as_str(),
        ]
        .iter()
        .any(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("退款") || value.contains("退货") || value.contains("refund")
        });
        if !refund_word || (!order_match && merchant == 0) {
            return None;
        }
        return Some(LinkScore {
            relation: "refund_candidate",
            confidence: if order_match {
                Decimal::new(98, 2)
            } else {
                Decimal::new(86, 2)
            },
            matched_on: if order_match {
                vec!["amount", "order_id", "refund_text"]
            } else {
                vec!["amount", "merchant", "refund_text"]
            },
        });
    }
    if candidate.days_apart > 1 || (!order_match && merchant == 0) {
        return None;
    }
    let (confidence, merchant_label) = if order_match {
        (Decimal::new(98, 2), "order_id")
    } else if merchant == 2 && account {
        (Decimal::new(94, 2), "merchant_exact")
    } else if merchant == 2 {
        (Decimal::new(88, 2), "merchant_exact")
    } else if account {
        (Decimal::new(82, 2), "merchant_similar")
    } else {
        return None;
    };
    let mut matched_on = vec!["amount", "within_24h", merchant_label];
    if account {
        matched_on.push("account");
    }
    Some(LinkScore {
        relation: "cross_source_candidate",
        confidence,
        matched_on,
    })
}

fn identifiers(candidate: &LinkCandidate) -> (Vec<String>, Vec<String>) {
    (
        normalized_values([
            candidate.left_provider_id.as_deref(),
            candidate.left_merchant_id.as_deref(),
        ]),
        normalized_values([
            candidate.right_provider_id.as_deref(),
            candidate.right_merchant_id.as_deref(),
        ]),
    )
}

fn account_match(candidate: &LinkCandidate) -> bool {
    let left = normalized_values([
        candidate.left_account.as_deref(),
        candidate.left_source.as_deref(),
        candidate.left_destination.as_deref(),
    ]);
    let right = normalized_values([
        candidate.right_account.as_deref(),
        candidate.right_source.as_deref(),
        candidate.right_destination.as_deref(),
    ]);
    left.iter().any(|value| right.contains(value))
}

fn merchant_match(candidate: &LinkCandidate) -> u8 {
    let left = normalized_values([
        Some(candidate.left_description.as_str()),
        candidate.left_counterparty.as_deref(),
        candidate.left_destination.as_deref(),
    ]);
    let right = normalized_values([
        Some(candidate.right_description.as_str()),
        candidate.right_counterparty.as_deref(),
        candidate.right_destination.as_deref(),
    ]);
    if left.iter().any(|value| right.contains(value)) {
        return 2;
    }
    left.iter()
        .any(|left| {
            left.chars().count() >= 2
                && right.iter().any(|right| {
                    right.chars().count() >= 2
                        && (left.contains(right.as_str()) || right.contains(left.as_str()))
                })
        })
        .into()
}

fn normalized_values<const N: usize>(values: [Option<&str>; N]) -> Vec<String> {
    let mut result = values
        .into_iter()
        .flatten()
        .map(normalize_text)
        .filter(|value| !value.is_empty() && !generic_term(value))
        .collect::<Vec<_>>();
    result.sort();
    result.dedup();
    result
}

fn normalize_text(value: &str) -> String {
    value
        .chars()
        .filter(|value| value.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn generic_term(value: &str) -> bool {
    matches!(
        value,
        "消费" | "支付" | "交易" | "转账" | "退款" | "收入" | "支出" | "withdrawal" | "deposit"
    )
}

fn decimal(value: String, label: &str) -> Result<Decimal, String> {
    Decimal::from_str(&value).map_err(|_| format!("{label}无法解析：{value}"))
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn balance_chain_allows_one_cent_rounding_but_reports_real_gaps() {
        assert_eq!(balance_difference(dec("100"), dec("-21"), dec("79")), None);
        assert_eq!(
            balance_difference(dec("100"), dec("-21"), dec("78.98")),
            Some(dec("0.02"))
        );
    }

    #[test]
    fn cross_source_requires_more_than_amount_and_time() {
        let mut candidate = fixture();
        candidate.left_description = "普通消费".to_owned();
        candidate.right_description = "另一笔交易".to_owned();
        candidate.left_counterparty = None;
        candidate.right_counterparty = None;
        candidate.left_destination = None;
        candidate.right_destination = None;
        candidate.left_account = None;
        candidate.right_account = None;
        candidate.left_source = None;
        candidate.right_source = None;
        assert_eq!(score_link(&candidate), None);
    }

    #[test]
    fn cross_source_scores_order_ids_and_merchant_similarity() {
        let mut order = fixture();
        order.left_merchant_id = Some("order-123456".to_owned());
        order.right_provider_id = Some("order-123456".to_owned());
        assert_eq!(score_link(&order).unwrap().confidence, dec("0.98"));

        let merchant = fixture();
        assert_eq!(score_link(&merchant).unwrap().confidence, dec("0.82"));
    }

    #[test]
    fn opposite_amounts_need_refund_text() {
        let mut candidate = fixture();
        candidate.right_amount = dec("21");
        assert_eq!(score_link(&candidate), None);
        candidate.right_description = "茶饮退款".to_owned();
        assert_eq!(score_link(&candidate).unwrap().relation, "refund_candidate");
    }

    fn fixture() -> LinkCandidate {
        LinkCandidate {
            left_id: 1,
            right_id: 2,
            days_apart: 0,
            left_amount: dec("-21"),
            right_amount: dec("-21"),
            left_channel: "alipay".to_owned(),
            right_channel: "cmb".to_owned(),
            left_account: Some("招商银行".to_owned()),
            right_account: Some("招商银行".to_owned()),
            left_source: None,
            right_source: None,
            left_destination: Some("一点点".to_owned()),
            right_destination: Some("一点点茶饮".to_owned()),
            left_counterparty: Some("一点点".to_owned()),
            right_counterparty: Some("一点点茶饮".to_owned()),
            left_description: "一点点".to_owned(),
            right_description: "一点点茶饮".to_owned(),
            left_provider_id: None,
            right_provider_id: None,
            left_merchant_id: None,
            right_merchant_id: None,
        }
    }

    fn dec(value: &str) -> Decimal {
        Decimal::from_str(value).unwrap()
    }

    #[test]
    fn the_auto_confirm_bar_is_exactly_the_top_scoring_tier() {
        // 自动确认的门槛必须和打分那头的最高档逐字对齐：这里松一点，用户就会在
        // 「已完成」里发现一批他没点过、也不那么确定的合并。
        let mut order = fixture();
        order.left_provider_id = Some("2026081122001".to_owned());
        order.right_provider_id = Some("2026081122001".to_owned());
        assert_eq!(score_link(&order).unwrap().confidence, AUTO_CONFIRM);
        assert!(score_link(&fixture()).unwrap().confidence < AUTO_CONFIRM);
    }

    #[tokio::test]
    async fn a_top_confidence_duplicate_is_merged_without_asking_and_can_be_taken_back() {
        let Some(pool) = crate::testdb::pool().await else {
            return;
        };
        let user_id = 8_116_001_i64;
        let mut client = pool.get().await.unwrap();
        let fixture = crate::testdb::seed(&client, user_id).await;
        let other_row_id = seed_second_row(&client, &fixture).await;
        let (left, right) = (
            fixture.row_id.min(other_row_id),
            fixture.row_id.max(other_row_id),
        );
        client
            .execute(
                "INSERT INTO abei_ai.bill_row_links
                   (user_id, left_row_id, right_row_id, relation, confidence, evidence)
                 VALUES ($1,$2,$3,'cross_source_candidate',0.9800,'{}'::jsonb)",
                &[&user_id, &left, &right],
            )
            .await
            .unwrap();

        let transaction = client.transaction().await.unwrap();
        let merged =
            auto_confirm_link(&transaction, user_id, left, right, "cross_source_candidate")
                .await
                .unwrap();
        // 重放一遍不该再并一行：第二次看到的已经是 confirmed。
        let replayed =
            auto_confirm_link(&transaction, user_id, left, right, "cross_source_candidate")
                .await
                .unwrap();
        transaction.commit().await.unwrap();
        assert!(merged);
        assert!(replayed);

        let link = client
            .query_one(
                "SELECT id, state, decided_by, merged_row_id FROM abei_ai.bill_row_links
                 WHERE left_row_id = $1 AND right_row_id = $2",
                &[&left, &right],
            )
            .await
            .unwrap();
        assert_eq!(link.get::<_, String>(1), "confirmed");
        // 自动和人工必须分得开，否则「系统悄悄并掉了一笔」就成了查不出来的事。
        assert_eq!(link.get::<_, String>(2), "auto");
        assert_eq!(link.get::<_, i64>(3), right);
        assert_eq!(row_status(&client, right).await, "dismissed");
        assert_eq!(row_status(&client, left).await, "pending");

        let service = crate::testdb::billing_service(pool.clone());
        service.undo_link(user_id, link.get(0)).await.unwrap();
        assert_eq!(row_status(&client, right).await, "pending");

        crate::testdb::cleanup(&client, user_id).await;
    }

    /// 同一份文档里再造一行，凑成一对能被合并的重复。
    async fn seed_second_row(
        client: &deadpool_postgres::Client,
        fixture: &crate::testdb::Fixture,
    ) -> i64 {
        client
            .query_one(
                "INSERT INTO abei_ai.bill_rows
                   (user_id, bill_document_id, revision, row_number, occurred_at,
                    signed_amount, currency_code, description, external_key, fingerprint,
                    firefly_type, firefly_date, firefly_amount, source_account_id)
                 VALUES ($1,$2,1,2,'2026-08-11 08:30:00',-12.34,'CNY','测试商户',
                         $3,$4,'withdrawal','2026-08-11',12.34,10)
                 RETURNING id",
                &[
                    &fixture.user_id,
                    &fixture.document_id,
                    &format!("auto-pair-{}", fixture.user_id),
                    &format!("{:064x}", fixture.user_id + 7),
                ],
            )
            .await
            .unwrap()
            .get(0)
    }

    async fn row_status(client: &deadpool_postgres::Client, row_id: i64) -> String {
        client
            .query_one(
                "SELECT status FROM abei_ai.bill_rows WHERE id = $1",
                &[&row_id],
            )
            .await
            .unwrap()
            .get(0)
    }
}
