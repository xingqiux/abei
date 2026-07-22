CREATE TABLE password_reset_tokens (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    selector text NOT NULL UNIQUE CHECK (selector ~ '^[0-9a-f]{16}$'),
    token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at)
);

CREATE INDEX password_reset_tokens_user_lookup
    ON password_reset_tokens (user_id, created_at DESC);
