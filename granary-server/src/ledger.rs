use std::collections::BTreeSet;

use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Transaction};
use thiserror::Error;
use time::OffsetDateTime;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditActorKind {
    User,
    Pat,
    System,
    Import,
    Job,
}

impl AuditActorKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Pat => "pat",
            Self::System => "system",
            Self::Import => "import",
            Self::Job => "job",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PostingInput {
    pub account_id: i64,
    pub budget_id: Option<i64>,
    #[serde(with = "rust_decimal::serde::str")]
    pub amount: Decimal,
    #[serde(with = "rust_decimal::serde::str")]
    pub book_amount: Decimal,
    pub memo: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PostJournal {
    pub book_id: i64,
    pub description: String,
    pub occurred_at: OffsetDateTime,
    pub counterparty_id: Option<i64>,
    pub created_by_user_id: i64,
    pub audit_actor_kind: AuditActorKind,
    pub postings: Vec<PostingInput>,
    #[serde(default)]
    pub tag_ids: Vec<i64>,
}

pub struct ReverseJournal {
    pub book_id: i64,
    pub journal_id: i64,
    pub occurred_at: OffsetDateTime,
    pub reason: String,
    pub actor_user_id: i64,
    pub audit_actor_kind: AuditActorKind,
}

#[derive(Debug, Error)]
pub enum LedgerError {
    #[error("description must not be empty")]
    EmptyDescription,
    #[error("a posted journal requires at least two postings")]
    TooFewPostings,
    #[error("posting {0} has a zero amount")]
    ZeroAmount(usize),
    #[error("book amounts do not balance; difference is {0}")]
    Unbalanced(Decimal),
    #[error("account {0} is not an active postable account in this book")]
    InvalidAccount(i64),
    #[error("tag {0} does not belong to this book")]
    InvalidTag(i64),
    #[error("budget {0} is not active in this book")]
    InvalidBudget(i64),
    #[error("counterparty {0} is not active in this book")]
    InvalidCounterparty(i64),
    #[error("a journal cannot contain the same tag more than once")]
    DuplicateTag,
    #[error("journal entry does not exist")]
    JournalNotFound,
    #[error("journal entry has already been reversed")]
    AlreadyReversed,
    #[error("only posted journal entries can be reversed")]
    JournalNotPosted,
    #[error("reversal reason must not be empty")]
    EmptyReversalReason,
    #[error("journal entry is not in the recycle bin")]
    JournalNotTrashed,
    #[error("journal entry has already been restored")]
    AlreadyRestored,
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),
}

impl PostJournal {
    pub fn validate(&self) -> Result<(), LedgerError> {
        if self.description.trim().is_empty() {
            return Err(LedgerError::EmptyDescription);
        }
        if self.postings.len() < 2 {
            return Err(LedgerError::TooFewPostings);
        }

        let mut balance = Decimal::ZERO;
        for (index, posting) in self.postings.iter().enumerate() {
            if posting.amount.is_zero() || posting.book_amount.is_zero() {
                return Err(LedgerError::ZeroAmount(index));
            }
            balance += posting.book_amount;
        }
        if !balance.is_zero() {
            return Err(LedgerError::Unbalanced(balance));
        }
        let mut tags = BTreeSet::new();
        if !self.tag_ids.iter().all(|tag_id| tags.insert(*tag_id)) {
            return Err(LedgerError::DuplicateTag);
        }

        Ok(())
    }
}

pub async fn post_journal(pool: &PgPool, command: &PostJournal) -> Result<i64, LedgerError> {
    let mut tx = pool.begin().await?;
    let journal_id = post_journal_in_tx(&mut tx, command, None).await?;
    tx.commit().await?;
    Ok(journal_id)
}

pub(crate) async fn post_journal_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    command: &PostJournal,
    cloned_from_id: Option<i64>,
) -> Result<i64, LedgerError> {
    command.validate()?;

    let description = command.description.trim();
    let journal_id = insert_journal(tx, command, None, cloned_from_id).await?;
    mark_posted(tx, journal_id).await?;

    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, book_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, after_data
        )
        SELECT b.organization_id, b.id, $2, $3, 'journal.posted',
               'journal_entry', $1, jsonb_build_object('description', $4)
        FROM books b
        WHERE b.id = $5
        "#,
    )
    .bind(journal_id)
    .bind(command.audit_actor_kind.as_str())
    .bind(command.created_by_user_id)
    .bind(description)
    .bind(command.book_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO outbox_events (book_id, event_type, aggregate_type, aggregate_id, payload)
        VALUES ($1, 'journal.posted', 'journal_entry', $2, jsonb_build_object('journal_entry_id', $2))
        "#,
    )
    .bind(command.book_id)
    .bind(journal_id)
    .execute(&mut **tx)
    .await?;

    Ok(journal_id)
}

