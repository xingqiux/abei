CREATE TABLE user_mfa (
    user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_secret bytea NOT NULL,
    nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
    enabled_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_recovery_codes (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
    used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, code_hash)
);

CREATE TABLE mfa_login_challenges (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    auth_epoch bigint NOT NULL,
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_login_challenges_expiry_lookup ON mfa_login_challenges (expires_at);
