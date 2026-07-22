CREATE TABLE currencies (
    code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
    name text NOT NULL,
    symbol text NOT NULL,
    exponent smallint NOT NULL CHECK (exponent BETWEEN 0 AND 8),
    enabled_by_default boolean NOT NULL DEFAULT false
);

INSERT INTO currencies (code, name, symbol, exponent, enabled_by_default) VALUES
    ('CNY', 'Chinese Yuan', 'CN¥', 2, true),
    ('USD', 'US Dollar', '$', 2, true),
    ('HKD', 'Hong Kong Dollar', 'HK$', 2, true),
    ('EUR', 'Euro', '€', 2, true),
    ('JPY', 'Japanese Yen', '¥', 0, true),
    ('GBP', 'Pound Sterling', '£', 2, true);

CREATE TABLE users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text NOT NULL,
    display_name text NOT NULL CHECK (btrim(display_name) <> ''),
    password_hash text NOT NULL,
    is_instance_admin boolean NOT NULL DEFAULT false,
    auth_epoch bigint NOT NULL DEFAULT 0,
    disabled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE organizations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL CHECK (btrim(name) <> ''),
    kind text NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'household', 'business')),
    created_by_user_id bigint NOT NULL REFERENCES users(id),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE books (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (btrim(name) <> ''),
    base_currency_code text NOT NULL DEFAULT 'CNY' REFERENCES currencies(code),
    timezone text NOT NULL DEFAULT 'Asia/Shanghai' CHECK (btrim(timezone) <> ''),
    archived_at timestamptz,
    created_by_user_id bigint NOT NULL REFERENCES users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name),
    UNIQUE (id, organization_id)
);

CREATE TABLE book_memberships (
    book_id bigint NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role text NOT NULL CHECK (role IN ('manager', 'editor', 'viewer')),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (book_id, user_id)
);

CREATE TABLE ledger_accounts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id bigint NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
    parent_id bigint,
    name text NOT NULL CHECK (btrim(name) <> ''),
    class text NOT NULL CHECK (class IN ('asset', 'liability', 'equity', 'income', 'expense')),
    role text NOT NULL CHECK (role IN (
        'bank', 'cash', 'card', 'loan', 'category', 'opening_balance',
        'reconciliation', 'fx_gain_loss', 'other'
    )),
    currency_code text NOT NULL REFERENCES currencies(code),
    postable boolean NOT NULL DEFAULT true,
    hidden boolean NOT NULL DEFAULT false,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (book_id, id),
    FOREIGN KEY (book_id, parent_id) REFERENCES ledger_accounts(book_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ledger_accounts_active_name_unique
    ON ledger_accounts (book_id, lower(name))
    WHERE archived_at IS NULL;

CREATE TABLE counterparties (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id bigint NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (btrim(name) <> ''),
    kind text NOT NULL DEFAULT 'merchant' CHECK (kind IN ('merchant', 'person', 'institution', 'other')),
    review_status text NOT NULL DEFAULT 'confirmed' CHECK (review_status IN ('confirmed', 'unreviewed')),
    notes text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (book_id, id)
);

CREATE UNIQUE INDEX counterparties_active_name_unique
    ON counterparties (book_id, lower(name))
    WHERE archived_at IS NULL;

CREATE TABLE categories (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id bigint NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
    parent_id bigint,
    ledger_account_id bigint NOT NULL,
    name text NOT NULL CHECK (btrim(name) <> ''),
    kind text NOT NULL CHECK (kind IN ('income', 'expense')),
    archived_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (book_id, id),
    UNIQUE (book_id, ledger_account_id),
    FOREIGN KEY (book_id, parent_id) REFERENCES categories(book_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (book_id, ledger_account_id) REFERENCES ledger_accounts(book_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX categories_active_name_unique
    ON categories (book_id, lower(name))
    WHERE archived_at IS NULL;

CREATE TABLE journal_entries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id bigint NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'reversed')),
    occurred_at timestamptz NOT NULL,
    description text NOT NULL CHECK (btrim(description) <> ''),
    counterparty_id bigint,
    created_by_user_id bigint NOT NULL REFERENCES users(id),
    reversal_of_id bigint UNIQUE REFERENCES journal_entries(id) ON DELETE RESTRICT,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    posted_at timestamptz,
    trashed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (book_id, id),
    FOREIGN KEY (book_id, counterparty_id) REFERENCES counterparties(book_id, id) ON DELETE RESTRICT,
    CHECK ((status = 'draft' AND posted_at IS NULL) OR (status <> 'draft' AND posted_at IS NOT NULL)),
    CHECK (status = 'draft' OR trashed_at IS NULL)
);

CREATE TABLE postings (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id bigint NOT NULL,
    journal_entry_id bigint NOT NULL,
    line_no integer NOT NULL CHECK (line_no >= 0),
    account_id bigint NOT NULL,
    amount numeric(28, 8) NOT NULL CHECK (amount <> 0),
    book_amount numeric(28, 8) NOT NULL CHECK (book_amount <> 0),
    memo text,
    cleared_at timestamptz,
    reconciliation_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (journal_entry_id, line_no),
    FOREIGN KEY (book_id, journal_entry_id) REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (book_id, account_id) REFERENCES ledger_accounts(book_id, id) ON DELETE RESTRICT
);

CREATE INDEX postings_account_occurred_lookup ON postings (book_id, account_id, journal_entry_id);

CREATE TABLE audit_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id bigint REFERENCES organizations(id) ON DELETE RESTRICT,
    book_id bigint REFERENCES books(id) ON DELETE RESTRICT,
    actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'pat', 'system', 'import', 'job')),
    actor_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
    action text NOT NULL CHECK (btrim(action) <> ''),
    entity_type text NOT NULL CHECK (btrim(entity_type) <> ''),
    entity_id bigint,
    before_data jsonb,
    after_data jsonb,
    reason text,
    request_id text,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_events_book_time_lookup ON audit_events (book_id, occurred_at DESC, id DESC);

