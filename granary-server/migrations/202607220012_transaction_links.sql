CREATE TABLE transaction_links (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN (
        'refund', 'reimbursement', 'installment', 'duplicate', 'related', 'cross_book_transfer'
    )),
    source_book_id bigint NOT NULL,
    source_journal_id bigint NOT NULL,
    target_book_id bigint NOT NULL,
    target_journal_id bigint NOT NULL,
    amount numeric(28, 8),
    created_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    deleted_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (source_book_id, source_journal_id)
        REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (target_book_id, target_journal_id)
        REFERENCES journal_entries(book_id, id) ON DELETE RESTRICT,
    CHECK (source_journal_id <> target_journal_id),
    CHECK (
        (kind IN ('refund', 'reimbursement') AND amount > 0)
        OR (kind NOT IN ('refund', 'reimbursement') AND amount IS NULL)
    ),
    CHECK (
        (kind = 'cross_book_transfer' AND source_book_id <> target_book_id)
        OR (kind <> 'cross_book_transfer' AND source_book_id = target_book_id)
    )
);

CREATE UNIQUE INDEX transaction_links_active_direction_unique
    ON transaction_links (kind, source_journal_id, target_journal_id)
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX transaction_links_active_symmetric_unique
    ON transaction_links (
        kind,
        LEAST(source_journal_id, target_journal_id),
        GREATEST(source_journal_id, target_journal_id)
    )
    WHERE deleted_at IS NULL AND kind IN ('duplicate', 'related');

CREATE INDEX transaction_links_source_lookup
    ON transaction_links (source_book_id, source_journal_id, id)
    WHERE deleted_at IS NULL;

CREATE INDEX transaction_links_target_lookup
    ON transaction_links (target_book_id, target_journal_id, id)
    WHERE deleted_at IS NULL;
