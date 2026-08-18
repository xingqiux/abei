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

    // source_account_id 必须有值：`validate_import_row` 会挡住没映射付款账户的支出流水，
    // 所以夹具里直接给一个，让入账用例能走到真正要测的那几步。
    let row_id: i64 = client
        .query_one(
            "INSERT INTO abei_ai.bill_rows
               (user_id, bill_document_id, revision, row_number, occurred_at,
                signed_amount, currency_code, description, external_key, fingerprint,
                firefly_type, firefly_date, firefly_amount, source_account_id)
             VALUES ($1,$2,1,1,'2026-08-11 08:30:00',-12.34,'CNY','测试商户',
                     $3,$4,'withdrawal','2026-08-11',12.34,10)
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

/// 假 Firefly。入账 saga 的分支全都由「Firefly 怎么回话」决定，所以要测它就得能
/// 精确控制那一侧：200 带交易组、200 不带、422 拒绝、503、以及连都连不上。
pub(crate) struct FakeFirefly {
    pub base: String,
    /// 收到的 `POST /api/v1/transactions` 次数。用来验证「不该发的时候真的没发」。
    pub writes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    /// 收到的 `DELETE /api/v1/transactions/{id}` 次数。撤销入账用它验证
    /// 「账本那笔真的去删了」和「不该删的时候没删」。
    pub deletes: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    /// 收到的 `POST /api/v1/accounts` 次数。自动建渠道账户用它验证建没建。
    pub accounts_created: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

/// 假 Firefly 对一次入账写入的回应。
#[derive(Clone, Copy)]
pub(crate) enum FakeWrite {
    /// 正常建好，返回这个交易组 id。
    Created(i64),
    /// 2xx 但响应里没有交易组 id——账多半记上了，我们却抓不住它。
    CreatedWithoutId,
    /// 明确拒绝，带这个状态码。
    Rejected(u16),
    /// 说 200，但响应体不是 JSON。账可能已经记上，我们却读不懂回话。
    UnreadableBody,
    /// 请求收下了，然后连接断掉，一个字节的响应都没有。写有没有生效完全不知道。
    ConnectionDropped,
}

/// 假 Firefly 对「按 external_id 找交易」的回应。对账的三条分支全由它决定。
#[derive(Clone, Copy)]
pub(crate) enum FakeSearch {
    /// 查不到：账确实没记上。
    Nothing,
    /// 正好一条，返回这个交易组 id。
    One(i64),
    /// 同一个 external_id 查到多条，系统不该替用户选。
    Many,
}

/// 假 Firefly 对「删掉这个交易组」的回应。撤销入账的三条分支全由它决定。
#[derive(Clone, Copy)]
pub(crate) enum FakeDelete {
    /// 204 删掉了。
    Gone,
    /// 404：这笔交易本来就不在了。撤销要的结果已经达成。
    Missing,
    /// 明确拒绝，带这个状态码。账还在账本里。
    Rejected(u16),
}

/// 假 Firefly 对「按名字找资产账户」的回应。自动建渠道账户那条路靠它分叉。
#[derive(Clone, Copy)]
pub(crate) enum FakeAccounts {
    /// 没有同名账户，系统该自己建一个。
    None,
    /// 已经有一个同名账户（id、名字）。系统不该静默绑定，要落成待确认。
    Existing(i64, &'static str),
}

impl FakeFirefly {
    /// 起一个只服务入账路径的假 Firefly，返回它的地址。
    ///
    /// `/api/v1/transactions` 的 GET（查重）一律返回空列表，POST 按 `write` 回应；
    /// `/api/v1/accounts/{id}` 返回一个资产账户；对账搜索按 `search` 回应；
    /// `DELETE /api/v1/transactions/{id}` 按 `delete` 回应；
    /// `GET /api/v1/search/accounts` 按 `accounts` 回应，`POST /api/v1/accounts` 一律建成。
    pub(crate) async fn start(write: FakeWrite) -> Self {
        Self::start_with_search(write, FakeSearch::Nothing).await
    }

    pub(crate) async fn start_with_search(write: FakeWrite, search: FakeSearch) -> Self {
        Self::start_with(write, search, FakeDelete::Gone).await
    }

    /// 撤销入账的用例用这个：删除那一侧要能精确控制。
    pub(crate) async fn start_with_delete(delete: FakeDelete) -> Self {
        Self::start_with(FakeWrite::Created(1), FakeSearch::Nothing, delete).await
    }

    /// 自动建渠道账户的用例用这个：账户那一侧要能精确控制。
    pub(crate) async fn start_with_accounts(write: FakeWrite, accounts: FakeAccounts) -> Self {
        Self::start_full(write, FakeSearch::Nothing, FakeDelete::Gone, accounts).await
    }

    pub(crate) async fn start_with(
        write: FakeWrite,
        search: FakeSearch,
        delete: FakeDelete,
    ) -> Self {
        Self::start_full(write, search, delete, FakeAccounts::None).await
    }

    pub(crate) async fn start_full(
        write: FakeWrite,
        search: FakeSearch,
        delete: FakeDelete,
        accounts: FakeAccounts,
    ) -> Self {
        use axum::Json;
        use axum::extract::State;
        use axum::routing::get;
        use serde_json::json;
        use std::sync::Arc;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let writes = Arc::new(AtomicUsize::new(0));
        let deletes = Arc::new(AtomicUsize::new(0));
        let accounts_created = Arc::new(AtomicUsize::new(0));
        let state = (write, writes.clone());
        let delete_counter = deletes.clone();
        let created_accounts = accounts_created.clone();
        let app = axum::Router::new()
            .route(
                "/api/v1/transactions/{id}",
                axum::routing::delete(move || {
                    let deletes = delete_counter.clone();
                    async move {
                        use axum::http::StatusCode;
                        use axum::response::IntoResponse;
                        deletes.fetch_add(1, Ordering::SeqCst);
                        match delete {
                            FakeDelete::Gone => StatusCode::NO_CONTENT.into_response(),
                            FakeDelete::Missing => (
                                StatusCode::NOT_FOUND,
                                Json(json!({ "message": "Resource not found" })),
                            )
                                .into_response(),
                            FakeDelete::Rejected(status) => (
                                StatusCode::from_u16(status).unwrap(),
                                Json(json!({ "message": "Firefly 说这笔删不得" })),
                            )
                                .into_response(),
                        }
                    }
                }),
            )
            .route(
                "/api/v1/transactions",
                get(|| async {
                    Json(json!({ "data": [], "meta": { "pagination": {
                    "current_page": 1, "total_pages": 1 } } }))
                })
                .post(
                    |State((write, writes)): State<(FakeWrite, Arc<AtomicUsize>)>| async move {
                        use axum::http::StatusCode;
                        use axum::response::IntoResponse;
                        writes.fetch_add(1, Ordering::SeqCst);
                        match write {
                            FakeWrite::Created(id) => (
                                StatusCode::OK,
                                Json(json!({ "data": { "id": id.to_string() } })),
                            )
                                .into_response(),
                            FakeWrite::CreatedWithoutId => (
                                StatusCode::OK,
                                Json(json!({ "data": { "attributes": {} } })),
                            )
                                .into_response(),
                            FakeWrite::Rejected(status) => (
                                StatusCode::from_u16(status).unwrap(),
                                Json(json!({ "message": "Firefly 说不行" })),
                            )
                                .into_response(),
                            FakeWrite::UnreadableBody => {
                                (StatusCode::OK, "<html>不是 JSON</html>").into_response()
                            }
                            // panic 会让 hyper 直接掐掉这条连接，客户端收到的是传输层错误，
                            // 正是「请求送出去了，回话没了」那种情况。
                            FakeWrite::ConnectionDropped => panic!("假 Firefly 故意断开连接"),
                        }
                    },
                ),
            )
            .route(
                "/api/v1/accounts/{id}",
                get(|| async {
                    Json(json!({ "data": { "attributes": {
                        "name": "招商银行信用卡", "type": "asset" } } }))
                }),
            )
            // 自动建渠道账户走这两条：先按名字找，找不到就建。
            // 找一律返回空——「Firefly 里已经有同名账户」那条路由
            // FakeAccounts::Existing 单独覆盖，见 start_with_accounts。
            .route(
                "/api/v1/search/accounts",
                get(move || async move {
                    match accounts {
                        FakeAccounts::None => Json(json!({ "data": [] })),
                        FakeAccounts::Existing(id, name) => Json(json!({ "data": [
                            { "id": id.to_string(), "attributes": { "name": name, "type": "asset" } }
                        ] })),
                    }
                }),
            )
            .route(
                "/api/v1/accounts",
                axum::routing::post(move || {
                    let created = created_accounts.clone();
                    async move {
                        created.fetch_add(1, Ordering::SeqCst);
                        Json(json!({ "data": { "id": "9001", "attributes": {
                            "name": "招商银行", "type": "asset" } } }))
                    }
                }),
            )
            .route(
                "/api/v1/search/transactions",
                get(move || async move {
                    let data = match search {
                        FakeSearch::Nothing => json!([]),
                        FakeSearch::One(id) => json!([{ "id": id.to_string() }]),
                        FakeSearch::Many => {
                            json!([{ "id": "9001" }, { "id": "9002" }])
                        }
                    };
                    Json(json!({ "data": data }))
                }),
            )
            .with_state(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        Self {
            base: format!("http://{address}"),
            writes,
            deletes,
            accounts_created,
        }
    }

    pub(crate) fn write_count(&self) -> usize {
        self.writes.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 建了几个资产账户。自动建渠道账户的用例靠它验证「该建的时候建了、不该建的时候没建」。
    pub(crate) fn account_count(&self) -> usize {
        self.accounts_created
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub(crate) fn delete_count(&self) -> usize {
        self.deletes.load(std::sync::atomic::Ordering::SeqCst)
    }

    pub(crate) fn client(&self) -> crate::firefly::Firefly {
        crate::firefly::Firefly::new(&self.base).unwrap()
    }
}

/// 一个默认配置的 billing::Service。不碰 Firefly 的用例用它，省得各处再抄一遍装配。
pub(crate) fn billing_service(pool: Pool) -> crate::billing::Service {
    let config = crate::mailbox::RuntimeConfig::test();
    let mail = crate::mail::Service::new(pool.clone(), config.storage_root().to_path_buf());
    let parser = crate::parser::Service::new(pool.clone(), mail.clone());
    crate::billing::Service::new(
        pool,
        mail,
        parser,
        config.job_secret_cipher(),
        config.reliability(),
        crate::firefly::Firefly::from_env(),
    )
}

/// 一个连不上的地址：端口先占再放，保证没人在听。用来模拟「请求发出去了但结果不明」。
pub(crate) async fn unreachable_firefly() -> crate::firefly::Firefly {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    crate::firefly::Firefly::new(&format!("http://{address}")).unwrap()
}
