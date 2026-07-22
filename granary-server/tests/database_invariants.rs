use granary_server::ledger::{AuditActorKind, PostJournal, PostingInput, post_journal};
use rust_decimal::Decimal;
use sqlx::PgPool;
use time::OffsetDateTime;

struct Seed {
    user_id: i64,
    book_id: i64,
    cash_account_id: i64,
    expense_account_id: i64,
}

async fn seed(pool: &PgPool) -> Seed {
    let user_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO users (email, display_name, password_hash, is_instance_admin) VALUES ('owner@example.test', 'Owner', 'test-only', TRUE) RETURNING id",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    let organization_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO organizations (name, created_by_user_id) VALUES ('Personal', $1) RETURNING id",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_memberships (organization_id, user_id, role) VALUES ($1, $2, 'owner')",
    )
    .bind(organization_id)
    .bind(user_id)
    .execute(pool)
    .await
    .unwrap();
    let book_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO books (organization_id, name, created_by_user_id) VALUES ($1, 'Main', $2) RETURNING id",
    )
    .bind(organization_id)
    .bind(user_id)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO book_memberships (book_id, user_id, role) VALUES ($1, $2, 'manager')")
        .bind(book_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();

    let cash_account_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO ledger_accounts (book_id, name, class, role, currency_code) VALUES ($1, 'Cash', 'asset', 'cash', 'CNY') RETURNING id",
    )
    .bind(book_id)
    .fetch_one(pool)
    .await
    .unwrap();
    let expense_account_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO ledger_accounts (book_id, name, class, role, currency_code, hidden) VALUES ($1, 'Dining', 'expense', 'category', 'CNY', TRUE) RETURNING id",
    )
    .bind(book_id)
    .fetch_one(pool)
    .await
    .unwrap();

    Seed {
        user_id,
        book_id,
        cash_account_id,
        expense_account_id,
    }
}

#[sqlx::test(migrations = "./migrations")]
async fn service_posts_a_balanced_journal(pool: PgPool) {
    let seed = seed(&pool).await;
    let command = PostJournal {
        book_id: seed.book_id,
        description: "Lunch".to_owned(),
        occurred_at: OffsetDateTime::now_utc(),
        counterparty_id: None,
        created_by_user_id: seed.user_id,
        audit_actor_kind: AuditActorKind::User,
        tag_ids: Vec::new(),
        postings: vec![
            PostingInput {
                account_id: seed.cash_account_id,
                budget_id: None,
                amount: Decimal::from(-100),
                book_amount: Decimal::from(-100),
                memo: None,
            },
            PostingInput {
                account_id: seed.expense_account_id,
                budget_id: None,
                amount: Decimal::from(100),
                book_amount: Decimal::from(100),
                memo: None,
            },
        ],
    };

    let journal_id = post_journal(&pool, &command).await.unwrap();
    let (status, count, balance) = sqlx::query_as::<_, (String, i64, Decimal)>(
        r#"
        SELECT j.status, count(p.id), sum(p.book_amount)
        FROM journal_entries j
        JOIN postings p ON p.journal_entry_id = j.id
        WHERE j.id = $1
        GROUP BY j.status
        "#,
    )
    .bind(journal_id)
    .fetch_one(&pool)
    .await
    .unwrap();

    assert_eq!(status, "posted");
    assert_eq!(count, 2);
    assert_eq!(balance, Decimal::ZERO);
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM audit_events WHERE entity_type = 'journal_entry' AND entity_id = $1",
        )
        .bind(journal_id)
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn database_rejects_an_unbalanced_posted_journal(pool: PgPool) {
    let seed = seed(&pool).await;
    let mut tx = pool.begin().await.unwrap();
    let journal_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO journal_entries (book_id, occurred_at, description, created_by_user_id) VALUES ($1, now(), 'Invalid', $2) RETURNING id",
    )
    .bind(seed.book_id)
    .bind(seed.user_id)
    .fetch_one(&mut *tx)
    .await
    .unwrap();

    for (line_no, account_id, amount) in [
        (0, seed.cash_account_id, Decimal::from(-100)),
        (1, seed.expense_account_id, Decimal::from(90)),
    ] {
        sqlx::query(
            "INSERT INTO postings (book_id, journal_entry_id, line_no, account_id, amount, book_amount) VALUES ($1, $2, $3, $4, $5, $5)",
        )
        .bind(seed.book_id)
        .bind(journal_id)
        .bind(line_no)
        .bind(account_id)
        .bind(amount)
        .execute(&mut *tx)
        .await
        .unwrap();
    }
    sqlx::query("UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1")
        .bind(journal_id)
        .execute(&mut *tx)
        .await
        .unwrap();

    assert!(tx.commit().await.is_err());
}

