CREATE TABLE account_reconciliations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id bigint NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
    account_id bigint NOT NULL,
    statement_ending_at timestamptz NOT NULL,
    statement_balance numeric(28, 8) NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'completed', 'cancelled')),
    notes text,
    adjustment_journal_id bigint,
    completed_by_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
    completed_at timestamptz,
    cancelled_by_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
    cancelled_at timestamptz,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (book_id, id),
    FOREIGN KEY (book_id, account_id)
        REFERENCES ledger_accounts(book_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (book_id, adjustment_journal_id)
        REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT,
    CHECK (
        (status = 'draft' AND completed_at IS NULL AND completed_by_user_id IS NULL
                          AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
        OR
        (status = 'completed' AND completed_at IS NOT NULL AND completed_by_user_id IS NOT NULL
                              AND cancelled_at IS NULL AND cancelled_by_user_id IS NULL)
        OR
        (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by_user_id IS NOT NULL
                              AND completed_at IS NULL AND completed_by_user_id IS NULL
                              AND adjustment_journal_id IS NULL)
    )
);

CREATE UNIQUE INDEX account_reconciliations_one_draft_per_account
    ON account_reconciliations (book_id, account_id)
    WHERE status = 'draft';

CREATE INDEX account_reconciliations_book_time_lookup
    ON account_reconciliations (book_id, statement_ending_at DESC, id DESC);

ALTER TABLE postings
    ADD CONSTRAINT postings_reconciliation_same_book
        FOREIGN KEY (book_id, reconciliation_id)
        REFERENCES account_reconciliations(book_id, id) ON DELETE RESTRICT,
    ADD CONSTRAINT postings_cleared_requires_reconciliation
        CHECK (cleared_at IS NULL OR reconciliation_id IS NOT NULL);

CREATE FUNCTION protect_finalized_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' OR OLD.status <> 'draft' THEN
        RAISE EXCEPTION 'finalized reconciliations are immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER account_reconciliations_immutable_after_finalize
    BEFORE UPDATE OR DELETE ON account_reconciliations
    FOR EACH ROW EXECUTE FUNCTION protect_finalized_reconciliation();

CREATE OR REPLACE FUNCTION protect_posted_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    parent_status text;
BEGIN
    SELECT status INTO parent_status
    FROM journal_entries
    WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

    IF parent_status <> 'draft' THEN
        IF TG_OP = 'UPDATE'
           AND NEW.id = OLD.id
           AND NEW.book_id = OLD.book_id
           AND NEW.journal_entry_id = OLD.journal_entry_id
           AND NEW.line_no = OLD.line_no
           AND NEW.account_id = OLD.account_id
           AND NEW.amount = OLD.amount
           AND NEW.book_amount = OLD.book_amount
           AND NEW.memo IS NOT DISTINCT FROM OLD.memo
           AND NEW.budget_id IS NOT DISTINCT FROM OLD.budget_id
           AND NEW.created_at = OLD.created_at THEN
            RETURN NEW;
        END IF;
        RAISE EXCEPTION 'postings of a posted journal are immutable' USING ERRCODE = '55000';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE FUNCTION validate_posting_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    reconciliation_account_id bigint;
    reconciliation_status text;
BEGIN
    IF NEW.reconciliation_id IS NULL OR NEW.reconciliation_id IS NOT DISTINCT FROM OLD.reconciliation_id THEN
        RETURN NEW;
    END IF;

    IF OLD.cleared_at IS NOT NULL THEN
        RAISE EXCEPTION 'cleared postings cannot move to another reconciliation'
            USING ERRCODE = '55000';
    END IF;

    SELECT account_id, status INTO reconciliation_account_id, reconciliation_status
    FROM account_reconciliations
    WHERE book_id = NEW.book_id AND id = NEW.reconciliation_id;

    IF reconciliation_account_id IS NULL
       OR reconciliation_account_id <> NEW.account_id
       OR reconciliation_status <> 'draft' THEN
        RAISE EXCEPTION 'posting must belong to the draft reconciliation for the same account'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER postings_validate_reconciliation
    BEFORE UPDATE OF reconciliation_id ON postings
    FOR EACH ROW EXECUTE FUNCTION validate_posting_reconciliation();
