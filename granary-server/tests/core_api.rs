use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
    response::Response,
};
use granary_server::{config::Config, http};
use http_body_util::BodyExt;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower::ServiceExt;

fn config() -> Config {
    Config {
        database_url: "unused-by-router-test".to_owned(),
        listen_addr: "127.0.0.1:0".parse().unwrap(),
        max_connections: 2,
        cookie_secure: false,
        allowed_origin: "http://localhost:18002".to_owned(),
        secret_key: [7; 32],
        smtp_host: "127.0.0.1".to_owned(),
        smtp_port: 13026,
        smtp_username: "bills".to_owned(),
        smtp_password: "bills-local-only".to_owned(),
        mail_from: "Granary <no-reply@granary.local>".to_owned(),
        public_url: "http://localhost:18002".to_owned(),
    }
}

fn json_request(method: &str, uri: &str, token: Option<&str>, body: Value) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, "http://localhost:18002");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder.body(Body::from(body.to_string())).unwrap()
}

fn get_request(uri: &str, token: &str) -> Request<Body> {
    Request::builder()
        .uri(uri)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap()
}

async fn response_json(response: Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

async fn send_json(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
    expected_status: StatusCode,
) -> Value {
    let response = app
        .clone()
        .oneshot(json_request(method, uri, token, body))
        .await
        .unwrap();
    let status = response.status();
    let response = response_json(response).await;
    assert_eq!(
        status, expected_status,
        "response body for {method} {uri}: {response}"
    );
    response
}

async fn send_status(
    app: &Router,
    method: &str,
    uri: &str,
    token: &str,
    expected_status: StatusCode,
) {
    let response = app
        .clone()
        .oneshot(json_request(method, uri, Some(token), Value::Null))
        .await
        .unwrap();
    assert_eq!(response.status(), expected_status);
}

async fn bootstrap(app: &Router, email: &str) -> Value {
    send_json(
        app,
        "POST",
        "/api/v1/auth/bootstrap",
        None,
        json!({
            "email": email,
            "display_name": "Owner",
            "password": "correct horse battery staple"
        }),
        StatusCode::CREATED,
    )
    .await
}

#[sqlx::test(migrations = "./migrations")]
async fn pat_can_post_a_balanced_withdrawal_and_read_the_result(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app, "owner@example.test").await;
    let token = initialized["personal_access_token"].as_str().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();

    let currencies = app
        .clone()
        .oneshot(get_request("/api/v1/currencies", token))
        .await
        .unwrap();
    assert_eq!(currencies.status(), StatusCode::OK);
    let currencies = response_json(currencies).await;
    assert!(currencies.as_array().unwrap().iter().any(|currency| {
        currency["code"] == "CNY"
            && currency["symbol"] == "CN¥"
            && currency["minor_units"] == 2
            && currency["enabled_by_default"] == true
    }));

    let account = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts"),
        Some(token),
        json!({
            "name": "日常银行卡",
            "class": "asset",
            "role": "bank",
            "currency_code": "CNY"
        }),
        StatusCode::CREATED,
    )
    .await;
    let category = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        Some(token),
        json!({"name": "餐饮", "parent_id": null}),
        StatusCode::CREATED,
    )
    .await;
    let counterparty = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/counterparties"),
        Some(token),
        json!({"name": "街角面馆", "kind": "merchant", "notes": "午餐"}),
        StatusCode::CREATED,
    )
    .await;

    let transaction = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        json!({
            "type": "withdrawal",
            "occurred_at": "2026-07-22T12:00:00Z",
            "description": "工作日午餐",
            "counterparty_id": counterparty["id"],
            "account_id": account["id"],
            "amount": "25.50",
            "book_amount": "25.50",
            "splits": [{
                "category_id": category["id"],
                "amount": "25.50",
                "book_amount": "25.50",
                "memo": "牛肉面"
            }]
        }),
        StatusCode::CREATED,
    )
    .await;

    assert_eq!(transaction["status"], "posted");
    assert_eq!(transaction["counterparty_name"], "街角面馆");
    assert_eq!(transaction["postings"].as_array().unwrap().len(), 2);
    let total = transaction["postings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|posting| {
            posting["book_amount"]
                .as_str()
                .unwrap()
                .parse::<Decimal>()
                .unwrap()
        })
        .sum::<Decimal>();
    assert_eq!(total, Decimal::ZERO);

    let listed = app
        .clone()
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/transactions"),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::OK);
    let listed = response_json(listed).await;
    assert_eq!(listed["data"].as_array().unwrap().len(), 1);
    assert_eq!(listed["data"][0]["id"], transaction["id"]);

    let accounts = app
        .clone()
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/accounts"),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(accounts.status(), StatusCode::OK);
    let accounts = response_json(accounts).await;
    let account_row = accounts
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == account["id"])
        .unwrap();
    assert_eq!(
        account_row["balance"]
            .as_str()
            .unwrap()
            .parse::<Decimal>()
            .unwrap(),
        Decimal::new(-2550, 2)
    );

    let actor_kind = sqlx::query_scalar::<_, String>(
        "SELECT actor_kind FROM audit_events WHERE entity_type = 'journal_entry' AND entity_id = $1",
    )
    .bind(transaction["id"].as_i64().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(actor_kind, "pat");

    let reversal = send_json(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/transactions/{}/reverse",
            transaction["id"]
        ),
        Some(token),
        json!({
            "occurred_at": "2026-07-22T13:00:00Z",
            "reason": "原交易录入错误"
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(reversal["status"], "posted");
    assert_eq!(reversal["reversal_of_id"], transaction["id"]);

    let repeated = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!(
                "/api/v1/books/{book_id}/transactions/{}/reverse",
                transaction["id"]
            ),
            Some(token),
            json!({"reason": "不能重复冲正"}),
        ))
        .await
        .unwrap();
    assert_eq!(repeated.status(), StatusCode::CONFLICT);

    let accounts = app
        .clone()
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/accounts"),
            token,
        ))
        .await
        .unwrap();
    let accounts = response_json(accounts).await;
    let account_row = accounts
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == account["id"])
        .unwrap();
    assert_eq!(
        account_row["balance"]
            .as_str()
            .unwrap()
            .parse::<Decimal>()
            .unwrap(),
        Decimal::ZERO
    );

    let listed = app
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/transactions"),
            token,
        ))
        .await
        .unwrap();
    let listed = response_json(listed).await;
    assert_eq!(listed["data"].as_array().unwrap().len(), 2);
    let original = listed["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == transaction["id"])
        .unwrap();
    assert_eq!(original["status"], "reversed");
    assert_eq!(original["reversed_by_id"], reversal["id"]);
}

