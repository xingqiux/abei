use std::{process, str::FromStr, time::SystemTime};

use granary_server::firefly_import::inspect_firefly;
use sqlx::{Connection, PgConnection, postgres::PgConnectOptions};

#[sqlx::test(migrations = "./migrations")]
async fn inventory_uses_only_aggregate_source_values(_pool: sqlx::PgPool) {
    let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is set by test runner");
    let base_options = PgConnectOptions::from_str(&database_url).unwrap();
    let suffix = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let database_name = format!("firefly_fixture_{}_{}", process::id(), suffix);
    let mut admin = PgConnection::connect_with(&base_options.clone().database("postgres"))
        .await
        .unwrap();
    sqlx::query(&format!("CREATE DATABASE {database_name}"))
        .execute(&mut admin)
        .await
        .unwrap();

    let mut source = PgConnection::connect_with(&base_options.clone().database(&database_name))
        .await
        .unwrap();
    sqlx::raw_sql(
        r#"
        CREATE TABLE users (id bigint PRIMARY KEY);
        CREATE TABLE account_types (id bigint PRIMARY KEY, type text);
        CREATE TABLE accounts (
            id bigint PRIMARY KEY,
            account_type_id bigint,
            name text,
            deleted_at timestamptz
        );
        CREATE TABLE attachments (id bigint PRIMARY KEY);
        CREATE TABLE audit_log_entries (id bigint PRIMARY KEY);
        CREATE TABLE bill_artifacts (id bigint PRIMARY KEY);
        CREATE TABLE bill_mail_messages (id bigint PRIMARY KEY);
        CREATE TABLE bill_secret_challenges (id bigint PRIMARY KEY);
        CREATE TABLE bill_statement_imports (id bigint PRIMARY KEY);
        CREATE TABLE bill_statement_rows (id bigint PRIMARY KEY);
        CREATE TABLE bill_task_events (id bigint PRIMARY KEY);
        CREATE TABLE bill_tasks (id bigint PRIMARY KEY);
        CREATE TABLE budget_limits (id bigint PRIMARY KEY);
        CREATE TABLE budgets (id bigint PRIMARY KEY);
        CREATE TABLE categories (id bigint PRIMARY KEY);
        CREATE TABLE category_transaction_journal (
            category_id bigint,
            transaction_journal_id bigint
        );
        CREATE TABLE notes (id bigint PRIMARY KEY);
        CREATE TABLE tag_transaction_journal (tag_id bigint, transaction_journal_id bigint);
        CREATE TABLE tags (id bigint PRIMARY KEY);
        CREATE TABLE transaction_currencies (id bigint PRIMARY KEY, code text);
        CREATE TABLE transaction_groups (
            id bigint PRIMARY KEY,
            deleted_at timestamptz
        );
        CREATE TABLE transaction_types (id bigint PRIMARY KEY, type text);
        CREATE TABLE transaction_journals (
            id bigint PRIMARY KEY,
            transaction_type_id bigint,
            transaction_currency_id bigint,
            transaction_group_id bigint,
            deleted_at timestamptz,
            updated_at timestamptz
        );
        CREATE TABLE transactions (
            id bigint PRIMARY KEY,
            transaction_journal_id bigint,
            deleted_at timestamptz,
            amount numeric,
            foreign_amount numeric,
            foreign_currency_id bigint,
            reconciled smallint
        );

        INSERT INTO users VALUES (1);
        INSERT INTO account_types VALUES (1, 'Asset account'), (2, 'Expense account');
        INSERT INTO accounts VALUES (1, 1, 'Checking', NULL), (2, 2, 'Merchant', NULL);
        INSERT INTO categories VALUES (1);
        INSERT INTO tags VALUES (1);
        INSERT INTO transaction_currencies VALUES (1, 'CNY');
        INSERT INTO transaction_groups VALUES (1, NULL);
        INSERT INTO transaction_types VALUES (1, 'Withdrawal');
        INSERT INTO transaction_journals VALUES (1, 1, 1, 1, NULL, '2026-07-22T00:00:00Z');
        INSERT INTO transactions VALUES
            (1, 1, NULL, -25.50, NULL, NULL, 0),
            (2, 1, NULL, 25.50, NULL, NULL, 0);
        INSERT INTO category_transaction_journal VALUES (1, 1);
        INSERT INTO tag_transaction_journal VALUES (1, 1);
        "#,
    )
    .execute(&mut source)
    .await
    .unwrap();

    let inventory = inspect_firefly(&mut source).await.unwrap();
    assert!(inventory.core_import_ready);
    assert!(!inventory.contains_personal_values);
    assert_eq!(inventory.counts.transaction_journals, 1);
    assert_eq!(inventory.counts.postings, 2);
    assert_eq!(inventory.used_currencies[0].name, "CNY");

    let json = serde_json::to_string(&inventory).unwrap();
    assert!(!json.contains("account_name"));
    assert!(!json.contains("description"));
    assert!(!json.contains("email"));
    assert!(!json.contains("filename"));

    source.close().await.unwrap();
    sqlx::query(&format!("DROP DATABASE {database_name}"))
        .execute(&mut admin)
        .await
        .unwrap();
}
