use std::collections::BTreeSet;

use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};
use thiserror::Error;
use time::OffsetDateTime;

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
    bidirectional_categories: i64,
    transfer_categories: i64,
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
            (SELECT count(*) FROM (
                SELECT link.category_id
                FROM category_transaction_journal link
                JOIN transaction_journals j ON j.id = link.transaction_journal_id
                JOIN transaction_types t ON t.id = j.transaction_type_id
                GROUP BY link.category_id
                HAVING bool_or(t.type = 'Deposit') AND bool_or(t.type = 'Withdrawal')
            ) bidirectional)::bigint AS bidirectional_categories,
            (SELECT count(DISTINCT link.category_id)
             FROM category_transaction_journal link
             JOIN transaction_journals j ON j.id = link.transaction_journal_id
             JOIN transaction_types t ON t.id = j.transaction_type_id
             WHERE t.type = 'Transfer')::bigint AS transfer_categories,
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
        compatibility.bidirectional_categories,
        "bidirectional_categories",
        FindingSeverity::Blocker,
        "Categories used for both deposits and withdrawals cannot fit the current one-kind category model.",
    );
    add_finding(
        &mut findings,
        compatibility.transfer_categories,
        "transfer_categories",
        FindingSeverity::Blocker,
        "Categories attached to transfers need a non-posting category association.",
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
    fn category_semantics_block_core_import() {
        let findings = build_findings(
            &empty_counts(),
            &CompatibilityCounts {
                unbalanced_journals: 0,
                multi_journal_groups: 0,
                journals_with_multiple_categories: 0,
                bidirectional_categories: 2,
                transfer_categories: 1,
                foreign_amount_postings: 0,
                non_cny_journals: 0,
                counterparty_name_collisions: 0,
                ledger_name_collisions: 0,
            },
            0,
            0,
        );

        assert_eq!(
            findings
                .iter()
                .filter(|finding| matches!(finding.severity, FindingSeverity::Blocker))
                .count(),
            2
        );
        assert!(
            findings
                .iter()
                .any(|finding| finding.code == "bidirectional_categories")
        );
    }
}
