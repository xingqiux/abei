use axum::{
    body::Body,
    http::{Request, StatusCode, header},
};
use granary_server::{config::Config, http};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::{
    io::{BufRead, BufReader, Write},
    net::TcpStream,
    time::Duration,
};
use totp_rs::{Algorithm, Secret, TOTP};
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
        smtp_port: std::env::var("GRANARY_TEST_SMTP_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(13026),
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

fn bearer_json_request(method: &str, uri: &str, token: &str, body: Value) -> Request<Body> {
    let mut request = json_request(method, uri, body);
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {token}").parse().unwrap(),
    );
    request
}

fn session_json_request(
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

fn read_imap_response(reader: &mut BufReader<TcpStream>, tag: &str) -> String {
    let mut response = String::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "IMAP connection closed before {tag}");
        response.push_str(&line);
        if line.starts_with(tag) {
            return response;
        }
    }
}

fn latest_mail() -> String {
    let port = std::env::var("GRANARY_TEST_IMAP_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(13144);
    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    let mut greeting = String::new();
    reader.read_line(&mut greeting).unwrap();
    assert!(greeting.starts_with("* OK"));

    writer
        .write_all(b"a1 LOGIN bills bills-local-only\r\n")
        .unwrap();
    assert!(read_imap_response(&mut reader, "a1 ").contains("a1 OK"));
    writer.write_all(b"a2 SELECT INBOX\r\n").unwrap();
    assert!(read_imap_response(&mut reader, "a2 ").contains("a2 OK"));
    writer.write_all(b"a3 SEARCH ALL\r\n").unwrap();
    let search = read_imap_response(&mut reader, "a3 ");
    let message_id = search
        .lines()
        .find_map(|line| line.strip_prefix("* SEARCH "))
        .and_then(|ids| ids.split_whitespace().last())
        .expect("password reset email was not delivered");
    writer
        .write_all(format!("a4 FETCH {message_id} BODY[]\r\n").as_bytes())
        .unwrap();
    read_imap_response(&mut reader, "a4 ")
}

#[sqlx::test(migrations = "./migrations")]
async fn bootstrap_pat_session_and_csrf_form_a_complete_auth_path(pool: PgPool) {
    let app = http::router(pool, &config());
    let bootstrap_body = json!({
        "email": "owner@example.test",
        "display_name": "Owner",
        "password": "correct horse battery staple"
    });
    let bootstrap = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/bootstrap",
            bootstrap_body.clone(),
        ))
        .await
        .unwrap();
    assert_eq!(bootstrap.status(), StatusCode::CREATED);
    let bootstrap_json = response_json(bootstrap).await;
    let pat = bootstrap_json["personal_access_token"]
        .as_str()
        .unwrap()
        .to_owned();
    let book_id = bootstrap_json["book_id"].as_i64().unwrap();
    assert!(pat.starts_with("grn_pat_"));

    let repeated = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/bootstrap",
            bootstrap_body,
        ))
        .await
        .unwrap();
    assert_eq!(repeated.status(), StatusCode::CONFLICT);

    let pat_me = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/me")
                .header(header::AUTHORIZATION, format!("Bearer {pat}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(pat_me.status(), StatusCode::OK);

    let limited = app
        .clone()
        .oneshot(bearer_json_request(
            "POST",
            "/api/v1/auth/pats",
            &pat,
            json!({
                "name": "read-only",
                "scopes": ["books:read"],
                "expires_at": null
            }),
        ))
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::CREATED);
    let limited = response_json(limited).await;
    let limited_id = limited["id"].as_i64().unwrap();
    let limited_token = limited["token"].as_str().unwrap();

    let books = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/books")
                .header(header::AUTHORIZATION, format!("Bearer {limited_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(books.status(), StatusCode::OK);
    let denied_write = app
        .clone()
        .oneshot(bearer_json_request(
            "POST",
            &format!("/api/v1/books/{book_id}/accounts"),
            limited_token,
            json!({
                "name": "denied",
                "class": "asset",
                "role": "cash",
                "currency_code": "CNY"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(denied_write.status(), StatusCode::FORBIDDEN);
    let denied_profile = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/me")
                .header(header::AUTHORIZATION, format!("Bearer {limited_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied_profile.status(), StatusCode::FORBIDDEN);

    let pats = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/auth/pats")
                .header(header::AUTHORIZATION, format!("Bearer {pat}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(pats.status(), StatusCode::OK);
    let pats = response_json(pats).await;
    assert_eq!(pats.as_array().unwrap().len(), 2);
    assert!(pats[0].get("token").is_none());

    let revoked = app
        .clone()
        .oneshot(bearer_json_request(
            "DELETE",
            &format!("/api/v1/auth/pats/{limited_id}"),
            &pat,
            Value::Null,
        ))
        .await
        .unwrap();
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    let revoked_use = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/books")
                .header(header::AUTHORIZATION, format!("Bearer {limited_token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(revoked_use.status(), StatusCode::UNAUTHORIZED);

    let login = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/login",
            json!({
                "email": "owner@example.test",
                "password": "correct horse battery staple"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = login
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let login_json = response_json(login).await;
    let csrf = login_json["csrf_token"].as_str().unwrap();

    let session_me = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/me")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(session_me.status(), StatusCode::OK);

    let missing_csrf = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/logout")
                .header(header::COOKIE, &cookie)
                .header(header::ORIGIN, "http://localhost:18002")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_csrf.status(), StatusCode::FORBIDDEN);

    let logout = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/auth/logout")
                .header(header::COOKIE, cookie)
                .header(header::ORIGIN, "http://localhost:18002")
                .header("x-csrf-token", csrf)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(logout.status(), StatusCode::NO_CONTENT);
}

#[sqlx::test(migrations = "./migrations")]
async fn totp_mfa_recovery_and_credential_invalidation_form_a_complete_path(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let bootstrap = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/bootstrap",
            json!({
                "email": "owner@example.test",
                "display_name": "Owner",
                "password": "correct horse battery staple"
            }),
        ))
        .await
        .unwrap();
    let bootstrap = response_json(bootstrap).await;
    let bootstrap_pat = bootstrap["personal_access_token"].as_str().unwrap();

    let login = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/login",
            json!({
                "email": "owner@example.test",
                "password": "correct horse battery staple"
            }),
        ))
        .await
        .unwrap();
    let cookie = login
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let login = response_json(login).await;
    let csrf = login["csrf_token"].as_str().unwrap();

    let setup = app
        .clone()
        .oneshot(session_json_request(
            "POST",
            "/api/v1/auth/mfa/setup",
            &cookie,
            csrf,
            json!({"password": "correct horse battery staple"}),
        ))
        .await
        .unwrap();
    assert_eq!(setup.status(), StatusCode::OK);
    let setup = response_json(setup).await;
    let secret = setup["secret"].as_str().unwrap();
    assert!(
        setup["otpauth_url"]
            .as_str()
            .unwrap()
            .starts_with("otpauth://totp/")
    );
    let totp = TOTP::new(
        Algorithm::SHA1,
        6,
        1,
        30,
        Secret::Encoded(secret.to_owned()).to_bytes().unwrap(),
        Some("Granary".to_owned()),
        "owner@example.test".to_owned(),
    )
    .unwrap();
    let code = totp.generate_current().unwrap();

    let stored =
        sqlx::query_as::<_, (Vec<u8>, Vec<u8>)>("SELECT encrypted_secret, nonce FROM user_mfa")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_ne!(
        stored.0,
        Secret::Encoded(secret.to_owned()).to_bytes().unwrap()
    );
    assert_eq!(stored.1.len(), 12);

    let confirm = app
        .clone()
        .oneshot(session_json_request(
            "POST",
            "/api/v1/auth/mfa/confirm",
            &cookie,
            csrf,
            json!({"code": code}),
        ))
        .await
        .unwrap();
    assert_eq!(confirm.status(), StatusCode::OK);
    let confirm = response_json(confirm).await;
    let recovery_code = confirm["recovery_codes"][0].as_str().unwrap().to_owned();
    assert_eq!(confirm["recovery_codes"].as_array().unwrap().len(), 10);

    let old_pat = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/me")
                .header(header::AUTHORIZATION, format!("Bearer {bootstrap_pat}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(old_pat.status(), StatusCode::UNAUTHORIZED);

    let login = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/login",
            json!({
                "email": "owner@example.test",
                "password": "correct horse battery staple"
            }),
        ))
        .await
        .unwrap();
    assert!(login.headers().get(header::SET_COOKIE).is_none());
    let login = response_json(login).await;
    assert_eq!(login["mfa_required"], true);
    let challenge = login["mfa_challenge_token"].as_str().unwrap();
    let verified = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/mfa/verify-login",
            json!({
                "challenge_token": challenge,
                "code": totp.generate_current().unwrap()
            }),
        ))
        .await
        .unwrap();
    assert_eq!(verified.status(), StatusCode::OK);

    let recovery_login = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/login",
            json!({
                "email": "owner@example.test",
                "password": "correct horse battery staple"
            }),
        ))
        .await
        .unwrap();
    let recovery_login = response_json(recovery_login).await;
    let recovery_challenge = recovery_login["mfa_challenge_token"].as_str().unwrap();
    let recovery_verified = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/mfa/verify-login",
            json!({
                "challenge_token": recovery_challenge,
                "code": recovery_code
            }),
        ))
        .await
        .unwrap();
    assert_eq!(recovery_verified.status(), StatusCode::OK);

    let replay_login = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/login",
            json!({
                "email": "owner@example.test",
                "password": "correct horse battery staple"
            }),
        ))
        .await
        .unwrap();
    let replay_login = response_json(replay_login).await;
    let replay = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/mfa/verify-login",
            json!({
                "challenge_token": replay_login["mfa_challenge_token"],
                "code": recovery_code
            }),
        ))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

    let final_login = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/login",
            json!({
                "email": "owner@example.test",
                "password": "correct horse battery staple"
            }),
        ))
        .await
        .unwrap();
    let final_login = response_json(final_login).await;
    let verified = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/mfa/verify-login",
            json!({
                "challenge_token": final_login["mfa_challenge_token"],
                "code": totp.generate_current().unwrap()
            }),
        ))
        .await
        .unwrap();
    let cookie = verified
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let verified = response_json(verified).await;
    let csrf = verified["csrf_token"].as_str().unwrap();
    let disabled = app
        .clone()
        .oneshot(session_json_request(
            "DELETE",
            "/api/v1/auth/mfa",
            &cookie,
            csrf,
            json!({
                "password": "correct horse battery staple",
                "code": totp.generate_current().unwrap()
            }),
        ))
        .await
        .unwrap();
    assert_eq!(disabled.status(), StatusCode::NO_CONTENT);

    let normal_login = app
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/login",
            json!({
                "email": "owner@example.test",
                "password": "correct horse battery staple"
            }),
        ))
        .await
        .unwrap();
    let normal_login = response_json(normal_login).await;
    assert_eq!(normal_login["mfa_required"], false);
    assert!(normal_login["csrf_token"].is_string());
}

