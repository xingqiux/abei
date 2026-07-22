CREATE TABLE instance_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    registration_mode text NOT NULL DEFAULT 'invite_only'
        CHECK (registration_mode IN ('invite_only', 'open')),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    updated_by_user_id bigint REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO instance_settings (singleton) VALUES (true);
