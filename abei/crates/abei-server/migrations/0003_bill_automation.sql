CREATE TABLE IF NOT EXISTS abei_ai.bill_documents (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  mail_message_id BIGINT NOT NULL REFERENCES abei_ai.mail_messages(id) ON DELETE RESTRICT,
  mail_rule_id BIGINT,
  mail_rule_version INTEGER,
  channel_key TEXT NOT NULL CHECK (char_length(channel_key) BETWEEN 1 AND 80),
  parser_flow_id BIGINT NOT NULL,
  parser_flow_version INTEGER NOT NULL CHECK (parser_flow_version > 0),
  active_revision INTEGER CHECK (active_revision IS NULL OR active_revision > 0),
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'archived')),
  summary TEXT,
  account_hint TEXT,
  period_start DATE,
  period_end DATE,
  received_at TIMESTAMPTZ,
  legacy_bill_task_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (mail_message_id),
  UNIQUE (legacy_bill_task_id),
  FOREIGN KEY (mail_rule_id, mail_rule_version)
    REFERENCES abei_ai.mail_rule_versions(rule_id, version) ON DELETE SET NULL,
  FOREIGN KEY (parser_flow_id, parser_flow_version)
    REFERENCES abei_ai.parser_flow_versions(flow_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS bill_documents_user_received_idx
  ON abei_ai.bill_documents (user_id, received_at DESC NULLS LAST, id DESC);
CREATE INDEX IF NOT EXISTS bill_documents_user_lifecycle_idx
  ON abei_ai.bill_documents (user_id, lifecycle, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS abei_ai.parse_jobs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bill_document_id BIGINT NOT NULL REFERENCES abei_ai.bill_documents(id) ON DELETE CASCADE,
  target_revision INTEGER NOT NULL CHECK (target_revision > 0),
  parser_flow_id BIGINT NOT NULL,
  parser_flow_version INTEGER NOT NULL CHECK (parser_flow_version > 0),
  definition_checksum CHAR(64) NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled')),
  stage TEXT NOT NULL DEFAULT 'route',
  priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 20),
  worker_id TEXT,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  waiting_reason TEXT,
  waiting_prompt TEXT,
  error_code TEXT,
  error_message TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bill_document_id, target_revision),
  FOREIGN KEY (parser_flow_id, parser_flow_version)
    REFERENCES abei_ai.parser_flow_versions(flow_id, version) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS parse_jobs_claim_idx
  ON abei_ai.parse_jobs (priority, requested_at, id)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS parse_jobs_user_updated_idx
  ON abei_ai.parse_jobs (user_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS abei_ai.parse_job_secrets (
  parse_job_id BIGINT PRIMARY KEY REFERENCES abei_ai.parse_jobs(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abei_ai.bill_document_revisions (
  bill_document_id BIGINT NOT NULL REFERENCES abei_ai.bill_documents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  parse_job_id BIGINT NOT NULL UNIQUE REFERENCES abei_ai.parse_jobs(id) ON DELETE RESTRICT,
  parser_flow_id BIGINT NOT NULL,
  parser_flow_version INTEGER NOT NULL,
  statement_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  valid_row_count INTEGER NOT NULL DEFAULT 0 CHECK (valid_row_count >= 0),
  invalid_row_count INTEGER NOT NULL DEFAULT 0 CHECK (invalid_row_count >= 0),
  amount_totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  invalid_rows JSONB NOT NULL DEFAULT '[]'::jsonb,
  warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  node_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bill_document_id, revision),
  FOREIGN KEY (parser_flow_id, parser_flow_version)
    REFERENCES abei_ai.parser_flow_versions(flow_id, version) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS abei_ai.bill_artifacts (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bill_document_id BIGINT NOT NULL REFERENCES abei_ai.bill_documents(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  parent_artifact_id BIGINT REFERENCES abei_ai.bill_artifacts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT,
  checksum CHAR(64) NOT NULL,
  size BIGINT NOT NULL CHECK (size >= 0),
  encrypted BOOLEAN NOT NULL DEFAULT false,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bill_document_id, revision, checksum, filename),
  FOREIGN KEY (bill_document_id, revision)
    REFERENCES abei_ai.bill_document_revisions(bill_document_id, revision) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS abei_ai.bill_rows (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bill_document_id BIGINT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  row_number INTEGER NOT NULL CHECK (row_number > 0),
  source_locator JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw_fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TEXT NOT NULL,
  posted_at TEXT,
  signed_amount NUMERIC(30,8) NOT NULL,
  currency_code CHAR(3) NOT NULL,
  foreign_amount NUMERIC(30,8),
  foreign_currency_code CHAR(3),
  balance_after NUMERIC(30,8),
  counterparty TEXT,
  counterparty_account TEXT,
  description TEXT NOT NULL,
  account_hint TEXT,
  payment_method TEXT,
  provider_transaction_id TEXT,
  merchant_order_id TEXT,
  provider_category TEXT,
  provider_status TEXT,
  remark TEXT,
  external_key TEXT NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  fingerprint_version SMALLINT NOT NULL DEFAULT 1,
  duplicate_of_row_id BIGINT REFERENCES abei_ai.bill_rows(id) ON DELETE SET NULL,
  duplicate_state TEXT NOT NULL DEFAULT 'unique'
    CHECK (duplicate_state IN ('unique', 'duplicate', 'conflict')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'imported', 'dismissed')),
  issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  dismissed_reason TEXT,
  dismissed_at TIMESTAMPTZ,
  firefly_type TEXT CHECK (firefly_type IS NULL OR firefly_type IN ('withdrawal', 'deposit', 'transfer')),
  firefly_date DATE,
  firefly_amount NUMERIC(30,8),
  firefly_description TEXT,
  source_account_id BIGINT,
  source_name TEXT,
  destination_account_id BIGINT,
  destination_name TEXT,
  category_id BIGINT,
  category_name TEXT,
  tags TEXT[],
  notes TEXT,
  suggested_by TEXT,
  suggested_at TIMESTAMPTZ,
  user_modified_at TIMESTAMPTZ,
  transaction_group_id BIGINT,
  last_import_error TEXT,
  legacy_bill_statement_row_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bill_document_id, revision, row_number),
  UNIQUE (legacy_bill_statement_row_id),
  FOREIGN KEY (bill_document_id, revision)
    REFERENCES abei_ai.bill_document_revisions(bill_document_id, revision) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS bill_rows_user_status_idx
  ON abei_ai.bill_rows (user_id, status, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS bill_rows_user_fingerprint_idx
  ON abei_ai.bill_rows (user_id, fingerprint, id);
CREATE INDEX IF NOT EXISTS bill_rows_document_revision_idx
  ON abei_ai.bill_rows (bill_document_id, revision, row_number);

CREATE TABLE IF NOT EXISTS abei_ai.bill_row_splits (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bill_row_id BIGINT NOT NULL REFERENCES abei_ai.bill_rows(id) ON DELETE CASCADE,
  part_index SMALLINT NOT NULL CHECK (part_index BETWEEN 1 AND 20),
  amount NUMERIC(30,8) NOT NULL CHECK (amount > 0),
  payment_method TEXT,
  source_account_id BIGINT,
  source_name TEXT,
  destination_account_id BIGINT,
  destination_name TEXT,
  category_id BIGINT,
  category_name TEXT,
  description TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bill_row_id, part_index)
);

CREATE TABLE IF NOT EXISTS abei_ai.bill_account_mappings (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  channel_key TEXT NOT NULL,
  account_hint TEXT NOT NULL,
  firefly_account_id BIGINT NOT NULL,
  firefly_account_name TEXT NOT NULL,
  firefly_account_type TEXT,
  source TEXT NOT NULL DEFAULT 'user',
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, channel_key, account_hint)
);
