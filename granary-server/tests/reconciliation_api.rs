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
            "email": "reconcile@example.test",
            "display_name": "Reconcile Owner",
            "password": "correct horse battery staple"
        }),
        StatusCode::CREATED,
    )
    .await
}

async fn dimensions(app: &Router, token: &str, book_id: i64, suffix: &str) -> (Value, Value) {
    let account = send(
        app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts"),
        Some(token),
        json!({
            "name": format!("Statement Account {suffix}"),
            "class": "asset",
            "role": "bank",
            "currency_code": "CNY"
        }),
        StatusCode::CREATED,
    )
    .await;
    let category = send(
        app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        Some(token),
        json!({
            "name": format!("Statement Expense {suffix}"),
            "kind": "expense",
            "parent_id": null
        }),
        StatusCode::CREATED,
    )
    .await;
    (account, category)
}

async fn withdrawal(
    app: &Router,
    token: &str,
    book_id: i64,
    account_id: &Value,
    category_id: &Value,
    amount: &str,
) -> Value {
    send(
        app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        Some(token),
        json!({
            "type": "withdrawal",
            "occurred_at": "2026-07-20T10:00:00Z",
            "description": format!("Statement charge {amount}"),
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

fn account_posting_id(transaction: &Value, account_id: &Value) -> i64 {
    transaction["postings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|posting| posting["account_id"] == *account_id)
        .unwrap()["id"]
        .as_i64()
        .unwrap()
}

fn decimal(value: &Value) -> Decimal {
    value.as_str().unwrap().parse().unwrap()
}

#[sqlx::test(migrations = "./migrations")]
async fn balanced_reconciliation_can_be_updated_completed_and_filtered(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app).await;
    let token = initialized["personal_access_token"].as_str().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();
    let (account, category) = dimensions(&app, token, book_id, "A").await;
    let transaction = withdrawal(&app, token, book_id, &account["id"], &category["id"], "30").await;
    let posting_id = account_posting_id(&transaction, &account["id"]);
    let created = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/reconciliations"),
        Some(token),
        json!({
            "account_id": account["id"],
            "statement_ending_at": "2026-07-31T23:59:59Z",
            "statement_balance": "-30",
            "posting_ids": [posting_id],
            "notes": "July statement"
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(created["status"], "draft");
    assert_eq!(decimal(&created["selected_total"]), Decimal::from(-30));
    assert_eq!(decimal(&created["difference"]), Decimal::ZERO);

    let duplicate_draft = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/reconciliations"),
        Some(token),
        json!({
            "account_id": account["id"],
            "statement_ending_at": "2026-08-31T23:59:59Z",
            "statement_balance": "-30",
            "posting_ids": []
        }),
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(duplicate_draft["error"]["code"], "duplicate");

    let updated = send(
        &app,
        "PUT",
        &format!("/api/v1/books/{book_id}/reconciliations/{}", created["id"]),
        Some(token),
        json!({
            "version": 1,
            "statement_ending_at": "2026-07-31T23:59:59Z",
            "statement_balance": "-30",
            "posting_ids": [posting_id],
            "notes": "July statement verified"
        }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(updated["version"], 2);
    assert_eq!(updated["notes"], "July statement verified");

    let completed = send(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/reconciliations/{}/complete",
            created["id"]
        ),
        Some(token),
        json!({
            "version": 2,
            "create_adjustment": false,
            "reason": "Statement matches"
        }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["version"], 3);
    assert!(completed["completed_at"].is_string());
    assert!(completed["adjustment_journal_id"].is_null());
    assert_eq!(decimal(&completed["difference"]), Decimal::ZERO);

    let posting_state = sqlx::query_as::<_, (i64, bool)>(
        "SELECT reconciliation_id, cleared_at IS NOT NULL FROM postings WHERE id = $1",
    )
    .bind(posting_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(posting_state, (created["id"].as_i64().unwrap(), true));
    let completed_list = send(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/reconciliations?status=completed"),
        Some(token),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(completed_list.as_array().unwrap().len(), 1);
    let immutable =
        sqlx::query("UPDATE account_reconciliations SET statement_balance = 0 WHERE id = $1")
            .bind(created["id"].as_i64().unwrap())
            .execute(&pool)
            .await
            .unwrap_err();
    assert_eq!(
        immutable.as_database_error().unwrap().code().as_deref(),
        Some("55000")
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn reconciliation_difference_requires_explicit_adjustment_and_draft_cancel_releases_postings(
    pool: PgPool,
) {
    let app = http::router(pool.clone(), &config());
    let initialized = bootstrap(&app).await;
    let token = initialized["personal_access_token"].as_str().unwrap();
    let book_id = initialized["book_id"].as_i64().unwrap();
    let (account, category) = dimensions(&app, token, book_id, "B").await;
    let transaction = withdrawal(&app, token, book_id, &account["id"], &category["id"], "40").await;
    let posting_id = account_posting_id(&transaction, &account["id"]);
    let reconciliation = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/reconciliations"),
        Some(token),
        json!({
            "account_id": account["id"],
            "statement_ending_at": "2026-07-31T23:59:59Z",
            "statement_balance": "-45",
            "posting_ids": [posting_id]
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(decimal(&reconciliation["difference"]), Decimal::from(-5));
    let unbalanced = send(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/reconciliations/{}/complete",
            reconciliation["id"]
        ),
        Some(token),
        json!({
            "version": 1,
            "create_adjustment": false,
            "reason": "Must not finish silently"
        }),
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(unbalanced["error"]["code"], "reconciliation_not_balanced");
    let completed = send(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/reconciliations/{}/complete",
            reconciliation["id"]
        ),
        Some(token),
        json!({
            "version": 1,
            "create_adjustment": true,
            "reason": "Bank statement includes a five yuan correction"
        }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(completed["status"], "completed");
    assert_eq!(decimal(&completed["difference"]), Decimal::ZERO);
    assert!(completed["adjustment_journal_id"].is_number());
    assert_eq!(
        completed["selected_posting_ids"].as_array().unwrap().len(),
        2
    );
    let adjustment = sqlx::query_as::<_, (Decimal, Decimal, String)>(
        r#"
        SELECT p.amount, p.book_amount, j.status
        FROM postings p
        JOIN journal_entries j ON j.id = p.journal_entry_id
        WHERE j.id = $1 AND p.account_id = $2
        "#,
    )
    .bind(completed["adjustment_journal_id"].as_i64().unwrap())
    .bind(account["id"].as_i64().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        adjustment,
        (Decimal::from(-5), Decimal::from(-5), "posted".to_owned())
    );

    let new_transaction =
        withdrawal(&app, token, book_id, &account["id"], &category["id"], "10").await;
    let new_posting_id = account_posting_id(&new_transaction, &account["id"]);
    let draft = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/reconciliations"),
        Some(token),
        json!({
            "account_id": account["id"],
            "statement_ending_at": "2026-08-31T23:59:59Z",
            "statement_balance": "-55",
            "posting_ids": [new_posting_id]
        }),
        StatusCode::CREATED,
    )
    .await;
    send(
        &app,
        "DELETE",
        &format!(
            "/api/v1/books/{book_id}/reconciliations/{}?version=1",
            draft["id"]
        ),
        Some(token),
        Value::Null,
        StatusCode::NO_CONTENT,
    )
    .await;
    let released = sqlx::query_as::<_, (Option<i64>, Option<time::OffsetDateTime>)>(
        "SELECT reconciliation_id, cleared_at FROM postings WHERE id = $1",
    )
    .bind(new_posting_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(released, (None, None));
    let detached_clear = sqlx::query("UPDATE postings SET cleared_at = now() WHERE id = $1")
        .bind(new_posting_id)
        .execute(&pool)
        .await
        .unwrap_err();
    assert_eq!(
        detached_clear
            .as_database_error()
            .unwrap()
            .code()
            .as_deref(),
        Some("23514")
    );
}