CREATE TABLE outbox_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id bigint REFERENCES books(id) ON DELETE RESTRICT,
    event_type text NOT NULL CHECK (btrim(event_type) <> ''),
    aggregate_type text NOT NULL CHECK (btrim(aggregate_type) <> ''),
    aggregate_id bigint,
    payload jsonb NOT NULL,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    claimed_at timestamptz,
    completed_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_events_pending_lookup
    ON outbox_events (available_at, id)
    WHERE completed_at IS NULL;

CREATE FUNCTION validate_category() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    account_class text;
    account_role text;
    parent_parent_id bigint;
    parent_kind text;
BEGIN
    SELECT class, role INTO account_class, account_role
    FROM ledger_accounts
    WHERE book_id = NEW.book_id AND id = NEW.ledger_account_id;

    IF account_class IS DISTINCT FROM NEW.kind OR account_role IS DISTINCT FROM 'category' THEN
        RAISE EXCEPTION 'category ledger account must be a matching income/expense category account'
            USING ERRCODE = '23514';
    END IF;

    IF NEW.parent_id IS NOT NULL THEN
        SELECT parent_id, kind INTO parent_parent_id, parent_kind
        FROM categories
        WHERE book_id = NEW.book_id AND id = NEW.parent_id;

        IF parent_kind IS NULL OR parent_kind <> NEW.kind OR parent_parent_id IS NOT NULL THEN
            RAISE EXCEPTION 'categories support at most two levels and parent kind must match'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER categories_validate
    BEFORE INSERT OR UPDATE ON categories
    FOR EACH ROW EXECUTE FUNCTION validate_category();

CREATE FUNCTION protect_posted_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    parent_status text;
BEGIN
    SELECT status INTO parent_status
    FROM journal_entries
    WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);

    IF parent_status <> 'draft' THEN
        RAISE EXCEPTION 'postings of a posted journal are immutable' USING ERRCODE = '55000';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER postings_immutable_after_post
    BEFORE INSERT OR UPDATE OR DELETE ON postings
    FOR EACH ROW EXECUTE FUNCTION protect_posted_posting();

CREATE FUNCTION enforce_balanced_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    trigger_row jsonb;
    target_id bigint;
    target_status text;
    posting_count bigint;
    balance numeric(28, 8);
BEGIN
    trigger_row := COALESCE(to_jsonb(NEW), to_jsonb(OLD));
    target_id := CASE
        WHEN TG_TABLE_NAME = 'journal_entries' THEN (trigger_row ->> 'id')::bigint
        ELSE (trigger_row ->> 'journal_entry_id')::bigint
    END;

    SELECT status INTO target_status FROM journal_entries WHERE id = target_id;
    IF target_status IN ('posted', 'reversed') THEN
        SELECT count(*), COALESCE(sum(book_amount), 0)
        INTO posting_count, balance
        FROM postings
        WHERE journal_entry_id = target_id;

        IF posting_count < 2 OR balance <> 0 THEN
            RAISE EXCEPTION 'posted journal % must have at least two postings and balance to zero', target_id
                USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER postings_balance_check
    AFTER INSERT OR UPDATE OR DELETE ON postings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_balanced_journal();

CREATE CONSTRAINT TRIGGER journal_status_balance_check
    AFTER INSERT OR UPDATE OF status ON journal_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_balanced_journal();

CREATE FUNCTION protect_book_currency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.base_currency_code <> OLD.base_currency_code AND EXISTS (
        SELECT 1 FROM journal_entries WHERE book_id = OLD.id AND status <> 'draft'
    ) THEN
        RAISE EXCEPTION 'book base currency cannot change after posting transactions'
            USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER books_currency_immutable_after_post
    BEFORE UPDATE OF base_currency_code ON books
    FOR EACH ROW EXECUTE FUNCTION protect_book_currency();

CREATE FUNCTION protect_audit_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit events are append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION protect_audit_event();
