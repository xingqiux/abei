//! 数据库用例的公共脚手架。
//!
//! 造一条能入账的流水要串六张表：用户 → 邮箱 → 邮件 → 账单文档 → 解析任务 → 流水行，
//! 各测试模块此前各抄一份。抄一次就多一处会跟着 schema 变化烂掉的地方，所以收到这里。
//!
//! 所有用例共用同一个本地库（`ABEI_TEST_DATABASE_URL`），靠各自不同的 `user_id` 隔离：
//! 8_11x_xxx 这段是给测试留的，不会撞上真实账本。

use deadpool_postgres::{Client, Pool};

/// 建库连接并跑好迁移。没配 `ABEI_TEST_DATABASE_URL` 就返回 None，调用方直接跳过用例。
pub(crate) async fn pool() -> Option<Pool> {
    let url = std::env::var("ABEI_TEST_DATABASE_URL").ok()?;
    let pool = crate::create_pool(url.parse().unwrap(), 4).unwrap();
    crate::initialize(&pool).await.unwrap();
    Some(pool)
}

/// 一个测试用户名下造好的整条链路，字段是后续插入要用到的外键。
pub(crate) struct Fixture {
    pub user_id: i64,
    #[allow(dead_code, reason = "批次④的入账用例要按文档查流水")]
    pub document_id: i64,
    pub row_id: i64,
}

/// 把 `user_id` 名下的东西清干净，然后重新造一条完整链路。
///
/// 每个用例挑一个自己的 `user_id`，这样并行跑也互不干扰。
pub(crate) async fn seed(client: &Client, user_id: i64) -> Fixture {
    crate::ensure_test_user(client, user_id).await;

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
                &format!("fixture-{user_id}@example.invalid"),
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
                     $3,$4,'withdrawal','2026-08-11',12.34)
             RETURNING id",
            &[
                &user_id,
                &document_id,
                &format!("fixture-{user_id}"),
                &fingerprint(user_id),
            ],
        )
        .await
        .unwrap()
        .get(0);

    Fixture {
        user_id,
        document_id,
        row_id,
    }
}

/// 指纹列要求正好 64 个十六进制字符，按 user_id 生成一个稳定又互不相同的值。
fn fingerprint(user_id: i64) -> String {
    format!("{user_id:064x}")
}

/// 插一条导入流水。`id` 被约束成 36 个字符（UUID），`payload_*` 非空。
pub(crate) async fn insert_attempt(
    client: &Client,
    fixture: &Fixture,
    status: &str,
    stale_secs: f64,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    client
        .execute(
            "INSERT INTO abei_ai.bill_import_attempts
               (id, user_id, bill_row_id, attempt_no, status, external_id,
                payload_hash, payload_snapshot, updated_at)
             VALUES ($1,$2,$3,1,$4,$1, repeat('0', 64), '{}'::jsonb,
                     now() - make_interval(secs => $5))",
            &[&id, &fixture.user_id, &fixture.row_id, &status, &stale_secs],
        )
        .await
        .unwrap();
    id
}

pub(crate) async fn attempt_status(client: &Client, id: &str) -> String {
    client
        .query_one(
            "SELECT status FROM abei_ai.bill_import_attempts WHERE id = $1",
            &[&id],
        )
        .await
        .unwrap()
        .get(0)
}

pub(crate) async fn cleanup(client: &Client, user_id: i64) {
    crate::remove_test_user(client, user_id).await;
}