#[sqlx::test(migrations = "./migrations")]
async fn password_reset_is_delivered_over_smtp_and_invalidates_credentials(pool: PgPool) {
    let app = http::router(pool.clone(), &config());
    let bootstrap = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/bootstrap",
            json!({
                "email": "bills@localhost",
                "display_name": "Bills",
                "password": "correct horse battery staple"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(bootstrap.status(), StatusCode::CREATED);
    let bootstrap = response_json(bootstrap).await;
    let user_id = bootstrap["user_id"].as_i64().unwrap();
    let pat = bootstrap["personal_access_token"].as_str().unwrap();

    let requested = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/password-reset/request",
            json!({"email": "bills@localhost"}),
        ))
        .await
        .unwrap();
    assert_eq!(requested.status(), StatusCode::ACCEPTED);
    let unknown = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/password-reset/request",
            json!({"email": "unknown@example.test"}),
        ))
        .await
        .unwrap();
    assert_eq!(unknown.status(), StatusCode::ACCEPTED);

    let mail = tokio::task::spawn_blocking(latest_mail)
        .await
        .unwrap()
        .replace("=\r\n", "")
        .replace("=3D", "=");
    let token_start = mail.find("?token=").unwrap() + "?token=".len();
    let token = mail[token_start..]
        .split_whitespace()
        .next()
        .unwrap()
        .trim_end_matches('\r')
        .to_owned();
    assert!(token.starts_with("grn_reset_"));
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM password_reset_tokens")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );

    let requested_again = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/password-reset/request",
            json!({"email": "bills@localhost"}),
        ))
        .await
        .unwrap();
    assert_eq!(requested_again.status(), StatusCode::ACCEPTED);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM password_reset_tokens")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );

    sqlx::query(
        "INSERT INTO user_mfa (user_id, encrypted_secret, nonce, enabled_at) VALUES ($1, $2, $3, now())",
    )
    .bind(user_id)
    .bind(vec![1_u8; 32])
    .bind(vec![2_u8; 12])
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)")
        .bind(user_id)
        .bind(vec![3_u8; 32])
        .execute(&pool)
        .await
        .unwrap();

    let reset = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/password-reset/confirm",
            json!({
                "token": token,
                "password": "new secure password value"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(reset.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM user_mfa WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );

    let old_pat = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/v1/me")
                .header(header::AUTHORIZATION, format!("Bearer {pat}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(old_pat.status(), StatusCode::UNAUTHORIZED);
    let old_password = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/login",
            json!({
                "email": "bills@localhost",
                "password": "correct horse battery staple"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(old_password.status(), StatusCode::UNAUTHORIZED);
    let new_password = app
        .clone()
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/login",
            json!({
                "email": "bills@localhost",
                "password": "new secure password value"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(new_password.status(), StatusCode::OK);

    let replay = app
        .oneshot(json_request(
            "POST",
            "/api/v1/auth/password-reset/confirm",
            json!({
                "token": token,
                "password": "another secure password"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
}
