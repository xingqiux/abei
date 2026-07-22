ALTER TABLE journal_entries
    ADD COLUMN cloned_from_id bigint,
    ADD CONSTRAINT journal_entries_clone_not_self
        CHECK (cloned_from_id IS NULL OR cloned_from_id <> id),
    ADD CONSTRAINT journal_entries_clone_same_book
        FOREIGN KEY (book_id, cloned_from_id)
        REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT;

CREATE INDEX journal_entries_clone_lookup
    ON journal_entries (book_id, cloned_from_id)
    WHERE cloned_from_id IS NOT NULL;

CREATE TABLE transaction_batch_previews (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    book_id bigint NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
    actor_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'pat')),
    operation text NOT NULL CHECK (operation IN ('replace', 'trash')),
    request jsonb NOT NULL CHECK (jsonb_typeof(request) = 'object'),
    expires_at timestamptz NOT NULL,
    executed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (book_id, id),
    CHECK (expires_at > created_at),
    CHECK (executed_at IS NULL OR executed_at >= created_at)
);

CREATE INDEX transaction_batch_previews_active_lookup
    ON transaction_batch_previews (book_id, actor_user_id, expires_at, id)
    WHERE executed_at IS NULL;

CREATE TABLE transaction_replacements (
    book_id bigint NOT NULL,
    original_journal_id bigint NOT NULL,
    reversal_journal_id bigint NOT NULL,
    replacement_journal_id bigint NOT NULL,
    batch_preview_id bigint,
    replaced_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    replaced_actor_kind text NOT NULL CHECK (replaced_actor_kind IN ('user', 'pat', 'system', 'import', 'job')),
    reason text NOT NULL CHECK (btrim(reason) <> ''),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (book_id, original_journal_id),
    UNIQUE (book_id, reversal_journal_id),
    UNIQUE (book_id, replacement_journal_id),
    FOREIGN KEY (book_id, original_journal_id)
        REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (book_id, reversal_journal_id)
        REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (book_id, replacement_journal_id)
        REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (book_id, batch_preview_id)
        REFERENCES transaction_batch_previews(book_id, id) ON DELETE RESTRICT,
    CHECK (original_journal_id <> reversal_journal_id),
    CHECK (original_journal_id <> replacement_journal_id),
    CHECK (reversal_journal_id <> replacement_journal_id)
);

CREATE OR REPLACE FUNCTION protect_posted_journal() RETURNS trigger LANGUAGE plpgsql AS $$
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
           AND NEW.cloned_from_id IS NOT DISTINCT FROM OLD.cloned_from_id
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
