use std::{process, str::FromStr, time::SystemTime};

use granary_server::firefly_import::{inspect_firefly, migrate_firefly};
use rust_decimal::Decimal;
use sqlx::{Connection, PgConnection, postgres::PgConnectOptions};

#[sqlx::test(migrations = "./migrations")]
async fn inventory_and_core_migration_preserve_balances_without_exposing_values(
    pool: sqlx::PgPool,
) {
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
            active smallint DEFAULT 1,
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
        CREATE TABLE categories (id bigint PRIMARY KEY, name text, deleted_at timestamptz);
        CREATE TABLE category_transaction_journal (
            category_id bigint,
            transaction_journal_id bigint
        );
        CREATE TABLE notes (
            id bigint PRIMARY KEY,
            noteable_id bigint,
            noteable_type text,
            title text,
            text text,
            deleted_at timestamptz
        );
        CREATE TABLE tag_transaction_journal (tag_id bigint, transaction_journal_id bigint);
        CREATE TABLE tags (id bigint PRIMARY KEY, tag text, deleted_at timestamptz);
        CREATE TABLE transaction_currencies (id bigint PRIMARY KEY, code text);
        CREATE TABLE transaction_groups (
            id bigint PRIMARY KEY,
            title text,
            deleted_at timestamptz
        );
        CREATE TABLE transaction_types (id bigint PRIMARY KEY, type text);
        CREATE TABLE transaction_journals (
            id bigint PRIMARY KEY,
            transaction_type_id bigint,
            transaction_currency_id bigint,
            transaction_group_id bigint,
            description text,
            date timestamptz,
            created_at timestamptz,
            deleted_at timestamptz,
            updated_at timestamptz
        );
        CREATE TABLE transactions (
            id bigint PRIMARY KEY,
            account_id bigint,
            transaction_journal_id bigint,
            identifier bigint,
            deleted_at timestamptz,
            amount numeric,
            foreign_amount numeric,
            foreign_currency_id bigint,
            reconciled smallint
        );

        INSERT INTO users VALUES (1);
        INSERT INTO account_types VALUES (1, 'Asset account'), (2, 'Expense account');
        INSERT INTO accounts VALUES
            (1, 1, 'Checking', 1, NULL),
            (2, 2, 'Merchant', 1, NULL),
            (3, 1, 'Savings', 1, NULL);
        INSERT INTO categories VALUES (1, 'Food', NULL);
        INSERT INTO tags VALUES (1, 'work', NULL);
        INSERT INTO transaction_currencies VALUES (1, 'CNY');
        INSERT INTO transaction_groups VALUES
            (1, 'Lunch', NULL),
            (2, 'Deleted transfer', '2026-07-23T00:00:00Z');
        INSERT INTO transaction_types VALUES (1, 'Withdrawal'), (2, 'Transfer');
        INSERT INTO transaction_journals VALUES
            (1, 1, 1, 1, 'Restaurant', '2026-07-22T00:00:00Z',
             '2026-07-22T00:00:00Z', NULL, '2026-07-22T00:00:00Z'),
            (2, 2, 1, 2, 'Transfer', '2026-07-23T00:00:00Z',
             '2026-07-23T00:00:00Z', '2026-07-23T01:00:00Z', '2026-07-23T01:00:00Z');
        INSERT INTO transactions VALUES
            (1, 1, 1, 0, NULL, -25.50, NULL, NULL, 0),
            (2, 2, 1, 1, NULL, 25.50, NULL, NULL, 0),
            (3, 1, 2, 0, '2026-07-23T01:00:00Z', -5.00, NULL, NULL, 0),
            (4, 3, 2, 1, '2026-07-23T01:00:00Z', 5.00, NULL, NULL, 0);
        INSERT INTO category_transaction_journal VALUES (1, 1), (1, 2);
        INSERT INTO tag_transaction_journal VALUES (1, 1), (1, 2);
        INSERT INTO notes VALUES
            (1, 1, 'FireflyIII\Models\TransactionJournal', 'Lunch note', 'Receipt', NULL),
            (2, 2, 'FireflyIII\Models\TransactionJournal', NULL, 'Deleted note', NULL),
            (3, 1, 'FireflyIII\Models\Account', NULL, 'Account note', NULL);
        "#,
    )
    .execute(&mut source)
    .await
    .unwrap();

    let inventory = inspect_firefly(&mut source).await.unwrap();
    assert!(inventory.core_import_ready);
    assert!(!inventory.contains_personal_values);
    assert_eq!(inventory.counts.transaction_journals, 2);
    assert_eq!(inventory.counts.postings, 4);
    assert_eq!(inventory.used_currencies[0].name, "CNY");

    let json = serde_json::to_string(&inventory).unwrap();
    assert!(!json.contains("account_name"));
    assert!(!json.contains("description"));
    assert!(!json.contains("email"));
    assert!(!json.contains("filename"));

    sqlx::raw_sql(
        r#"
        INSERT INTO users (id, email, display_name, password_hash)
            OVERRIDING SYSTEM VALUE VALUES (100, 'target@example.test', 'Target', 'x');
        INSERT INTO organizations (id, name, created_by_user_id)
            OVERRIDING SYSTEM VALUE VALUES (100, 'Target', 100);
        INSERT INTO organization_memberships (organization_id, user_id, role)
            VALUES (100, 100, 'owner');
        INSERT INTO books (id, organization_id, name, created_by_user_id)
            OVERRIDING SYSTEM VALUE VALUES (100, 100, 'Default', 100);
        INSERT INTO book_memberships (book_id, user_id, role)
            VALUES (100, 100, 'manager');
        INSERT INTO ledger_accounts (
            id, book_id, name, class, role, currency_code, hidden, system_key
        ) OVERRIDING SYSTEM VALUE VALUES
            (1000, 100, 'Opening', 'equity', 'opening_balance', 'CNY', TRUE, NULL),
            (1001, 100, 'Income', 'income', 'category', 'CNY', TRUE, 'default_income'),
            (1002, 100, 'Expense', 'expense', 'category', 'CNY', TRUE, 'default_expense');
        INSERT INTO categories (id, book_id, name)
            OVERRIDING SYSTEM VALUE VALUES (1000, 100, '未分类');
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();

    let report = migrate_firefly(&mut source, &pool, "target@example.test")
        .await
        .unwrap();
    assert_eq!(report.target_book_id, 100);
    assert_eq!(report.ledger_accounts, 2);
    assert_eq!(report.counterparties, 1);
    assert_eq!(report.categories, 1);
    assert_eq!(report.tags, 1);
    assert_eq!(report.original_journals, 2);
    assert_eq!(report.reversal_journals, 1);
    assert_eq!(report.postings, 6);
    assert_eq!(report.recycle_bin_entries, 1);
    assert_eq!(report.journal_notes_preserved, 2);
    assert_eq!(report.account_notes_unmapped, 1);
    assert_eq!(report.balance_mismatches, 0);

    let balances = sqlx::query_as::<_, (String, rust_decimal::Decimal)>(
        r#"
        SELECT a.name,
               COALESCE(sum(p.amount) FILTER (WHERE j.status IN ('posted', 'reversed')), 0)
        FROM ledger_accounts a
        LEFT JOIN postings p ON p.book_id = a.book_id AND p.account_id = a.id
        LEFT JOIN journal_entries j ON j.id = p.journal_entry_id
        WHERE a.book_id = 100 AND a.hidden = FALSE
        GROUP BY a.id ORDER BY a.name
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(balances[0].0, "Checking");
    assert_eq!(balances[0].1, Decimal::new(-2550, 2));
    assert_eq!(balances[1].0, "Savings");
    assert_eq!(balances[1].1, Decimal::ZERO);

    source.close().await.unwrap();
    sqlx::query(&format!("DROP DATABASE {database_name}"))
        .execute(&mut admin)
        .await
        .unwrap();
}
