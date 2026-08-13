ALTER TABLE abei_ai.bill_artifacts
  ADD COLUMN IF NOT EXISTS mime_type TEXT NOT NULL DEFAULT 'application/octet-stream';

ALTER TABLE abei_ai.bill_artifacts
  ADD COLUMN IF NOT EXISTS generation_stage TEXT NOT NULL DEFAULT 'derived'
    CHECK (generation_stage IN ('received', 'downloaded', 'extracted', 'derived'));

UPDATE abei_ai.bill_artifacts
SET mime_type = 'message/rfc822', generation_stage = 'received'
WHERE kind = 'eml';

CREATE TABLE IF NOT EXISTS abei_ai.bill_row_links (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  left_row_id BIGINT NOT NULL REFERENCES abei_ai.bill_rows(id) ON DELETE CASCADE,
  right_row_id BIGINT NOT NULL REFERENCES abei_ai.bill_rows(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN ('cross_source_candidate', 'refund_candidate')),
  confidence NUMERIC(5,4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (left_row_id < right_row_id),
  UNIQUE (left_row_id, right_row_id, relation)
);

CREATE INDEX IF NOT EXISTS bill_row_links_user_relation_idx
  ON abei_ai.bill_row_links (user_id, relation, created_at DESC);

CREATE TABLE IF NOT EXISTS abei_ai.bill_import_attempts (
  id TEXT PRIMARY KEY CHECK (char_length(id) = 36),
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  bill_row_id BIGINT NOT NULL REFERENCES abei_ai.bill_rows(id) ON DELETE RESTRICT,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'sending', 'succeeded', 'rejected', 'retryable', 'uncertain', 'reconciled')
  ),
  external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 255),
  payload_hash CHAR(64) NOT NULL,
  payload_snapshot JSONB NOT NULL,
  firefly_status INTEGER CHECK (firefly_status IS NULL OR firefly_status BETWEEN 100 AND 599),
  transaction_group_id BIGINT,
  error_code TEXT,
  error_message TEXT,
  retry_after TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  UNIQUE (bill_row_id, attempt_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS bill_import_attempts_active_row_idx
  ON abei_ai.bill_import_attempts (bill_row_id)
  WHERE status IN ('prepared', 'sending', 'uncertain');

CREATE UNIQUE INDEX IF NOT EXISTS bill_import_attempts_success_row_idx
  ON abei_ai.bill_import_attempts (bill_row_id)
  WHERE status IN ('succeeded', 'reconciled');

CREATE INDEX IF NOT EXISTS bill_import_attempts_user_created_idx
  ON abei_ai.bill_import_attempts (user_id, created_at DESC, id);

CREATE INDEX IF NOT EXISTS bill_import_attempts_uncertain_idx
  ON abei_ai.bill_import_attempts (updated_at, id)
  WHERE status = 'uncertain';
