CREATE TABLE tags (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id bigint NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (btrim(name) <> ''),
    color text CHECK (color IS NULL OR color ~ '^#[0-9A-F]{6}$'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (book_id, id)
);

CREATE UNIQUE INDEX tags_active_name_unique
    ON tags (book_id, lower(name))
    WHERE archived_at IS NULL;

CREATE TABLE journal_entry_tags (
    book_id bigint NOT NULL,
    journal_entry_id bigint NOT NULL,
    tag_id bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (journal_entry_id, tag_id),
    FOREIGN KEY (book_id, journal_entry_id)
        REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (book_id, tag_id)
        REFERENCES tags(book_id, id) ON DELETE RESTRICT
);

CREATE INDEX journal_entry_tags_book_tag_lookup
    ON journal_entry_tags (book_id, tag_id, journal_entry_id);

CREATE TABLE budgets (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id bigint NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (btrim(name) <> ''),
    color text CHECK (color IS NULL OR color ~ '^#[0-9A-F]{6}$'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (book_id, id)
);

CREATE UNIQUE INDEX budgets_active_name_unique
    ON budgets (book_id, lower(name))
    WHERE archived_at IS NULL;

CREATE TABLE budget_month_limits (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id bigint NOT NULL,
    budget_id bigint NOT NULL,
    month date NOT NULL CHECK (date_part('day', month) = 1),
    amount numeric(28, 8) NOT NULL CHECK (amount > 0),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (book_id, id),
    FOREIGN KEY (book_id, budget_id) REFERENCES budgets(book_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX budget_month_limits_active_unique
    ON budget_month_limits (budget_id, month)
    WHERE archived_at IS NULL;

ALTER TABLE postings
    ADD COLUMN budget_id bigint,
    ADD CONSTRAINT postings_budget_same_book
        FOREIGN KEY (book_id, budget_id) REFERENCES budgets(book_id, id) ON DELETE RESTRICT;

CREATE INDEX postings_budget_journal_lookup
    ON postings (book_id, budget_id, journal_entry_id)
    WHERE budget_id IS NOT NULL;

CREATE FUNCTION validate_posting_budget() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    category_kind text;
BEGIN
    IF NEW.budget_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c.kind INTO category_kind
    FROM categories c
    WHERE c.book_id = NEW.book_id AND c.ledger_account_id = NEW.account_id;

    IF category_kind IS DISTINCT FROM 'expense' THEN
        RAISE EXCEPTION 'budgets may only be assigned to expense category postings'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER postings_validate_budget
    BEFORE INSERT OR UPDATE OF budget_id, account_id, book_id ON postings
    FOR EACH ROW EXECUTE FUNCTION validate_posting_budget();