#[sqlx::test(migrations = "./migrations")]
async fn one_category_classifies_withdrawals_deposits_and_transfers(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app, "neutral-category@example.test").await;
    let token = initialized["personal_access_token"].as_str().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();

    let source = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts"),
        Some(token),
        json!({
            "name": "分类测试账户",
            "class": "asset",
            "role": "bank",
            "currency_code": "CNY"
        }),
        StatusCode::CREATED,
    )
    .await;
    let destination = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts"),
        Some(token),
        json!({
            "name": "分类测试现金",
            "class": "asset",
            "role": "cash",
            "currency_code": "CNY"
        }),
        StatusCode::CREATED,
    )
    .await;
    let category = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        Some(token),
        json!({"name": "往来测试", "parent_id": null}),
        StatusCode::CREATED,
    )
    .await;
    assert!(!category.as_object().unwrap().contains_key("kind"));

    let withdrawal = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        json!({
            "type": "withdrawal",
            "occurred_at": "2026-07-22T08:00:00Z",
            "description": "分类支出",
            "counterparty_id": null,
            "account_id": source["id"],
            "amount": "10.00",
            "book_amount": "10.00",
            "splits": [{
                "category_id": category["id"],
                "budget_id": null,
                "amount": "10.00",
                "book_amount": "10.00",
                "memo": null
            }]
        }),
        StatusCode::CREATED,
    )
    .await;
    let deposit = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        json!({
            "type": "deposit",
            "occurred_at": "2026-07-22T09:00:00Z",
            "description": "分类收入",
            "counterparty_id": null,
            "account_id": source["id"],
            "amount": "4.00",
            "book_amount": "4.00",
            "splits": [{
                "category_id": category["id"],
                "budget_id": null,
                "amount": "4.00",
                "book_amount": "4.00",
                "memo": null
            }]
        }),
        StatusCode::CREATED,
    )
    .await;
    let transfer = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        json!({
            "type": "transfer",
            "occurred_at": "2026-07-22T10:00:00Z",
            "description": "分类转账",
            "counterparty_id": null,
            "source_account_id": source["id"],
            "source_amount": "2.00",
            "source_book_amount": "2.00",
            "destination_account_id": destination["id"],
            "destination_amount": "2.00",
            "destination_book_amount": "2.00",
            "category_id": category["id"]
        }),
        StatusCode::CREATED,
    )
    .await;

    for transaction in [&withdrawal, &deposit, &transfer] {
        assert!(
            transaction["postings"]
                .as_array()
                .unwrap()
                .iter()
                .any(|posting| posting["category_id"] == category["id"])
        );
    }
    assert_eq!(transfer["transaction_type"], "transfer");

    let summary = app
        .clone()
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/reports/summary?start=2026-07-01&end=2026-07-31"),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(summary.status(), StatusCode::OK);
    let summary = response_json(summary).await;
    assert_eq!(summary["expense"], "10.00000000");
    assert_eq!(summary["income"], "4.00000000");
    assert_eq!(summary["net_cashflow"], "-6.00000000");

    let category_report = app
        .oneshot(get_request(
            &format!(
                "/api/v1/books/{book_id}/reports/expenses/by-category?start=2026-07-01&end=2026-07-31"
            ),
            token,
        ))
        .await
        .unwrap();
    assert_eq!(category_report.status(), StatusCode::OK);
    let category_report = response_json(category_report).await;
    assert_eq!(category_report.as_array().unwrap().len(), 1);
    assert_eq!(category_report[0]["id"], category["id"]);
    assert_eq!(category_report[0]["amount"], "10.00000000");
}

