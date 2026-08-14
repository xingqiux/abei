//! 配对闭环：算出来的「这两笔可能是同一件事」，人得能确认或否掉，还能反悔。
//!
//! 打分早就在 [`super::analysis`] 里了，结果写进 `bill_row_links`。缺的是后半截：
//! 建议只是挂在那儿，人点不动，下一轮重算又原样提一遍。这里补上状态和三个动作——
//! 确认、否掉、撤回。确认一笔跨渠道重复，会把被并的那一行按忽略处理
//! （`dismissed_reason = 'duplicate_confirmed'`），撤回再把它放回来。

use serde_json::{Value, json};

use super::Service;
use crate::ApiError;
use crate::states::LinkState;

/// 确认重复时被并掉的那一行，忽略原因写这个。撤回时也按它找回来。
pub(crate) const DUPLICATE_CONFIRMED: &str = "duplicate_confirmed";

pub(crate) mod reasons {
    /// 配对建议不存在，或者不属于这个用户。
    pub(crate) const LINK_NOT_FOUND: &str = "link_not_found";
    /// 当前状态不允许这一步（例如确认过的想直接否掉）。
    pub(crate) const LINK_TRANSITION_INVALID: &str = "link_transition_invalid";
    /// 想留下的那一行不在这条配对里。
    pub(crate) const LINK_KEEP_ROW_INVALID: &str = "link_keep_row_invalid";
}

/// 一条配对建议在库里的样子。
struct Link {
    left_row_id: i64,
    right_row_id: i64,
    relation: String,
    confidence: String,
    state: LinkState,
}

impl Link {
    /// 确认重复时，另一侧就是被并掉的那一行。
    fn other_side(&self, keep_row_id: i64) -> i64 {
        if keep_row_id == self.left_row_id {
            self.right_row_id
        } else {
            self.left_row_id
        }
    }
}

