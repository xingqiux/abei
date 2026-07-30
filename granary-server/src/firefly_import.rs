use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rust_decimal::Decimal;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection, PgPool, Postgres, Transaction};
use thiserror::Error;
use time::OffsetDateTime;

use crate::ledger::{
    AuditActorKind, LedgerError, PostJournal, PostingInput, ReverseJournal, post_journal_in_tx,
    trash_journal_in_tx,
};

const REQUIRED_TABLES: &[&str] = &[
    "account_types",
    "accounts",
    "attachments",
    "audit_log_entries",
    "bill_artifacts",
    "bill_mail_messages",
    "bill_secret_challenges",
    "bill_statement_imports",
    "bill_statement_rows",
    "bill_task_events",
    "bill_tasks",
    "budget_limits",
    "budgets",
    "categories",
    "category_transaction_journal",
    "notes",
    "tag_transaction_journal",
    "tags",
    "transaction_currencies",
    "transaction_groups",
    "transaction_journals",
    "transaction_types",
    "transactions",
    "users",
];

const SUPPORTED_ACCOUNT_TYPES: &[&str] = &[
    "Asset account",
    "Cash account",
    "Debt",
    "Expense account",
    "Initial balance account",
    "Liability credit account",
    "Loan",
    "Revenue account",
];

const SUPPORTED_TRANSACTION_TYPES: &[&str] = &[
    "Deposit",
    "Liability credit",
    "Opening balance",
    "Transfer",
    "Withdrawal",
];

