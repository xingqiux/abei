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
                       confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence",
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
}
