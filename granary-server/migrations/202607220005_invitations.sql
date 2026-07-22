CREATE TABLE organization_invitations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id bigint NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    email text NOT NULL,
    organization_role text NOT NULL CHECK (organization_role IN ('owner', 'admin', 'member')),
    selector text NOT NULL UNIQUE CHECK (selector ~ '^[0-9a-f]{16}$'),
    token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
    invited_by_user_id bigint NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    expires_at timestamptz NOT NULL,
    accepted_by_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
    accepted_at timestamptz,
    revoked_by_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, organization_id),
    CHECK (expires_at > created_at),
    CHECK ((accepted_at IS NULL) = (accepted_by_user_id IS NULL)),
    CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL)),
    CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

CREATE UNIQUE INDEX organization_invitations_active_email_unique
    ON organization_invitations (organization_id, lower(email))
    WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE organization_invitation_books (
    invitation_id bigint NOT NULL,
    organization_id bigint NOT NULL,
    book_id bigint NOT NULL,
    role text NOT NULL CHECK (role IN ('manager', 'editor', 'viewer')),
    PRIMARY KEY (invitation_id, book_id),
    FOREIGN KEY (invitation_id, organization_id)
        REFERENCES organization_invitations(id, organization_id) ON DELETE CASCADE,
    FOREIGN KEY (book_id, organization_id)
        REFERENCES books(id, organization_id) ON DELETE RESTRICT
);