#[derive(Debug, Error)]
pub enum FireflyInspectError {
    #[error("source schema is missing required Firefly tables: {0}")]
    MissingTables(String),
    #[error("source query failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("could not fingerprint the source inventory: {0}")]
    Serialize(#[from] serde_json::Error),
}

#[derive(Debug, Error)]
pub enum FireflyMigrationError {
    #[error(transparent)]
    Inspect(#[from] FireflyInspectError),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Ledger(#[from] LedgerError),
    #[error("source is not ready for core migration")]
    SourceNotReady,
    #[error("source contains unsupported {0}")]
    UnsupportedSource(&'static str),
    #[error("target user must own exactly one active book")]
    TargetBookNotUnique,
    #[error("target book must contain no user data")]
    TargetBookNotEmpty,
    #[error("source account {0} has no target mapping")]
    MissingAccount(i64),
    #[error("source category {0} has no target mapping")]
    MissingCategory(i64),
    #[error("source tag {0} has no target mapping")]
    MissingTag(i64),
    #[error("migration verification failed: {0}")]
    Verification(String),
}

#[derive(Debug, Serialize)]
pub struct FireflyMigrationReport {
    pub source_inventory_fingerprint: String,
    pub contains_personal_values: bool,
    pub target_book_id: i64,
    pub ledger_accounts: usize,
    pub counterparties: usize,
    pub categories: usize,
    pub tags: usize,
    pub original_journals: usize,
    pub reversal_journals: usize,
    pub postings: i64,
    pub recycle_bin_entries: i64,
    pub journal_notes_preserved: usize,
    pub account_notes_preserved: usize,
    pub account_notes_unmapped: usize,
    pub balance_mismatches: usize,
    pub legacy_audit_events_not_imported: i64,
    pub bill_records_not_imported: i64,
    pub bill_secret_challenges_not_imported: i64,
}

#[derive(Clone, Debug, FromRow, Serialize)]
pub struct SourceCounts {
    pub users: i64,
    pub accounts: i64,
    pub ledger_source_accounts: i64,
    pub counterparty_source_accounts: i64,
    pub categories: i64,
    pub tags: i64,
    pub budgets: i64,
    pub budget_limits: i64,
    pub transaction_groups: i64,
    pub active_transaction_groups: i64,
    pub transaction_journals: i64,
    pub active_transaction_journals: i64,
    pub deleted_transaction_journals: i64,
    pub postings: i64,
    pub active_postings: i64,
    pub reconciled_postings: i64,
    pub notes: i64,
    pub attachments: i64,
    pub audit_events: i64,
    pub bill_tasks: i64,
    pub bill_mail_messages: i64,
    pub bill_imports: i64,
    pub bill_rows: i64,
    pub bill_artifacts: i64,
    pub bill_task_events: i64,
    pub bill_secret_challenges: i64,
    pub max_account_id: i64,
    pub max_journal_id: i64,
    pub journal_updated_at: Option<OffsetDateTime>,
}

#[derive(Clone, Debug, Serialize)]
pub struct NamedCount {
    pub name: String,
    pub count: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Info,
    Pending,
    Blocker,
}

#[derive(Clone, Debug, Serialize)]
pub struct MigrationFinding {
    pub code: &'static str,
    pub severity: FindingSeverity,
    pub count: i64,
    pub message: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct FireflyInventory {
    pub source_kind: &'static str,
    pub inventory_fingerprint: String,
    pub contains_personal_values: bool,
    pub counts: SourceCounts,
    pub account_types: Vec<NamedCount>,
    pub transaction_types: Vec<NamedCount>,
    pub used_currencies: Vec<NamedCount>,
    pub category_usage: Vec<NamedCount>,
    pub findings: Vec<MigrationFinding>,
    pub core_import_ready: bool,
}

#[derive(Debug, FromRow)]
struct CompatibilityCounts {
    unbalanced_journals: i64,
    multi_journal_groups: i64,
    journals_with_multiple_categories: i64,
    foreign_amount_postings: i64,
    non_cny_journals: i64,
    counterparty_name_collisions: i64,
    ledger_name_collisions: i64,
}

pub async fn inspect_firefly(
    connection: &mut PgConnection,
) -> Result<FireflyInventory, FireflyInspectError> {
    validate_schema(connection).await?;

    let counts = sqlx::query_as::<_, SourceCounts>(
        r#"
        SELECT
            (SELECT count(*) FROM users)::bigint AS users,
            (SELECT count(*) FROM accounts)::bigint AS accounts,
            (SELECT count(*) FROM accounts a JOIN account_types t ON t.id = a.account_type_id
             WHERE t.type NOT IN ('Expense account', 'Revenue account'))::bigint AS ledger_source_accounts,
            (SELECT count(*) FROM accounts a JOIN account_types t ON t.id = a.account_type_id
             WHERE t.type IN ('Expense account', 'Revenue account'))::bigint AS counterparty_source_accounts,
            (SELECT count(*) FROM categories)::bigint AS categories,
            (SELECT count(*) FROM tags)::bigint AS tags,
            (SELECT count(*) FROM budgets)::bigint AS budgets,
            (SELECT count(*) FROM budget_limits)::bigint AS budget_limits,
            (SELECT count(*) FROM transaction_groups)::bigint AS transaction_groups,
            (SELECT count(*) FROM transaction_groups WHERE deleted_at IS NULL)::bigint
                AS active_transaction_groups,
            (SELECT count(*) FROM transaction_journals)::bigint AS transaction_journals,
            (SELECT count(*) FROM transaction_journals WHERE deleted_at IS NULL)::bigint
                AS active_transaction_journals,
            (SELECT count(*) FROM transaction_journals WHERE deleted_at IS NOT NULL)::bigint
                AS deleted_transaction_journals,
            (SELECT count(*) FROM transactions)::bigint AS postings,
            (SELECT count(*) FROM transactions t
             JOIN transaction_journals j ON j.id = t.transaction_journal_id
             WHERE t.deleted_at IS NULL AND j.deleted_at IS NULL)::bigint AS active_postings,
            (SELECT count(*) FROM transactions WHERE reconciled <> 0)::bigint AS reconciled_postings,
            (SELECT count(*) FROM notes)::bigint AS notes,
            (SELECT count(*) FROM attachments)::bigint AS attachments,
            (SELECT count(*) FROM audit_log_entries)::bigint AS audit_events,
            (SELECT count(*) FROM bill_tasks)::bigint AS bill_tasks,
            (SELECT count(*) FROM bill_mail_messages)::bigint AS bill_mail_messages,
            (SELECT count(*) FROM bill_statement_imports)::bigint AS bill_imports,
            (SELECT count(*) FROM bill_statement_rows)::bigint AS bill_rows,
            (SELECT count(*) FROM bill_artifacts)::bigint AS bill_artifacts,
            (SELECT count(*) FROM bill_task_events)::bigint AS bill_task_events,
            (SELECT count(*) FROM bill_secret_challenges)::bigint AS bill_secret_challenges,
            COALESCE((SELECT max(id) FROM accounts), 0)::bigint AS max_account_id,
            COALESCE((SELECT max(id) FROM transaction_journals), 0)::bigint AS max_journal_id,
            (SELECT max(updated_at) FROM transaction_journals) AS journal_updated_at
        "#,
    )
    .fetch_one(&mut *connection)
    .await?;

    let account_types = named_counts(
        connection,
        r#"
        SELECT t.type, count(*)::bigint
        FROM accounts a
        JOIN account_types t ON t.id = a.account_type_id
        GROUP BY t.type
        ORDER BY t.type
        "#,
    )
    .await?;
    let transaction_types = named_counts(
        connection,
        r#"
        SELECT t.type, count(*)::bigint
        FROM transaction_journals j
        JOIN transaction_types t ON t.id = j.transaction_type_id
        GROUP BY t.type
        ORDER BY t.type
        "#,
    )
    .await?;
    let used_currencies = named_counts(
        connection,
        r#"
        SELECT c.code, count(DISTINCT j.id)::bigint
        FROM transaction_journals j
        JOIN transaction_currencies c ON c.id = j.transaction_currency_id
        GROUP BY c.code
        ORDER BY c.code
        "#,
    )
    .await?;
    let category_usage = named_counts(
        connection,
        r#"
        WITH usage AS (
            SELECT c.id,
                   COALESCE(string_agg(DISTINCT t.type, ',' ORDER BY t.type), 'unused') AS kinds
            FROM categories c
            LEFT JOIN category_transaction_journal link ON link.category_id = c.id
            LEFT JOIN transaction_journals j ON j.id = link.transaction_journal_id
            LEFT JOIN transaction_types t ON t.id = j.transaction_type_id
            GROUP BY c.id
        )
        SELECT kinds, count(*)::bigint
        FROM usage
        GROUP BY kinds
        ORDER BY kinds
        "#,
    )
    .await?;
    let compatibility = sqlx::query_as::<_, CompatibilityCounts>(
        r#"
        SELECT
            (SELECT count(*) FROM (
                SELECT transaction_journal_id
                FROM transactions
                GROUP BY transaction_journal_id
                HAVING count(*) < 2 OR sum(amount) <> 0
            ) invalid)::bigint AS unbalanced_journals,
            (SELECT count(*) FROM (
                SELECT transaction_group_id
                FROM transaction_journals
                GROUP BY transaction_group_id
                HAVING count(*) > 1
            ) grouped)::bigint AS multi_journal_groups,
            (SELECT count(*) FROM (
                SELECT transaction_journal_id
                FROM category_transaction_journal
                GROUP BY transaction_journal_id
                HAVING count(*) > 1
            ) categorized)::bigint AS journals_with_multiple_categories,
            (SELECT count(*) FROM transactions
             WHERE foreign_amount IS NOT NULL OR foreign_currency_id IS NOT NULL)::bigint
                AS foreign_amount_postings,
            (SELECT count(*)
             FROM transaction_journals j
             JOIN transaction_currencies c ON c.id = j.transaction_currency_id
             WHERE c.code <> 'CNY')::bigint AS non_cny_journals,
            (SELECT count(*) FROM (
                SELECT lower(a.name)
                FROM accounts a
                JOIN account_types t ON t.id = a.account_type_id
                WHERE t.type IN ('Expense account', 'Revenue account')
                GROUP BY lower(a.name)
                HAVING count(*) > 1
            ) collisions)::bigint AS counterparty_name_collisions,
            (SELECT count(*) FROM (
                SELECT lower(a.name)
                FROM accounts a
                JOIN account_types t ON t.id = a.account_type_id
                WHERE t.type NOT IN ('Expense account', 'Revenue account')
                GROUP BY lower(a.name)
                HAVING count(*) > 1
            ) collisions)::bigint AS ledger_name_collisions
        "#,
    )
    .fetch_one(&mut *connection)
    .await?;

    let supported: BTreeSet<&str> = SUPPORTED_ACCOUNT_TYPES.iter().copied().collect();
    let unsupported_account_types = account_types
        .iter()
        .filter(|item| !supported.contains(item.name.as_str()))
        .map(|item| item.count)
        .sum();
    let supported: BTreeSet<&str> = SUPPORTED_TRANSACTION_TYPES.iter().copied().collect();
    let unsupported_transaction_types = transaction_types
        .iter()
        .filter(|item| !supported.contains(item.name.as_str()))
        .map(|item| item.count)
        .sum();
    let findings = build_findings(
        &counts,
        &compatibility,
        unsupported_account_types,
        unsupported_transaction_types,
    );
    let core_import_ready = !findings
        .iter()
        .any(|finding| matches!(finding.severity, FindingSeverity::Blocker));
    let fingerprint_material = serde_json::json!({
        "counts": &counts,
        "account_types": &account_types,
        "transaction_types": &transaction_types,
        "used_currencies": &used_currencies,
        "category_usage": &category_usage,
    });
    let inventory_fingerprint =
        hex::encode(Sha256::digest(serde_json::to_vec(&fingerprint_material)?));

    Ok(FireflyInventory {
        source_kind: "firefly_iii_postgresql",
        inventory_fingerprint,
        contains_personal_values: false,
        counts,
        account_types,
        transaction_types,
        used_currencies,
        category_usage,
        findings,
        core_import_ready,
    })
}

#[derive(Debug, FromRow)]
struct ImportAccount {
    id: i64,
    name: String,
    account_type: String,
    active: i16,
    deleted_at: Option<OffsetDateTime>,
    expected_balance: Decimal,
    note: Option<String>,
}

#[derive(Debug, FromRow)]
struct ImportCategory {
    id: i64,
    name: String,
    deleted_at: Option<OffsetDateTime>,
}

#[derive(Debug, FromRow)]
struct ImportTag {
    id: i64,
    name: String,
    deleted_at: Option<OffsetDateTime>,
}

#[derive(Debug, FromRow)]
struct ImportJournal {
    id: i64,
    transaction_type: String,
    description: String,
    detail: Option<String>,
    occurred_at: OffsetDateTime,
    deleted_at: Option<OffsetDateTime>,
    category_id: Option<i64>,
    note: Option<String>,
}

#[derive(Debug, FromRow)]
struct ImportPosting {
    journal_id: i64,
    account_id: i64,
    amount: Decimal,
}

pub async fn migrate_firefly(
    source: &mut PgConnection,
    target: &PgPool,
    target_user_email: &str,
) -> Result<FireflyMigrationReport, FireflyMigrationError> {
    let inventory = inspect_firefly(source).await?;
    if !inventory.core_import_ready {
        return Err(FireflyMigrationError::SourceNotReady);
    }
    for (count, name) in [
        (inventory.counts.budgets, "budgets"),
        (inventory.counts.budget_limits, "budget limits"),
        (inventory.counts.reconciled_postings, "reconciled postings"),
        (inventory.counts.attachments, "attachments"),
    ] {
        if count != 0 {
            return Err(FireflyMigrationError::UnsupportedSource(name));
        }
    }

    let accounts = load_import_accounts(source).await?;
    let categories = sqlx::query_as::<_, ImportCategory>(
        "SELECT id, COALESCE(NULLIF(btrim(name), ''), 'Firefly category #' || id) AS name, deleted_at FROM categories ORDER BY id",
    )
    .fetch_all(&mut *source)
    .await?;
    let tags = sqlx::query_as::<_, ImportTag>(
        "SELECT id, COALESCE(NULLIF(btrim(tag), ''), 'Firefly tag #' || id) AS name, deleted_at FROM tags ORDER BY id",
    )
    .fetch_all(&mut *source)
    .await?;
    let journals = load_import_journals(source).await?;
    let source_postings = sqlx::query_as::<_, ImportPosting>(
        r#"
        SELECT transaction_journal_id AS journal_id, account_id, amount
        FROM transactions
        ORDER BY transaction_journal_id, identifier, id
        "#,
    )
    .fetch_all(&mut *source)
    .await?;
    let source_tag_links = sqlx::query_as::<_, (i64, i64)>(
        "SELECT transaction_journal_id, tag_id FROM tag_transaction_journal ORDER BY transaction_journal_id, tag_id",
    )
    .fetch_all(&mut *source)
    .await?;

    let mut postings_by_journal = BTreeMap::<i64, Vec<ImportPosting>>::new();
    for posting in source_postings {
        postings_by_journal
            .entry(posting.journal_id)
            .or_default()
            .push(posting);
    }
    let mut tags_by_journal = BTreeMap::<i64, Vec<i64>>::new();
    for (journal_id, tag_id) in source_tag_links {
        tags_by_journal.entry(journal_id).or_default().push(tag_id);
    }

    let mut tx = target.begin().await?;
    let (target_user_id, target_book_id) = target_book(&mut tx, target_user_email).await?;
    require_empty_target(&mut tx, target_book_id).await?;
    sqlx::query("DELETE FROM categories WHERE book_id = $1")
        .bind(target_book_id)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE books SET name = 'Firefly 导入账本', updated_at = now() WHERE id = $1")
        .bind(target_book_id)
        .execute(&mut *tx)
        .await?;

    let (default_income, default_expense, opening_balance) =
        system_accounts(&mut tx, target_book_id).await?;
    let mut account_map = HashMap::<i64, i64>::new();
    let mut counterparty_map = HashMap::<i64, i64>::new();
    let mut expected_by_target = HashMap::<i64, Decimal>::new();
    let mut archived_accounts = Vec::<(i64, Option<OffsetDateTime>)>::new();
    let mut used_account_names = HashSet::new();
    let mut counterparty_by_name = HashMap::<String, i64>::new();
    let mut counterparty_active = HashMap::<i64, bool>::new();
    let mut imported_ledger_accounts = 0usize;
    let mut account_notes_preserved = 0usize;
    let mut account_notes_unmapped = 0usize;

    for account in &accounts {
        let mapped_account = match account.account_type.as_str() {
            "Expense account" => default_expense,
            "Revenue account" => default_income,
            "Initial balance account" => opening_balance,
            account_type => {
                let (class, role) = map_ledger_account_type(account_type)?;
                let name = unique_import_name(&account.name, account.id, &mut used_account_names);
                let id = sqlx::query_scalar::<_, i64>(
                    r#"
                    INSERT INTO ledger_accounts (book_id, name, class, role, currency_code)
                    VALUES ($1, $2, $3, $4, 'CNY') RETURNING id
                    "#,
                )
                .bind(target_book_id)
                .bind(name)
                .bind(class)
                .bind(role)
                .fetch_one(&mut *tx)
                .await?;
                imported_ledger_accounts += 1;
                if account.note.is_some() {
                    account_notes_unmapped += 1;
                }
                if account.deleted_at.is_some() || account.active == 0 {
                    archived_accounts.push((id, account.deleted_at));
                }
                id
            }
        };
        account_map.insert(account.id, mapped_account);
        *expected_by_target.entry(mapped_account).or_default() += account.expected_balance;

        if matches!(
            account.account_type.as_str(),
            "Expense account" | "Revenue account"
        ) {
            let key = account.name.to_lowercase();
            let (counterparty_id, already_exists) = if let Some(id) = counterparty_by_name.get(&key)
            {
                (*id, true)
            } else {
                let id = sqlx::query_scalar::<_, i64>(
                    "INSERT INTO counterparties (book_id, name, notes) VALUES ($1, $2, $3) RETURNING id",
                )
                .bind(target_book_id)
                .bind(&account.name)
                .bind(&account.note)
                .fetch_one(&mut *tx)
                .await?;
                if account.note.is_some() {
                    account_notes_preserved += 1;
                }
                counterparty_by_name.insert(key, id);
                (id, false)
            };
            if already_exists && let Some(note) = &account.note {
                sqlx::query(
                    "UPDATE counterparties SET notes = concat_ws(E'\\n\\n', notes, $2) WHERE id = $1",
                )
                .bind(counterparty_id)
                .bind(note)
                .execute(&mut *tx)
                .await?;
                account_notes_preserved += 1;
            }
            counterparty_map.insert(account.id, counterparty_id);
            let active = account.deleted_at.is_none() && account.active != 0;
            counterparty_active
                .entry(counterparty_id)
                .and_modify(|current| *current |= active)
                .or_insert(active);
        }
    }

    let mut category_map = HashMap::<i64, i64>::new();
    let mut archived_categories = Vec::<(i64, OffsetDateTime)>::new();
    let mut used_category_names = HashSet::new();
    for category in &categories {
        let name = unique_import_name(&category.name, category.id, &mut used_category_names);
        let id = sqlx::query_scalar::<_, i64>(
            "INSERT INTO categories (book_id, name) VALUES ($1, $2) RETURNING id",
        )
        .bind(target_book_id)
        .bind(name)
        .fetch_one(&mut *tx)
        .await?;
        category_map.insert(category.id, id);
        if let Some(archived_at) = category.deleted_at {
            archived_categories.push((id, archived_at));
        }
    }

    let mut tag_map = HashMap::<i64, i64>::new();
    let mut archived_tags = Vec::<(i64, OffsetDateTime)>::new();
    let mut used_tag_names = HashSet::new();
    for tag in &tags {
        let name = unique_import_name(&tag.name, tag.id, &mut used_tag_names);
        let id = sqlx::query_scalar::<_, i64>(
            "INSERT INTO tags (book_id, name) VALUES ($1, $2) RETURNING id",
        )
        .bind(target_book_id)
        .bind(name)
        .fetch_one(&mut *tx)
        .await?;
        tag_map.insert(tag.id, id);
        if let Some(archived_at) = tag.deleted_at {
            archived_tags.push((id, archived_at));
        }
    }

    let account_by_id = accounts
        .iter()
        .map(|account| (account.id, account))
        .collect::<HashMap<_, _>>();
    let mut reversal_journals = 0usize;
    let mut reversal_postings = 0i64;
    let mut journal_notes_preserved = 0usize;
    for journal in &journals {
        let source_lines = postings_by_journal.remove(&journal.id).ok_or_else(|| {
            FireflyMigrationError::Verification(format!(
                "source journal {} has no postings",
                journal.id
            ))
        })?;
        let dimension_index = dimension_posting_index(journal, &source_lines, &account_by_id)?;
        let category_id = journal
            .category_id
            .map(|id| {
                category_map
                    .get(&id)
                    .copied()
                    .ok_or(FireflyMigrationError::MissingCategory(id))
            })
            .transpose()?;
        let memo = import_memo(journal);
        if journal.note.is_some() {
            journal_notes_preserved += 1;
        }
        let mut postings = Vec::with_capacity(source_lines.len());
        for (index, source_line) in source_lines.iter().enumerate() {
            let account_id = account_map.get(&source_line.account_id).copied().ok_or(
                FireflyMigrationError::MissingAccount(source_line.account_id),
            )?;
            postings.push(PostingInput {
                account_id,
                category_id: (index == dimension_index).then_some(category_id).flatten(),
                budget_id: None,
                amount: source_line.amount,
                book_amount: source_line.amount,
                memo: (index == dimension_index).then(|| memo.clone()).flatten(),
            });
        }
        let mut tag_ids = tags_by_journal
            .remove(&journal.id)
            .unwrap_or_default()
            .into_iter()
            .map(|id| {
                tag_map
                    .get(&id)
                    .copied()
                    .ok_or(FireflyMigrationError::MissingTag(id))
            })
            .collect::<Result<Vec<_>, _>>()?;
        tag_ids.sort_unstable();
        tag_ids.dedup();
        let counterparty_id = source_lines
            .iter()
            .find_map(|line| counterparty_map.get(&line.account_id).copied());
        let target_journal_id = post_journal_in_tx(
            &mut tx,
            &PostJournal {
                book_id: target_book_id,
                description: journal.description.clone(),
                occurred_at: journal.occurred_at,
                counterparty_id,
                created_by_user_id: target_user_id,
                audit_actor_kind: AuditActorKind::Import,
                postings,
                tag_ids,
            },
            None,
        )
        .await?;
        if let Some(deleted_at) = journal.deleted_at {
            trash_journal_in_tx(
                &mut tx,
                &ReverseJournal {
                    book_id: target_book_id,
                    journal_id: target_journal_id,
                    occurred_at: deleted_at,
                    reason: "从 Firefly 软删除记录迁移".to_owned(),
                    actor_user_id: target_user_id,
                    audit_actor_kind: AuditActorKind::Import,
                },
            )
            .await?;
            sqlx::query(
                "UPDATE transaction_recycle_bin SET deleted_at = $3 WHERE book_id = $1 AND original_journal_id = $2",
            )
            .bind(target_book_id)
            .bind(target_journal_id)
            .bind(deleted_at)
            .execute(&mut *tx)
            .await?;
            reversal_journals += 1;
            reversal_postings += source_lines.len() as i64;
        }
    }

    archive_imported_dimensions(
        &mut tx,
        target_book_id,
        archived_accounts,
        counterparty_active,
        archived_categories,
        archived_tags,
    )
    .await?;

    let balance_mismatches = verify_balances(&mut tx, target_book_id, expected_by_target).await?;
    if balance_mismatches != 0 {
        return Err(FireflyMigrationError::Verification(format!(
            "{balance_mismatches} account balances differ"
        )));
    }
    let (target_journals, target_postings, recycle_bin_entries) =
        sqlx::query_as::<_, (i64, i64, i64)>(
            r#"
            SELECT
                (SELECT count(*) FROM journal_entries WHERE book_id = $1),
                (SELECT count(*) FROM postings WHERE book_id = $1),
                (SELECT count(*) FROM transaction_recycle_bin WHERE book_id = $1)
            "#,
        )
        .bind(target_book_id)
        .fetch_one(&mut *tx)
        .await?;
    let expected_journals = journals.len() as i64 + reversal_journals as i64;
    let expected_postings = inventory.counts.postings + reversal_postings;
    if target_journals != expected_journals
        || target_postings != expected_postings
        || recycle_bin_entries != reversal_journals as i64
    {
        return Err(FireflyMigrationError::Verification(
            "journal, posting, or recycle-bin counts differ".to_owned(),
        ));
    }

    tx.commit().await?;
    Ok(FireflyMigrationReport {
        source_inventory_fingerprint: inventory.inventory_fingerprint,
        contains_personal_values: false,
        target_book_id,
        ledger_accounts: imported_ledger_accounts,
        counterparties: counterparty_by_name.len(),
        categories: categories.len(),
        tags: tags.len(),
        original_journals: journals.len(),
        reversal_journals,
        postings: target_postings,
        recycle_bin_entries,
        journal_notes_preserved,
        account_notes_preserved,
        account_notes_unmapped,
        balance_mismatches,
        legacy_audit_events_not_imported: inventory.counts.audit_events,
        bill_records_not_imported: inventory.counts.bill_tasks
            + inventory.counts.bill_mail_messages
            + inventory.counts.bill_imports
            + inventory.counts.bill_rows
            + inventory.counts.bill_artifacts
            + inventory.counts.bill_task_events,
        bill_secret_challenges_not_imported: inventory.counts.bill_secret_challenges,
    })
}

async fn load_import_accounts(
    source: &mut PgConnection,
) -> Result<Vec<ImportAccount>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT a.id,
               COALESCE(NULLIF(btrim(a.name), ''), 'Firefly account #' || a.id) AS name,
               t.type AS account_type, COALESCE(a.active, 1)::smallint AS active,
               a.deleted_at,
               COALESCE((
                   SELECT sum(tx.amount)
                   FROM transactions tx
                   JOIN transaction_journals j ON j.id = tx.transaction_journal_id
                   WHERE tx.account_id = a.id AND tx.deleted_at IS NULL AND j.deleted_at IS NULL
               ), 0) AS expected_balance,
               notes.note
        FROM accounts a
        JOIN account_types t ON t.id = a.account_type_id
        LEFT JOIN LATERAL (
            SELECT NULLIF(string_agg(
                NULLIF(concat_ws(E'\n\n', NULLIF(btrim(n.title), ''), NULLIF(btrim(n.text), '')), ''),
                E'\n\n' ORDER BY n.id
            ), '') AS note
            FROM notes n
            WHERE n.noteable_id = a.id
              AND n.noteable_type = 'FireflyIII\Models\Account'
              AND n.deleted_at IS NULL
        ) notes ON TRUE
        ORDER BY a.id
        "#,
    )
    .fetch_all(source)
    .await
}

async fn load_import_journals(
    source: &mut PgConnection,
) -> Result<Vec<ImportJournal>, sqlx::Error> {
    sqlx::query_as(
        r#"
        SELECT j.id, tt.type AS transaction_type,
               COALESCE(NULLIF(btrim(g.title), ''), NULLIF(btrim(j.description), ''),
                        'Firefly transaction #' || j.id) AS description,
               CASE
                   WHEN NULLIF(btrim(j.description), '') IS NOT NULL
                    AND btrim(COALESCE(g.title, '')) <> btrim(j.description)
                   THEN btrim(j.description)
               END AS detail,
               COALESCE(j.date, j.created_at, to_timestamp(0)) AS occurred_at,
               j.deleted_at,
               category.category_id,
               notes.note
        FROM transaction_journals j
        JOIN transaction_types tt ON tt.id = j.transaction_type_id
        JOIN transaction_groups g ON g.id = j.transaction_group_id
        LEFT JOIN LATERAL (
            SELECT min(link.category_id) AS category_id
            FROM category_transaction_journal link
            WHERE link.transaction_journal_id = j.id
        ) category ON TRUE
        LEFT JOIN LATERAL (
            SELECT NULLIF(string_agg(
                NULLIF(concat_ws(E'\n\n', NULLIF(btrim(n.title), ''), NULLIF(btrim(n.text), '')), ''),
                E'\n\n' ORDER BY n.id
            ), '') AS note
            FROM notes n
            WHERE n.noteable_id = j.id
              AND n.noteable_type = 'FireflyIII\Models\TransactionJournal'
              AND n.deleted_at IS NULL
        ) notes ON TRUE
        ORDER BY j.id
        "#,
    )
    .fetch_all(source)
    .await
}

async fn target_book(
    tx: &mut Transaction<'_, Postgres>,
    target_user_email: &str,
) -> Result<(i64, i64), FireflyMigrationError> {
    let books = sqlx::query_as::<_, (i64, i64)>(
        r#"
        SELECT u.id, b.id
        FROM users u
        JOIN book_memberships membership ON membership.user_id = u.id
        JOIN books b ON b.id = membership.book_id
        WHERE lower(u.email) = lower($1) AND u.disabled_at IS NULL AND b.archived_at IS NULL
        ORDER BY b.id
        "#,
    )
    .bind(target_user_email.trim())
    .fetch_all(&mut **tx)
    .await?;
    if books.len() != 1 {
        return Err(FireflyMigrationError::TargetBookNotUnique);
    }
    Ok(books[0])
}

async fn require_empty_target(
    tx: &mut Transaction<'_, Postgres>,
    book_id: i64,
) -> Result<(), FireflyMigrationError> {
    let counts = sqlx::query_as::<_, (i64, i64, i64, i64, i64, i64)>(
        r#"
        SELECT
            (SELECT count(*) FROM journal_entries WHERE book_id = $1),
            (SELECT count(*) FROM ledger_accounts WHERE book_id = $1 AND hidden = FALSE),
            (SELECT count(*) FROM counterparties WHERE book_id = $1),
            (SELECT count(*) FROM tags WHERE book_id = $1),
            (SELECT count(*) FROM budgets WHERE book_id = $1),
            (SELECT count(*) FROM categories WHERE book_id = $1)
        "#,
    )
    .bind(book_id)
    .fetch_one(&mut **tx)
    .await?;
    if counts.0 != 0
        || counts.1 != 0
        || counts.2 != 0
        || counts.3 != 0
        || counts.4 != 0
        || counts.5 > 1
    {
        return Err(FireflyMigrationError::TargetBookNotEmpty);
    }
    Ok(())
}

async fn system_accounts(
    tx: &mut Transaction<'_, Postgres>,
    book_id: i64,
) -> Result<(i64, i64, i64), FireflyMigrationError> {
    let accounts = sqlx::query_as::<_, (Option<i64>, Option<i64>, Option<i64>)>(
        r#"
        SELECT
            (SELECT id FROM ledger_accounts WHERE book_id = $1 AND system_key = 'default_income'),
            (SELECT id FROM ledger_accounts WHERE book_id = $1 AND system_key = 'default_expense'),
            (SELECT id FROM ledger_accounts WHERE book_id = $1 AND role = 'opening_balance' AND hidden)
        "#,
    )
    .bind(book_id)
    .fetch_one(&mut **tx)
    .await?;
    match accounts {
        (Some(income), Some(expense), Some(opening)) => Ok((income, expense, opening)),
        _ => Err(FireflyMigrationError::Verification(
            "target book lacks system accounts".to_owned(),
        )),
    }
}

fn map_ledger_account_type(
    account_type: &str,
) -> Result<(&'static str, &'static str), FireflyMigrationError> {
    match account_type {
        "Asset account" => Ok(("asset", "bank")),
        "Cash account" => Ok(("asset", "cash")),
        "Debt" | "Loan" => Ok(("liability", "loan")),
        "Liability credit account" => Ok(("liability", "card")),
        _ => Err(FireflyMigrationError::UnsupportedSource(
            "ledger account type",
        )),
    }
}

fn unique_import_name(raw: &str, source_id: i64, used: &mut HashSet<String>) -> String {
    let base = raw.trim();
    let base = if base.is_empty() { "Firefly" } else { base };
    let mut name = base.to_owned();
    let mut suffix = 0;
    while !used.insert(name.to_lowercase()) {
        suffix += 1;
        name = if suffix == 1 {
            format!("{base} [Firefly #{source_id}]")
        } else {
            format!("{base} [Firefly #{source_id}-{suffix}]")
        };
    }
    name
}

fn dimension_posting_index(
    journal: &ImportJournal,
    postings: &[ImportPosting],
    accounts: &HashMap<i64, &ImportAccount>,
) -> Result<usize, FireflyMigrationError> {
    let account_type = |posting: &ImportPosting| {
        accounts
            .get(&posting.account_id)
            .map(|account| account.account_type.as_str())
            .ok_or(FireflyMigrationError::MissingAccount(posting.account_id))
    };
    if let Some(index) = postings.iter().position(|posting| {
        matches!(
            account_type(posting),
            Ok("Expense account" | "Revenue account")
        )
    }) {
        return Ok(index);
    }
    if journal.transaction_type == "Opening balance"
        && let Some(index) = postings
            .iter()
            .position(|posting| !matches!(account_type(posting), Ok("Initial balance account")))
    {
        return Ok(index);
    }
    Ok(postings
        .iter()
        .position(|posting| posting.amount.is_sign_negative())
        .unwrap_or(0))
}

fn import_memo(journal: &ImportJournal) -> Option<String> {
    match (&journal.detail, &journal.note) {
        (Some(detail), Some(note)) => Some(format!("{detail}\n\n{note}")),
        (Some(detail), None) => Some(detail.clone()),
        (None, Some(note)) => Some(note.clone()),
        (None, None) => None,
    }
}

async fn archive_imported_dimensions(
    tx: &mut Transaction<'_, Postgres>,
    book_id: i64,
    accounts: Vec<(i64, Option<OffsetDateTime>)>,
    counterparties: HashMap<i64, bool>,
    categories: Vec<(i64, OffsetDateTime)>,
    tags: Vec<(i64, OffsetDateTime)>,
) -> Result<(), sqlx::Error> {
    for (id, archived_at) in accounts {
        sqlx::query("UPDATE ledger_accounts SET archived_at = $3 WHERE book_id = $1 AND id = $2")
            .bind(book_id)
            .bind(id)
            .bind(archived_at.unwrap_or_else(OffsetDateTime::now_utc))
            .execute(&mut **tx)
            .await?;
    }
    for (id, active) in counterparties {
        if !active {
            sqlx::query(
                "UPDATE counterparties SET archived_at = now() WHERE book_id = $1 AND id = $2",
            )
            .bind(book_id)
            .bind(id)
            .execute(&mut **tx)
            .await?;
        }
    }
    for (id, archived_at) in categories {
        sqlx::query("UPDATE categories SET archived_at = $3 WHERE book_id = $1 AND id = $2")
            .bind(book_id)
            .bind(id)
            .bind(archived_at)
            .execute(&mut **tx)
            .await?;
    }
    for (id, archived_at) in tags {
        sqlx::query("UPDATE tags SET archived_at = $3 WHERE book_id = $1 AND id = $2")
            .bind(book_id)
            .bind(id)
            .bind(archived_at)
            .execute(&mut **tx)
            .await?;
    }
    Ok(())
}

async fn verify_balances(
    tx: &mut Transaction<'_, Postgres>,
    book_id: i64,
    expected: HashMap<i64, Decimal>,
) -> Result<usize, sqlx::Error> {
    let mut mismatches = 0;
    for (account_id, expected_balance) in expected {
        let target_balance = sqlx::query_scalar::<_, Decimal>(
            r#"
            SELECT COALESCE(sum(p.amount) FILTER (WHERE j.status IN ('posted', 'reversed')), 0)
            FROM ledger_accounts a
            LEFT JOIN postings p ON p.book_id = a.book_id AND p.account_id = a.id
            LEFT JOIN journal_entries j ON j.id = p.journal_entry_id
            WHERE a.book_id = $1 AND a.id = $2
            "#,
        )
        .bind(book_id)
        .bind(account_id)
        .fetch_one(&mut **tx)
        .await?;
        if target_balance != expected_balance {
            mismatches += 1;
        }
    }
    Ok(mismatches)
}

async fn validate_schema(connection: &mut PgConnection) -> Result<(), FireflyInspectError> {
    let available = sqlx::query_scalar::<_, String>(
        r#"
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)
        "#,
    )
    .bind(REQUIRED_TABLES)
    .fetch_all(&mut *connection)
    .await?;
    let available: BTreeSet<&str> = available.iter().map(String::as_str).collect();
    let missing: Vec<&str> = REQUIRED_TABLES
        .iter()
        .copied()
        .filter(|table| !available.contains(table))
        .collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(FireflyInspectError::MissingTables(missing.join(", ")))
    }
}

