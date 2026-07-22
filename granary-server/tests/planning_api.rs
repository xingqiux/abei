use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use granary_server::{config::Config, http};
use http_body_util::BodyExt;
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

fn request(method: &str, uri: &str, token: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, "http://localhost:18002")
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

async fn send(
    app: &axum::Router,
    method: &str,
    uri: &str,
    token: &str,
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

async fn bootstrap(app: &axum::Router) -> Value {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/bootstrap")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::ORIGIN, "http://localhost:18002")
                .body(Body::from(
                    json!({
                        "email": "owner@example.test",
                        "display_name": "Owner",
                        "password": "correct-horse-battery-staple"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response_json(response).await
}

async fn create_tag(app: &axum::Router, book_id: i64, token: &str, name: &str) -> Value {
    send(
        app,
        "POST",
        &format!("/api/v1/books/{book_id}/tags"),
        token,
        json!({ "name": name, "color": "#1a2b3c" }),
        StatusCode::CREATED,
    )
    .await
}

async fn create_budget(app: &axum::Router, book_id: i64, token: &str, name: &str) -> Value {
    send(
        app,
        "POST",
        &format!("/api/v1/books/{book_id}/budgets"),
        token,
        json!({ "name": name, "color": "#d97706" }),
        StatusCode::CREATED,
    )
    .await
}

#[sqlx::test(migrations = "./migrations")]
async fn tags_budgets_and_month_limits_have_versioned_soft_delete_lifecycles(pool: PgPool) {
    let app = http::router(pool, &config());
    let bootstrap = bootstrap(&app).await;
    let token = bootstrap["personal_access_token"].as_str().unwrap();
    let book_id = bootstrap["book_id"].as_i64().unwrap();

    let tag = create_tag(&app, book_id, token, "Travel").await;
    let tag_id = tag["id"].as_i64().unwrap();
    assert_eq!(tag["color"], "#1A2B3C");
    let tag = send(
        &app,
        "PUT",
        &format!("/api/v1/books/{book_id}/tags/{tag_id}"),
        token,
        json!({ "name": "Business Travel", "color": null, "version": 1 }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(tag["version"], 2);
    send(
        &app,
        "PUT",
        &format!("/api/v1/books/{book_id}/tags/{tag_id}"),
        token,
        json!({ "name": "Stale", "color": null, "version": 1 }),
        StatusCode::CONFLICT,
    )
    .await;
    send(
        &app,
        "DELETE",
        &format!("/api/v1/books/{book_id}/tags/{tag_id}?version=2"),
        token,
        json!(null),
        StatusCode::NO_CONTENT,
    )
    .await;
    let archived_tags = send(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/tags?archived=true"),
        token,
        json!(null),
        StatusCode::OK,
    )
    .await;
    assert_eq!(archived_tags[0]["version"], 3);
    send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/tags/{tag_id}/restore?version=3"),
        token,
        json!(null),
        StatusCode::NO_CONTENT,
    )
    .await;

    let budget = create_budget(&app, book_id, token, "Monthly Living").await;
    let budget_id = budget["id"].as_i64().unwrap();
    let limit = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/budgets/{budget_id}/limits"),
        token,
        json!({ "month": "2026-08", "amount": "1000.00" }),
        StatusCode::CREATED,
    )
    .await;
    let limit_id = limit["id"].as_i64().unwrap();
    assert_eq!(limit["amount"], "1000");
    let limit = send(
        &app,
        "PUT",
        &format!("/api/v1/books/{book_id}/budgets/{budget_id}/limits/{limit_id}"),
        token,
        json!({ "month": "2026-08", "amount": "1200", "version": 1 }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(limit["version"], 2);
    send(
        &app,
        "DELETE",
        &format!("/api/v1/books/{book_id}/budgets/{budget_id}/limits/{limit_id}?version=2"),
        token,
        json!(null),
        StatusCode::NO_CONTENT,
    )
    .await;
    send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/budgets/{budget_id}/limits/{limit_id}/restore?version=3"),
        token,
        json!(null),
        StatusCode::NO_CONTENT,
    )
    .await;
    send(
        &app,
        "DELETE",
        &format!("/api/v1/books/{book_id}/budgets/{budget_id}?version=1"),
        token,
        json!(null),
        StatusCode::NO_CONTENT,
    )
    .await;
    let active_budgets = send(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/budgets"),
        token,
        json!(null),
        StatusCode::OK,
    )
    .await;
    assert!(active_budgets.as_array().unwrap().is_empty());
    send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/budgets/{budget_id}/restore?version=2"),
        token,
        json!(null),
        StatusCode::NO_CONTENT,
    )
    .await;
}

#[sqlx::test(migrations = "./migrations")]
async fn natural_month_reports_follow_book_timezone_and_reversal_recovery_chains(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let bootstrap = bootstrap(&app).await;
    let token = bootstrap["personal_access_token"].as_str().unwrap();
    let book_id = bootstrap["book_id"].as_i64().unwrap();

    let account = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts"),
        token,
        json!({
            "name": "Wallet", "class": "asset", "role": "cash", "currency_code": "CNY"
        }),
        StatusCode::CREATED,
    )
    .await;
    let account_id = account["id"].as_i64().unwrap();
    let category = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        token,
        json!({ "name": "Travel Expense", "kind": "expense", "parent_id": null }),
        StatusCode::CREATED,
    )
    .await;
    let category_id = category["id"].as_i64().unwrap();
    let tag = create_tag(&app, book_id, token, "Trip").await;
    let tag_id = tag["id"].as_i64().unwrap();
    let budget = create_budget(&app, book_id, token, "Travel Budget").await;
    let budget_id = budget["id"].as_i64().unwrap();
    send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/budgets/{budget_id}/limits"),
        token,
        json!({ "month": "2026-08", "amount": "100" }),
        StatusCode::CREATED,
    )
    .await;

    let transaction = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        token,
        json!({
            "type": "withdrawal",
            "occurred_at": "2026-07-31T16:30:00Z",
            "description": "Late dinner",
            "counterparty_id": null,
            "account_id": account_id,
            "amount": "80",
            "book_amount": "80",
            "splits": [{
                "category_id": category_id, "budget_id": budget_id,
                "amount": "80", "book_amount": "80", "memo": null
            }],
            "tag_ids": [tag_id]
        }),
        StatusCode::CREATED,
    )
    .await;
    let transaction_id = transaction["id"].as_i64().unwrap();
    assert_eq!(transaction["tags"][0]["id"], tag_id);
    assert_eq!(transaction["postings"][1]["budget_id"], budget_id);
    assert_eq!(transaction["postings"][1]["budget_name"], "Travel Budget");

    let july = send(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/budget-report?month=2026-07"),
        token,
        json!(null),
        StatusCode::OK,
    )
    .await;
    assert_eq!(july["items"][0]["actual_amount"], "0");
    let august = send(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/budget-report?month=2026-08"),
        token,
        json!(null),
        StatusCode::OK,
    )
    .await;
    assert_eq!(august["timezone"], "Asia/Shanghai");
    assert_eq!(august["items"][0]["actual_amount"], "80");
    assert_eq!(august["items"][0]["remaining_amount"], "20");
    assert_eq!(august["items"][0]["exceeded"], false);

    let reversed = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions/{transaction_id}/reverse"),
        token,
        json!({
            "occurred_at": "2026-08-02T00:00:00Z", "reason": "duplicate"
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(reversed["tags"][0]["id"], tag_id);
    assert_eq!(reversed["postings"][1]["budget_id"], budget_id);
    let after_reversal = send(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/budget-report?month=2026-08"),
        token,
        json!(null),
        StatusCode::OK,
    )
    .await;
    assert_eq!(after_reversal["items"][0]["actual_amount"], "0");

    let recyclable = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        token,
        json!({
            "type": "withdrawal",
            "occurred_at": "2026-08-03T00:00:00Z",
            "description": "Train",
            "counterparty_id": null,
            "account_id": account_id,
            "amount": "30",
            "book_amount": "30",
            "splits": [{
                "category_id": category_id, "budget_id": budget_id,
                "amount": "30", "book_amount": "30", "memo": null
            }],
            "tag_ids": [tag_id]
        }),
        StatusCode::CREATED,
    )
    .await;
    let recyclable_id = recyclable["id"].as_i64().unwrap();
    send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions/{recyclable_id}/trash"),
        token,
        json!({
            "occurred_at": "2026-08-04T00:00:00Z", "reason": "remove test transaction"
        }),
        StatusCode::CREATED,
    )
    .await;
    let after_trash = send(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/budget-report?month=2026-08"),
        token,
        json!(null),
        StatusCode::OK,
    )
    .await;
    assert_eq!(after_trash["items"][0]["actual_amount"], "0");
    let restored = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions/{recyclable_id}/restore"),
        token,
        json!({
            "occurred_at": "2026-08-05T00:00:00Z", "reason": "restore test transaction"
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(restored["tags"][0]["id"], tag_id);
    assert_eq!(restored["postings"][1]["budget_id"], budget_id);
    let after_restore = send(
        &app,
        "GET",
        &format!("/api/v1/books/{book_id}/budget-report?month=2026-08"),
        token,
        json!(null),
        StatusCode::OK,
    )
    .await;
    assert_eq!(after_restore["items"][0]["actual_amount"], "30");

    let links = sqlx::query_as::<_, (i64, i64)>(
        r#"
        SELECT count(DISTINCT jet.journal_entry_id), count(DISTINCT p.journal_entry_id)
        FROM journal_entry_tags jet
        JOIN postings p ON p.journal_entry_id = jet.journal_entry_id AND p.budget_id = $1
        WHERE jet.tag_id = $2
        "#,
    )
    .bind(budget_id)
    .bind(tag_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(links, (5, 5));
}

#[sqlx::test(migrations = "./migrations")]
async fn transaction_tags_and_budgets_cannot_cross_book_boundaries(pool: PgPool) {
    let app = http::router(pool, &config());
    let bootstrap = bootstrap(&app).await;
    let token = bootstrap["personal_access_token"].as_str().unwrap();
    let organization_id = bootstrap["organization_id"].as_i64().unwrap();
    let first_book_id = bootstrap["book_id"].as_i64().unwrap();
    let second_book = send(
        &app,
        "POST",
        &format!("/api/v1/organizations/{organization_id}/books"),
        token,
        json!({
            "name": "Second", "base_currency_code": "CNY", "timezone": "Asia/Shanghai"
        }),
        StatusCode::CREATED,
    )
    .await;
    let second_book_id = second_book["id"].as_i64().unwrap();
    let foreign_tag = create_tag(&app, first_book_id, token, "First Book Only").await;
    let foreign_budget = create_budget(&app, first_book_id, token, "First Budget Only").await;
    let account = send(
        &app,
        "POST",
        &format!("/api/v1/books/{second_book_id}/accounts"),
        token,
        json!({
            "name": "Second Wallet", "class": "asset", "role": "cash",
            "currency_code": "CNY"
        }),
        StatusCode::CREATED,
    )
    .await;
    let category = send(
        &app,
        "POST",
        &format!("/api/v1/books/{second_book_id}/categories"),
        token,
        json!({ "name": "Second Expense", "kind": "expense", "parent_id": null }),
        StatusCode::CREATED,
    )
    .await;
    let transaction = |tag_ids: Value, budget_id: Value| {
        json!({
            "type": "withdrawal",
            "occurred_at": "2026-08-03T00:00:00Z",
            "description": "Cross-book attempt",
            "counterparty_id": null,
            "account_id": account["id"],
            "amount": "10",
            "book_amount": "10",
            "splits": [{
                "category_id": category["id"], "budget_id": budget_id,
                "amount": "10", "book_amount": "10", "memo": null
            }],
            "tag_ids": tag_ids
        })
    };
    let bad_tag = send(
        &app,
        "POST",
        &format!("/api/v1/books/{second_book_id}/transactions"),
        token,
        transaction(json!([foreign_tag["id"]]), Value::Null),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(bad_tag["error"]["code"], "tag_invalid");
    let bad_budget = send(
        &app,
        "POST",
        &format!("/api/v1/books/{second_book_id}/transactions"),
        token,
        transaction(json!([]), foreign_budget["id"].clone()),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(bad_budget["error"]["code"], "budget_invalid");
}

#[sqlx::test(migrations = "./migrations")]
async fn reversals_preserve_archived_dimensions_but_new_clones_require_active_dimensions(
    pool: PgPool,
) {
    let app = http::router(pool, &config());
    let bootstrap = bootstrap(&app).await;
    let token = bootstrap["personal_access_token"].as_str().unwrap();
    let book_id = bootstrap["book_id"].as_i64().unwrap();
    let tag = create_tag(&app, book_id, token, "Historical Tag").await;
    let budget = create_budget(&app, book_id, token, "Historical Budget").await;
    let account = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/accounts"),
        token,
        json!({
            "name": "Historical Wallet", "class": "asset", "role": "cash",
            "currency_code": "CNY"
        }),
        StatusCode::CREATED,
    )
    .await;
    let category = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/categories"),
        token,
        json!({ "name": "Historical Expense", "kind": "expense", "parent_id": null }),
        StatusCode::CREATED,
    )
    .await;
    let transaction = send(
        &app,
        "POST",
        &format!("/api/v1/books/{book_id}/transactions"),
        token,
        json!({
            "type": "withdrawal",
            "occurred_at": "2026-08-03T00:00:00Z",
            "description": "Historical dimensions",
            "counterparty_id": null,
            "account_id": account["id"],
            "amount": "18",
            "book_amount": "18",
            "splits": [{
                "category_id": category["id"], "budget_id": budget["id"],
                "amount": "18", "book_amount": "18", "memo": null
            }],
            "tag_ids": [tag["id"]]
        }),
        StatusCode::CREATED,
    )
    .await;
    for uri in [
        format!(
            "/api/v1/books/{book_id}/categories/{}?version=1",
            category["id"]
        ),
        format!("/api/v1/books/{book_id}/tags/{}?version=1", tag["id"]),
        format!("/api/v1/books/{book_id}/budgets/{}?version=1", budget["id"]),
        format!(
            "/api/v1/books/{book_id}/accounts/{}?version=1",
            account["id"]
        ),
    ] {
        send(
            &app,
            "DELETE",
            &uri,
            token,
            Value::Null,
            StatusCode::NO_CONTENT,
        )
        .await;
    }

    let trashed = send(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/transactions/{}/trash",
            transaction["id"]
        ),
        token,
        json!({"reason": "archive-safe reversal"}),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(trashed["tags"][0]["id"], tag["id"]);
    assert_eq!(trashed["tags"][0]["archived"], true);
    assert_eq!(trashed["postings"][1]["budget_id"], budget["id"]);

    let restored = send(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/transactions/{}/restore",
            transaction["id"]
        ),
        token,
        json!({"reason": "archive-safe restoration"}),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(restored["tags"][0]["id"], tag["id"]);
    assert_eq!(restored["postings"][1]["budget_id"], budget["id"]);

    let clone = send(
        &app,
        "POST",
        &format!(
            "/api/v1/books/{book_id}/transactions/{}/clone",
            transaction["id"]
        ),
        token,
        json!({"description": "must not reuse archived dimensions"}),
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_eq!(clone["error"]["code"], "journal_invalid");
}