pub async fn reverse_journal(pool: &PgPool, command: &ReverseJournal) -> Result<i64, LedgerError> {
    let mut tx = pool.begin().await?;
    let reversal_id = reverse_journal_in_tx(&mut tx, command).await?;
    tx.commit().await?;
    Ok(reversal_id)
}

pub async fn trash_journal(pool: &PgPool, command: &ReverseJournal) -> Result<i64, LedgerError> {
    let mut tx = pool.begin().await?;
    let reversal_id = trash_journal_in_tx(&mut tx, command).await?;
    tx.commit().await?;
    Ok(reversal_id)
}

pub(crate) async fn trash_journal_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    command: &ReverseJournal,
) -> Result<i64, LedgerError> {
    let reversal_id = reverse_journal_in_tx(tx, command).await?;
    let reason = command.reason.trim();
    sqlx::query(
        r#"
        INSERT INTO transaction_recycle_bin (
            book_id, original_journal_id, reversal_journal_id, deleted_by_user_id,
            deleted_actor_kind, delete_reason
        ) VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(command.book_id)
    .bind(command.journal_id)
    .bind(reversal_id)
    .bind(command.actor_user_id)
    .bind(command.audit_actor_kind.as_str())
    .bind(reason)
    .execute(&mut **tx)
    .await?;
    record_lifecycle_event(tx, command, "journal.trashed", reversal_id, reason).await?;
    Ok(reversal_id)
}

pub async fn restore_trashed_journal(
    pool: &PgPool,
    command: &ReverseJournal,
) -> Result<i64, LedgerError> {
    if command.reason.trim().is_empty() {
        return Err(LedgerError::EmptyReversalReason);
    }
    let mut tx = pool.begin().await?;
    let recycle = sqlx::query_as::<_, (i64, Option<OffsetDateTime>)>(
        r#"
        SELECT reversal_journal_id, restored_at
        FROM transaction_recycle_bin
        WHERE book_id = $1 AND original_journal_id = $2
        FOR UPDATE
        "#,
    )
    .bind(command.book_id)
    .bind(command.journal_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(LedgerError::JournalNotTrashed)?;
    if recycle.1.is_some() {
        return Err(LedgerError::AlreadyRestored);
    }
    let restore_command = ReverseJournal {
        book_id: command.book_id,
        journal_id: recycle.0,
        occurred_at: command.occurred_at,
        reason: command.reason.clone(),
        actor_user_id: command.actor_user_id,
        audit_actor_kind: command.audit_actor_kind,
    };
    let restored_id = reverse_journal_in_tx(&mut tx, &restore_command).await?;
    sqlx::query(
        r#"
        UPDATE transaction_recycle_bin
        SET restored_journal_id = $3, restored_by_user_id = $4,
            restored_actor_kind = $5, restore_reason = $6, restored_at = now()
        WHERE book_id = $1 AND original_journal_id = $2
        "#,
    )
    .bind(command.book_id)
    .bind(command.journal_id)
    .bind(restored_id)
    .bind(command.actor_user_id)
    .bind(command.audit_actor_kind.as_str())
    .bind(command.reason.trim())
    .execute(&mut *tx)
    .await?;
    record_lifecycle_event(
        &mut tx,
        command,
        "journal.restored",
        restored_id,
        command.reason.trim(),
    )
    .await?;
    tx.commit().await?;
    Ok(restored_id)
}

pub(crate) async fn reverse_journal_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    command: &ReverseJournal,
) -> Result<i64, LedgerError> {
    let reason = command.reason.trim();
    if reason.is_empty() {
        return Err(LedgerError::EmptyReversalReason);
    }

    let original = sqlx::query_as::<_, (String, String, Option<i64>)>(
        r#"
        SELECT status, description, counterparty_id
        FROM journal_entries
        WHERE book_id = $1 AND id = $2
        FOR UPDATE
        "#,
    )
    .bind(command.book_id)
    .bind(command.journal_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or(LedgerError::JournalNotFound)?;
    if original.0 == "reversed" {
        return Err(LedgerError::AlreadyReversed);
    }
    if original.0 != "posted" {
        return Err(LedgerError::JournalNotPosted);
    }

    let postings = sqlx::query_as::<_, (i64, Option<i64>, Decimal, Decimal, Option<String>)>(
        r#"
        SELECT account_id, budget_id, amount, book_amount, memo
        FROM postings
        WHERE book_id = $1 AND journal_entry_id = $2
        ORDER BY line_no
        "#,
    )
    .bind(command.book_id)
    .bind(command.journal_id)
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .map(
        |(account_id, budget_id, amount, book_amount, memo)| PostingInput {
            account_id,
            budget_id,
            amount: -amount,
            book_amount: -book_amount,
            memo,
        },
    )
    .collect();
    let tag_ids = sqlx::query_scalar::<_, i64>(
        "SELECT tag_id FROM journal_entry_tags WHERE book_id = $1 AND journal_entry_id = $2 ORDER BY tag_id",
    )
    .bind(command.book_id)
    .bind(command.journal_id)
    .fetch_all(&mut **tx)
    .await?;
    let reversal = PostJournal {
        book_id: command.book_id,
        description: format!("冲正：{}", original.1),
        occurred_at: command.occurred_at,
        counterparty_id: original.2,
        created_by_user_id: command.actor_user_id,
        audit_actor_kind: command.audit_actor_kind,
        postings,
        tag_ids,
    };
    reversal.validate()?;
    let reversal_id = insert_journal(tx, &reversal, Some(command.journal_id), None).await?;
    mark_posted(tx, reversal_id).await?;
    sqlx::query(
        "UPDATE journal_entries SET status = 'reversed', version = version + 1, updated_at = now() WHERE id = $1",
    )
    .bind(command.journal_id)
    .execute(&mut **tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, book_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, before_data, after_data, reason
        )
        SELECT b.organization_id, b.id, $2, $3, 'journal.reversed',
               'journal_entry', $1, jsonb_build_object('status', 'posted'),
               jsonb_build_object('status', 'reversed', 'reversal_journal_id', $4::bigint), $5
        FROM books b
        WHERE b.id = $6
        "#,
    )
    .bind(command.journal_id)
    .bind(command.audit_actor_kind.as_str())
    .bind(command.actor_user_id)
    .bind(reversal_id)
    .bind(reason)
    .bind(command.book_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO outbox_events (book_id, event_type, aggregate_type, aggregate_id, payload)
        VALUES ($1, 'journal.reversed', 'journal_entry', $2,
                jsonb_build_object('journal_entry_id', $2, 'reversal_journal_id', $3::bigint))
        "#,
    )
    .bind(command.book_id)
    .bind(command.journal_id)
    .bind(reversal_id)
    .execute(&mut **tx)
    .await?;
    Ok(reversal_id)
}

async fn record_lifecycle_event(
    tx: &mut Transaction<'_, Postgres>,
    command: &ReverseJournal,
    action: &'static str,
    related_journal_id: i64,
    reason: &str,
) -> Result<(), LedgerError> {
    sqlx::query(
        r#"
        INSERT INTO audit_events (
            organization_id, book_id, actor_kind, actor_user_id, action,
            entity_type, entity_id, after_data, reason
        )
        SELECT b.organization_id, b.id, $2, $3, $4, 'journal_entry', $5,
               jsonb_build_object('related_journal_id', $6::bigint), $7
        FROM books b WHERE b.id = $1
        "#,
    )
    .bind(command.book_id)
    .bind(command.audit_actor_kind.as_str())
    .bind(command.actor_user_id)
    .bind(action)
    .bind(command.journal_id)
    .bind(related_journal_id)
    .bind(reason)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        r#"
        INSERT INTO outbox_events (book_id, event_type, aggregate_type, aggregate_id, payload)
        VALUES ($1, $2, 'journal_entry', $3,
                jsonb_build_object('journal_entry_id', $3, 'related_journal_id', $4::bigint))
        "#,
    )
    .bind(command.book_id)
    .bind(action)
    .bind(command.journal_id)
    .bind(related_journal_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn insert_journal(
    tx: &mut Transaction<'_, Postgres>,
    command: &PostJournal,
    reversal_of_id: Option<i64>,
    cloned_from_id: Option<i64>,
) -> Result<i64, LedgerError> {
    let copies_historical_dimensions = reversal_of_id.is_some();
    if !copies_historical_dimensions && let Some(counterparty_id) = command.counterparty_id {
        let active = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM counterparties WHERE book_id = $1 AND id = $2 AND archived_at IS NULL)",
        )
        .bind(command.book_id)
        .bind(counterparty_id)
        .fetch_one(&mut **tx)
        .await?;
        if !active {
            return Err(LedgerError::InvalidCounterparty(counterparty_id));
        }
    }

    if !copies_historical_dimensions {
        for budget_id in command
            .postings
            .iter()
            .filter_map(|posting| posting.budget_id)
            .collect::<BTreeSet<_>>()
        {
            let active = sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS (SELECT 1 FROM budgets WHERE book_id = $1 AND id = $2 AND archived_at IS NULL)",
            )
            .bind(command.book_id)
            .bind(budget_id)
            .fetch_one(&mut **tx)
            .await?;
            if !active {
                return Err(LedgerError::InvalidBudget(budget_id));
            }
        }
    }

    let journal_id = sqlx::query_scalar::<_, i64>(
        r#"
        INSERT INTO journal_entries (
            book_id, status, occurred_at, description, counterparty_id,
            created_by_user_id, reversal_of_id, cloned_from_id
        )
        VALUES ($1, 'draft', $2, $3, $4, $5, $6, $7)
        RETURNING id
        "#,
    )
    .bind(command.book_id)
    .bind(command.occurred_at)
    .bind(command.description.trim())
    .bind(command.counterparty_id)
    .bind(command.created_by_user_id)
    .bind(reversal_of_id)
    .bind(cloned_from_id)
    .fetch_one(&mut **tx)
    .await?;

    for (index, posting) in command.postings.iter().enumerate() {
        let inserted = sqlx::query(
            r#"
            INSERT INTO postings (
                book_id, journal_entry_id, line_no, account_id, amount, book_amount, memo, budget_id
            )
            SELECT $1, $2, $3, a.id, $5, $6, $7, $8
            FROM ledger_accounts a
            WHERE a.book_id = $1
              AND a.id = $4
              AND a.postable = TRUE
              AND ($9 OR a.archived_at IS NULL)
            "#,
        )
        .bind(command.book_id)
        .bind(journal_id)
        .bind(index as i32)
        .bind(posting.account_id)
        .bind(posting.amount)
        .bind(posting.book_amount)
        .bind(
            posting
                .memo
                .as_deref()
                .map(str::trim)
                .filter(|memo| !memo.is_empty()),
        )
        .bind(posting.budget_id)
        .bind(copies_historical_dimensions)
        .execute(&mut **tx)
        .await?;

        if inserted.rows_affected() != 1 {
            return Err(LedgerError::InvalidAccount(posting.account_id));
        }
    }

    for tag_id in &command.tag_ids {
        let inserted = sqlx::query(
            r#"
            INSERT INTO journal_entry_tags (book_id, journal_entry_id, tag_id)
            SELECT $1, $2, t.id
            FROM tags t
            WHERE t.book_id = $1 AND t.id = $3 AND ($4 OR t.archived_at IS NULL)
            "#,
        )
        .bind(command.book_id)
        .bind(journal_id)
        .bind(tag_id)
        .bind(copies_historical_dimensions)
        .execute(&mut **tx)
        .await?;
        if inserted.rows_affected() != 1 {
            return Err(LedgerError::InvalidTag(*tag_id));
        }
    }

    Ok(journal_id)
}