async fn named_counts(
    connection: &mut PgConnection,
    query: &str,
) -> Result<Vec<NamedCount>, sqlx::Error> {
    Ok(sqlx::query_as::<_, (String, i64)>(query)
        .fetch_all(connection)
        .await?
        .into_iter()
        .map(|(name, count)| NamedCount { name, count })
        .collect())
}

fn build_findings(
    counts: &SourceCounts,
    compatibility: &CompatibilityCounts,
    unsupported_account_types: i64,
    unsupported_transaction_types: i64,
) -> Vec<MigrationFinding> {
    let mut findings = Vec::new();
    if counts.users != 1 {
        findings.push(MigrationFinding {
            code: "source_user_cardinality",
            severity: FindingSeverity::Blocker,
            count: counts.users,
            message: "The current private migration path requires exactly one Firefly source user.",
        });
    }
    add_finding(
        &mut findings,
        unsupported_account_types,
        "unsupported_account_types",
        FindingSeverity::Blocker,
        "Account types without an explicit Granary mapping are present.",
    );
    add_finding(
        &mut findings,
        unsupported_transaction_types,
        "unsupported_transaction_types",
        FindingSeverity::Blocker,
        "Transaction types without an explicit Granary mapping are present.",
    );
    add_finding(
        &mut findings,
        compatibility.unbalanced_journals,
        "unbalanced_source_journals",
        FindingSeverity::Blocker,
        "Source journals with fewer than two postings or a non-zero sum are present.",
    );
    add_finding(
        &mut findings,
        compatibility.multi_journal_groups,
        "multi_journal_groups",
        FindingSeverity::Blocker,
        "Firefly groups containing multiple journals need an explicit split-group mapping.",
    );
    add_finding(
        &mut findings,
        compatibility.journals_with_multiple_categories,
        "multiple_categories_per_journal",
        FindingSeverity::Blocker,
        "Firefly journals linked to multiple categories need split-level mapping.",
    );
    add_finding(
        &mut findings,
        compatibility.foreign_amount_postings,
        "foreign_amount_postings",
        FindingSeverity::Blocker,
        "Foreign posting amounts require explicit account and book amount mapping.",
    );
    add_finding(
        &mut findings,
        compatibility.non_cny_journals,
        "non_cny_journals",
        FindingSeverity::Blocker,
        "Non-CNY journals require target-book currency and book-amount validation.",
    );
    add_finding(
        &mut findings,
        counts.deleted_transaction_journals,
        "deleted_journals",
        FindingSeverity::Info,
        "Soft-deleted Firefly journals must be imported with reversal and recycle-bin history.",
    );
    add_finding(
        &mut findings,
        compatibility.counterparty_name_collisions,
        "counterparty_name_collisions",
        FindingSeverity::Info,
        "Same-name Firefly expense and revenue accounts should map to one Granary counterparty.",
    );
    add_finding(
        &mut findings,
        compatibility.ledger_name_collisions,
        "ledger_name_collisions",
        FindingSeverity::Info,
        "Same-name ledger accounts require stable source-ID mapping and archive-aware naming.",
    );
    add_finding(
        &mut findings,
        counts.reconciled_postings,
        "reconciled_postings",
        FindingSeverity::Pending,
        "Firefly reconciled flags require reconciliation-session or cleared-at mapping.",
    );
    add_finding(
        &mut findings,
        counts.notes,
        "legacy_notes",
        FindingSeverity::Pending,
        "Transaction and account notes require the advanced transaction metadata schema.",
    );
    add_finding(
        &mut findings,
        counts.audit_events,
        "legacy_audit_events",
        FindingSeverity::Pending,
        "Legacy audit events require a read-only historical audit representation.",
    );
    add_finding(
        &mut findings,
        counts.attachments,
        "legacy_attachments",
        FindingSeverity::Pending,
        "Attachment metadata and storage objects require the S3-backed attachment domain.",
    );
    add_finding(
        &mut findings,
        counts.bill_tasks
            + counts.bill_mail_messages
            + counts.bill_imports
            + counts.bill_rows
            + counts.bill_artifacts
            + counts.bill_task_events,
        "bill_inbox_records",
        FindingSeverity::Pending,
        "Bill inbox records and artifacts require the Rust bill-inbox and S3 schemas.",
    );
    add_finding(
        &mut findings,
        counts.bill_secret_challenges,
        "bill_secret_challenges",
        FindingSeverity::Info,
        "Stored bill passwords and challenge responses are excluded and must be supplied again when needed.",
    );
    findings.push(MigrationFinding {
        code: "authentication_reset",
        severity: FindingSeverity::Info,
        count: counts.users,
        message: "Passwords, sessions, PATs, OAuth tokens, MFA secrets, and mailbox credentials are intentionally excluded.",
    });
    findings
}