impl Service {
    /// 一行流水身上挂着的配对建议。已否掉的不再露面，确认过的要留着——
    /// 界面上得能看见「这笔已经和另一笔合了」，也才有地方撤回。
    pub(crate) async fn row_links(&self, user_id: i64, row_id: i64) -> Result<Value, ApiError> {
        let rows = self
            .pool
            .get()
            .await
            .map_err(ApiError::database)?
            .query(
                "SELECT l.id, l.relation, l.state, l.confidence::text, l.evidence,
                        l.decided_at::text,
                        CASE WHEN l.left_row_id = $2 THEN l.right_row_id ELSE l.left_row_id END,
                        o.status, o.occurred_at::text, o.signed_amount::text, o.currency_code,
                        o.description, o.counterparty, o.source_name, o.destination_name,
                        od.channel_key, o.dismissed_reason
                 FROM abei_ai.bill_row_links l
                 JOIN abei_ai.bill_rows o
                   ON o.id = CASE WHEN l.left_row_id = $2 THEN l.right_row_id ELSE l.left_row_id END
                 JOIN abei_ai.bill_documents od ON od.id = o.bill_document_id
                 WHERE l.user_id = $1 AND (l.left_row_id = $2 OR l.right_row_id = $2)
                   AND l.state <> 'rejected'
                 ORDER BY l.confidence DESC, l.id",
                &[&user_id, &row_id],
            )
            .await
            .map_err(ApiError::database)?;
        let data = rows
            .iter()
            .map(|row| {
                json!({
                    "id": row.get::<_, i64>(0).to_string(),
                    "type": "bill-row-link",
                    "attributes": {
                        "row_id": row_id.to_string(),
                        "relation": row.get::<_, String>(1),
                        "state": row.get::<_, String>(2),
                        "confidence": row.get::<_, String>(3),
                        "evidence": row.get::<_, Value>(4),
                        "decided_at": row.get::<_, Option<String>>(5),
                        "related_row": {
                            "id": row.get::<_, i64>(6).to_string(),
                            "status": row.get::<_, String>(7),
                            "occurred_at": row.get::<_, Option<String>>(8),
                            "signed_amount": row.get::<_, String>(9),
                            "currency_code": row.get::<_, String>(10),
                            "description": row.get::<_, Option<String>>(11),
                            "counterparty": row.get::<_, Option<String>>(12),
                            "source_name": row.get::<_, Option<String>>(13),
                            "destination_name": row.get::<_, Option<String>>(14),
                            "channel_key": row.get::<_, Option<String>>(15),
                            "dismissed_reason": row.get::<_, Option<String>>(16),
                        }
                    }
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({ "data": data }))
    }

    /// 确认这两笔是一件事。跨渠道重复会把被并的那一行按忽略处理；退款关系只记结论，
    /// 两笔都还是真发生过的，谁也不该消失。
    pub(crate) async fn confirm_link(
        &self,
        user_id: i64,
        link_id: i64,
        keep_row_id: Option<i64>,
    ) -> Result<Value, ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let link = load_link(&transaction, user_id, link_id).await?;
        assert_transition(link.state, LinkState::Confirmed)?;

        let mut merged_row_id = None;
        if link.relation == "cross_source_candidate" {
            let keep = resolve_keep_row(&transaction, &link, keep_row_id).await?;
            let merged = link.other_side(keep);
            transaction
                .execute(
                    "UPDATE abei_ai.bill_rows SET status = 'dismissed',
                       dismissed_reason = $3, dismissed_at = now(), updated_at = now()
                     WHERE user_id = $1 AND id = $2 AND status = 'pending'",
                    &[&user_id, &merged, &DUPLICATE_CONFIRMED],
                )
                .await
                .map_err(ApiError::database)?;
            merged_row_id = Some(merged);
        }

        clear_pair_issue(&transaction, user_id, &link).await?;
        set_state(&transaction, user_id, link_id, LinkState::Confirmed).await?;
        transaction.commit().await.map_err(ApiError::database)?;
        Ok(json!({
            "data": {
                "id": link_id.to_string(),
                "type": "bill-row-link",
                "attributes": {
                    "state": LinkState::Confirmed.as_str(),
                    "merged_row_id": merged_row_id.map(|id| id.to_string()),
                }
            }
        }))
    }

    /// 否掉这条建议。下一轮重算不会再把它提上来（见 analysis 里的 ON CONFLICT）。
    pub(crate) async fn reject_link(&self, user_id: i64, link_id: i64) -> Result<Value, ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let link = load_link(&transaction, user_id, link_id).await?;
        assert_transition(link.state, LinkState::Rejected)?;
        clear_pair_issue(&transaction, user_id, &link).await?;
        set_state(&transaction, user_id, link_id, LinkState::Rejected).await?;
        transaction.commit().await.map_err(ApiError::database)?;
        Ok(json!({
            "data": {
                "id": link_id.to_string(),
                "type": "bill-row-link",
                "attributes": { "state": LinkState::Rejected.as_str() }
            }
        }))
    }

    /// 撤回上一个决定，回到「还没定」。确认重复时被并掉的那一行跟着放回来——
    /// 只放我们自己并掉的（`duplicate_confirmed`），用户手动忽略的不动。
    pub(crate) async fn undo_link(&self, user_id: i64, link_id: i64) -> Result<Value, ApiError> {
        let mut client = self.pool.get().await.map_err(ApiError::database)?;
        let transaction = client.transaction().await.map_err(ApiError::database)?;
        let link = load_link(&transaction, user_id, link_id).await?;
        assert_transition(link.state, LinkState::Suggested)?;
        let restored = transaction
            .execute(
                "UPDATE abei_ai.bill_rows SET status = 'pending', dismissed_reason = NULL,
                   dismissed_at = NULL, updated_at = now()
                 WHERE user_id = $1 AND id = ANY($2) AND status = 'dismissed'
                   AND dismissed_reason = $3",
                &[
                    &user_id,
                    &vec![link.left_row_id, link.right_row_id],
                    &DUPLICATE_CONFIRMED,
                ],
            )
            .await
            .map_err(ApiError::database)?;
        restore_pair_issue(&transaction, user_id, &link).await?;
        set_state(&transaction, user_id, link_id, LinkState::Suggested).await?;
        transaction.commit().await.map_err(ApiError::database)?;
        Ok(json!({
            "data": {
                "id": link_id.to_string(),
                "type": "bill-row-link",
                "attributes": {
                    "state": LinkState::Suggested.as_str(),
                    "restored_rows": restored,
                }
            }
        }))
    }
}

async fn load_link(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id: i64,
    link_id: i64,
) -> Result<Link, ApiError> {
    let row = transaction
        .query_opt(
            "SELECT left_row_id, right_row_id, relation, state, confidence::text
             FROM abei_ai.bill_row_links
             WHERE user_id = $1 AND id = $2 FOR UPDATE",
            &[&user_id, &link_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| {
            ApiError::not_found("配对建议不存在。").with_reason(reasons::LINK_NOT_FOUND)
        })?;
    let state: String = row.get(3);
    Ok(Link {
        left_row_id: row.get(0),
        right_row_id: row.get(1),
        relation: row.get(2),
        confidence: row.get(4),
        state: LinkState::from_str(&state)
            .ok_or_else(|| ApiError::internal(format!("配对状态 {state} 不认识。")))?,
    })
}

/// 没指定留哪一行时：已入账的那一行留下（账已经在 Firefly 里，动它没意义），
/// 都没入账就留先来的那条。
async fn resolve_keep_row(
    transaction: &tokio_postgres::Transaction<'_>,
    link: &Link,
    requested: Option<i64>,
) -> Result<i64, ApiError> {
    if let Some(keep) = requested {
        if keep != link.left_row_id && keep != link.right_row_id {
            return Err(ApiError::invalid_params("keep_row_id 不在这条配对里。")
                .with_reason(reasons::LINK_KEEP_ROW_INVALID));
        }
        return Ok(keep);
    }
    let imported = transaction
        .query_opt(
            "SELECT id FROM abei_ai.bill_rows
             WHERE id = ANY($1) AND status = 'imported' ORDER BY id LIMIT 1",
            &[&vec![link.left_row_id, link.right_row_id]],
        )
        .await
        .map_err(ApiError::database)?;
    Ok(imported.map_or(link.left_row_id, |row| row.get(0)))
}

/// 定了就不该再在「待确认」里挂着。配对那条 issue 是 analysis 挂上去的，
/// 决定做完之后从两行上都摘掉，行才走得出 attention。
async fn clear_pair_issue(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id: i64,
    link: &Link,
) -> Result<(), ApiError> {
    for (row_id, other_id) in [
        (link.left_row_id, link.right_row_id),
        (link.right_row_id, link.left_row_id),
    ] {
        transaction
            .execute(
                "UPDATE abei_ai.bill_rows SET issues = COALESCE((
                     SELECT jsonb_agg(item) FROM jsonb_array_elements(issues) item
                     WHERE NOT (item->>'code' = $3 AND item->>'related_row_id' = $4)
                   ), '[]'::jsonb), updated_at = now()
                 WHERE user_id = $1 AND id = $2",
                &[&user_id, &row_id, &link.relation, &other_id.to_string()],
            )
            .await
            .map_err(ApiError::database)?;
    }
    Ok(())
}

