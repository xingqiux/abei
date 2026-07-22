CREATE TABLE transaction_recycle_bin (
    book_id bigint NOT NULL,
    original_journal_id bigint NOT NULL,
    reversal_journal_id bigint NOT NULL,
    deleted_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    deleted_actor_kind text NOT NULL CHECK (deleted_actor_kind IN ('user', 'pat', 'system', 'import', 'job')),
    delete_reason text NOT NULL CHECK (btrim(delete_reason) <> ''),
    deleted_at timestamptz NOT NULL DEFAULT now(),
    restored_journal_id bigint,
    restored_by_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
    restored_actor_kind text CHECK (restored_actor_kind IN ('user', 'pat', 'system', 'import', 'job')),
    restore_reason text,
    restored_at timestamptz,
    PRIMARY KEY (book_id, original_journal_id),
    UNIQUE (book_id, reversal_journal_id),
    UNIQUE (book_id, restored_journal_id),
    FOREIGN KEY (book_id, original_journal_id) REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (book_id, reversal_journal_id) REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (book_id, restored_journal_id) REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT,
    CHECK (
        (restored_at IS NULL AND restored_journal_id IS NULL AND restored_by_user_id IS NULL
         AND restored_actor_kind IS NULL AND restore_reason IS NULL)
        OR
        (restored_at IS NOT NULL AND restored_journal_id IS NOT NULL AND restored_by_user_id IS NOT NULL
         AND restored_actor_kind IS NOT NULL AND btrim(restore_reason) <> '')
    )
);

CREATE INDEX transaction_recycle_bin_active_lookup
    ON transaction_recycle_bin (book_id, deleted_at DESC, original_journal_id DESC)
    WHERE restored_at IS NULL;