fn add_finding(
    findings: &mut Vec<MigrationFinding>,
    count: i64,
    code: &'static str,
    severity: FindingSeverity,
    message: &'static str,
) {
    if count > 0 {
        findings.push(MigrationFinding {
            code,
            severity,
            count,
            message,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_counts() -> SourceCounts {
        SourceCounts {
            users: 1,
            accounts: 0,
            ledger_source_accounts: 0,
            counterparty_source_accounts: 0,
            categories: 0,
            tags: 0,
            budgets: 0,
            budget_limits: 0,
            transaction_groups: 0,
            active_transaction_groups: 0,
            transaction_journals: 0,
            active_transaction_journals: 0,
            deleted_transaction_journals: 0,
            postings: 0,
            active_postings: 0,
            reconciled_postings: 0,
            notes: 0,
            attachments: 0,
            audit_events: 0,
            bill_tasks: 0,
            bill_mail_messages: 0,
            bill_imports: 0,
            bill_rows: 0,
            bill_artifacts: 0,
            bill_task_events: 0,
            bill_secret_challenges: 0,
            max_account_id: 0,
            max_journal_id: 0,
            journal_updated_at: None,
        }
    }

    #[test]
    fn neutral_category_semantics_do_not_add_blockers() {
        let findings = build_findings(
            &empty_counts(),
            &CompatibilityCounts {
                unbalanced_journals: 0,
                multi_journal_groups: 0,
                journals_with_multiple_categories: 0,
                foreign_amount_postings: 0,
                non_cny_journals: 0,
                counterparty_name_collisions: 0,
                ledger_name_collisions: 0,
            },
            0,
            0,
        );

        assert!(
            findings
                .iter()
                .all(|finding| !matches!(finding.severity, FindingSeverity::Blocker))
        );
    }
}
