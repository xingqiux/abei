CREATE TABLE IF NOT EXISTS abei_ai.mail_rules (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  enabled BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 10000),
  current_version INTEGER CHECK (current_version > 0),
  draft_conditions JSONB NOT NULL DEFAULT '{"type":"all","conditions":[]}'::jsonb,
  draft_channel_key TEXT NOT NULL DEFAULT '' CHECK (char_length(draft_channel_key) <= 80),
  draft_parser_flow_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS mail_rules_enabled_position_idx
  ON abei_ai.mail_rules (user_id, position) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS mail_rules_user_order_idx
  ON abei_ai.mail_rules (user_id, position, id);

CREATE TABLE IF NOT EXISTS abei_ai.mail_rule_versions (
  rule_id BIGINT NOT NULL REFERENCES abei_ai.mail_rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  conditions JSONB NOT NULL,
  channel_key TEXT NOT NULL CHECK (char_length(channel_key) BETWEEN 1 AND 80),
  parser_flow_id BIGINT,
  checksum CHAR(64) NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, version)
);

CREATE TABLE IF NOT EXISTS abei_ai.mail_messages (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  mailbox_user_id BIGINT NOT NULL REFERENCES abei_ai.mailboxes(user_id) ON DELETE CASCADE,
  folder TEXT NOT NULL,
  uid_validity BIGINT NOT NULL CHECK (uid_validity > 0),
  uid BIGINT NOT NULL CHECK (uid > 0),
  message_id TEXT,
  from_address TEXT,
  to_addresses TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT,
  received_at TIMESTAMPTZ,
  headers JSONB NOT NULL DEFAULT '{}'::jsonb,
  body_structure JSONB NOT NULL DEFAULT '{}'::jsonb,
  content_state TEXT NOT NULL DEFAULT 'metadata_only'
    CHECK (content_state IN ('metadata_only', 'cached', 'expired', 'unavailable')),
  raw_path TEXT,
  raw_checksum CHAR(64),
  raw_expires_at TIMESTAMPTZ,
  classification TEXT NOT NULL DEFAULT 'unclassified'
    CHECK (classification IN ('unclassified', 'matched', 'ignored', 'error')),
  matched_rule_id BIGINT REFERENCES abei_ai.mail_rules(id) ON DELETE SET NULL,
  matched_rule_version INTEGER,
  channel_key TEXT,
  parser_flow_id BIGINT,
  legacy_channel_key TEXT,
  match_diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mailbox_user_id, folder, uid_validity, uid)
);

CREATE INDEX IF NOT EXISTS mail_messages_user_received_idx
  ON abei_ai.mail_messages (user_id, received_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS mail_messages_user_classification_idx
  ON abei_ai.mail_messages (user_id, classification, received_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS mail_messages_user_sender_idx
  ON abei_ai.mail_messages (user_id, lower(from_address));
CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_user_message_id_idx
  ON abei_ai.mail_messages (user_id, message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_user_checksum_idx
  ON abei_ai.mail_messages (user_id, raw_checksum) WHERE raw_checksum IS NOT NULL;

CREATE TABLE IF NOT EXISTS abei_ai.mail_samples (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  mail_message_id BIGINT NOT NULL REFERENCES abei_ai.mail_messages(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  purpose TEXT NOT NULL CHECK (purpose IN ('rule', 'parser', 'negative')),
  pinned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, mail_message_id, purpose)
);

CREATE INDEX IF NOT EXISTS mail_samples_user_idx
  ON abei_ai.mail_samples (user_id, pinned_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS abei_ai.mail_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  mailbox_user_id BIGINT NOT NULL REFERENCES abei_ai.mailboxes(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'incremental' CHECK (kind IN ('incremental', 'rescan')),
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  stage TEXT NOT NULL DEFAULT 'queued',
  scanned INTEGER NOT NULL DEFAULT 0 CHECK (scanned >= 0),
  fetched INTEGER NOT NULL DEFAULT 0 CHECK (fetched >= 0),
  matched INTEGER NOT NULL DEFAULT 0 CHECK (matched >= 0),
  unclassified INTEGER NOT NULL DEFAULT 0 CHECK (unclassified >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_summary TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mail_sync_runs_user_requested_idx
  ON abei_ai.mail_sync_runs (user_id, requested_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS mail_sync_runs_active_idx
  ON abei_ai.mail_sync_runs (status, requested_at) WHERE status IN ('queued', 'running');