#[sqlx::test(migrations = "./migrations")]
async fn non_member_cannot_read_or_write_another_book(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app, "owner@example.test").await;
    let owner_token = initialized["personal_access_token"].as_str().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();

    let outsider_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO users (email, display_name, password_hash) VALUES ('outsider@example.test', 'Outsider', 'not-used') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let selector = "0123456789abcdef";
    let secret = "outsider-secret";
    let token_hash = Sha256::digest(secret.as_bytes()).to_vec();
    sqlx::query(
        "INSERT INTO personal_access_tokens (selector, token_hash, user_id, name, scopes) VALUES ($1, $2, $3, 'test', ARRAY['*'])",
    )
    .bind(selector)
    .bind(token_hash)
    .bind(outsider_id)
    .execute(&pool)
    .await
    .unwrap();
    let outsider_token = format!("grn_pat_{selector}_{secret}");

    for uri in [
        format!("/api/v1/books/{book_id}/accounts"),
        format!("/api/v1/books/{book_id}/categories"),
        format!("/api/v1/books/{book_id}/counterparties"),
        format!("/api/v1/books/{book_id}/transactions"),
    ] {
        let response = app
            .clone()
            .oneshot(get_request(&uri, &outsider_token))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "GET {uri}");
    }

    let denied = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!("/api/v1/books/{book_id}/accounts"),
            Some(&outsider_token),
            json!({
                "name": "越权账户",
                "class": "asset",
                "role": "cash",
                "currency_code": "CNY"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::NOT_FOUND);

    let owner_view = app
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/accounts"),
            owner_token,
        ))
        .await
        .unwrap();
    assert_eq!(owner_view.status(), StatusCode::OK);
}

