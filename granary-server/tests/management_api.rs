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

fn json_request(method: &str, uri: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, "http://localhost:18002")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn bearer_request(method: &str, uri: &str, token: &str, body: Value) -> Request<Body> {
    let mut request = json_request(method, uri, body);
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    request
}

fn session_request(
    method: &str,
    uri: &str,
    cookie: &str,
    csrf: &str,
    body: Value,
) -> Request<Body> {
    Request::builder()
        .method(method)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, "http://localhost:18002")
        .header(header::COOKIE, cookie)
        .header("x-csrf-token", csrf)
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

async fn bootstrap(app: &axum::Router) -> Value {
    let response = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/bootstrap",
            json!({
                "email": "owner@example.test",
                "display_name": "Owner",
                "password": "correct-horse-battery-staple"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response_json(response).await
}

async fn login(app: &axum::Router, email: &str, password: &str) -> (String, String) {
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ORIGIN, "http://localhost:18002")
        .header(header::USER_AGENT, "Granary Management Test/1.0")
        .body(Body::from(
            json!({ "email": email, "password": password }).to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let body = response_json(response).await;
    (cookie, body["csrf_token"].as_str().unwrap().to_owned())
}

#[sqlx::test(migrations = "./migrations")]
async fn sessions_can_be_inspected_and_revoked_without_losing_the_audit_record(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let bootstrap = bootstrap(&app).await;
    let pat = bootstrap["personal_access_token"].as_str().unwrap();
    let (cookie, _) = login(&app, "owner@example.test", "correct-horse-battery-staple").await;

    let sessions = app
        .clone()
        .oneshot(bearer_request(
            "GET",
            "/api/v1/auth/sessions",
            pat,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(sessions.status(), StatusCode::OK);
    let sessions = response_json(sessions).await;
    assert_eq!(sessions.as_array().unwrap().len(), 1);
    assert_eq!(sessions[0]["user_agent"], "Granary Management Test/1.0");
    assert_eq!(sessions[0]["current"], false);
    let session_id = sessions[0]["id"].as_i64().unwrap();

    let revoked = app
        .clone()
        .oneshot(bearer_request(
            "DELETE",
            &format!("/api/v1/auth/sessions/{session_id}"),
            pat,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);

    let stale_session = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/me")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale_session.status(), StatusCode::UNAUTHORIZED);
    let retained = sqlx::query_as::<_, (bool, Option<String>)>(
        "SELECT revoked_at IS NOT NULL, revoke_reason FROM user_sessions WHERE id = $1",
    )
    .bind(session_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(retained.0);
    assert_eq!(retained.1.as_deref(), Some("用户撤销"));
}

#[sqlx::test(migrations = "./migrations")]
async fn administrator_user_lifecycle_revokes_credentials_and_can_reset_mfa(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let bootstrap = bootstrap(&app).await;
    let owner_id = bootstrap["user_id"].as_i64().unwrap();
    let organization_id = bootstrap["organization_id"].as_i64().unwrap();
    let owner_pat = bootstrap["personal_access_token"].as_str().unwrap();

    let invitation = app
        .clone()
        .oneshot(bearer_request(
            "POST",
            &format!("/api/v1/organizations/{organization_id}/invitations"),
            owner_pat,
            json!({
                "email": "member@example.test",
                "organization_role": "member",
                "books": [],
                "expires_in_days": 7
            }),
        ))
        .await
        .unwrap();
    assert_eq!(invitation.status(), StatusCode::CREATED);
    let invitation_token = response_json(invitation).await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let accepted = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/invitations/accept",
            json!({
                "token": invitation_token,
                "display_name": "Member",
                "password": "member-password-long-enough"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(accepted.status(), StatusCode::CREATED);
    let member_id = response_json(accepted).await["user_id"].as_i64().unwrap();

    let (member_cookie, member_csrf) =
        login(&app, "member@example.test", "member-password-long-enough").await;
    let created_pat = app
        .clone()
        .oneshot(session_request(
            "POST",
            "/api/v1/auth/pats",
            &member_cookie,
            &member_csrf,
            json!({ "name": "Member CLI", "scopes": ["profile:read"] }),
        ))
        .await
        .unwrap();
    assert_eq!(created_pat.status(), StatusCode::CREATED);
    let member_pat = response_json(created_pat).await["token"]
        .as_str()
        .unwrap()
        .to_owned();

    let self_disable = app
        .clone()
        .oneshot(bearer_request(
            "POST",
            &format!("/api/v1/admin/users/{owner_id}/disable"),
            owner_pat,
            json!({ "reason": "must be rejected" }),
        ))
        .await
        .unwrap();
    assert_eq!(self_disable.status(), StatusCode::CONFLICT);

    let disabled = app
        .clone()
        .oneshot(bearer_request(
            "POST",
            &format!("/api/v1/admin/users/{member_id}/disable"),
            owner_pat,
            json!({ "reason": "security review" }),
        ))
        .await
        .unwrap();
    assert_eq!(disabled.status(), StatusCode::NO_CONTENT);

    for request in [
        Request::builder()
            .uri("/api/v1/me")
            .header(header::COOKIE, &member_cookie)
            .body(Body::empty())
            .unwrap(),
        Request::builder()
            .uri("/api/v1/me")
            .header(header::AUTHORIZATION, format!("Bearer {member_pat}"))
            .body(Body::empty())
            .unwrap(),
    ] {
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let login_while_disabled = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/login",
            json!({
                "email": "member@example.test",
                "password": "member-password-long-enough"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(login_while_disabled.status(), StatusCode::UNAUTHORIZED);

    let restored = app
        .clone()
        .oneshot(bearer_request(
            "POST",
            &format!("/api/v1/admin/users/{member_id}/restore"),
            owner_pat,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(restored.status(), StatusCode::NO_CONTENT);
    let (restored_cookie, _) =
        login(&app, "member@example.test", "member-password-long-enough").await;

    sqlx::query(
        "INSERT INTO user_mfa (user_id, encrypted_secret, nonce, enabled_at) VALUES ($1, $2, $3, now())",
    )
    .bind(member_id)
    .bind(vec![1_u8; 32])
    .bind(vec![2_u8; 12])
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)")
        .bind(member_id)
        .bind(vec![3_u8; 32])
        .execute(&pool)
        .await
        .unwrap();
    let reset = app
        .clone()
        .oneshot(bearer_request(
            "POST",
            &format!("/api/v1/admin/users/{member_id}/mfa/reset"),
            owner_pat,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(reset.status(), StatusCode::NO_CONTENT);
    let stale_after_reset = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/me")
                .header(header::COOKIE, restored_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale_after_reset.status(), StatusCode::UNAUTHORIZED);
    let mfa_rows = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM user_mfa WHERE user_id = $1")
        .bind(member_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(mfa_rows, 0);

    let users = app
        .clone()
        .oneshot(bearer_request(
            "GET",
            "/api/v1/admin/users?limit=1",
            owner_pat,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(users.status(), StatusCode::OK);
    let users = response_json(users).await;
    assert_eq!(users["items"].as_array().unwrap().len(), 1);
    assert!(users["next_after_id"].is_number());
}

#[sqlx::test(migrations = "./migrations")]
async fn organization_and_book_lifecycle_is_versioned_audited_and_recoverable(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let bootstrap = bootstrap(&app).await;
    let pat = bootstrap["personal_access_token"].as_str().unwrap();
    let organization_id = bootstrap["organization_id"].as_i64().unwrap();
    let book_id = bootstrap["book_id"].as_i64().unwrap();

    let updated_organization = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            &format!("/api/v1/organizations/{organization_id}"),
            pat,
            json!({ "name": "Family", "kind": "household", "version": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(updated_organization.status(), StatusCode::OK);
    assert_eq!(response_json(updated_organization).await["version"], 2);
    let stale_update = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            &format!("/api/v1/organizations/{organization_id}"),
            pat,
            json!({ "name": "Stale", "kind": "personal", "version": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(stale_update.status(), StatusCode::CONFLICT);

    let archived_organization = app
        .clone()
        .oneshot(bearer_request(
            "DELETE",
            &format!("/api/v1/organizations/{organization_id}?version=2"),
            pat,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(archived_organization.status(), StatusCode::NO_CONTENT);
    let active_books = app
        .clone()
        .oneshot(bearer_request("GET", "/api/v1/books", pat, json!(null)))
        .await
        .unwrap();
    assert!(
        response_json(active_books)
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    let archived_organizations = app
        .clone()
        .oneshot(bearer_request(
            "GET",
            "/api/v1/organizations?archived=true",
            pat,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(response_json(archived_organizations).await[0]["version"], 3);
    let restored_organization = app
        .clone()
        .oneshot(bearer_request(
            "POST",
            &format!("/api/v1/organizations/{organization_id}/restore?version=3"),
            pat,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(restored_organization.status(), StatusCode::NO_CONTENT);

    let invalid_timezone = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            &format!("/api/v1/books/{book_id}"),
            pat,
            json!({
                "name": "Primary", "base_currency_code": "HKD",
                "timezone": "not-a-timezone", "version": 1
            }),
        ))
        .await
        .unwrap();
    assert_eq!(invalid_timezone.status(), StatusCode::BAD_REQUEST);
    let updated_book = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            &format!("/api/v1/books/{book_id}"),
            pat,
            json!({
                "name": "Primary", "base_currency_code": "HKD",
                "timezone": "Asia/Hong_Kong", "version": 1
            }),
        ))
        .await
        .unwrap();
    assert_eq!(updated_book.status(), StatusCode::OK);
    let updated_book = response_json(updated_book).await;
    assert_eq!(updated_book["version"], 2);
    assert_eq!(updated_book["timezone"], "Asia/Hong_Kong");
    let system_currencies = sqlx::query_scalar::<_, String>(
        "SELECT DISTINCT currency_code FROM ledger_accounts WHERE book_id = $1 AND hidden",
    )
    .bind(book_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(system_currencies, vec!["HKD"]);

    let archived_book = app
        .clone()
        .oneshot(bearer_request(
            "DELETE",
            &format!("/api/v1/books/{book_id}?version=2"),
            pat,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(archived_book.status(), StatusCode::NO_CONTENT);
    let archived_books = app
        .clone()
        .oneshot(bearer_request(
            "GET",
            "/api/v1/books?archived=true",
            pat,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(response_json(archived_books).await[0]["version"], 3);
    let restored_book = app
        .clone()
        .oneshot(bearer_request(
            "POST",
            &format!("/api/v1/books/{book_id}/restore?version=3"),
            pat,
            json!(null),
        ))
        .await
        .unwrap();
    assert_eq!(restored_book.status(), StatusCode::NO_CONTENT);

    let actions = sqlx::query_scalar::<_, String>(
        r#"
        SELECT action FROM audit_events
        WHERE action IN (
            'organization.updated', 'organization.archived', 'organization.restored',
            'book.updated', 'book.archived', 'book.restored'
        )
        ORDER BY id
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(actions.len(), 6);
}

#[sqlx::test(migrations = "./migrations")]
async fn registration_policy_and_instance_admin_roles_are_enforced(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let before_bootstrap = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/instance")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(before_bootstrap.status(), StatusCode::OK);
    let before_bootstrap = response_json(before_bootstrap).await;
    assert_eq!(before_bootstrap["initialized"], false);
    assert_eq!(before_bootstrap["registration_mode"], "invite_only");

    let bootstrap = bootstrap(&app).await;
    let owner_id = bootstrap["user_id"].as_i64().unwrap();
    let owner_pat = bootstrap["personal_access_token"].as_str().unwrap();
    let closed_registration = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/register",
            json!({
                "email": "public@example.test",
                "display_name": "Public User",
                "password": "public-password-long-enough"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(closed_registration.status(), StatusCode::FORBIDDEN);

    let opened = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            "/api/v1/admin/instance/settings",
            owner_pat,
            json!({ "registration_mode": "open", "version": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    assert_eq!(response_json(opened).await["version"], 2);
    let stale_settings = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            "/api/v1/admin/instance/settings",
            owner_pat,
            json!({ "registration_mode": "invite_only", "version": 1 }),
        ))
        .await
        .unwrap();
    assert_eq!(stale_settings.status(), StatusCode::CONFLICT);

    let registered = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/register",
            json!({
                "email": "public@example.test",
                "display_name": "Public User",
                "password": "public-password-long-enough"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(registered.status(), StatusCode::CREATED);
    let registered_cookie = registered
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let registered = response_json(registered).await;
    let registered_id = registered["user_id"].as_i64().unwrap();
    let registered_csrf = registered["csrf_token"].as_str().unwrap();
    assert!(registered["organization_id"].is_number());
    assert!(registered["book_id"].is_number());

    let promoted = app
        .clone()
        .oneshot(bearer_request(
            "PUT",
            &format!("/api/v1/admin/users/{registered_id}/instance-admin"),
            owner_pat,
            json!({ "instance_admin": true }),
        ))
        .await
        .unwrap();
    assert_eq!(promoted.status(), StatusCode::NO_CONTENT);
    let admin_settings = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/admin/instance/settings")
                .header(header::COOKIE, &registered_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(admin_settings.status(), StatusCode::OK);

    let demoted_owner = app
        .clone()
        .oneshot(session_request(
            "PUT",
            &format!("/api/v1/admin/users/{owner_id}/instance-admin"),
            &registered_cookie,
            registered_csrf,
            json!({ "instance_admin": false }),
        ))
        .await
        .unwrap();
    assert_eq!(demoted_owner.status(), StatusCode::NO_CONTENT);
    let reject_last_admin = app
        .clone()
        .oneshot(session_request(
            "PUT",
            &format!("/api/v1/admin/users/{registered_id}/instance-admin"),
            &registered_cookie,
            registered_csrf,
            json!({ "instance_admin": false }),
        ))
        .await
        .unwrap();
    assert_eq!(reject_last_admin.status(), StatusCode::CONFLICT);

    let registered_workspace_count = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT count(*)
        FROM organizations o
        JOIN organization_memberships om ON om.organization_id = o.id
        JOIN books b ON b.organization_id = o.id
        JOIN book_memberships bm ON bm.book_id = b.id AND bm.user_id = om.user_id
        WHERE om.user_id = $1 AND om.role = 'owner' AND bm.role = 'manager'
        "#,
    )
    .bind(registered_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(registered_workspace_count, 1);
}