#[sqlx::test(migrations = "./migrations")]
async fn database_rejects_changes_to_posted_lines(pool: PgPool) {
    let seed = seed(&pool).await;
    let command = PostJournal {
        book_id: seed.book_id,
        description: "Immutable".to_owned(),
        occurred_at: OffsetDateTime::now_utc(),
        counterparty_id: None,
        created_by_user_id: seed.user_id,
        audit_actor_kind: AuditActorKind::User,
        tag_ids: Vec::new(),
        postings: vec![
            PostingInput {
                account_id: seed.cash_account_id,
                budget_id: None,
                amount: Decimal::from(-1),
                book_amount: Decimal::from(-1),
                memo: None,
            },
            PostingInput {
                account_id: seed.expense_account_id,
                budget_id: None,
                amount: Decimal::ONE,
                book_amount: Decimal::ONE,
                memo: None,
            },
        ],
    };
    let journal_id = post_journal(&pool, &command).await.unwrap();

    let result = sqlx::query("UPDATE postings SET amount = amount + 1 WHERE journal_entry_id = $1")
        .bind(journal_id)
        .execute(&pool)
        .await;

    assert!(result.is_err());
}

#[sqlx::test(migrations = "./migrations")]
async fn database_protects_posted_journal_and_account_dimensions(pool: PgPool) {
    let seed = seed(&pool).await;
    let command = PostJournal {
        book_id: seed.book_id,
        description: "Protected".to_owned(),
        occurred_at: OffsetDateTime::now_utc(),
        counterparty_id: None,
        created_by_user_id: seed.user_id,
        audit_actor_kind: AuditActorKind::User,
        tag_ids: Vec::new(),
        postings: vec![
            PostingInput {
                account_id: seed.cash_account_id,
                budget_id: None,
                amount: Decimal::from(-1),
                book_amount: Decimal::from(-1),
                memo: None,
            },
            PostingInput {
                account_id: seed.expense_account_id,
                budget_id: None,
                amount: Decimal::ONE,
                book_amount: Decimal::ONE,
                memo: None,
            },
        ],
    };
    let journal_id = post_journal(&pool, &command).await.unwrap();

    assert!(
        sqlx::query("UPDATE journal_entries SET description = 'tampered' WHERE id = $1")
            .bind(journal_id)
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE ledger_accounts SET currency_code = 'USD' WHERE id = $1")
            .bind(seed.cash_account_id)
            .execute(&pool)
            .await
            .is_err()
    );
    assert!(
        sqlx::query("UPDATE ledger_accounts SET class = 'liability' WHERE id = $1")
            .bind(seed.cash_account_id)
            .execute(&pool)
            .await
            .is_err()
    );
}

#[sqlx::test(migrations = "./migrations")]
async fn database_rejects_budget_assignments_on_non_expense_postings(pool: PgPool) {
    let seed = seed(&pool).await;
    let budget_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO budgets (book_id, name) VALUES ($1, 'Monthly') RETURNING id",
    )
    .bind(seed.book_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let journal_id = sqlx::query_scalar::<_, i64>(
        "INSERT INTO journal_entries (book_id, occurred_at, description, created_by_user_id) VALUES ($1, now(), 'Invalid budget target', $2) RETURNING id",
    )
    .bind(seed.book_id)
    .bind(seed.user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let result = sqlx::query(
        r#"
        INSERT INTO postings (
            book_id, journal_entry_id, line_no, account_id, amount, book_amount, budget_id
        ) VALUES ($1, $2, 0, $3, -1, -1, $4)
        "#,
    )
    .bind(seed.book_id)
    .bind(journal_id)
    .bind(seed.cash_account_id)
    .bind(budget_id)
    .execute(&pool)
    .await;
    assert!(result.is_err());
}
