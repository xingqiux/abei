ALTER TABLE categories
    ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE journal_entries
    ADD CONSTRAINT journal_entries_reversal_not_self
    CHECK (reversal_of_id IS NULL OR reversal_of_id <> id);

CREATE FUNCTION protect_account_dimensions() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.book_id <> OLD.book_id THEN
        RAISE EXCEPTION 'ledger accounts cannot move between books' USING ERRCODE = '55000';
    END IF;

    IF (NEW.class <> OLD.class OR NEW.currency_code <> OLD.currency_code) AND EXISTS (
        SELECT 1 FROM postings WHERE book_id = OLD.book_id AND account_id = OLD.id
    ) THEN
        RAISE EXCEPTION 'account class and currency cannot change after posting transactions'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_accounts_dimensions_immutable_after_post
    BEFORE UPDATE OF book_id, class, currency_code ON ledger_accounts
    FOR EACH ROW EXECUTE FUNCTION protect_account_dimensions();

CREATE OR REPLACE FUNCTION validate_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    account_class text;
    account_role text;
    parent_parent_id bigint;
    parent_kind text;
    parent_archived_at timestamptz;
BEGIN
    SELECT class, role INTO account_class, account_role
    FROM ledger_accounts
    WHERE book_id = NEW.book_id AND id = NEW.ledger_account_id;

    IF account_class IS DISTINCT FROM NEW.kind OR account_role IS DISTINCT FROM 'category' THEN
        RAISE EXCEPTION 'category ledger account must be a matching income/expense category account'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.parent_id IS NOT NULL THEN
        SELECT parent_id, kind, archived_at INTO parent_parent_id, parent_kind, parent_archived_at
        FROM categories
        WHERE book_id = NEW.book_id AND id = NEW.parent_id;

        IF parent_kind IS NULL OR parent_kind <> NEW.kind OR parent_parent_id IS NOT NULL
           OR parent_archived_at IS NOT NULL THEN
            RAISE EXCEPTION 'categories support at most two levels and parent kind must match'
                USING ERRCODE = '23514';
        END IF;

        IF EXISTS (
            SELECT 1 FROM categories
            WHERE book_id = NEW.book_id AND parent_id = NEW.id AND archived_at IS NULL
        ) THEN
            RAISE EXCEPTION 'a category with children cannot become a child category'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    IF TG_OP = 'UPDATE' AND NEW.kind <> OLD.kind AND EXISTS (
        SELECT 1 FROM categories
        WHERE book_id = NEW.book_id AND parent_id = NEW.id AND kind <> NEW.kind
    ) THEN
        RAISE EXCEPTION 'parent and child category kinds must match'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE FUNCTION require_leaf_category_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM categories parent
        JOIN categories child
          ON child.book_id = parent.book_id
         AND child.parent_id = parent.id
         AND child.archived_at IS NULL
        WHERE parent.book_id = NEW.book_id
          AND parent.ledger_account_id = NEW.account_id
          AND parent.archived_at IS NULL
    ) THEN
        RAISE EXCEPTION 'only leaf categories may receive postings' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER postings_require_leaf_category
    BEFORE INSERT ON postings
    FOR EACH ROW EXECUTE FUNCTION require_leaf_category_posting();

CREATE FUNCTION protect_posted_journal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'posted journal entries are immutable' USING ERRCODE = '55000';
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.status <> 'draft' THEN
        IF OLD.status = 'posted'
           AND NEW.status = 'reversed'
           AND NEW.book_id = OLD.book_id
           AND NEW.occurred_at = OLD.occurred_at
           AND NEW.description = OLD.description
           AND NEW.counterparty_id IS NOT DISTINCT FROM OLD.counterparty_id
           AND NEW.created_by_user_id = OLD.created_by_user_id
           AND NEW.reversal_of_id IS NOT DISTINCT FROM OLD.reversal_of_id
           AND NEW.posted_at = OLD.posted_at
           AND NEW.trashed_at IS NOT DISTINCT FROM OLD.trashed_at
           AND EXISTS (
               SELECT 1 FROM journal_entries reversal
               WHERE reversal.reversal_of_id = OLD.id AND reversal.status = 'posted'
           ) THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION 'posted journal entries are immutable' USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER journal_entries_immutable_after_post
    BEFORE UPDATE OR DELETE ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION protect_posted_journal();