#[sqlx::test(migrations = "./migrations")]
async fn managed_resources_use_versions_archive_and_restore(pool: PgPool) {
    let app = http::router(pool, &config());
    let initialized = bootstrap(&app, "owner@example.test").await;
    let token = initialized["personal_access_token"].as_str().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();

    let account = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts"),
        Some(token),
        json!({
            "name": "现金",
            "class": "asset",
            "role": "cash",
            "currency_code": "CNY"
        }),
        StatusCode::CREATED,
    )
    .await;
    let account_id = account["id"].as_i64().unwrap();
    let account = send_json(
        &app,
        "PUT",
        &format!("/api/v1/books/{book_id}/accounts/{account_id}"),
        Some(token),
        json!({
            "name": "随身现金",
            "class": "asset",
            "role": "cash",
            "currency_code": "CNY",
            "version": 1
        }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(account["version"], 2);
    let stale = app
        .clone()
        .oneshot(json_request(
            "PUT",
            &format!("/api/v1/books/{book_id}/accounts/{account_id}"),
            Some(token),
            json!({
                "name": "过期写入",
                "class": "asset",
                "role": "cash",
                "currency_code": "CNY",
                "version": 1
            }),
        ))
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    send_status(
        &app,
        "DELETE",
        &format!("/api/v1/books/{book_id}/accounts/{account_id}?version=2"),
        token,
        StatusCode::NO_CONTENT,
    )
    .await;
    let archived_accounts = app
        .clone()
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/accounts?archived=true"),
            token,
        ))
        .await
        .unwrap();
    let archived_accounts = response_json(archived_accounts).await;
    assert_eq!(archived_accounts[0]["id"], account_id);
    assert!(archived_accounts[0]["archived_at"].is_string());
    send_status(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts/{account_id}/restore?version=3"),
        token,
        StatusCode::NO_CONTENT,
    )
    .await;

    let parent = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        Some(token),
        json!({"name": "日常", "parent_id": null}),
        StatusCode::CREATED,
    )
    .await;
    let parent_id = parent["id"].as_i64().unwrap();
    let child = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        Some(token),
        json!({"name": "餐饮", "parent_id": parent_id}),
        StatusCode::CREATED,
    )
    .await;
    let child_id = child["id"].as_i64().unwrap();
    let parent_archive = app
        .clone()
        .oneshot(json_request(
            "DELETE",
            &format!("/api/v1/books/{book_id}/categories/{parent_id}?version=1"),
            Some(token),
            Value::Null,
        ))
        .await
        .unwrap();
    assert_eq!(parent_archive.status(), StatusCode::CONFLICT);

    let parent_post = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!("/api/v1/books/{book_id}/transactions"),
            Some(token),
            json!({
                "type": "withdrawal",
                "occurred_at": "2026-07-22T12:00:00Z",
                "description": "错误使用父分类",
                "counterparty_id": null,
                "account_id": account_id,
                "amount": "10.00",
                "book_amount": "10.00",
                "splits": [{
                    "category_id": parent_id,
                    "amount": "10.00",
                    "book_amount": "10.00",
                    "memo": null
                }]
            }),
        ))
        .await
        .unwrap();
    assert_eq!(parent_post.status(), StatusCode::BAD_REQUEST);

    let child = send_json(
        &app,
        "PUT",
        &format!("/api/v1/books/{book_id}/categories/{child_id}"),
        Some(token),
        json!({
            "name": "工作餐",
            "parent_id": parent_id,
            "version": 1
        }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(child["version"], 2);
    send_status(
        &app,
        "DELETE",
        &format!("/api/v1/books/{book_id}/categories/{child_id}?version=2"),
        token,
        StatusCode::NO_CONTENT,
    )
    .await;
    send_status(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories/{child_id}/restore?version=3"),
        token,
        StatusCode::NO_CONTENT,
    )
    .await;

    let counterparty = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/counterparties"),
        Some(token),
        json!({"name": "商户", "kind": "merchant", "notes": null}),
        StatusCode::CREATED,
    )
    .await;
    let counterparty_id = counterparty["id"].as_i64().unwrap();
    let counterparty = send_json(
        &app,
        "PUT",
        &format!("/api/v1/books/{book_id}/counterparties/{counterparty_id}"),
        Some(token),
        json!({
            "name": "确认商户",
            "kind": "merchant",
            "review_status": "confirmed",
            "notes": "已核对",
            "version": 1
        }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(counterparty["version"], 2);
    send_status(
        &app,
        "DELETE",
        &format!("/api/v1/books/{book_id}/counterparties/{counterparty_id}?version=2"),
        token,
        StatusCode::NO_CONTENT,
    )
    .await;
    send_status(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/counterparties/{counterparty_id}/restore?version=3"),
        token,
        StatusCode::NO_CONTENT,
    )
    .await;
}

#[sqlx::test(migrations = "./migrations")]
async fn transaction_recycle_bin_uses_reversal_and_restoration_journals(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app, "owner@example.test").await;
    let token = initialized["personal_access_token"].as_str().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();
    let account = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts"),
        Some(token),
        json!({
            "name": "零钱",
            "class": "asset",
            "role": "cash",
            "currency_code": "CNY"
        }),
        StatusCode::CREATED,
    )
    .await;
    let category = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        Some(token),
        json!({"name": "交通", "parent_id": null}),
        StatusCode::CREATED,
    )
    .await;
    let transaction = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        json!({
            "type": "withdrawal",
            "occurred_at": "2026-07-22T12:00:00Z",
            "description": "地铁",
            "counterparty_id": null,
            "account_id": account["id"],
            "amount": "12.00",
            "book_amount": "12.00",
            "splits": [{
                "category_id": category["id"],
                "amount": "12.00",
                "book_amount": "12.00",
                "memo": null
            }]
        }),
        StatusCode::CREATED,
    )
    .await;
    let transaction_id = transaction["id"].as_i64().unwrap();
    let trash = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions/{transaction_id}/trash"),
        Some(token),
        json!({"reason": "不需要保留在当前账目中"}),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(trash["reversal_of_id"], transaction_id);

    let recycle_bin = app
        .clone()
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/transactions/recycle-bin"),
            token,
        ))
        .await
        .unwrap();
    let recycle_bin = response_json(recycle_bin).await;
    assert_eq!(recycle_bin.as_array().unwrap().len(), 1);
    assert_eq!(recycle_bin[0]["original_journal_id"], transaction_id);
    assert!(recycle_bin[0]["restored_at"].is_null());

    let balance = sqlx::query_scalar::<_, Decimal>(
        r#"
        SELECT COALESCE(sum(p.amount), 0)
        FROM postings p
        JOIN journal_entries j ON j.id = p.journal_entry_id
        WHERE p.book_id = $1 AND p.account_id = $2 AND j.status IN ('posted', 'reversed')
        "#,
    )
    .bind(book_id)
    .bind(account["id"].as_i64().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(balance, Decimal::ZERO);

    let restored = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions/{transaction_id}/restore"),
        Some(token),
        json!({"reason": "撤销删除"}),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(restored["reversal_of_id"], trash["id"]);

    let active_recycle_bin = app
        .clone()
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/transactions/recycle-bin"),
            token,
        ))
        .await
        .unwrap();
    assert!(
        response_json(active_recycle_bin)
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    let restored_recycle_bin = app
        .clone()
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/transactions/recycle-bin?restored=true"),
            token,
        ))
        .await
        .unwrap();
    let restored_recycle_bin = response_json(restored_recycle_bin).await;
    assert_eq!(
        restored_recycle_bin[0]["restored_journal_id"],
        restored["id"]
    );

    let balance = sqlx::query_scalar::<_, Decimal>(
        r#"
        SELECT COALESCE(sum(p.amount), 0)
        FROM postings p
        JOIN journal_entries j ON j.id = p.journal_entry_id
        WHERE p.book_id = $1 AND p.account_id = $2 AND j.status IN ('posted', 'reversed')
        "#,
    )
    .bind(book_id)
    .bind(account["id"].as_i64().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(balance, Decimal::from(-12));

    let repeated = app
        .oneshot(json_request(
            "POST",
            &format!("/api/v1/books/{book_id}/transactions/{transaction_id}/restore"),
            Some(token),
            json!({"reason": "不能重复恢复"}),
        ))
        .await
        .unwrap();
    assert_eq!(repeated.status(), StatusCode::CONFLICT);
}

