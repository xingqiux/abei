use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use granary_server::{config::Config, http};
use http_body_util::BodyExt;
use rust_decimal::Decimal;
use serde_json::{Value, json};
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

fn request(method: &str, uri: &str, token: Option<&str>, body: Value) -> Request<Body> {
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

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

async fn send(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
    status: StatusCode,
) -> Value {
    let response = app
        .clone()
        .oneshot(request(method, uri, token, body))
        .await
        .unwrap();
    assert_eq!(response.status(), status, "{method} {uri}");
    if status == StatusCode::NO_CONTENT {
        Value::Null
    } else {
        response_json(response).await
    }
}

async fn bootstrap(app: &Router) -> Value {
    send(
        app,
        "POST",
        "/api/v1/auth/bootstrap",
        None,
        json!({
            "email": "links@example.test",
            "display_name": "Link Owner",
            "password": "correct horse battery staple"
        }),
        StatusCode::CREATED,
    )
    .await
}

async fn create_dimensions(
    app: &Router,
    token: &str,
    book_id: i64,
    prefix: &str,
) -> (Value, Value, Value) {
    let account = send(
        app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts"),
        Some(token),
        json!({
            "name": format!("{prefix} Account"),
            "class": "asset",
            "role": "bank",
            "currency_code": "CNY"
        }),
        StatusCode::CREATED,
    )
    .await;
    let expense = send(
        app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        Some(token),
        json!({
            "name": format!("{prefix} Expense"),
            "kind": "expense",
            "parent_id": null
        }),
        StatusCode::CREATED,
    )
    .await;
    let income = send(
        app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        Some(token),
        json!({
            "name": format!("{prefix} Income"),
            "kind": "income",
            "parent_id": null
        }),
        StatusCode::CREATED,
    )
    .await;
    (account, expense, income)
}

async fn withdrawal(
    app: &Router,
    token: &str,
    book_id: i64,
    account_id: &Value,
    category_id: &Value,
    description: &str,
    amount: &str,
) -> Value {
    send(
        app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        json!({
            "type": "withdrawal",
            "occurred_at": "2026-07-22T10:00:00Z",
            "description": description,
            "counterparty_id": null,
            "account_id": account_id,
            "amount": amount,
            "book_amount": amount,
            "splits": [{
                "category_id": category_id,
                "budget_id": null,
                "amount": amount,
                "book_amount": amount,
                "memo": null
            }],
            "tag_ids": []
        }),
        StatusCode::CREATED,
    )
    .await
}

async fn deposit(
    app: &Router,
    token: &str,
    book_id: i64,
    account_id: &Value,
    category_id: &Value,
    description: &str,
    amount: &str,
) -> Value {
    send(
        app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        json!({
            "type": "deposit",
            "occurred_at": "2026-07-23T10:00:00Z",
            "description": description,
            "counterparty_id": null,
            "account_id": account_id,
            "amount": amount,
            "book_amount": amount,
            "splits": [{
                "category_id": category_id,
                "budget_id": null,
                "amount": amount,
                "book_amount": amount,
                "memo": null
            }],
            "tag_ids": []
        }),
        StatusCode::CREATED,
    )
    .await
}

#[sqlx::test(migrations = "./migrations")]
async fn partial_refund_and_reimbursement_links_enforce_totals_and_restore_rules(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app).await;
    let token = initialized["personal_access_token"].as_str().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();
    let (account, expense, income) = create_dimensions(&app, token, book_id, "Main").await;
    let source = withdrawal(
        &app,
        token,
        book_id,
        &account["id"],
        &expense["id"],
        "Original expense",
        "100",
    )
    .await;
    let refund = deposit(
        &app,
        token,
        book_id,
        &account["id"],
        &income["id"],
        "Partial refund",
        "60",
    )
    .await;
    let reimbursement = deposit(
        &app,
        token,
        book_id,
        &account["id"],
        &income["id"],
        "Reimbursement",
        "50",
    )
    .await;
    let first = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transaction-links"),
        Some(token),
        json!({
            "kind": "refund",
            "source_transaction_id": source["id"],
            "target_transaction_id": refund["id"],
            "amount": "40"
        }),
        StatusCode::CREATED,
    )
    .await;
    let second = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transaction-links"),
        Some(token),
        json!({
            "kind": "reimbursement",
            "source_transaction_id": source["id"],
            "target_transaction_id": reimbursement["id"],
            "amount": "50"
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(
        first["amount"]
            .as_str()
            .unwrap()
            .parse::<Decimal>()
            .unwrap(),
        Decimal::from(40)
    );
    assert_eq!(second["kind"], "reimbursement");

    let source_exceeded = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transaction-links"),
        Some(token),
        json!({
            "kind": "refund",
            "source_transaction_id": source["id"],
            "target_transaction_id": refund["id"],
            "amount": "20"
        }),
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(
        source_exceeded["error"]["code"],
        "source_link_amount_exceeded"
    );

    let second_source = withdrawal(
        &app,
        token,
        book_id,
        &account["id"],
        &expense["id"],
        "Second expense",
        "100",
    )
    .await;
    let target_exceeded = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transaction-links"),
        Some(token),
        json!({
            "kind": "refund",
            "source_transaction_id": second_source["id"],
            "target_transaction_id": refund["id"],
            "amount": "30"
        }),
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(
        target_exceeded["error"]["code"],
        "target_link_amount_exceeded"
    );

    send(
        &app,
        "DELETE",
        &format!(
            "/api/v1/books/{book_id}/transaction-links/{}?version=1",
            first["id"]
        ),
        Some(token),
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;
    let replacement = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transaction-links"),
        Some(token),
        json!({
            "kind": "refund",
            "source_transaction_id": source["id"],
            "target_transaction_id": refund["id"],
            "amount": "50"
        }),
        StatusCode::CREATED,
    )
    .await;
    let restore_conflict = send(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/transaction-links/{}/restore?version=2",
            first["id"]
        ),
        Some(token),
        Value::Null,
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(
        restore_conflict["error"]["code"],
        "source_link_amount_exceeded"
    );
    send(
        &app,
        "DELETE",
        &format!(
            "/api/v1/books/{book_id}/transaction-links/{}?version=1",
            replacement["id"]
        ),
        Some(token),
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;
    send(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/transaction-links/{}/restore?version=2",
            first["id"]
        ),
        Some(token),
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;

    let related = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transaction-links"),
        Some(token),
        json!({
            "kind": "related",
            "source_transaction_id": source["id"],
            "target_transaction_id": refund["id"]
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(related["kind"], "related");
    let symmetric_duplicate = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transaction-links"),
        Some(token),
        json!({
            "kind": "related",
            "source_transaction_id": refund["id"],
            "target_transaction_id": source["id"]
        }),
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(symmetric_duplicate["error"]["code"], "duplicate");

    let active = send(
        &app,
        "GET",
        &format!(
            "/api/v1/books/{book_id}/transaction-links?transaction_id={}",
            source["id"]
        ),
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(active.as_array().unwrap().len(), 3);
    let deleted = send(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/transaction-links?deleted=true"),
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(deleted.as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn cross_book_transfer_links_require_the_fixed_kind_and_audit_both_books(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app).await;
    let token = initialized["personal_access_token"].as_str().unwrap();
    let organization_id = initialized["organization_id"].as_i64().unwrap();
    let source_book_id = initialized["book_id"].as_i64().unwrap();
    let target_book = send(
        &app,
        "POST",
        &format!("/api/v1/organizations/{organization_id}/books"),
        Some(token),
        json!({
            "name": "Target Book",
            "base_currency_code": "CNY",
            "timezone": "Asia/Shanghai"
        }),
        StatusCode::CREATED,
    )
    .await;
    let target_book_id = target_book["id"].as_i64().unwrap();
    let (source_account, source_expense, _) =
        create_dimensions(&app, token, source_book_id, "Source").await;
    let (target_account, _, target_income) =
        create_dimensions(&app, token, target_book_id, "Target").await;
    let source = withdrawal(
        &app,
        token,
        source_book_id,
        &source_account["id"],
        &source_expense["id"],
        "Move out",
        "88",
    )
    .await;
    let target = deposit(
        &app,
        token,
        target_book_id,
        &target_account["id"],
        &target_income["id"],
        "Move in",
        "88",
    )
    .await;

    let invalid = send(
        &app,
        "POST",
        &format!("/api/v1/books/{source_book_id}/transaction-links"),
        Some(token),
        json!({
            "kind": "related",
            "source_transaction_id": source["id"],
            "target_book_id": target_book_id,
            "target_transaction_id": target["id"]
        }),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(invalid["error"]["code"], "link_book_invalid");
    let link = send(
        &app,
        "POST",
        &format!("/api/v1/books/{source_book_id}/transaction-links"),
        Some(token),
        json!({
            "kind": "cross_book_transfer",
            "source_transaction_id": source["id"],
            "target_book_id": target_book_id,
            "target_transaction_id": target["id"]
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(link["source_book_id"], source_book_id);
    assert_eq!(link["target_book_id"], target_book_id);

    let from_target = send(
        &app,
        "GET",
        &format!(
            "/api/v1/books/{target_book_id}/transaction-links?transaction_id={}",
            target["id"]
        ),
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(from_target[0]["id"], link["id"]);
    let audits = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM audit_events WHERE entity_type = 'transaction_link' AND entity_id = $1 AND action = 'transaction_link.created'",
    )
    .bind(link["id"].as_i64().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(audits, 2);

    sqlx::query("DELETE FROM book_memberships WHERE book_id = $1 AND user_id = $2")
        .bind(target_book_id)
        .bind(initialized["user_id"].as_i64().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    let hidden_after_access_revocation = send(
        &app,
        "GET",
        &format!("/api/v1/books/{source_book_id}/transaction-links"),
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert!(
        hidden_after_access_revocation
            .as_array()
            .unwrap()
            .is_empty()
    );
}