/// 撤回之后建议重新变成「待确认」，两行也得重新挂回那条 issue，
/// 否则界面上看不出还有事没定。
async fn restore_pair_issue(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id: i64,
    link: &Link,
) -> Result<(), ApiError> {
    let message = if link.relation == "refund_candidate" {
        "发现可能对应的原交易或退款，请确认关联关系。"
    } else {
        "发现另一来源的相似流水，请确认是否为同一笔交易。"
    };
    for (row_id, other_id) in [
        (link.left_row_id, link.right_row_id),
        (link.right_row_id, link.left_row_id),
    ] {
        let issue = json!([{
            "severity": "warning",
            "code": link.relation,
            "message": message,
            "related_row_id": other_id.to_string(),
            "confidence": link.confidence,
        }]);
        transaction
            .execute(
                "UPDATE abei_ai.bill_rows SET issues = issues || $3::jsonb, updated_at = now()
                 WHERE user_id = $1 AND id = $2 AND status = 'pending'
                   AND NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements(issues) item
                     WHERE item->>'code' = $4 AND item->>'related_row_id' = $5
                   )",
                &[
                    &user_id,
                    &row_id,
                    &issue,
                    &link.relation,
                    &other_id.to_string(),
                ],
            )
            .await
            .map_err(ApiError::database)?;
    }
    Ok(())
}

