ALTER TABLE ledger_accounts
    ADD COLUMN system_key text
    CHECK (system_key IS NULL OR system_key IN ('default_income', 'default_expense'));

CREATE UNIQUE INDEX ledger_accounts_book_system_key_unique
    ON ledger_accounts (book_id, system_key)
    WHERE system_key IS NOT NULL;

WITH candidates AS (
    SELECT DISTINCT ON (c.book_id, c.kind)
           c.book_id, c.kind, c.ledger_account_id
    FROM categories c
    JOIN ledger_accounts a
      ON a.book_id = c.book_id AND a.id = c.ledger_account_id
    WHERE c.kind IN ('income', 'expense')
      AND c.archived_at IS NULL
      AND a.archived_at IS NULL
    ORDER BY c.book_id, c.kind,
             CASE c.name
                 WHEN '未分类收入' THEN 0
                 WHEN '未分类支出' THEN 0
                 ELSE 1
             END,
             c.id
)
UPDATE ledger_accounts a
SET system_key = CASE candidates.kind
                     WHEN 'income' THEN 'default_income'
                     ELSE 'default_expense'
                 END
FROM candidates
WHERE a.book_id = candidates.book_id
  AND a.id = candidates.ledger_account_id;

INSERT INTO ledger_accounts (
    book_id, name, class, role, currency_code, hidden, system_key
)
SELECT b.id, '系统默认收入', 'income', 'category', b.base_currency_code, TRUE, 'default_income'
FROM books b
WHERE NOT EXISTS (
    SELECT 1 FROM ledger_accounts a
    WHERE a.book_id = b.id AND a.system_key = 'default_income'
);

INSERT INTO ledger_accounts (
    book_id, name, class, role, currency_code, hidden, system_key
)
SELECT b.id, '系统默认费用', 'expense', 'category', b.base_currency_code, TRUE, 'default_expense'
FROM books b
WHERE NOT EXISTS (
    SELECT 1 FROM ledger_accounts a
    WHERE a.book_id = b.id AND a.system_key = 'default_expense'
);

ALTER TABLE postings
    ADD COLUMN category_id bigint;

DROP TRIGGER postings_immutable_after_post ON postings;

UPDATE postings p
SET category_id = c.id
FROM categories c
WHERE c.book_id = p.book_id
  AND c.ledger_account_id = p.account_id;

-- The backfill queues the deferred balance constraint trigger. Drain it before
-- altering postings again, then restore the transaction's deferred mode.
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;

CREATE TRIGGER postings_immutable_after_post
    BEFORE INSERT OR UPDATE OR DELETE ON postings
    FOR EACH ROW EXECUTE FUNCTION protect_posted_posting();

ALTER TABLE postings
    ADD CONSTRAINT postings_category_same_book
        FOREIGN KEY (book_id, category_id) REFERENCES categories(book_id, id) ON DELETE RESTRICT;

CREATE INDEX postings_category_journal_lookup
    ON postings (book_id, category_id, journal_entry_id)
    WHERE category_id IS NOT NULL;

DROP TRIGGER postings_validate_budget ON postings;
DROP FUNCTION validate_posting_budget();
DROP TRIGGER postings_require_leaf_category ON postings;
DROP FUNCTION require_leaf_category_posting();
DROP TRIGGER categories_validate ON categories;
DROP FUNCTION validate_category();

ALTER TABLE categories
    DROP COLUMN ledger_account_id,
    DROP COLUMN kind;

CREATE FUNCTION validate_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    parent_parent_id bigint;
    parent_archived_at timestamptz;
BEGIN
    IF NEW.parent_id IS NOT NULL THEN
        SELECT parent_id, archived_at
        INTO parent_parent_id, parent_archived_at
        FROM categories
        WHERE book_id = NEW.book_id AND id = NEW.parent_id;

        IF NOT FOUND OR parent_parent_id IS NOT NULL OR parent_archived_at IS NOT NULL THEN
            RAISE EXCEPTION 'categories support at most two active levels'
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

    RETURN NEW;
END;
$$;

CREATE TRIGGER categories_validate
    BEFORE INSERT OR UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION validate_category();

CREATE FUNCTION validate_posting_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    category_archived_at timestamptz;
    copies_historical_dimension boolean;
BEGIN
    IF NEW.category_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT reversal_of_id IS NOT NULL
    INTO copies_historical_dimension
    FROM journal_entries
    WHERE book_id = NEW.book_id AND id = NEW.journal_entry_id;

    SELECT archived_at INTO category_archived_at
    FROM categories
    WHERE book_id = NEW.book_id AND id = NEW.category_id;

    IF NOT FOUND OR (category_archived_at IS NOT NULL AND NOT COALESCE(copies_historical_dimension, FALSE)) THEN
        RAISE EXCEPTION 'posting category must be active and belong to the same book'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1 FROM categories child
        WHERE child.book_id = NEW.book_id
          AND child.parent_id = NEW.category_id
          AND child.archived_at IS NULL
    ) THEN
        RAISE EXCEPTION 'only leaf categories may be assigned to postings'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER postings_validate_category
    BEFORE INSERT OR UPDATE OF category_id, book_id, journal_entry_id ON postings
    FOR EACH ROW EXECUTE FUNCTION validate_posting_category();

CREATE FUNCTION validate_posting_budget() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    account_class text;
BEGIN
    IF NEW.budget_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT class INTO account_class
    FROM ledger_accounts
    WHERE book_id = NEW.book_id AND id = NEW.account_id;

    IF account_class IS DISTINCT FROM 'expense' OR NEW.category_id IS NULL THEN
        RAISE EXCEPTION 'budgets may only be assigned to categorized expense postings'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER postings_validate_budget
    BEFORE INSERT OR UPDATE OF budget_id, category_id, account_id, book_id ON postings
    FOR EACH ROW EXECUTE FUNCTION validate_posting_budget();
