CREATE TABLE user_sessions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
    auth_epoch bigint NOT NULL,
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_sessions_expiry_lookup ON user_sessions (expires_at);

CREATE TABLE personal_access_tokens (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    selector text NOT NULL UNIQUE CHECK (selector ~ '^[0-9a-f]{16}$'),
    token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (btrim(name) <> ''),
    scopes text[] NOT NULL DEFAULT '{}',
    expires_at timestamptz,
    revoked_at timestamptz,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX personal_access_tokens_user_lookup
    ON personal_access_tokens (user_id, created_at DESC);
