CREATE TABLE IF NOT EXISTS abei_ai.parser_flows (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id BIGINT REFERENCES public.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'published', 'retired')),
  current_version INTEGER CHECK (current_version > 0),
  draft_definition JSONB NOT NULL,
  draft_source_yaml TEXT NOT NULL,
  draft_script_sources JSONB NOT NULL DEFAULT '{}'::jsonb,
  cloned_from_flow_id BIGINT REFERENCES abei_ai.parser_flows(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS parser_flows_owner_slug_idx
  ON abei_ai.parser_flows (COALESCE(owner_user_id, 0), slug);
CREATE INDEX IF NOT EXISTS parser_flows_owner_status_idx
  ON abei_ai.parser_flows (owner_user_id, status, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS abei_ai.parser_flow_versions (
  flow_id BIGINT NOT NULL REFERENCES abei_ai.parser_flows(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  definition JSONB NOT NULL,
  source_yaml TEXT NOT NULL,
  script_sources JSONB NOT NULL DEFAULT '{}'::jsonb,
  checksum CHAR(64) NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, version),
  UNIQUE (flow_id, checksum)
);

CREATE TABLE IF NOT EXISTS abei_ai.parser_test_cases (
  id BIGSERIAL PRIMARY KEY,
  flow_id BIGINT NOT NULL REFERENCES abei_ai.parser_flows(id) ON DELETE CASCADE,
  owner_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  mail_sample_id BIGINT NOT NULL REFERENCES abei_ai.mail_samples(id) ON DELETE RESTRICT,
  expected JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (flow_id, name)
);

CREATE INDEX IF NOT EXISTS parser_test_cases_flow_idx
  ON abei_ai.parser_test_cases (flow_id, enabled, id);

CREATE TABLE IF NOT EXISTS abei_ai.parser_test_runs (
  id BIGSERIAL PRIMARY KEY,
  flow_id BIGINT NOT NULL REFERENCES abei_ai.parser_flows(id) ON DELETE CASCADE,
  flow_version INTEGER,
  owner_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  parser_test_case_id BIGINT REFERENCES abei_ai.parser_test_cases(id) ON DELETE SET NULL,
  mail_message_id BIGINT REFERENCES abei_ai.mail_messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  result_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
  node_results JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_summary TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS parser_test_runs_flow_started_idx
  ON abei_ai.parser_test_runs (flow_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS parser_test_runs_owner_started_idx
  ON abei_ai.parser_test_runs (owner_user_id, started_at DESC, id DESC);