async fn mark_posted(
    tx: &mut Transaction<'_, Postgres>,
    journal_id: i64,
) -> Result<(), LedgerError> {
    sqlx::query("UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1")
        .bind(journal_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::Decimal;

    fn command(postings: Vec<PostingInput>) -> PostJournal {
        PostJournal {
            book_id: 1,
            description: "Lunch".to_owned(),
            occurred_at: OffsetDateTime::UNIX_EPOCH,
            counterparty_id: None,
            created_by_user_id: 1,
            audit_actor_kind: AuditActorKind::User,
            postings,
            tag_ids: Vec::new(),
        }
    }

    fn posting(account_id: i64, amount: i64) -> PostingInput {
        PostingInput {
            account_id,
            budget_id: None,
            amount: Decimal::from(amount),
            book_amount: Decimal::from(amount),
            memo: None,
        }
    }

    #[test]
    fn accepts_a_balanced_journal() {
        let value = command(vec![posting(1, -100), posting(2, 100)]);
        assert!(value.validate().is_ok());
    }

    #[test]
    fn rejects_an_unbalanced_journal() {
        let value = command(vec![posting(1, -100), posting(2, 90)]);
        assert!(matches!(value.validate(), Err(LedgerError::Unbalanced(_))));
    }

    #[test]
    fn rejects_zero_and_single_postings() {
        let single = command(vec![posting(1, 100)]);
        assert!(matches!(
            single.validate(),
            Err(LedgerError::TooFewPostings)
        ));

        let zero = command(vec![posting(1, 0), posting(2, 0)]);
        assert!(matches!(zero.validate(), Err(LedgerError::ZeroAmount(0))));
    }
}