#[sqlx::test(migrations = "./migrations")]
async fn organization_and_book_roles_enforce_shared_book_boundaries(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app, "owner@example.test").await;
    let owner_id = initialized["user_id"].as_i64().unwrap();
    let owner_token = initialized["personal_access_token"].as_str().unwrap();
    let organization_id = initialized["organization_id"].as_i64().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();

    let member_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO users (email, display_name, password_hash) VALUES ('member@example.test', 'Member', 'not-used') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let selector = "fedcba9876543210";
    let secret = "member-secret";
    sqlx::query(
        r#"
        INSERT INTO personal_access_tokens (selector, token_hash, user_id, name, scopes)
        VALUES ($1, $2, $3, 'member-test', ARRAY['organizations:manage', 'books:write'])
        "#,
    )
    .bind(selector)
    .bind(Sha256::digest(secret.as_bytes()).to_vec())
    .bind(member_id)
    .execute(&pool)
    .await
    .unwrap();
    let member_token = format!("grn_pat_{selector}_{secret}");

    send_json(
        &app,
        "POST",
        &format!("/api/v1/organizations/{organization_id}/members"),
        Some(owner_token),
        json!({"user_id": member_id, "role": "admin"}),
        StatusCode::CREATED,
    )
    .await;

    let hidden = app
        .clone()
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/accounts"),
            &member_token,
        ))
        .await
        .unwrap();
    assert_eq!(hidden.status(), StatusCode::NOT_FOUND);

    send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/members"),
        Some(&member_token),
        json!({"user_id": member_id, "role": "viewer"}),
        StatusCode::CREATED,
    )
    .await;
    let readable = app
        .clone()
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/accounts"),
            &member_token,
        ))
        .await
        .unwrap();
    assert_eq!(readable.status(), StatusCode::OK);
    let denied = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!("/api/v1/books/{book_id}/accounts"),
            Some(&member_token),
            json!({
                "name": "viewer denied",
                "class": "asset",
                "role": "cash",
                "currency_code": "CNY"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::FORBIDDEN);

    send_json(
        &app,
        "PUT",
        &format!("/api/v1/books/{book_id}/members/{member_id}"),
        Some(owner_token),
        json!({"role": "editor"}),
        StatusCode::OK,
    )
    .await;
    let created = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!("/api/v1/books/{book_id}/accounts"),
            Some(&member_token),
            json!({
                "name": "editor account",
                "class": "asset",
                "role": "cash",
                "currency_code": "CNY"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::CREATED);

    let last_owner = app
        .clone()
        .oneshot(json_request(
            "DELETE",
            &format!("/api/v1/organizations/{organization_id}/members/{owner_id}"),
            Some(owner_token),
            Value::Null,
        ))
        .await
        .unwrap();
    assert_eq!(last_owner.status(), StatusCode::CONFLICT);
    let last_manager = app
        .clone()
        .oneshot(json_request(
            "DELETE",
            &format!("/api/v1/books/{book_id}/members/{owner_id}"),
            Some(owner_token),
            Value::Null,
        ))
        .await
        .unwrap();
    assert_eq!(last_manager.status(), StatusCode::CONFLICT);

    send_status(
        &app,
        "DELETE",
        &format!("/api/v1/books/{book_id}/members/{member_id}"),
        owner_token,
        StatusCode::NO_CONTENT,
    )
    .await;
    let removed = app
        .oneshot(get_request(
            &format!("/api/v1/books/{book_id}/accounts"),
            &member_token,
        ))
        .await
        .unwrap();
    assert_eq!(removed.status(), StatusCode::NOT_FOUND);
}

#[sqlx::test(migrations = "./migrations")]
async fn transaction_clone_and_batch_replacement_preserve_history_and_support_type_conversion(
    pool: PgPool,
) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app, "advanced@example.test").await;
    let token = initialized["personal_access_token"].as_str().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();
    let account = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts"),
        Some(token),
        json!({
            "name": "日常账户",
            "class": "asset",
            "role": "bank",
            "currency_code": "CNY"
        }),
        StatusCode::CREATED,
    )
    .await;
    let expense = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        Some(token),
        json!({"name": "餐饮", "parent_id": null}),
        StatusCode::CREATED,
    )
    .await;
    let income = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        Some(token),
        json!({"name": "退款收入", "parent_id": null}),
        StatusCode::CREATED,
    )
    .await;
    let tag = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/tags"),
        Some(token),
        json!({"name": "待报销", "color": "#336699"}),
        StatusCode::CREATED,
    )
    .await;

    let withdrawal = |description: &str, amount: &str| {
        json!({
            "type": "withdrawal",
            "occurred_at": "2026-07-22T08:00:00Z",
            "description": description,
            "counterparty_id": null,
            "account_id": account["id"],
            "amount": amount,
            "book_amount": amount,
            "splits": [{
                "category_id": expense["id"],
                "budget_id": null,
                "amount": amount,
                "book_amount": amount,
                "memo": "工作日午餐"
            }],
            "tag_ids": [tag["id"]]
        })
    };
    let first = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        withdrawal("午餐 A", "10.00"),
        StatusCode::CREATED,
    )
    .await;
    let second = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        withdrawal("午餐 B", "20.00"),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(first["transaction_type"], "withdrawal");

    let clone = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions/{}/clone", first["id"]),
        Some(token),
        json!({
            "occurred_at": "2026-07-23T08:00:00Z",
            "description": "午餐 A 复制"
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(clone["cloned_from_id"], first["id"]);
    assert_eq!(clone["transaction_type"], "withdrawal");
    assert_eq!(clone["tags"][0]["id"], tag["id"]);
    assert_eq!(
        clone["postings"][0]["amount"],
        first["postings"][0]["amount"]
    );
    assert_eq!(
        clone["postings"][1]["budget_id"],
        first["postings"][1]["budget_id"]
    );

    let replacement_first = json!({
        "type": "deposit",
        "occurred_at": "2026-07-24T08:00:00Z",
        "description": "午餐退款",
        "counterparty_id": null,
        "account_id": account["id"],
        "amount": "15.00",
        "book_amount": "15.00",
        "splits": [{
            "category_id": income["id"],
            "budget_id": null,
            "amount": "15.00",
            "book_amount": "15.00",
            "memo": null
        }],
        "tag_ids": [tag["id"]]
    });
    let replacement_second = withdrawal("午餐 B 调整", "25.00");
    let preview = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions/batches/preview"),
        Some(token),
        json!({
            "operation": "replace",
            "reason": "批量修正测试",
            "items": [
                {
                    "transaction_id": first["id"],
                    "version": first["version"],
                    "replacement": replacement_first
                },
                {
                    "transaction_id": second["id"],
                    "version": second["version"],
                    "replacement": replacement_second
                }
            ]
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(preview["operation"], "replace");
    assert_eq!(preview["item_count"], 2);
    assert_eq!(
        preview["items"][0]["before"]["transaction_type"],
        "withdrawal"
    );
    assert_eq!(preview["items"][0]["replacement"]["type"], "deposit");
    let account_impact = preview["account_impacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|impact| impact["account_id"] == account["id"])
        .unwrap();
    assert_eq!(
        account_impact["book_amount_delta"]
            .as_str()
            .unwrap()
            .parse::<Decimal>()
            .unwrap(),
        Decimal::from(20)
    );

    let executed = send_json(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/transactions/batches/{}/execute",
            preview["preview_id"]
        ),
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(executed["results"].as_array().unwrap().len(), 2);
    let first_replacement_id = executed["results"][0]["replacement_journal_id"]
        .as_i64()
        .unwrap();
    let old_first = send_json(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/transactions/{}", first["id"]),
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(old_first["status"], "reversed");
    assert_eq!(old_first["replaced_by_id"], first_replacement_id);
    let new_first = send_json(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/transactions/{first_replacement_id}"),
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(new_first["transaction_type"], "deposit");
    assert_eq!(new_first["replaces_id"], first["id"]);

    let repeated = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!(
                "/api/v1/books/{book_id}/transactions/batches/{}/execute",
                preview["preview_id"]
            ),
            Some(token),
            Value::Null,
        ))
        .await
        .unwrap();
    assert_eq!(repeated.status(), StatusCode::CONFLICT);

    let replacement_links = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM transaction_replacements WHERE book_id = $1 AND batch_preview_id = $2",
    )
    .bind(book_id)
    .bind(preview["preview_id"].as_i64().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(replacement_links, 2);
    let batch_events = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM audit_events WHERE book_id = $1 AND action IN ('transaction_batch.previewed', 'transaction_batch.executed')",
    )
    .bind(book_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(batch_events, 2);
}

#[sqlx::test(migrations = "./migrations")]
async fn stale_batch_preview_is_atomic_and_batch_trash_populates_the_recycle_bin(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app, "batch-trash@example.test").await;
    let token = initialized["personal_access_token"].as_str().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();
    let account = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts"),
        Some(token),
        json!({"name": "现金", "class": "asset", "role": "cash", "currency_code": "CNY"}),
        StatusCode::CREATED,
    )
    .await;
    let category = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        Some(token),
        json!({"name": "杂项", "parent_id": null}),
        StatusCode::CREATED,
    )
    .await;
    let create = |description: &str, amount: &str| {
        json!({
            "type": "withdrawal",
            "occurred_at": "2026-07-22T10:00:00Z",
            "description": description,
            "counterparty_id": null,
            "account_id": account["id"],
            "amount": amount,
            "book_amount": amount,
            "splits": [{
                "category_id": category["id"],
                "budget_id": null,
                "amount": amount,
                "book_amount": amount,
                "memo": null
            }],
            "tag_ids": []
        })
    };
    let first = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        create("第一笔", "7.00"),
        StatusCode::CREATED,
    )
    .await;
    let second = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        create("第二笔", "8.00"),
        StatusCode::CREATED,
    )
    .await;
    let stale_preview = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions/batches/preview"),
        Some(token),
        json!({
            "operation": "trash",
            "reason": "先生成预览",
            "items": [
                {"transaction_id": first["id"], "version": 1},
                {"transaction_id": second["id"], "version": 1}
            ]
        }),
        StatusCode::CREATED,
    )
    .await;
    send_json(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/transactions/{}/reverse",
            first["id"]
        ),
        Some(token),
        json!({"reason": "让预览失效"}),
        StatusCode::CREATED,
    )
    .await;
    let stale_execute = app
        .clone()
        .oneshot(json_request(
            "POST",
            &format!(
                "/api/v1/books/{book_id}/transactions/batches/{}/execute",
                stale_preview["preview_id"]
            ),
            Some(token),
            Value::Null,
        ))
        .await
        .unwrap();
    assert_eq!(stale_execute.status(), StatusCode::CONFLICT);
    let unchanged_second = send_json(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/transactions/{}", second["id"]),
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(unchanged_second["status"], "posted");
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM transaction_recycle_bin WHERE book_id = $1"
        )
        .bind(book_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        0
    );

    let third = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        create("第三笔", "9.00"),
        StatusCode::CREATED,
    )
    .await;
    let preview = send_json(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions/batches/preview"),
        Some(token),
        json!({
            "operation": "trash",
            "reason": "批量移入回收站",
            "items": [
                {"transaction_id": second["id"], "version": 1},
                {"transaction_id": third["id"], "version": 1}
            ]
        }),
        StatusCode::CREATED,
    )
    .await;
    let executed = send_json(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/transactions/batches/{}/execute",
            preview["preview_id"]
        ),
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(executed["results"].as_array().unwrap().len(), 2);
    let recycle_bin = send_json(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/transactions/recycle-bin"),
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(recycle_bin.as_array().unwrap().len(), 2);
}