fn assert_transition(from: LinkState, to: LinkState) -> Result<(), ApiError> {
    if from.can_transition(to) {
        return Ok(());
    }
    Err(
        ApiError::conflict(format!("配对已经是{}，这一步做不了。", state_label(from)))
            .with_reason(reasons::LINK_TRANSITION_INVALID),
    )
}

fn state_label(state: LinkState) -> &'static str {
    match state {
        LinkState::Suggested => "待确认",
        LinkState::Confirmed => "已确认",
        LinkState::Rejected => "已否掉",
    }
}

async fn set_state(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id: i64,
    link_id: i64,
    state: LinkState,
) -> Result<(), ApiError> {
    let decided = state != LinkState::Suggested;
    transaction
        .execute(
            "UPDATE abei_ai.bill_row_links
             SET state = $3, updated_at = now(),
                 decided_at = CASE WHEN $4 THEN now() ELSE NULL END
             WHERE user_id = $1 AND id = $2",
            &[&user_id, &link_id, &state.as_str(), &decided],
        )
        .await
        .map_err(ApiError::database)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link(state: LinkState) -> Link {
        Link {
            left_row_id: 10,
            right_row_id: 20,
            relation: "cross_source_candidate".to_owned(),
            confidence: "0.9000".to_owned(),
            state,
        }
    }

    #[test]
    fn the_side_that_gets_merged_away_is_the_one_we_did_not_keep() {
        let link = link(LinkState::Suggested);
        assert_eq!(link.other_side(10), 20);
        assert_eq!(link.other_side(20), 10);
    }

    #[test]
    fn a_confirmed_pairing_has_to_be_taken_back_before_anything_else() {
        assert!(assert_transition(LinkState::Suggested, LinkState::Confirmed).is_ok());
        assert!(assert_transition(LinkState::Confirmed, LinkState::Suggested).is_ok());
        let refused = assert_transition(LinkState::Confirmed, LinkState::Rejected)
            .expect_err("确认过的不该能直接否掉");
        assert_eq!(refused.reason(), reasons::LINK_TRANSITION_INVALID);
    }

    /// 造一条「同一笔钱被两个渠道各记了一遍」的配对，两行都挂上 analysis 那条 issue。
    async fn seed_pair(
        client: &deadpool_postgres::Client,
        fixture: &crate::testdb::Fixture,
    ) -> (i64, i64) {
        let other_row_id: i64 = client
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
                    &format!("pair-{}", fixture.user_id),
                    &format!("{:064x}", fixture.user_id + 1),
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
        let link_id: i64 = client
            .query_one(
                "INSERT INTO abei_ai.bill_row_links
                   (user_id, left_row_id, right_row_id, relation, confidence, evidence)
                 VALUES ($1,$2,$3,'cross_source_candidate',0.9200,'{}'::jsonb)
                 RETURNING id",
                &[&fixture.user_id, &left, &right],
            )
            .await
            .unwrap()
            .get(0);
        for (row_id, other) in [(left, right), (right, left)] {
            let issue = json!([{
                "severity": "warning",
                "code": "cross_source_candidate",
                "message": "发现另一来源的相似流水，请确认是否为同一笔交易。",
                "related_row_id": other.to_string(),
                "confidence": "0.9200",
            }]);
            client
                .execute(
                    "UPDATE abei_ai.bill_rows SET issues = issues || $2::jsonb WHERE id = $1",
                    &[&row_id, &issue],
                )
                .await
                .unwrap();
        }
        (link_id, other_row_id)
    }

    async fn row_state(client: &deadpool_postgres::Client, row_id: i64) -> (String, usize) {
        let row = client
            .query_one(
                "SELECT status, jsonb_array_length(issues) FROM abei_ai.bill_rows WHERE id = $1",
                &[&row_id],
            )
            .await
            .unwrap();
        (row.get(0), usize::try_from(row.get::<_, i32>(1)).unwrap())
    }

    fn service(pool: deadpool_postgres::Pool) -> Service {
        let config = crate::mailbox::RuntimeConfig::test();
        let mail = crate::mail::Service::new(pool.clone(), config.storage_root().to_path_buf());
        let parser = crate::parser::Service::new(pool.clone(), mail.clone());
        Service::new(
            pool,
            mail,
            parser,
            config.job_secret_cipher(),
            config.reliability(),
            crate::firefly::Firefly::from_env(),
        )
    }

    #[tokio::test]
    async fn confirming_a_duplicate_puts_the_merged_row_away_and_undo_brings_it_back() {
        let Some(pool) = crate::testdb::pool().await else {
            return;
        };
        let user_id = 8_115_001_i64;
        let client = pool.get().await.unwrap();
        let fixture = crate::testdb::seed(&client, user_id).await;
        let (link_id, other_row_id) = seed_pair(&client, &fixture).await;
        let kept = fixture.row_id.min(other_row_id);
        let merged = fixture.row_id.max(other_row_id);
        let service = service(pool.clone());

        let confirmed = service.confirm_link(user_id, link_id, None).await.unwrap();
        assert_eq!(confirmed["data"]["attributes"]["state"], "confirmed");
        assert_eq!(
            confirmed["data"]["attributes"]["merged_row_id"],
            merged.to_string()
        );
        assert_eq!(
            row_state(&client, merged).await,
            ("dismissed".to_owned(), 0)
        );
        // 留下的那一行也要出「待确认」：配对已经定了，它不该还挂着那条 issue。
        assert_eq!(row_state(&client, kept).await, ("pending".to_owned(), 0));

        let undone = service.undo_link(user_id, link_id).await.unwrap();
        assert_eq!(undone["data"]["attributes"]["state"], "suggested");
        assert_eq!(row_state(&client, merged).await, ("pending".to_owned(), 1));
        assert_eq!(row_state(&client, kept).await, ("pending".to_owned(), 1));

        crate::testdb::cleanup(&client, user_id).await;
    }

    #[tokio::test]
    async fn a_rejected_pairing_stops_showing_up_and_survives_a_rescore() {
        let Some(pool) = crate::testdb::pool().await else {
            return;
        };
        let user_id = 8_115_002_i64;
        let client = pool.get().await.unwrap();
        let fixture = crate::testdb::seed(&client, user_id).await;
        let (link_id, _) = seed_pair(&client, &fixture).await;
        let service = service(pool.clone());

        service.reject_link(user_id, link_id).await.unwrap();
        let listed = service.row_links(user_id, fixture.row_id).await.unwrap();
        assert_eq!(listed["data"].as_array().unwrap().len(), 0);

        // 再打一次分不该把否掉的建议顶回「待确认」。
        client
            .execute(
                "INSERT INTO abei_ai.bill_row_links
                   (user_id, left_row_id, right_row_id, relation, confidence, evidence)
                 SELECT user_id, left_row_id, right_row_id, relation, 0.9900, '{}'::jsonb
                 FROM abei_ai.bill_row_links WHERE id = $1
                 ON CONFLICT (left_row_id, right_row_id, relation) DO UPDATE SET
                   confidence = EXCLUDED.confidence, evidence = EXCLUDED.evidence,
                   updated_at = now()
                 WHERE abei_ai.bill_row_links.state = 'suggested'",
                &[&link_id],
            )
            .await
            .unwrap();
        let state: String = client
            .query_one(
                "SELECT state FROM abei_ai.bill_row_links WHERE id = $1",
                &[&link_id],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(state, "rejected");

        crate::testdb::cleanup(&client, user_id).await;
    }
}
