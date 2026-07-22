ALTER TABLE users
    ADD COLUMN disabled_by_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
    ADD COLUMN disabled_reason text CHECK (
        disabled_reason IS NULL OR length(btrim(disabled_reason)) BETWEEN 1 AND 500
    ),
    ADD CONSTRAINT users_disabled_metadata_consistent CHECK (
        (disabled_at IS NULL AND disabled_by_user_id IS NULL AND disabled_reason IS NULL)
        OR (disabled_at IS NOT NULL AND disabled_by_user_id IS NOT NULL AND disabled_reason IS NOT NULL)
    );

ALTER TABLE user_sessions
    ADD COLUMN user_agent text CHECK (user_agent IS NULL OR length(user_agent) <= 1024),
    ADD COLUMN revoked_at timestamptz,
    ADD COLUMN revoked_by_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
    ADD COLUMN revoke_reason text CHECK (
        revoke_reason IS NULL OR length(btrim(revoke_reason)) BETWEEN 1 AND 200
    ),
    ADD CONSTRAINT user_sessions_revocation_consistent CHECK (
        (revoked_at IS NULL AND revoked_by_user_id IS NULL AND revoke_reason IS NULL)
        OR (revoked_at IS NOT NULL AND revoke_reason IS NOT NULL)
    );

CREATE INDEX user_sessions_user_activity_lookup
    ON user_sessions (user_id, created_at DESC, id DESC);

ALTER TABLE organizations
    ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE books
    ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version > 0);