#[sqlx::test(migrations = "./migrations")]
async fn invitation_registration_and_existing_user_acceptance_are_enforced(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app, "owner@example.test").await;
    let owner_token = initialized["personal_access_token"].as_str().unwrap();
    let organization_id = initialized["organization_id"].as_i64().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();

    let invitation = send_json(
        &app,
        "POST",
        &format!("/api/v1/organizations/{organization_id}/invitations"),
        Some(owner_token),
        json!({
            "email": "invitee@example.test",
            "organization_role": "member",
            "books": [{"book_id": book_id, "role": "editor"}],
            "expires_in_days": 7
        }),
        StatusCode::CREATED,
    )
    .await;
    let invitation_token = invitation["token"].as_str().unwrap();
    assert!(invitation_token.starts_with("grn_inv_"));

    let listed = app
        .clone()
        .oneshot(get_request(
            &format!("/api/v1/organizations/{organization_id}/invitations"),
            owner_token,
        ))
        .await
        .unwrap();
    let listed = response_json(listed).await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert!(listed[0].get("token").is_none());

    let accepted = send_json(
        &app,
        "POST",
        "/api/v1/auth/invitations/accept",
        None,
        json!({
            "token": invitation_token,
            "display_name": "Invitee",
            "password": "invitee secure password"
        }),
        StatusCode::CREATED,
    )
    .await;
    let invitee_id = accepted["user_id"].as_i64().unwrap();
    assert_eq!(accepted["book_ids"][0], book_id);
    let roles = sqlx::query_as::<_, (String, String)>(
        r#"
        SELECT om.role, bm.role
        FROM organization_memberships om
        JOIN book_memberships bm ON bm.user_id = om.user_id AND bm.book_id = $2
        WHERE om.organization_id = $1 AND om.user_id = $3
        "#,
    )
    .bind(organization_id)
    .bind(book_id)
    .bind(invitee_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(roles, ("member".to_owned(), "editor".to_owned()));

    let repeated = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/invitations/accept",
            None,
            json!({
                "token": invitation_token,
                "display_name": "Invitee",
                "password": "invitee secure password"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(repeated.status(), StatusCode::UNAUTHORIZED);

    let second_organization = send_json(
        &app,
        "POST",
        "/api/v1/organizations",
        Some(owner_token),
        json!({"name": "第二组织", "kind": "household"}),
        StatusCode::CREATED,
    )
    .await;
    let second_organization_id = second_organization["id"].as_i64().unwrap();
    let second_book = send_json(
        &app,
        "POST",
        &format!("/api/v1/organizations/{second_organization_id}/books"),
        Some(owner_token),
        json!({"name": "共享账本", "base_currency_code": "CNY", "timezone": "Asia/Shanghai"}),
        StatusCode::CREATED,
    )
    .await;
    let second_book_id = second_book["id"].as_i64().unwrap();
    let second_invitation = send_json(
        &app,
        "POST",
        &format!("/api/v1/organizations/{second_organization_id}/invitations"),
        Some(owner_token),
        json!({
            "email": "invitee@example.test",
            "organization_role": "admin",
            "books": [{"book_id": second_book_id, "role": "viewer"}]
        }),
        StatusCode::CREATED,
    )
    .await;
    let second_token = second_invitation["token"].as_str().unwrap();
    let wrong_password = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/invitations/accept",
            None,
            json!({
                "token": second_token,
                "display_name": null,
                "password": "wrong password value"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(wrong_password.status(), StatusCode::UNAUTHORIZED);
    send_json(
        &app,
        "POST",
        "/api/v1/auth/invitations/accept",
        None,
        json!({
            "token": second_token,
            "display_name": null,
            "password": "invitee secure password"
        }),
        StatusCode::CREATED,
    )
    .await;

    let revoked_invitation = send_json(
        &app,
        "POST",
        &format!("/api/v1/organizations/{second_organization_id}/invitations"),
        Some(owner_token),
        json!({
            "email": "revoked@example.test",
            "organization_role": "member",
            "books": []
        }),
        StatusCode::CREATED,
    )
    .await;
    send_status(
        &app,
        "DELETE",
        &format!(
            "/api/v1/organizations/{second_organization_id}/invitations/{}",
            revoked_invitation["id"]
        ),
        owner_token,
        StatusCode::NO_CONTENT,
    )
    .await;
    let revoked_accept = app
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/invitations/accept",
            None,
            json!({
                "token": revoked_invitation["token"],
                "display_name": "Revoked",
                "password": "revoked secure password"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(revoked_accept.status(), StatusCode::UNAUTHORIZED);
}
