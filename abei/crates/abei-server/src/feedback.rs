use std::collections::BTreeSet;
use std::fmt::Write;

use axum::Json;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use deadpool_postgres::{GenericClient, Transaction};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_postgres::{Client, Row};

use crate::{ApiError, AppState, WriteGate, actor, authenticated_user_id};

const MAX_MESSAGE_CHARS: usize = 4_000;
const MAX_CONTEXT_BYTES: usize = 16 * 1024;
const FINGERPRINT_VERSION: i32 = 1;
const MATCH_ALGORITHM_VERSION: i32 = 1;
const TEXT_MATCH_THRESHOLD: f64 = 0.42;

pub(crate) async fn initialize(
    client: &Client,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    client.batch_execute(SCHEMA).await?;
    Ok(())
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS abei_ai.feedback (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  labels TEXT[] NOT NULL DEFAULT '{}',
  kind TEXT NOT NULL,
  submitted_by TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  response TEXT,
  responded_by TEXT,
  responded_at timestamptz,
  duplicate_of BIGINT,
  github_issue_url TEXT,
  github_issue_number INTEGER,
  sync_status TEXT NOT NULL DEFAULT 'local',
  sync_error TEXT,
  deleted_at timestamptz,
  deleted_by TEXT,
  delete_reason TEXT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS response TEXT;
ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS responded_by TEXT;
ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS responded_at timestamptz;
ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS duplicate_of BIGINT;
ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS deleted_by TEXT;
ALTER TABLE abei_ai.feedback ADD COLUMN IF NOT EXISTS delete_reason TEXT;

CREATE TABLE IF NOT EXISTS abei_ai.feedback_events (
  id BIGSERIAL PRIMARY KEY,
  feedback_id BIGINT NOT NULL REFERENCES abei_ai.feedback(id),
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  message TEXT,
  actor TEXT NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abei_ai.feedback_items (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK (kind IN ('bug', 'experience', 'suggestion')),
  target TEXT NOT NULL CHECK (target IN ('cli', 'app', 'web')),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'reviewing', 'planned', 'in_progress', 'completed', 'closed')),
  severity TEXT CHECK (severity IN ('critical', 'high', 'normal', 'low')),
  public_summary TEXT NOT NULL DEFAULT '' CHECK (char_length(public_summary) <= 4000),
  close_reason TEXT CHECK (char_length(close_reason) <= 4000),
  merged_into_id BIGINT REFERENCES abei_ai.feedback_items(id),
  archived_at timestamptz,
  archived_by TEXT,
  legacy_feedback_id BIGINT UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (severity IS NULL OR kind = 'bug'),
  CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);

CREATE TABLE IF NOT EXISTS abei_ai.feedback_submissions (
  id BIGSERIAL PRIMARY KEY,
  item_id BIGINT REFERENCES abei_ai.feedback_items(id),
  user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bug', 'experience', 'suggestion')),
  target TEXT NOT NULL CHECK (target IN ('cli', 'app', 'web')),
  submitted_via TEXT NOT NULL CHECK (submitted_via IN ('cli', 'web', 'app', 'legacy')),
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000),
  expected TEXT CHECK (char_length(expected) <= 4000),
  actual TEXT CHECK (char_length(actual) <= 4000),
  state TEXT NOT NULL
    CHECK (state IN ('pending_confirmation', 'linked', 'needs_information', 'dismissed', 'redacted')),
  idempotency_key TEXT,
  context_version INTEGER NOT NULL DEFAULT 1,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  fingerprint_version INTEGER NOT NULL DEFAULT 1,
  fingerprint TEXT,
  match_algorithm_version INTEGER NOT NULL DEFAULT 1,
  match_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  legacy_feedback_id BIGINT UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  linked_at timestamptz,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (octet_length(context::text) <= 16384),
  CHECK (user_id IS NULL OR idempotency_key IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS abei_ai.feedback_updates (
  id BIGSERIAL PRIMARY KEY,
  item_id BIGINT NOT NULL REFERENCES abei_ai.feedback_items(id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  status_snapshot TEXT NOT NULL
    CHECK (status_snapshot IN ('open', 'reviewing', 'planned', 'in_progress', 'completed', 'closed')),
  author_admin_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  legacy_feedback_id BIGINT UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abei_ai.feedback_messages (
  id BIGSERIAL PRIMARY KEY,
  submission_id BIGINT NOT NULL REFERENCES abei_ai.feedback_submissions(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'admin', 'system')),
  author_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS abei_ai.feedback_audit_events (
  id BIGSERIAL PRIMARY KEY,
  item_id BIGINT REFERENCES abei_ai.feedback_items(id),
  submission_id BIGINT REFERENCES abei_ai.feedback_submissions(id),
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'admin', 'system', 'migration')),
  actor_user_id BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 4096),
  legacy_feedback_id BIGINT UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((item_id IS NULL) <> (submission_id IS NULL))
);

CREATE INDEX IF NOT EXISTS feedback_items_active_idx
  ON abei_ai.feedback_items (target, status, updated_at DESC, id DESC)
  WHERE archived_at IS NULL AND merged_into_id IS NULL;
CREATE INDEX IF NOT EXISTS feedback_submissions_user_idx
  ON abei_ai.feedback_submissions (user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS feedback_submissions_item_idx
  ON abei_ai.feedback_submissions (item_id, state, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS feedback_submissions_fingerprint_idx
  ON abei_ai.feedback_submissions (target, fingerprint)
  WHERE fingerprint IS NOT NULL AND state = 'linked';
CREATE INDEX IF NOT EXISTS feedback_updates_item_idx
  ON abei_ai.feedback_updates (item_id, created_at, id);
CREATE INDEX IF NOT EXISTS feedback_messages_submission_idx
  ON abei_ai.feedback_messages (submission_id, created_at, id);
CREATE INDEX IF NOT EXISTS feedback_audit_item_idx
  ON abei_ai.feedback_audit_events (item_id, created_at, id);
CREATE INDEX IF NOT EXISTS feedback_audit_submission_idx
  ON abei_ai.feedback_audit_events (submission_id, created_at, id);

CREATE OR REPLACE FUNCTION abei_ai.reject_feedback_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'feedback audit events are immutable';
END
$function$;

DO $trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'feedback_audit_events_immutable'
  ) THEN
    CREATE TRIGGER feedback_audit_events_immutable
      BEFORE UPDATE OR DELETE ON abei_ai.feedback_audit_events
      FOR EACH ROW EXECUTE FUNCTION abei_ai.reject_feedback_audit_mutation();
  END IF;
END
$trigger$;

-- Legacy rows have no trusted Firefly user ID. They remain owner-only via NULL user_id.
INSERT INTO abei_ai.feedback_items
  (title, kind, target, status, public_summary, close_reason, archived_at, archived_by,
   legacy_feedback_id, created_at, updated_at, completed_at)
SELECT
  left(COALESCE(NULLIF(btrim(f.title), ''), 'Legacy feedback #' || f.id::text), 160),
  CASE f.kind WHEN 'bug' THEN 'bug' WHEN 'idea' THEN 'suggestion' ELSE 'experience' END,
  CASE f.source WHEN 'web' THEN 'web' ELSE 'cli' END,
  CASE f.status
    WHEN 'planned' THEN 'planned'
    WHEN 'started' THEN 'in_progress'
    WHEN 'completed' THEN 'completed'
    WHEN 'declined' THEN 'closed'
    WHEN 'duplicate' THEN 'closed'
    ELSE 'open'
  END,
  '',
  CASE WHEN f.status IN ('declined', 'duplicate') THEN f.response ELSE NULL END,
  f.deleted_at,
  f.deleted_by,
  f.id,
  f.created_at,
  f.updated_at,
  CASE WHEN f.status = 'completed' THEN COALESCE(f.responded_at, f.updated_at) ELSE NULL END
FROM abei_ai.feedback f
ON CONFLICT (legacy_feedback_id) DO NOTHING;

INSERT INTO abei_ai.feedback_submissions
  (item_id, user_id, kind, target, submitted_via, message, state, idempotency_key,
   context_version, context, fingerprint_version, match_algorithm_version,
   match_candidates, legacy_feedback_id, created_at, linked_at, last_seen_at)
SELECT
  COALESCE(target_item.id, own_item.id),
  NULL,
  CASE f.kind WHEN 'bug' THEN 'bug' WHEN 'idea' THEN 'suggestion' ELSE 'experience' END,
  CASE f.source WHEN 'web' THEN 'web' ELSE 'cli' END,
  'legacy',
  left(COALESCE(NULLIF(btrim(f.body), ''), COALESCE(NULLIF(btrim(f.title), ''), 'Legacy feedback')), 4000),
  CASE WHEN f.deleted_at IS NULL THEN 'linked' ELSE 'dismissed' END,
  NULL,
  1,
  jsonb_build_object('legacy', true),
  1,
  1,
  '[]'::jsonb,
  f.id,
  f.created_at,
  f.created_at,
  f.updated_at
FROM abei_ai.feedback f
JOIN abei_ai.feedback_items own_item ON own_item.legacy_feedback_id = f.id
LEFT JOIN abei_ai.feedback target
  ON target.id = f.duplicate_of
 AND target.id <> f.id
 AND target.duplicate_of IS NULL
LEFT JOIN abei_ai.feedback_items target_item ON target_item.legacy_feedback_id = target.id
ON CONFLICT (legacy_feedback_id) DO NOTHING;

UPDATE abei_ai.feedback_items source_item
SET merged_into_id = target_item.id,
    archived_at = COALESCE(source_item.archived_at, source_feedback.updated_at),
    archived_by = COALESCE(source_item.archived_by, 'legacy-migration'),
    updated_at = GREATEST(source_item.updated_at, source_feedback.updated_at)
FROM abei_ai.feedback source_feedback
JOIN abei_ai.feedback target_feedback
  ON target_feedback.id = source_feedback.duplicate_of
 AND target_feedback.id <> source_feedback.id
 AND target_feedback.duplicate_of IS NULL
JOIN abei_ai.feedback_items target_item ON target_item.legacy_feedback_id = target_feedback.id
WHERE source_item.legacy_feedback_id = source_feedback.id
  AND source_item.merged_into_id IS NULL;

INSERT INTO abei_ai.feedback_updates
  (item_id, body, status_snapshot, author_admin_id, legacy_feedback_id, created_at)
SELECT
  submission.item_id,
  left(btrim(f.response), 4000),
  item.status,
  NULL,
  f.id,
  COALESCE(f.responded_at, f.updated_at)
FROM abei_ai.feedback f
JOIN abei_ai.feedback_submissions submission ON submission.legacy_feedback_id = f.id
JOIN abei_ai.feedback_items item ON item.id = submission.item_id
WHERE NULLIF(btrim(f.response), '') IS NOT NULL
ON CONFLICT (legacy_feedback_id) DO NOTHING;

INSERT INTO abei_ai.feedback_audit_events
  (submission_id, event_type, actor_kind, metadata, legacy_feedback_id, created_at)
SELECT submission.id, 'legacy_migrated', 'migration',
       jsonb_build_object('legacy_feedback_id', f.id), f.id, f.created_at
FROM abei_ai.feedback f
JOIN abei_ai.feedback_submissions submission ON submission.legacy_feedback_id = f.id
ON CONFLICT (legacy_feedback_id) DO NOTHING;
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FeedbackKind {
    Bug,
    Experience,
    Suggestion,
}

impl FeedbackKind {
    fn parse(input: &InputChoice, field: &str) -> Result<Self, ApiError> {
        match input {
            InputChoice::Number(1) => Ok(Self::Bug),
            InputChoice::Number(2) => Ok(Self::Experience),
            InputChoice::Number(3) => Ok(Self::Suggestion),
            InputChoice::Text(value) if value.eq_ignore_ascii_case("bug") => Ok(Self::Bug),
            InputChoice::Text(value) if value.eq_ignore_ascii_case("experience") => {
                Ok(Self::Experience)
            }
            InputChoice::Text(value) if value.eq_ignore_ascii_case("suggestion") => {
                Ok(Self::Suggestion)
            }
            _ => Err(ApiError::invalid_params(format!(
                "{field} 只能是 1/bug、2/experience 或 3/suggestion。"
            ))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Bug => "bug",
            Self::Experience => "experience",
            Self::Suggestion => "suggestion",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FeedbackTarget {
    Cli,
    App,
    Web,
}

impl FeedbackTarget {
    fn parse(input: Option<&InputChoice>) -> Result<Self, ApiError> {
        match input {
            None | Some(InputChoice::Number(1)) => Ok(Self::Cli),
            Some(InputChoice::Number(2)) => Ok(Self::App),
            Some(InputChoice::Number(3)) => Ok(Self::Web),
            Some(InputChoice::Text(value)) if value.eq_ignore_ascii_case("cli") => Ok(Self::Cli),
            Some(InputChoice::Text(value)) if value.eq_ignore_ascii_case("app") => Ok(Self::App),
            Some(InputChoice::Text(value)) if value.eq_ignore_ascii_case("web") => Ok(Self::Web),
            _ => Err(ApiError::invalid_params(
                "target 只能是 1/cli、2/app 或 3/web。",
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Cli => "cli",
            Self::App => "app",
            Self::Web => "web",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum InputChoice {
    Number(u8),
    Text(String),
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
struct RuntimeContext {
    cli_version: Option<String>,
    os: Option<String>,
    arch: Option<String>,
    recorded_at: Option<String>,
    recent: Option<RecentInvocation>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
struct RecentInvocation {
    capability_id: Option<String>,
    request_id: Option<String>,
    result: Option<String>,
    error_reason: Option<String>,
    error_code: Option<String>,
    exit_code: Option<i32>,
    recorded_at: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateFeedback {
    kind: InputChoice,
    message: String,
    target: Option<InputChoice>,
    expected: Option<String>,
    actual: Option<String>,
    idempotency_key: String,
    #[serde(default)]
    context: RuntimeContext,
    #[serde(default = "default_submitted_via")]
    submitted_via: String,
}

fn default_submitted_via() -> String {
    "cli".to_owned()
}

struct ValidatedCreate {
    kind: FeedbackKind,
    target: FeedbackTarget,
    message: String,
    expected: Option<String>,
    actual: Option<String>,
    idempotency_key: String,
    context: Value,
    submitted_via: String,
    fingerprint: Option<String>,
}

impl CreateFeedback {
    fn validate(self) -> Result<ValidatedCreate, ApiError> {
        let kind = FeedbackKind::parse(&self.kind, "kind")?;
        let target = FeedbackTarget::parse(self.target.as_ref())?;
        let message = validate_text("message", &self.message, true)?
            .expect("required text validation always returns a value");
        let expected = validate_text_option("expected", self.expected)?;
        let actual = validate_text_option("actual", self.actual)?;
        validate_idempotency_key(&self.idempotency_key)?;
        if !matches!(self.submitted_via.as_str(), "cli" | "web" | "app") {
            return Err(ApiError::invalid_params(
                "submitted_via 只能是 cli、app 或 web。",
            ));
        }
        validate_runtime_context(&self.context)?;
        let context = serde_json::to_value(&self.context)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        if context.to_string().len() > MAX_CONTEXT_BYTES {
            return Err(ApiError::invalid_params("context 编码后不能超过 16 KiB。"));
        }
        let fingerprint = fingerprint(target, &self.context);
        Ok(ValidatedCreate {
            kind,
            target,
            message,
            expected,
            actual,
            idempotency_key: self.idempotency_key,
            context,
            submitted_via: self.submitted_via,
            fingerprint,
        })
    }
}

#[derive(Debug, Serialize, Clone)]
struct MatchInfo {
    reason: &'static str,
    confidence: &'static str,
    score: f64,
    algorithm_version: i32,
}

#[derive(Debug, Serialize, Clone)]
struct Candidate {
    feedback_id: i64,
    title: String,
    kind: String,
    target: String,
    status: String,
    affected_users: i64,
    occurrences: i64,
    #[serde(rename = "match")]
    match_info: MatchInfo,
}

pub(crate) async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    gate: Result<Query<WriteGate>, QueryRejection>,
    payload: Result<Json<CreateFeedback>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let actor_name = actor(&headers)?.name;
    let gate = parse_gate(gate)?;
    let Json(input) = payload.map_err(json_error)?;
    let input = input.validate()?;

    if gate.dry_run {
        return Ok((
            StatusCode::OK,
            Json(json!({
                "dry_run": true,
                "data": {
                    "kind": input.kind.as_str(),
                    "target": input.target.as_str(),
                    "message": input.message,
                    "expected": input.expected,
                    "actual": input.actual,
                    "submitted_via": input.submitted_via,
                    "context": input.context,
                    "fingerprint_version": FINGERPRINT_VERSION,
                    "has_fingerprint": input.fingerprint.is_some(),
                }
            })),
        ));
    }

    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    if let Some(id) = existing_submission(&client, user_id, &input.idempotency_key).await? {
        let response = submission_result(&client, user_id, id).await?;
        return Ok((StatusCode::OK, Json(response)));
    }

    let candidates = find_candidates(&client, &input).await?;
    let candidate_json =
        serde_json::to_value(&candidates).map_err(|error| ApiError::internal(error.to_string()))?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let row = transaction
        .query_opt(
            "INSERT INTO abei_ai.feedback_submissions
             (user_id, kind, target, submitted_via, message, expected, actual, state,
              idempotency_key, context_version, context, fingerprint_version, fingerprint,
              match_algorithm_version, match_candidates)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_confirmation', $8, 1, $9,
                     $10, $11, $12, $13)
             ON CONFLICT (user_id, idempotency_key) DO NOTHING
             RETURNING id",
            &[
                &user_id,
                &input.kind.as_str(),
                &input.target.as_str(),
                &input.submitted_via,
                &input.message,
                &input.expected,
                &input.actual,
                &input.idempotency_key,
                &input.context,
                &FINGERPRINT_VERSION,
                &input.fingerprint,
                &MATCH_ALGORITHM_VERSION,
                &candidate_json,
            ],
        )
        .await
        .map_err(ApiError::database)?;

    let Some(row) = row else {
        transaction.rollback().await.map_err(ApiError::database)?;
        let id = existing_submission(&client, user_id, &input.idempotency_key)
            .await?
            .ok_or_else(|| ApiError::conflict("幂等请求正在处理中，请重试。"))?;
        let response = submission_result(&client, user_id, id).await?;
        return Ok((StatusCode::OK, Json(response)));
    };
    let submission_id: i64 = row.get(0);
    audit_submission(
        &transaction,
        submission_id,
        "submission_created",
        "user",
        Some(user_id),
        json!({
            "kind": input.kind.as_str(),
            "target": input.target.as_str(),
            "candidate_count": candidates.len(),
        }),
    )
    .await?;

    if candidates.is_empty() {
        let item_id = create_item_from_submission(
            &transaction,
            input.kind.as_str(),
            input.target.as_str(),
            &input.message,
        )
        .await?;
        transaction
            .execute(
                "UPDATE abei_ai.feedback_submissions
                 SET item_id = $2, state = 'linked', linked_at = now(), last_seen_at = now()
                 WHERE id = $1",
                &[&submission_id, &item_id],
            )
            .await
            .map_err(ApiError::database)?;
        audit_item(
            &transaction,
            item_id,
            "item_created",
            "user",
            Some(user_id),
            json!({ "from_submission_id": submission_id }),
        )
        .await?;
        audit_submission(
            &transaction,
            submission_id,
            "submission_linked",
            "system",
            Some(user_id),
            json!({ "item_id": item_id, "reason": "no_candidates" }),
        )
        .await?;
    }
    transaction.commit().await.map_err(ApiError::database)?;

    let response = submission_result(&client, user_id, submission_id).await?;
    let status = if candidates.is_empty() {
        StatusCode::CREATED
    } else {
        StatusCode::ACCEPTED
    };
    tracing::info!(
        submission_id,
        user_id,
        actor = %actor_name,
        state = if candidates.is_empty() { "linked" } else { "needs_confirmation" },
        "feedback submission created"
    );
    Ok((status, Json(response)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ConfirmFeedback {
    same_as: Option<i64>,
    #[serde(default, rename = "new")]
    create_new: bool,
}

pub(crate) async fn confirm(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<ConfirmFeedback>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let submission_id = positive_id(path, "submission id")?;
    let Json(input) = payload.map_err(json_error)?;
    if input.same_as.is_some() == input.create_new {
        return Err(ApiError::invalid_params(
            "same_as 和 new=true 必须且只能选择一个。",
        ));
    }
    if input.same_as.is_some_and(|id| id <= 0) {
        return Err(ApiError::invalid_params("same_as 必须是正整数。"));
    }

    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let row = transaction
        .query_opt(
            "SELECT id, item_id, kind, target, message, state, match_candidates
             FROM abei_ai.feedback_submissions
             WHERE id = $1 AND user_id = $2 FOR UPDATE",
            &[&submission_id, &user_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| {
            ApiError::not_found(format!("feedback submission {submission_id} 不存在。"))
        })?;
    let state_name: String = row.get("state");
    if state_name == "linked" || state_name == "needs_information" {
        transaction.commit().await.map_err(ApiError::database)?;
        return Ok(Json(
            submission_result(&client, user_id, submission_id).await?,
        ));
    }
    if state_name != "pending_confirmation" {
        return Err(ApiError::conflict("这条 submission 已不能确认。"));
    }

    let item_id = if let Some(item_id) = input.same_as {
        let candidates: Value = row.get("match_candidates");
        if !candidate_ids(&candidates).contains(&item_id) {
            return Err(ApiError::invalid_params(
                "same_as 必须是 create 返回的候选 feedback_id。",
            ));
        }
        ensure_active_item(&transaction, item_id).await?;
        item_id
    } else {
        let kind: String = row.get("kind");
        let target: String = row.get("target");
        let message: String = row.get("message");
        let item_id = create_item_from_submission(&transaction, &kind, &target, &message).await?;
        audit_item(
            &transaction,
            item_id,
            "item_created",
            "user",
            Some(user_id),
            json!({ "from_submission_id": submission_id }),
        )
        .await?;
        item_id
    };

    transaction
        .execute(
            "UPDATE abei_ai.feedback_submissions
             SET item_id = $2, state = 'linked', linked_at = now(), last_seen_at = now()
             WHERE id = $1",
            &[&submission_id, &item_id],
        )
        .await
        .map_err(ApiError::database)?;
    audit_submission(
        &transaction,
        submission_id,
        "submission_linked",
        "user",
        Some(user_id),
        json!({
            "item_id": item_id,
            "reason": if input.same_as.is_some() { "user_confirmed_same" } else { "user_confirmed_new" },
        }),
    )
    .await?;
    transaction.commit().await.map_err(ApiError::database)?;

    Ok(Json(
        submission_result(&client, user_id, submission_id).await?,
    ))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct ListFeedback {
    kind: Option<String>,
    target: Option<String>,
    status: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

pub(crate) async fn list(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<ListFeedback>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let Query(query) =
        query.map_err(|error| ApiError::invalid_params(format!("查询参数不对：{error}")))?;
    validate_optional_choice(
        "kind",
        query.kind.as_deref(),
        &["bug", "experience", "suggestion"],
    )?;
    validate_optional_choice("target", query.target.as_deref(), &["cli", "app", "web"])?;
    validate_optional_choice(
        "status",
        query.status.as_deref(),
        &[
            "open",
            "reviewing",
            "planned",
            "in_progress",
            "completed",
            "closed",
        ],
    )?;
    let (limit, offset) = pagination(query.limit, query.offset)?;
    let client = state.pool.get().await.map_err(ApiError::database)?;
    let rows = client
        .query(
            "SELECT i.id, i.title, i.kind, i.target, i.status, i.severity, i.public_summary,
                    i.archived_at::text AS archived_at, i.created_at::text AS created_at,
                    i.updated_at::text AS updated_at,
                    count(DISTINCT all_s.id) FILTER
                      (WHERE all_s.state IN ('linked', 'needs_information'))::bigint AS occurrences,
                    count(DISTINCT all_s.user_id) FILTER
                      (WHERE all_s.state IN ('linked', 'needs_information'))::bigint AS affected_users,
                    min(all_s.created_at) FILTER
                      (WHERE all_s.state IN ('linked', 'needs_information'))::text AS first_seen,
                    max(all_s.created_at) FILTER
                      (WHERE all_s.state IN ('linked', 'needs_information'))::text AS last_seen,
                    array_agg(DISTINCT mine.id ORDER BY mine.id) AS my_submission_ids
             FROM abei_ai.feedback_items i
             JOIN abei_ai.feedback_submissions mine
               ON mine.item_id = i.id AND mine.user_id = $1
              AND mine.state IN ('linked', 'needs_information')
             LEFT JOIN abei_ai.feedback_submissions all_s ON all_s.item_id = i.id
             WHERE i.merged_into_id IS NULL
               AND ($2::text IS NULL OR i.kind = $2)
               AND ($3::text IS NULL OR i.target = $3)
               AND ($4::text IS NULL OR i.status = $4)
             GROUP BY i.id
             ORDER BY i.updated_at DESC, i.id DESC
             LIMIT $5 OFFSET $6",
            &[&user_id, &query.kind, &query.target, &query.status, &limit, &offset],
        )
        .await
        .map_err(ApiError::database)?;
    let items = rows.iter().map(item_summary).collect::<Vec<_>>();
    let pending_rows = client
        .query(
            "SELECT id, kind, target, submitted_via, message, expected, actual, state,
                    match_candidates, created_at::text AS created_at,
                    last_seen_at::text AS last_seen_at,
                    COALESCE((
                      SELECT jsonb_agg(jsonb_build_object(
                        'id', m.id,
                        'submission_id', m.submission_id,
                        'author_kind', m.author_kind,
                        'body', m.body,
                        'created_at', m.created_at::text
                      ) ORDER BY m.created_at, m.id)
                      FROM abei_ai.feedback_messages m WHERE m.submission_id = s.id
                    ), '[]'::jsonb) AS messages
             FROM abei_ai.feedback_submissions s
             WHERE user_id = $1 AND item_id IS NULL
               AND state IN ('pending_confirmation', 'needs_information')
             ORDER BY created_at DESC, id DESC",
            &[&user_id],
        )
        .await
        .map_err(ApiError::database)?;
    let pending = pending_rows
        .iter()
        .map(pending_submission)
        .collect::<Vec<_>>();

    Ok(Json(json!({
        "data": items,
        "pending": pending,
        "pagination": { "limit": limit, "offset": offset, "count": items.len() },
    })))
}

pub(crate) async fn get(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let actor = actor(&headers)?;
    let item_id = positive_id(path, "feedback id")?;
    let client = state.pool.get().await.map_err(ApiError::database)?;
    Ok(Json(
        item_detail(&client, item_id, Some(user_id), actor.role == "owner").await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CreateMessage {
    message: String,
}

pub(crate) async fn reply(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<CreateMessage>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let user_id = authenticated_user_id(&headers)?;
    let submission_id = positive_id(path, "submission id")?;
    let Json(input) = payload.map_err(json_error)?;
    let body = validate_text("message", &input.message, true)?
        .expect("required text validation always returns a value");
    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let row = transaction
        .query_opt(
            "SELECT state, item_id FROM abei_ai.feedback_submissions
             WHERE id = $1 AND user_id = $2 FOR UPDATE",
            &[&submission_id, &user_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| {
            ApiError::not_found(format!("feedback submission {submission_id} 不存在。"))
        })?;
    let submission_state: String = row.get("state");
    let item_id: Option<i64> = row.get("item_id");
    if matches!(submission_state.as_str(), "dismissed" | "redacted") {
        return Err(ApiError::conflict("这条 submission 已不能回复。"));
    }
    let message_row = transaction
        .query_one(
            "INSERT INTO abei_ai.feedback_messages
             (submission_id, author_kind, author_user_id, body)
             VALUES ($1, 'user', $2, $3)
             RETURNING id, created_at::text AS created_at",
            &[&submission_id, &user_id, &body],
        )
        .await
        .map_err(ApiError::database)?;
    if submission_state == "needs_information" {
        transaction
            .execute(
                "UPDATE abei_ai.feedback_submissions
                 SET state = $2, last_seen_at = now() WHERE id = $1",
                &[
                    &submission_id,
                    &if item_id.is_some() {
                        "linked"
                    } else {
                        "pending_confirmation"
                    },
                ],
            )
            .await
            .map_err(ApiError::database)?;
    }
    audit_submission(
        &transaction,
        submission_id,
        "message_added",
        "user",
        Some(user_id),
        json!({ "message_id": message_row.get::<_, i64>("id") }),
    )
    .await?;
    transaction.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": message_row.get::<_, i64>("id"),
                "submission_id": submission_id,
                "author_kind": "user",
                "body": body,
                "created_at": message_row.get::<_, String>("created_at"),
            }
        })),
    ))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct AdminSubmissionList {
    state: Option<String>,
    kind: Option<String>,
    target: Option<String>,
    item_id: Option<i64>,
    limit: Option<i64>,
    offset: Option<i64>,
}

pub(crate) async fn admin_list_submissions(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<AdminSubmissionList>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    crate::owner(&headers)?;
    let Query(query) =
        query.map_err(|error| ApiError::invalid_params(format!("查询参数不对：{error}")))?;
    validate_optional_choice(
        "state",
        query.state.as_deref(),
        &[
            "pending_confirmation",
            "linked",
            "needs_information",
            "dismissed",
            "redacted",
        ],
    )?;
    validate_optional_choice(
        "kind",
        query.kind.as_deref(),
        &["bug", "experience", "suggestion"],
    )?;
    validate_optional_choice("target", query.target.as_deref(), &["cli", "app", "web"])?;
    if query.item_id.is_some_and(|id| id <= 0) {
        return Err(ApiError::invalid_params("item_id 必须是正整数。"));
    }
    let (limit, offset) = pagination(query.limit, query.offset)?;
    let client = state.pool.get().await.map_err(ApiError::database)?;
    let rows = client
        .query(
            "SELECT s.id, s.item_id, s.user_id, s.kind, s.target, s.submitted_via,
                    s.message, s.expected, s.actual, s.state, s.context,
                    s.fingerprint_version, s.fingerprint, s.match_algorithm_version,
                    s.match_candidates, s.created_at::text AS created_at,
                    s.linked_at::text AS linked_at, s.last_seen_at::text AS last_seen_at,
                    i.title AS item_title, i.status AS item_status,
                    count(m.id)::bigint AS message_count
             FROM abei_ai.feedback_submissions s
             LEFT JOIN abei_ai.feedback_items i ON i.id = s.item_id
             LEFT JOIN abei_ai.feedback_messages m ON m.submission_id = s.id
             WHERE ($1::text IS NULL OR s.state = $1)
               AND ($2::text IS NULL OR s.kind = $2)
               AND ($3::text IS NULL OR s.target = $3)
               AND ($4::bigint IS NULL OR s.item_id = $4)
             GROUP BY s.id, i.id
             ORDER BY
               CASE s.state WHEN 'pending_confirmation' THEN 0 WHEN 'needs_information' THEN 1 ELSE 2 END,
               s.created_at DESC, s.id DESC
             LIMIT $5 OFFSET $6",
            &[
                &query.state,
                &query.kind,
                &query.target,
                &query.item_id,
                &limit,
                &offset,
            ],
        )
        .await
        .map_err(ApiError::database)?;
    let data = rows
        .iter()
        .map(admin_submission_from_row)
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "data": data,
        "pagination": { "limit": limit, "offset": offset, "count": data.len() },
    })))
}

pub(crate) async fn admin_get_submission(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    crate::owner(&headers)?;
    let submission_id = positive_id(path, "submission id")?;
    let client = state.pool.get().await.map_err(ApiError::database)?;
    Ok(Json(admin_submission_detail(&client, submission_id).await?))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct AdminItemList {
    archived: Option<bool>,
    kind: Option<String>,
    target: Option<String>,
    status: Option<String>,
    severity: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

pub(crate) async fn admin_list_items(
    State(state): State<AppState>,
    headers: HeaderMap,
    query: Result<Query<AdminItemList>, QueryRejection>,
) -> Result<Json<Value>, ApiError> {
    crate::owner(&headers)?;
    let Query(query) =
        query.map_err(|error| ApiError::invalid_params(format!("查询参数不对：{error}")))?;
    validate_optional_choice(
        "kind",
        query.kind.as_deref(),
        &["bug", "experience", "suggestion"],
    )?;
    validate_optional_choice("target", query.target.as_deref(), &["cli", "app", "web"])?;
    validate_optional_choice(
        "status",
        query.status.as_deref(),
        &[
            "open",
            "reviewing",
            "planned",
            "in_progress",
            "completed",
            "closed",
        ],
    )?;
    validate_optional_choice(
        "severity",
        query.severity.as_deref(),
        &["critical", "high", "normal", "low"],
    )?;
    let (limit, offset) = pagination(query.limit, query.offset)?;
    let archived = query.archived.unwrap_or(false);
    let client = state.pool.get().await.map_err(ApiError::database)?;
    let rows = client
        .query(
            "SELECT i.id, i.title, i.kind, i.target, i.status, i.severity, i.public_summary,
                    i.close_reason, i.merged_into_id, i.archived_at::text AS archived_at,
                    i.archived_by, i.created_at::text AS created_at,
                    i.updated_at::text AS updated_at, i.completed_at::text AS completed_at,
                    count(s.id) FILTER (WHERE s.state IN ('linked', 'needs_information'))::bigint AS occurrences,
                    count(DISTINCT s.user_id) FILTER
                      (WHERE s.state IN ('linked', 'needs_information'))::bigint AS affected_users,
                    min(s.created_at) FILTER
                      (WHERE s.state IN ('linked', 'needs_information'))::text AS first_seen,
                    max(s.created_at) FILTER
                      (WHERE s.state IN ('linked', 'needs_information'))::text AS last_seen
             FROM abei_ai.feedback_items i
             LEFT JOIN abei_ai.feedback_submissions s ON s.item_id = i.id
             WHERE (($1 AND i.archived_at IS NOT NULL) OR (NOT $1 AND i.archived_at IS NULL))
               AND ($1 OR i.merged_into_id IS NULL)
               AND ($2::text IS NULL OR i.kind = $2)
               AND ($3::text IS NULL OR i.target = $3)
               AND ($4::text IS NULL OR i.status = $4)
               AND ($5::text IS NULL OR i.severity = $5)
             GROUP BY i.id
             ORDER BY
               CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                    WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
               count(DISTINCT s.user_id) FILTER
                 (WHERE s.state IN ('linked', 'needs_information')) DESC,
               count(s.id) FILTER (WHERE s.state IN ('linked', 'needs_information')) DESC,
               max(s.created_at) FILTER
                 (WHERE s.state IN ('linked', 'needs_information')) DESC NULLS LAST,
               i.updated_at DESC, i.id DESC
             LIMIT $6 OFFSET $7",
            &[
                &archived,
                &query.kind,
                &query.target,
                &query.status,
                &query.severity,
                &limit,
                &offset,
            ],
        )
        .await
        .map_err(ApiError::database)?;
    let data = rows
        .iter()
        .map(admin_item_summary_from_row)
        .collect::<Vec<_>>();
    Ok(Json(json!({
        "data": data,
        "pagination": { "limit": limit, "offset": offset, "count": data.len() },
    })))
}

pub(crate) async fn admin_get_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
) -> Result<Json<Value>, ApiError> {
    crate::owner(&headers)?;
    let item_id = positive_id(path, "feedback id")?;
    let client = state.pool.get().await.map_err(ApiError::database)?;
    Ok(Json(item_detail(&client, item_id, None, true).await?))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub(crate) struct UpdateItem {
    title: Option<String>,
    kind: Option<String>,
    target: Option<String>,
    status: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    severity: Option<Option<String>>,
    public_summary: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    close_reason: Option<Option<String>>,
    update: Option<String>,
}

fn deserialize_nullable_string<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

pub(crate) async fn admin_update_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<UpdateItem>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let admin_id = authenticated_user_id(&headers)?;
    crate::owner(&headers)?;
    let item_id = positive_id(path, "feedback id")?;
    let Json(input) = payload.map_err(json_error)?;
    if input.title.is_none()
        && input.kind.is_none()
        && input.target.is_none()
        && input.status.is_none()
        && input.severity.is_none()
        && input.public_summary.is_none()
        && input.close_reason.is_none()
        && input.update.is_none()
    {
        return Err(ApiError::invalid_params("至少提供一个要修改的字段。"));
    }
    let title = input.title.as_deref().map(validate_title).transpose()?;
    validate_optional_choice(
        "kind",
        input.kind.as_deref(),
        &["bug", "experience", "suggestion"],
    )?;
    validate_optional_choice("target", input.target.as_deref(), &["cli", "app", "web"])?;
    validate_optional_choice(
        "status",
        input.status.as_deref(),
        &[
            "open",
            "reviewing",
            "planned",
            "in_progress",
            "completed",
            "closed",
        ],
    )?;
    let severity_provided = input.severity.is_some();
    let severity = input
        .severity
        .as_ref()
        .and_then(|value| value.as_deref())
        .map(str::trim)
        .and_then(|value| {
            if value.is_empty() {
                None
            } else {
                Some(value.to_owned())
            }
        });
    validate_optional_choice(
        "severity",
        severity.as_deref(),
        &["critical", "high", "normal", "low"],
    )?;
    let public_summary = input
        .public_summary
        .as_deref()
        .map(|value| validate_text("public_summary", value, false))
        .transpose()?
        .flatten()
        .unwrap_or_default();
    let close_reason_provided = input.close_reason.is_some();
    let close_reason = input
        .close_reason
        .flatten()
        .map(|value| validate_text("close_reason", &value, false))
        .transpose()?
        .flatten();
    let update = validate_text_option("update", input.update)?;

    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let current = transaction
        .query_opt(
            "SELECT title, kind, target, status, severity, public_summary, close_reason,
                    archived_at::text AS archived_at, merged_into_id
             FROM abei_ai.feedback_items WHERE id = $1 FOR UPDATE",
            &[&item_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found(format!("feedback item {item_id} 不存在。")))?;
    if current.get::<_, Option<i64>>("merged_into_id").is_some() {
        return Err(ApiError::conflict("已合并的 feedback item 不能再修改。"));
    }
    if current.get::<_, Option<String>>("archived_at").is_some() {
        return Err(ApiError::conflict(
            "已归档的 feedback item 必须先恢复再修改。",
        ));
    }
    let old_status: String = current.get("status");
    let final_title = title.unwrap_or_else(|| current.get("title"));
    let final_kind = input.kind.unwrap_or_else(|| current.get("kind"));
    let final_target = input.target.unwrap_or_else(|| current.get("target"));
    let final_status = input.status.unwrap_or_else(|| old_status.clone());
    let final_severity = if severity_provided {
        severity
    } else {
        current.get("severity")
    };
    let final_public_summary = if input.public_summary.is_some() {
        public_summary
    } else {
        current.get("public_summary")
    };
    let final_close_reason = if close_reason_provided {
        close_reason
    } else {
        current.get("close_reason")
    };
    if final_kind != "bug" && final_severity.is_some() {
        return Err(ApiError::invalid_params(
            "severity 只适用于 kind=bug；改为其他类型时请传空字符串清除 severity。",
        ));
    }
    if matches!(final_status.as_str(), "completed" | "closed")
        && final_status != old_status
        && update.is_none()
    {
        return Err(ApiError::invalid_params(
            "状态改为 completed 或 closed 时必须同时填写 update。",
        ));
    }
    if final_status == "closed" && final_close_reason.is_none() {
        return Err(ApiError::invalid_params(
            "状态改为 closed 时必须填写 close_reason。",
        ));
    }

    let changed_fields = changed_item_fields(
        &current,
        &final_title,
        &final_kind,
        &final_target,
        &final_status,
        &final_severity,
        &final_public_summary,
        &final_close_reason,
    );
    if changed_fields.is_empty() && update.is_none() {
        transaction.commit().await.map_err(ApiError::database)?;
        return Ok(Json(item_detail(&client, item_id, None, true).await?));
    }

    transaction
        .execute(
            "UPDATE abei_ai.feedback_items
             SET title = $2, kind = $3, target = $4, status = $5, severity = $6,
                 public_summary = $7, close_reason = $8,
                 completed_at = CASE
                   WHEN $5 = 'completed' THEN COALESCE(completed_at, now()) ELSE NULL END,
                 updated_at = now()
             WHERE id = $1",
            &[
                &item_id,
                &final_title,
                &final_kind,
                &final_target,
                &final_status,
                &final_severity,
                &final_public_summary,
                &final_close_reason,
            ],
        )
        .await
        .map_err(ApiError::database)?;
    if let Some(body) = update {
        insert_public_update(&transaction, item_id, &body, &final_status, admin_id).await?;
    }
    audit_item(
        &transaction,
        item_id,
        "item_updated",
        "admin",
        Some(admin_id),
        json!({
            "changed_fields": changed_fields,
            "from_status": old_status,
            "to_status": final_status,
        }),
    )
    .await?;
    transaction.commit().await.map_err(ApiError::database)?;
    Ok(Json(item_detail(&client, item_id, None, true).await?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PublishUpdate {
    body: String,
}

pub(crate) async fn admin_publish_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<PublishUpdate>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let admin_id = authenticated_user_id(&headers)?;
    crate::owner(&headers)?;
    let item_id = positive_id(path, "feedback id")?;
    let Json(input) = payload.map_err(json_error)?;
    let body = validate_text("body", &input.body, true)?
        .expect("required text validation always returns a value");
    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let row = transaction
        .query_opt(
            "SELECT status, archived_at::text AS archived_at FROM abei_ai.feedback_items
             WHERE id = $1 AND merged_into_id IS NULL FOR UPDATE",
            &[&item_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found(format!("feedback item {item_id} 不存在。")))?;
    let status: String = row.get("status");
    if row.get::<_, Option<String>>("archived_at").is_some() {
        return Err(ApiError::conflict(
            "已归档的 feedback item 必须先恢复再发布进展。",
        ));
    }
    let update = insert_public_update(&transaction, item_id, &body, &status, admin_id).await?;
    transaction
        .execute(
            "UPDATE abei_ai.feedback_items SET updated_at = now() WHERE id = $1",
            &[&item_id],
        )
        .await
        .map_err(ApiError::database)?;
    audit_item(
        &transaction,
        item_id,
        "public_update_added",
        "admin",
        Some(admin_id),
        json!({ "update_id": update["id"] }),
    )
    .await?;
    transaction.commit().await.map_err(ApiError::database)?;
    Ok((StatusCode::CREATED, Json(json!({ "data": update }))))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct MergeItems {
    target_id: i64,
    reason: String,
}

pub(crate) async fn admin_merge_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<MergeItems>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let admin_id = authenticated_user_id(&headers)?;
    let admin = crate::owner(&headers)?;
    let source_id = positive_id(path, "feedback id")?;
    let Json(input) = payload.map_err(json_error)?;
    if input.target_id <= 0 || input.target_id == source_id {
        return Err(ApiError::invalid_params(
            "target_id 必须是另一个正整数 feedback id。",
        ));
    }
    let reason = validate_audit_reason(&input.reason)?;
    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let ids = if source_id < input.target_id {
        vec![source_id, input.target_id]
    } else {
        vec![input.target_id, source_id]
    };
    let rows = transaction
        .query(
            "SELECT id, archived_at::text AS archived_at, merged_into_id
             FROM abei_ai.feedback_items
             WHERE id = ANY($1) ORDER BY id FOR UPDATE",
            &[&ids],
        )
        .await
        .map_err(ApiError::database)?;
    if rows.len() != 2 {
        return Err(ApiError::not_found("源或目标 feedback item 不存在。"));
    }
    for row in &rows {
        if row.get::<_, Option<i64>>("merged_into_id").is_some() {
            return Err(ApiError::conflict(
                "源和目标都必须是最终 item，不能形成合并链。",
            ));
        }
        if row.get::<_, i64>("id") == input.target_id
            && row.get::<_, Option<String>>("archived_at").is_some()
        {
            return Err(ApiError::conflict("目标 feedback item 已归档。"));
        }
    }
    let moved = transaction
        .execute(
            "UPDATE abei_ai.feedback_submissions SET item_id = $2
             WHERE item_id = $1",
            &[&source_id, &input.target_id],
        )
        .await
        .map_err(ApiError::database)?;
    transaction
        .execute(
            "UPDATE abei_ai.feedback_items
             SET merged_into_id = $2, archived_at = now(), archived_by = $3, updated_at = now()
             WHERE id = $1",
            &[&source_id, &input.target_id, &admin.name],
        )
        .await
        .map_err(ApiError::database)?;
    transaction
        .execute(
            "UPDATE abei_ai.feedback_items SET updated_at = now() WHERE id = $1",
            &[&input.target_id],
        )
        .await
        .map_err(ApiError::database)?;
    audit_item(
        &transaction,
        source_id,
        "item_merged",
        "admin",
        Some(admin_id),
        json!({ "target_id": input.target_id, "moved_submissions": moved, "reason": reason }),
    )
    .await?;
    audit_item(
        &transaction,
        input.target_id,
        "item_absorbed_merge",
        "admin",
        Some(admin_id),
        json!({ "source_id": source_id, "moved_submissions": moved }),
    )
    .await?;
    transaction.commit().await.map_err(ApiError::database)?;
    Ok(Json(
        item_detail(&client, input.target_id, None, true).await?,
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ArchiveItem {
    reason: String,
}

pub(crate) async fn admin_archive_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<ArchiveItem>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    set_archive_state(state, headers, path, payload, true).await
}

pub(crate) async fn admin_restore_item(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<ArchiveItem>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    set_archive_state(state, headers, path, payload, false).await
}

async fn set_archive_state(
    state: AppState,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<ArchiveItem>, JsonRejection>,
    archive: bool,
) -> Result<Json<Value>, ApiError> {
    let admin_id = authenticated_user_id(&headers)?;
    let admin = crate::owner(&headers)?;
    let item_id = positive_id(path, "feedback id")?;
    let Json(input) = payload.map_err(json_error)?;
    let reason = validate_audit_reason(&input.reason)?;
    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let row = transaction
        .query_opt(
            "SELECT archived_at::text AS archived_at, merged_into_id
             FROM abei_ai.feedback_items WHERE id = $1 FOR UPDATE",
            &[&item_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found(format!("feedback item {item_id} 不存在。")))?;
    if row.get::<_, Option<i64>>("merged_into_id").is_some() {
        return Err(ApiError::conflict("合并产生的归档记录不能单独恢复。"));
    }
    let archived: Option<String> = row.get("archived_at");
    if archive == archived.is_some() {
        transaction.commit().await.map_err(ApiError::database)?;
        return Ok(Json(item_detail(&client, item_id, None, true).await?));
    }
    if archive {
        transaction
            .execute(
                "UPDATE abei_ai.feedback_items
                 SET archived_at = now(), archived_by = $2, updated_at = now() WHERE id = $1",
                &[&item_id, &admin.name],
            )
            .await
            .map_err(ApiError::database)?;
    } else {
        transaction
            .execute(
                "UPDATE abei_ai.feedback_items
                 SET archived_at = NULL, archived_by = NULL, updated_at = now() WHERE id = $1",
                &[&item_id],
            )
            .await
            .map_err(ApiError::database)?;
    }
    audit_item(
        &transaction,
        item_id,
        if archive {
            "item_archived"
        } else {
            "item_restored"
        },
        "admin",
        Some(admin_id),
        json!({ "reason": reason }),
    )
    .await?;
    transaction.commit().await.map_err(ApiError::database)?;
    Ok(Json(item_detail(&client, item_id, None, true).await?))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LinkSubmission {
    item_id: Option<i64>,
    #[serde(default, rename = "new")]
    create_new: bool,
    title: Option<String>,
    reason: String,
}

pub(crate) async fn admin_link_submission(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<LinkSubmission>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let admin_id = authenticated_user_id(&headers)?;
    crate::owner(&headers)?;
    let submission_id = positive_id(path, "submission id")?;
    let Json(input) = payload.map_err(json_error)?;
    if input.item_id.is_some() == input.create_new {
        return Err(ApiError::invalid_params(
            "item_id 和 new=true 必须且只能选择一个。",
        ));
    }
    if input.item_id.is_some_and(|id| id <= 0) {
        return Err(ApiError::invalid_params("item_id 必须是正整数。"));
    }
    let reason = validate_audit_reason(&input.reason)?;
    let requested_title = input.title.as_deref().map(validate_title).transpose()?;
    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let submission = transaction
        .query_opt(
            "SELECT item_id, kind, target, message, state
             FROM abei_ai.feedback_submissions WHERE id = $1 FOR UPDATE",
            &[&submission_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| {
            ApiError::not_found(format!("feedback submission {submission_id} 不存在。"))
        })?;
    if submission.get::<_, String>("state") == "redacted" {
        return Err(ApiError::conflict("已脱敏的 submission 不能重新关联。"));
    }
    let previous_item_id: Option<i64> = submission.get("item_id");
    let item_id = if let Some(item_id) = input.item_id {
        ensure_active_item(&transaction, item_id).await?;
        item_id
    } else {
        let kind: String = submission.get("kind");
        let target: String = submission.get("target");
        let message: String = submission.get("message");
        let item_id = transaction
            .query_one(
                "INSERT INTO abei_ai.feedback_items (title, kind, target)
                 VALUES ($1, $2, $3) RETURNING id",
                &[
                    &requested_title.unwrap_or_else(|| initial_title(&message)),
                    &kind,
                    &target,
                ],
            )
            .await
            .map_err(ApiError::database)?
            .get(0);
        audit_item(
            &transaction,
            item_id,
            "item_created",
            "admin",
            Some(admin_id),
            json!({ "from_submission_id": submission_id }),
        )
        .await?;
        item_id
    };
    transaction
        .execute(
            "UPDATE abei_ai.feedback_submissions
             SET item_id = $2, state = 'linked', linked_at = COALESCE(linked_at, now()),
                 last_seen_at = now()
             WHERE id = $1",
            &[&submission_id, &item_id],
        )
        .await
        .map_err(ApiError::database)?;
    audit_submission(
        &transaction,
        submission_id,
        "submission_linked_by_admin",
        "admin",
        Some(admin_id),
        json!({ "from_item_id": previous_item_id, "to_item_id": item_id, "reason": reason }),
    )
    .await?;
    transaction.commit().await.map_err(ApiError::database)?;
    Ok(Json(admin_submission_detail(&client, submission_id).await?))
}

pub(crate) async fn admin_message_submission(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<CreateMessage>, JsonRejection>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let admin_id = authenticated_user_id(&headers)?;
    crate::owner(&headers)?;
    let submission_id = positive_id(path, "submission id")?;
    let Json(input) = payload.map_err(json_error)?;
    let body = validate_text("message", &input.message, true)?
        .expect("required text validation always returns a value");
    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let row = transaction
        .query_opt(
            "SELECT user_id, state FROM abei_ai.feedback_submissions
             WHERE id = $1 FOR UPDATE",
            &[&submission_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| {
            ApiError::not_found(format!("feedback submission {submission_id} 不存在。"))
        })?;
    if row.get::<_, Option<i64>>("user_id").is_none() {
        return Err(ApiError::conflict(
            "legacy submission 没有可信用户，不能发送追问。",
        ));
    }
    let current_state: String = row.get("state");
    if matches!(current_state.as_str(), "dismissed" | "redacted") {
        return Err(ApiError::conflict("这条 submission 已不能发送追问。"));
    }
    let message_row = transaction
        .query_one(
            "INSERT INTO abei_ai.feedback_messages
             (submission_id, author_kind, author_user_id, body)
             VALUES ($1, 'admin', $2, $3)
             RETURNING id, created_at::text AS created_at",
            &[&submission_id, &admin_id, &body],
        )
        .await
        .map_err(ApiError::database)?;
    transaction
        .execute(
            "UPDATE abei_ai.feedback_submissions
             SET state = 'needs_information', last_seen_at = now() WHERE id = $1",
            &[&submission_id],
        )
        .await
        .map_err(ApiError::database)?;
    audit_submission(
        &transaction,
        submission_id,
        "information_requested",
        "admin",
        Some(admin_id),
        json!({ "message_id": message_row.get::<_, i64>("id") }),
    )
    .await?;
    transaction.commit().await.map_err(ApiError::database)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({
            "data": {
                "id": message_row.get::<_, i64>("id"),
                "submission_id": submission_id,
                "author_kind": "admin",
                "body": body,
                "created_at": message_row.get::<_, String>("created_at"),
            }
        })),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ModerateSubmission {
    state: String,
    reason: String,
}

pub(crate) async fn admin_update_submission(
    State(state): State<AppState>,
    headers: HeaderMap,
    path: Result<Path<String>, PathRejection>,
    payload: Result<Json<ModerateSubmission>, JsonRejection>,
) -> Result<Json<Value>, ApiError> {
    let admin_id = authenticated_user_id(&headers)?;
    crate::owner(&headers)?;
    let submission_id = positive_id(path, "submission id")?;
    let Json(input) = payload.map_err(json_error)?;
    validate_optional_choice("state", Some(&input.state), &["dismissed", "redacted"])?;
    let reason = validate_audit_reason(&input.reason)?;
    let mut client = state.pool.get().await.map_err(ApiError::database)?;
    let transaction = client.transaction().await.map_err(ApiError::database)?;
    let row = transaction
        .query_opt(
            "SELECT state FROM abei_ai.feedback_submissions WHERE id = $1 FOR UPDATE",
            &[&submission_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| {
            ApiError::not_found(format!("feedback submission {submission_id} 不存在。"))
        })?;
    let old_state: String = row.get("state");
    if input.state == "redacted" {
        transaction
            .execute(
                "UPDATE abei_ai.feedback_submissions
                 SET state = 'redacted', message = '[redacted]', expected = NULL, actual = NULL,
                     context = '{}'::jsonb, fingerprint = NULL, match_candidates = '[]'::jsonb,
                     last_seen_at = now()
                 WHERE id = $1",
                &[&submission_id],
            )
            .await
            .map_err(ApiError::database)?;
        transaction
            .execute(
                "UPDATE abei_ai.feedback_messages SET body = '[redacted]'
                 WHERE submission_id = $1",
                &[&submission_id],
            )
            .await
            .map_err(ApiError::database)?;
    } else {
        transaction
            .execute(
                "UPDATE abei_ai.feedback_submissions
                 SET state = 'dismissed', last_seen_at = now() WHERE id = $1",
                &[&submission_id],
            )
            .await
            .map_err(ApiError::database)?;
    }
    audit_submission(
        &transaction,
        submission_id,
        "submission_moderated",
        "admin",
        Some(admin_id),
        json!({ "from_state": old_state, "to_state": input.state, "reason": reason }),
    )
    .await?;
    transaction.commit().await.map_err(ApiError::database)?;
    Ok(Json(admin_submission_detail(&client, submission_id).await?))
}

async fn insert_public_update(
    transaction: &Transaction<'_>,
    item_id: i64,
    body: &str,
    status: &str,
    admin_id: i64,
) -> Result<Value, ApiError> {
    let row = transaction
        .query_one(
            "INSERT INTO abei_ai.feedback_updates
             (item_id, body, status_snapshot, author_admin_id)
             VALUES ($1, $2, $3, $4)
             RETURNING id, created_at::text AS created_at",
            &[&item_id, &body, &status, &admin_id],
        )
        .await
        .map_err(ApiError::database)?;
    Ok(json!({
        "id": row.get::<_, i64>("id"),
        "item_id": item_id,
        "body": body,
        "status": status,
        "created_at": row.get::<_, String>("created_at"),
    }))
}

async fn admin_submission_detail(
    client: &impl GenericClient,
    submission_id: i64,
) -> Result<Value, ApiError> {
    let row = client
        .query_opt(
            "SELECT s.id, s.item_id, s.user_id, s.kind, s.target, s.submitted_via,
                    s.message, s.expected, s.actual, s.state, s.context,
                    s.fingerprint_version, s.fingerprint, s.match_algorithm_version,
                    s.match_candidates, s.created_at::text AS created_at,
                    s.linked_at::text AS linked_at, s.last_seen_at::text AS last_seen_at,
                    i.title AS item_title, i.status AS item_status,
                    (SELECT count(*)::bigint FROM abei_ai.feedback_messages m
                     WHERE m.submission_id = s.id) AS message_count
             FROM abei_ai.feedback_submissions s
             LEFT JOIN abei_ai.feedback_items i ON i.id = s.item_id
             WHERE s.id = $1",
            &[&submission_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| {
            ApiError::not_found(format!("feedback submission {submission_id} 不存在。"))
        })?;
    let messages = client
        .query(
            "SELECT id, submission_id, author_kind, body, created_at::text AS created_at
             FROM abei_ai.feedback_messages WHERE submission_id = $1 ORDER BY created_at, id",
            &[&submission_id],
        )
        .await
        .map_err(ApiError::database)?
        .iter()
        .map(message_from_row)
        .collect::<Vec<_>>();
    let audit = client
        .query(
            "SELECT id, item_id, submission_id, event_type, actor_kind, actor_user_id,
                    metadata, created_at::text AS created_at
             FROM abei_ai.feedback_audit_events
             WHERE submission_id = $1 ORDER BY created_at, id",
            &[&submission_id],
        )
        .await
        .map_err(ApiError::database)?
        .iter()
        .map(audit_from_row)
        .collect::<Vec<_>>();
    Ok(json!({
        "data": admin_submission_from_row(&row),
        "messages": messages,
        "audit": audit,
    }))
}

fn admin_submission_from_row(row: &Row) -> Value {
    json!({
        "submission_id": row.get::<_, i64>("id"),
        "feedback_id": row.get::<_, Option<i64>>("item_id"),
        "user_id": row.get::<_, Option<i64>>("user_id"),
        "kind": row.get::<_, String>("kind"),
        "target": row.get::<_, String>("target"),
        "submitted_via": row.get::<_, String>("submitted_via"),
        "message": row.get::<_, String>("message"),
        "expected": row.get::<_, Option<String>>("expected"),
        "actual": row.get::<_, Option<String>>("actual"),
        "state": row.get::<_, String>("state"),
        "context": row.get::<_, Value>("context"),
        "fingerprint_version": row.get::<_, i32>("fingerprint_version"),
        "has_fingerprint": row.get::<_, Option<String>>("fingerprint").is_some(),
        "match_algorithm_version": row.get::<_, i32>("match_algorithm_version"),
        "candidates": row.get::<_, Value>("match_candidates"),
        "item_title": row.get::<_, Option<String>>("item_title"),
        "item_status": row.get::<_, Option<String>>("item_status"),
        "message_count": row.get::<_, i64>("message_count"),
        "created_at": row.get::<_, String>("created_at"),
        "linked_at": row.get::<_, Option<String>>("linked_at"),
        "last_seen_at": row.get::<_, String>("last_seen_at"),
    })
}

fn admin_item_summary_from_row(row: &Row) -> Value {
    json!({
        "feedback_id": row.get::<_, i64>("id"),
        "title": row.get::<_, String>("title"),
        "kind": row.get::<_, String>("kind"),
        "target": row.get::<_, String>("target"),
        "status": row.get::<_, String>("status"),
        "severity": row.get::<_, Option<String>>("severity"),
        "public_summary": row.get::<_, String>("public_summary"),
        "close_reason": row.get::<_, Option<String>>("close_reason"),
        "affected_users": row.get::<_, i64>("affected_users"),
        "occurrences": row.get::<_, i64>("occurrences"),
        "first_seen": row.get::<_, Option<String>>("first_seen"),
        "last_seen": row.get::<_, Option<String>>("last_seen"),
        "archived_at": row.get::<_, Option<String>>("archived_at"),
        "archived_by": row.get::<_, Option<String>>("archived_by"),
        "created_at": row.get::<_, String>("created_at"),
        "updated_at": row.get::<_, String>("updated_at"),
        "completed_at": row.get::<_, Option<String>>("completed_at"),
    })
}

#[allow(clippy::too_many_arguments)]
fn changed_item_fields(
    current: &Row,
    title: &str,
    kind: &str,
    target: &str,
    status: &str,
    severity: &Option<String>,
    public_summary: &str,
    close_reason: &Option<String>,
) -> Vec<&'static str> {
    let mut fields = Vec::new();
    if current.get::<_, String>("title") != title {
        fields.push("title");
    }
    if current.get::<_, String>("kind") != kind {
        fields.push("kind");
    }
    if current.get::<_, String>("target") != target {
        fields.push("target");
    }
    if current.get::<_, String>("status") != status {
        fields.push("status");
    }
    if current.get::<_, Option<String>>("severity") != *severity {
        fields.push("severity");
    }
    if current.get::<_, String>("public_summary") != public_summary {
        fields.push("public_summary");
    }
    if current.get::<_, Option<String>>("close_reason") != *close_reason {
        fields.push("close_reason");
    }
    fields
}

fn validate_title(title: &str) -> Result<String, ApiError> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 160 {
        Err(ApiError::invalid_params("title 不能为空，且最多 160 字。"))
    } else {
        Ok(title.to_owned())
    }
}

async fn existing_submission(
    client: &impl GenericClient,
    user_id: i64,
    idempotency_key: &str,
) -> Result<Option<i64>, ApiError> {
    client
        .query_opt(
            "SELECT id FROM abei_ai.feedback_submissions
             WHERE user_id = $1 AND idempotency_key = $2",
            &[&user_id, &idempotency_key],
        )
        .await
        .map_err(ApiError::database)
        .map(|row| row.map(|row| row.get(0)))
}

async fn find_candidates(
    client: &impl GenericClient,
    input: &ValidatedCreate,
) -> Result<Vec<Candidate>, ApiError> {
    let rows = client
        .query(
            "SELECT i.id, i.title, i.kind, i.target, i.status, i.public_summary,
                    count(s.id) FILTER (WHERE s.state IN ('linked', 'needs_information'))::bigint AS occurrences,
                    count(DISTINCT s.user_id) FILTER
                      (WHERE s.state IN ('linked', 'needs_information'))::bigint AS affected_users,
                    COALESCE(bool_or(
                      $2::text IS NOT NULL
                      AND s.state IN ('linked', 'needs_information')
                      AND s.fingerprint = $2
                    ), false) AS fingerprint_match
             FROM abei_ai.feedback_items i
             LEFT JOIN abei_ai.feedback_submissions s ON s.item_id = i.id
             WHERE i.target = $1 AND i.archived_at IS NULL AND i.merged_into_id IS NULL
             GROUP BY i.id
             HAVING count(s.id) FILTER
               (WHERE s.state IN ('linked', 'needs_information')) > 0
             ORDER BY i.updated_at DESC, i.id DESC
             LIMIT 200",
            &[&input.target.as_str(), &input.fingerprint],
        )
        .await
        .map_err(ApiError::database)?;
    let mut candidates = Vec::new();
    for row in rows {
        let exact: bool = row.get("fingerprint_match");
        let candidate_kind: String = row.get("kind");
        let title: String = row.get("title");
        let summary: String = row.get("public_summary");
        let score = text_similarity(&input.message, &format!("{title} {summary}"));
        if !exact && (candidate_kind != input.kind.as_str() || score < TEXT_MATCH_THRESHOLD) {
            continue;
        }
        let (reason, confidence, effective_score) = if exact {
            ("same_capability_and_error", "high", 1.0)
        } else if score >= 0.75 {
            ("similar_text", "high", score)
        } else if score >= 0.55 {
            ("similar_text", "medium", score)
        } else {
            ("similar_text", "low", score)
        };
        candidates.push(Candidate {
            feedback_id: row.get("id"),
            title,
            kind: candidate_kind,
            target: row.get("target"),
            status: row.get("status"),
            affected_users: row.get("affected_users"),
            occurrences: row.get("occurrences"),
            match_info: MatchInfo {
                reason,
                confidence,
                score: (effective_score * 1000.0).round() / 1000.0,
                algorithm_version: MATCH_ALGORITHM_VERSION,
            },
        });
    }
    candidates.sort_by(|left, right| {
        right
            .match_info
            .score
            .total_cmp(&left.match_info.score)
            .then_with(|| right.occurrences.cmp(&left.occurrences))
            .then_with(|| right.feedback_id.cmp(&left.feedback_id))
    });
    candidates.truncate(3);
    Ok(candidates)
}

async fn create_item_from_submission(
    transaction: &Transaction<'_>,
    kind: &str,
    target: &str,
    message: &str,
) -> Result<i64, ApiError> {
    transaction
        .query_one(
            "INSERT INTO abei_ai.feedback_items (title, kind, target)
             VALUES ($1, $2, $3) RETURNING id",
            &[&initial_title(message), &kind, &target],
        )
        .await
        .map_err(ApiError::database)
        .map(|row| row.get(0))
}

async fn ensure_active_item(transaction: &Transaction<'_>, item_id: i64) -> Result<(), ApiError> {
    let exists = transaction
        .query_opt(
            "SELECT id FROM abei_ai.feedback_items
             WHERE id = $1 AND archived_at IS NULL AND merged_into_id IS NULL FOR UPDATE",
            &[&item_id],
        )
        .await
        .map_err(ApiError::database)?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(ApiError::conflict(format!(
            "feedback item {item_id} 已归档、合并或不存在。"
        )))
    }
}

async fn submission_result(
    client: &impl GenericClient,
    user_id: i64,
    submission_id: i64,
) -> Result<Value, ApiError> {
    let row = client
        .query_opt(
            "SELECT s.id, s.item_id, s.state, s.match_candidates,
                    i.status AS item_status,
                    count(all_s.id) FILTER (WHERE all_s.state IN ('linked', 'needs_information'))::bigint AS occurrences,
                    count(DISTINCT all_s.user_id) FILTER
                      (WHERE all_s.state IN ('linked', 'needs_information'))::bigint AS affected_users
             FROM abei_ai.feedback_submissions s
             LEFT JOIN abei_ai.feedback_items i ON i.id = s.item_id
             LEFT JOIN abei_ai.feedback_submissions all_s ON all_s.item_id = i.id
             WHERE s.id = $1 AND s.user_id = $2
             GROUP BY s.id, i.id",
            &[&submission_id, &user_id],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found(format!("feedback submission {submission_id} 不存在。")))?;
    let state: String = row.get("state");
    let item_id: Option<i64> = row.get("item_id");
    if state == "pending_confirmation" {
        let candidates: Value = row.get("match_candidates");
        Ok(json!({
            "submission_id": submission_id,
            "state": "needs_confirmation",
            "candidates": candidates,
            "next_actions": ["confirm_same", "confirm_new"],
        }))
    } else {
        Ok(json!({
            "submission_id": submission_id,
            "feedback_id": item_id,
            "state": state,
            "status": row.get::<_, Option<String>>("item_status"),
            "affected_users": row.get::<_, i64>("affected_users"),
            "occurrences": row.get::<_, i64>("occurrences"),
        }))
    }
}

async fn item_detail(
    client: &impl GenericClient,
    item_id: i64,
    user_id: Option<i64>,
    is_owner: bool,
) -> Result<Value, ApiError> {
    let item = client
        .query_opt(
            "SELECT i.id, i.title, i.kind, i.target, i.status, i.severity, i.public_summary,
                    i.close_reason, i.merged_into_id, i.archived_at::text AS archived_at,
                    i.archived_by, i.created_at::text AS created_at,
                    i.updated_at::text AS updated_at, i.completed_at::text AS completed_at,
                    count(s.id) FILTER (WHERE s.state IN ('linked', 'needs_information'))::bigint AS occurrences,
                    count(DISTINCT s.user_id) FILTER
                      (WHERE s.state IN ('linked', 'needs_information'))::bigint AS affected_users,
                    min(s.created_at) FILTER
                      (WHERE s.state IN ('linked', 'needs_information'))::text AS first_seen,
                    max(s.created_at) FILTER
                      (WHERE s.state IN ('linked', 'needs_information'))::text AS last_seen
             FROM abei_ai.feedback_items i
             LEFT JOIN abei_ai.feedback_submissions s ON s.item_id = i.id
             WHERE i.id = $1
               AND ($3::boolean OR EXISTS (
                 SELECT 1 FROM abei_ai.feedback_submissions mine
                 WHERE mine.item_id = i.id AND mine.user_id = $2
                   AND mine.state IN ('linked', 'needs_information')
               ))
             GROUP BY i.id",
            &[&item_id, &user_id, &is_owner],
        )
        .await
        .map_err(ApiError::database)?
        .ok_or_else(|| ApiError::not_found(format!("feedback item {item_id} 不存在。")))?;
    let updates = client
        .query(
            "SELECT id, body, status_snapshot, created_at::text AS created_at
             FROM abei_ai.feedback_updates WHERE item_id = $1 ORDER BY created_at, id",
            &[&item_id],
        )
        .await
        .map_err(ApiError::database)?
        .iter()
        .map(|row| {
            json!({
                "id": row.get::<_, i64>("id"),
                "body": row.get::<_, String>("body"),
                "status": row.get::<_, String>("status_snapshot"),
                "created_at": row.get::<_, String>("created_at"),
            })
        })
        .collect::<Vec<_>>();
    let submissions = client
        .query(
            "SELECT id, kind, target, submitted_via, message, expected, actual, state,
                    context, match_candidates, created_at::text AS created_at,
                    linked_at::text AS linked_at, last_seen_at::text AS last_seen_at
             FROM abei_ai.feedback_submissions
             WHERE item_id = $1 AND ($3::boolean OR user_id = $2)
             ORDER BY created_at DESC, id DESC",
            &[&item_id, &user_id, &is_owner],
        )
        .await
        .map_err(ApiError::database)?;
    let submission_ids = submissions
        .iter()
        .map(|row| row.get::<_, i64>("id"))
        .collect::<Vec<_>>();
    let submission_values = submissions
        .iter()
        .map(|row| submission_from_row(row, is_owner))
        .collect::<Vec<_>>();
    let messages = if submission_ids.is_empty() {
        Vec::new()
    } else {
        client
            .query(
                "SELECT id, submission_id, author_kind, body, created_at::text AS created_at
                 FROM abei_ai.feedback_messages
                 WHERE submission_id = ANY($1) ORDER BY created_at, id",
                &[&submission_ids],
            )
            .await
            .map_err(ApiError::database)?
            .iter()
            .map(message_from_row)
            .collect()
    };
    let audit = if is_owner {
        client
            .query(
                "SELECT id, item_id, submission_id, event_type, actor_kind, actor_user_id,
                        metadata, created_at::text AS created_at
                 FROM abei_ai.feedback_audit_events
                 WHERE item_id = $1 OR submission_id = ANY($2)
                 ORDER BY created_at, id",
                &[&item_id, &submission_ids],
            )
            .await
            .map_err(ApiError::database)?
            .iter()
            .map(audit_from_row)
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    Ok(json!({
        "data": item_detail_from_row(&item),
        "updates": updates,
        "submissions": submission_values,
        "messages": messages,
        "audit": audit,
        "permissions": { "manage": is_owner },
    }))
}

fn item_summary(row: &Row) -> Value {
    json!({
        "feedback_id": row.get::<_, i64>("id"),
        "title": row.get::<_, String>("title"),
        "kind": row.get::<_, String>("kind"),
        "target": row.get::<_, String>("target"),
        "status": row.get::<_, String>("status"),
        "severity": row.get::<_, Option<String>>("severity"),
        "public_summary": row.get::<_, String>("public_summary"),
        "affected_users": row.get::<_, i64>("affected_users"),
        "occurrences": row.get::<_, i64>("occurrences"),
        "first_seen": row.get::<_, Option<String>>("first_seen"),
        "last_seen": row.get::<_, Option<String>>("last_seen"),
        "my_submission_ids": row.get::<_, Vec<i64>>("my_submission_ids"),
        "archived_at": row.get::<_, Option<String>>("archived_at"),
        "created_at": row.get::<_, String>("created_at"),
        "updated_at": row.get::<_, String>("updated_at"),
    })
}

fn item_detail_from_row(row: &Row) -> Value {
    json!({
        "feedback_id": row.get::<_, i64>("id"),
        "title": row.get::<_, String>("title"),
        "kind": row.get::<_, String>("kind"),
        "target": row.get::<_, String>("target"),
        "status": row.get::<_, String>("status"),
        "severity": row.get::<_, Option<String>>("severity"),
        "public_summary": row.get::<_, String>("public_summary"),
        "close_reason": row.get::<_, Option<String>>("close_reason"),
        "merged_into_id": row.get::<_, Option<i64>>("merged_into_id"),
        "archived_at": row.get::<_, Option<String>>("archived_at"),
        "archived_by": row.get::<_, Option<String>>("archived_by"),
        "affected_users": row.get::<_, i64>("affected_users"),
        "occurrences": row.get::<_, i64>("occurrences"),
        "first_seen": row.get::<_, Option<String>>("first_seen"),
        "last_seen": row.get::<_, Option<String>>("last_seen"),
        "created_at": row.get::<_, String>("created_at"),
        "updated_at": row.get::<_, String>("updated_at"),
        "completed_at": row.get::<_, Option<String>>("completed_at"),
    })
}

fn pending_submission(row: &Row) -> Value {
    let state: String = row.get("state");
    json!({
        "submission_id": row.get::<_, i64>("id"),
        "kind": row.get::<_, String>("kind"),
        "target": row.get::<_, String>("target"),
        "submitted_via": row.get::<_, String>("submitted_via"),
        "message": row.get::<_, String>("message"),
        "expected": row.get::<_, Option<String>>("expected"),
        "actual": row.get::<_, Option<String>>("actual"),
        "state": if state == "pending_confirmation" { "needs_confirmation" } else { "needs_information" },
        "candidates": row.get::<_, Value>("match_candidates"),
        "messages": row.get::<_, Value>("messages"),
        "created_at": row.get::<_, String>("created_at"),
        "last_seen_at": row.get::<_, String>("last_seen_at"),
    })
}

fn submission_from_row(row: &Row, include_context: bool) -> Value {
    let mut value = json!({
        "submission_id": row.get::<_, i64>("id"),
        "kind": row.get::<_, String>("kind"),
        "target": row.get::<_, String>("target"),
        "submitted_via": row.get::<_, String>("submitted_via"),
        "message": row.get::<_, String>("message"),
        "expected": row.get::<_, Option<String>>("expected"),
        "actual": row.get::<_, Option<String>>("actual"),
        "state": row.get::<_, String>("state"),
        "created_at": row.get::<_, String>("created_at"),
        "linked_at": row.get::<_, Option<String>>("linked_at"),
        "last_seen_at": row.get::<_, String>("last_seen_at"),
    });
    if include_context {
        value["context"] = row.get::<_, Value>("context");
        value["match_candidates"] = row.get::<_, Value>("match_candidates");
    }
    value
}

fn message_from_row(row: &Row) -> Value {
    json!({
        "id": row.get::<_, i64>("id"),
        "submission_id": row.get::<_, i64>("submission_id"),
        "author_kind": row.get::<_, String>("author_kind"),
        "body": row.get::<_, String>("body"),
        "created_at": row.get::<_, String>("created_at"),
    })
}

fn audit_from_row(row: &Row) -> Value {
    json!({
        "id": row.get::<_, i64>("id"),
        "item_id": row.get::<_, Option<i64>>("item_id"),
        "submission_id": row.get::<_, Option<i64>>("submission_id"),
        "event_type": row.get::<_, String>("event_type"),
        "actor_kind": row.get::<_, String>("actor_kind"),
        "actor_user_id": row.get::<_, Option<i64>>("actor_user_id"),
        "metadata": row.get::<_, Value>("metadata"),
        "created_at": row.get::<_, String>("created_at"),
    })
}

async fn audit_item(
    transaction: &Transaction<'_>,
    item_id: i64,
    event_type: &str,
    actor_kind: &str,
    actor_user_id: Option<i64>,
    metadata: Value,
) -> Result<(), ApiError> {
    transaction
        .execute(
            "INSERT INTO abei_ai.feedback_audit_events
             (item_id, event_type, actor_kind, actor_user_id, metadata)
             VALUES ($1, $2, $3, $4, $5)",
            &[
                &item_id,
                &event_type,
                &actor_kind,
                &actor_user_id,
                &metadata,
            ],
        )
        .await
        .map_err(ApiError::database)?;
    Ok(())
}

async fn audit_submission(
    transaction: &Transaction<'_>,
    submission_id: i64,
    event_type: &str,
    actor_kind: &str,
    actor_user_id: Option<i64>,
    metadata: Value,
) -> Result<(), ApiError> {
    transaction
        .execute(
            "INSERT INTO abei_ai.feedback_audit_events
             (submission_id, event_type, actor_kind, actor_user_id, metadata)
             VALUES ($1, $2, $3, $4, $5)",
            &[
                &submission_id,
                &event_type,
                &actor_kind,
                &actor_user_id,
                &metadata,
            ],
        )
        .await
        .map_err(ApiError::database)?;
    Ok(())
}

fn validate_text(field: &str, value: &str, required: bool) -> Result<Option<String>, ApiError> {
    let value = value.trim();
    if value.is_empty() {
        return if required {
            Err(ApiError::invalid_params(format!("{field} 不能为空。")))
        } else {
            Ok(None)
        };
    }
    if value.chars().count() > MAX_MESSAGE_CHARS {
        return Err(ApiError::invalid_params(format!(
            "{field} 最多 {MAX_MESSAGE_CHARS} 字。"
        )));
    }
    if value.chars().any(|character| {
        character == '\0' || (character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    }) {
        return Err(ApiError::invalid_params(format!(
            "{field} 包含不允许的控制字符。"
        )));
    }
    Ok(Some(value.to_owned()))
}

fn validate_text_option(field: &str, value: Option<String>) -> Result<Option<String>, ApiError> {
    value
        .as_deref()
        .map(|value| validate_text(field, value, false))
        .transpose()
        .map(Option::flatten)
}

fn validate_audit_reason(value: &str) -> Result<String, ApiError> {
    let value = validate_text("reason", value, true)?
        .expect("required text validation always returns a value");
    if json!({ "reason": value }).to_string().len() > 3 * 1024 {
        return Err(ApiError::invalid_params("reason 编码后不能超过 3 KiB。"));
    }
    Ok(value)
}

fn validate_idempotency_key(value: &str) -> Result<(), ApiError> {
    let valid = (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'));
    if valid {
        Ok(())
    } else {
        Err(ApiError::invalid_params(
            "idempotency_key 必须是 8 到 128 个 ASCII 字母、数字、-、_、. 或 :。",
        ))
    }
}

fn validate_runtime_context(context: &RuntimeContext) -> Result<(), ApiError> {
    for (name, value, limit) in [
        ("cli_version", context.cli_version.as_deref(), 64),
        ("os", context.os.as_deref(), 64),
        ("arch", context.arch.as_deref(), 64),
        ("recorded_at", context.recorded_at.as_deref(), 64),
    ] {
        validate_short_context(name, value, limit)?;
    }
    if let Some(recent) = &context.recent {
        for (name, value, limit) in [
            ("capability_id", recent.capability_id.as_deref(), 128),
            ("request_id", recent.request_id.as_deref(), 128),
            ("result", recent.result.as_deref(), 16),
            ("error_reason", recent.error_reason.as_deref(), 128),
            ("error_code", recent.error_code.as_deref(), 128),
            ("recorded_at", recent.recorded_at.as_deref(), 64),
        ] {
            validate_short_context(name, value, limit)?;
        }
        if recent
            .result
            .as_deref()
            .is_some_and(|value| !matches!(value, "success" | "error"))
        {
            return Err(ApiError::invalid_params(
                "context.recent.result 只能是 success 或 error。",
            ));
        }
    }
    Ok(())
}

fn validate_short_context(
    field: &str,
    value: Option<&str>,
    max_chars: usize,
) -> Result<(), ApiError> {
    if value.is_some_and(|value| {
        value.chars().count() > max_chars || value.chars().any(|character| character.is_control())
    }) {
        Err(ApiError::invalid_params(format!(
            "context.{field} 不合法或过长。"
        )))
    } else {
        Ok(())
    }
}

fn fingerprint(target: FeedbackTarget, context: &RuntimeContext) -> Option<String> {
    let recent = context.recent.as_ref()?;
    let capability = recent.capability_id.as_deref()?.trim();
    let error = recent
        .error_reason
        .as_deref()
        .or(recent.error_code.as_deref())?
        .trim();
    if capability.is_empty() || error.is_empty() {
        return None;
    }
    let stable = format!(
        "v{FINGERPRINT_VERSION}|{}|{capability}|{error}",
        target.as_str()
    );
    let mut output = String::with_capacity(64);
    for byte in Sha256::digest(stable.as_bytes()) {
        write!(output, "{byte:02x}").expect("writing to String cannot fail");
    }
    Some(output)
}

fn initial_title(message: &str) -> String {
    let collapsed = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title = collapsed.chars().take(80).collect::<String>();
    if collapsed.chars().count() > 80 {
        title.push_str("...");
    }
    if title.is_empty() {
        "Feedback".to_owned()
    } else {
        title
    }
}

fn text_similarity(left: &str, right: &str) -> f64 {
    let left = normalized_chars(left);
    let right = normalized_chars(right);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    if left == right {
        return 1.0;
    }
    let left_grams = ngrams(&left);
    let right_grams = ngrams(&right);
    let intersection = left_grams.intersection(&right_grams).count();
    let union = left_grams.union(&right_grams).count();
    if union == 0 {
        0.0
    } else {
        intersection as f64 / union as f64
    }
}

fn normalized_chars(value: &str) -> Vec<char> {
    value
        .to_lowercase()
        .chars()
        .filter(|character| character.is_alphanumeric())
        .collect()
}

fn ngrams(chars: &[char]) -> BTreeSet<String> {
    let width = if chars.len() >= 4 { 2 } else { 1 };
    chars
        .windows(width)
        .map(|window| window.iter().collect())
        .collect()
}

fn candidate_ids(value: &Value) -> BTreeSet<i64> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|candidate| candidate.get("feedback_id").and_then(Value::as_i64))
        .collect()
}

fn parse_gate(gate: Result<Query<WriteGate>, QueryRejection>) -> Result<WriteGate, ApiError> {
    gate.map(|Query(gate)| gate)
        .map_err(|error| ApiError::invalid_params(format!("查询参数不对：{error}")))
}

fn json_error(error: JsonRejection) -> ApiError {
    ApiError::invalid_params(format!("JSON 请求体不对：{}", error.body_text()))
}

fn positive_id(path: Result<Path<String>, PathRejection>, field: &str) -> Result<i64, ApiError> {
    let raw = path
        .map_err(|error| ApiError::invalid_params(format!("{field} 不对：{error}")))?
        .0;
    if raw.is_empty()
        || raw.starts_with('0')
        || raw.starts_with('+')
        || raw.starts_with('-')
        || !raw.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ApiError::invalid_params(format!(
            "{field} 必须是正整数，收到的是 {raw}。"
        )));
    }
    raw.parse()
        .map_err(|_| ApiError::invalid_params(format!("{field} 必须是正整数。")))
}

fn validate_optional_choice(
    field: &str,
    value: Option<&str>,
    choices: &[&str],
) -> Result<(), ApiError> {
    if value.is_none_or(|value| choices.contains(&value)) {
        Ok(())
    } else {
        Err(ApiError::invalid_params(format!(
            "{field} 只能是 {}。",
            choices.join("、")
        )))
    }
}

fn pagination(limit: Option<i64>, offset: Option<i64>) -> Result<(i64, i64), ApiError> {
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);
    if !(1..=100).contains(&limit) {
        return Err(ApiError::invalid_params("limit 必须在 1 到 100 之间。"));
    }
    if offset < 0 {
        return Err(ApiError::invalid_params("offset 不能小于 0。"));
    }
    Ok((limit, offset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn kind_and_target_accept_numeric_and_named_aliases() {
        for input in [InputChoice::Number(1), InputChoice::Text("bug".to_owned())] {
            assert_eq!(
                FeedbackKind::parse(&input, "kind").unwrap(),
                FeedbackKind::Bug
            );
        }
        assert_eq!(FeedbackTarget::parse(None).unwrap(), FeedbackTarget::Cli);
        assert_eq!(
            FeedbackTarget::parse(Some(&InputChoice::Number(3))).unwrap(),
            FeedbackTarget::Web
        );
    }

    #[test]
    fn text_similarity_is_versioned_and_deterministic() {
        assert_eq!(text_similarity("账单导入失败", "账单导入失败"), 1.0);
        assert!(text_similarity("账单导入一直没有结果", "账单导入没有结果") > TEXT_MATCH_THRESHOLD);
        assert!(text_similarity("账单导入失败", "希望增加预算图表") < TEXT_MATCH_THRESHOLD);
    }

    #[test]
    fn fingerprint_uses_only_stable_runtime_fields() {
        let context = RuntimeContext {
            recent: Some(RecentInvocation {
                capability_id: Some("bills.import".to_owned()),
                request_id: Some("request-a".to_owned()),
                error_reason: Some("UpstreamUnavailable".to_owned()),
                ..RecentInvocation::default()
            }),
            ..RuntimeContext::default()
        };
        let first = fingerprint(FeedbackTarget::Cli, &context).unwrap();
        let mut changed_request = context;
        changed_request.recent.as_mut().unwrap().request_id = Some("request-b".to_owned());
        assert_eq!(
            first,
            fingerprint(FeedbackTarget::Cli, &changed_request).unwrap()
        );
    }

    #[test]
    fn context_rejects_unknown_or_oversized_values() {
        let parsed = serde_json::from_value::<RuntimeContext>(json!({ "argv": ["secret"] }));
        assert!(parsed.is_err());
        let context = RuntimeContext {
            cli_version: Some("x".repeat(65)),
            ..RuntimeContext::default()
        };
        assert!(validate_runtime_context(&context).is_err());
    }

    #[test]
    fn create_rejects_client_supplied_identity_fields() {
        for field in ["user_id", "role", "submitted_by"] {
            let mut body = json!({
                "kind": "bug",
                "message": "identity must come from authentication",
                "idempotency_key": "identity-test"
            });
            body[field] = json!("forged-owner");
            assert!(
                serde_json::from_value::<CreateFeedback>(body).is_err(),
                "{field} must not be accepted from the request body"
            );
        }
    }

    #[test]
    fn audit_reason_is_limited_by_encoded_size() {
        assert_eq!(validate_audit_reason("reviewed").unwrap(), "reviewed");
        assert!(validate_audit_reason(&"x".repeat(MAX_MESSAGE_CHARS)).is_err());
    }

    #[test]
    fn item_patch_distinguishes_missing_and_null_fields() {
        let missing: UpdateItem = serde_json::from_value(json!({ "title": "Updated" })).unwrap();
        assert!(missing.severity.is_none());
        assert!(missing.close_reason.is_none());

        let cleared: UpdateItem = serde_json::from_value(json!({
            "severity": null,
            "close_reason": null,
        }))
        .unwrap();
        assert_eq!(cleared.severity, Some(None));
        assert_eq!(cleared.close_reason, Some(None));
    }

    #[tokio::test]
    async fn database_flow_is_isolated_idempotent_and_admin_audited() {
        let Ok(url) = std::env::var("ABEI_TEST_DATABASE_URL") else {
            return;
        };
        let pool = crate::create_pool(url.parse().unwrap(), 4).unwrap();
        crate::initialize(&pool).await.unwrap();
        let db = pool.get().await.unwrap();
        let users = db
            .query(
                "SELECT id::bigint FROM public.users ORDER BY id LIMIT 2",
                &[],
            )
            .await
            .unwrap();
        if users.len() < 2 {
            return;
        }
        let first_user: i64 = users[0].get(0);
        let second_user: i64 = users[1].get(0);
        drop(db);

        let verification_pool = pool.clone();
        let app = crate::build_app(crate::AppState::new(
            pool,
            crate::mailbox::RuntimeConfig::test(),
            crate::TEST_SECRET.to_owned(),
        ));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let base = format!("http://{address}");
        let client = reqwest::Client::new();
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut nonce = String::with_capacity(64);
        for byte in Sha256::digest(suffix.to_string().as_bytes()) {
            write!(nonce, "{byte:02x}").unwrap();
        }
        let message = format!("feedback database probe {nonce}");
        let key_one = format!("feedback-test-{suffix}-one");
        let key_two = format!("feedback-test-{suffix}-two");
        let key_three = format!("feedback-test-{suffix}-three");
        let create_body = |key: &str| {
            json!({
                "kind": 1,
                "message": message,
                "idempotency_key": key,
                "context": {
                    "cli_version": "test",
                    "os": "test",
                    "arch": "test",
                    "recent": {
                        "capability_id": "bills.import",
                        "result": "error",
                        "error_reason": format!("FeedbackTest{suffix}")
                    }
                }
            })
        };
        let with_identity = |request: reqwest::RequestBuilder, user_id: i64, role: &str| {
            let actor = format!("user-{user_id}");
            request
                .header(crate::ACTOR_HEADER, &actor)
                .header(crate::ROLE_HEADER, role)
                .header(crate::USER_ID_HEADER, user_id)
                .header(
                    crate::SIGNATURE_HEADER,
                    crate::test_signature(&actor, role, user_id),
                )
        };

        let response = with_identity(
            client.post(format!("{base}/v1/feedback")),
            first_user,
            "demo",
        )
        .json(&create_body(&key_one))
        .send()
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let first: Value = response.json().await.unwrap();
        assert_eq!(first["state"], "linked");
        let submission_one = first["submission_id"].as_i64().unwrap();
        let item_id = first["feedback_id"].as_i64().unwrap();

        let retry = with_identity(
            client.post(format!("{base}/v1/feedback")),
            first_user,
            "demo",
        )
        .json(&create_body(&key_one))
        .send()
        .await
        .unwrap();
        assert_eq!(retry.status(), StatusCode::OK);
        let retry: Value = retry.json().await.unwrap();
        assert_eq!(retry["submission_id"], submission_one);
        assert_eq!(retry["occurrences"], 1);

        let response = with_identity(
            client.post(format!("{base}/v1/feedback")),
            second_user,
            "demo",
        )
        .json(&create_body(&key_two))
        .send()
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let second: Value = response.json().await.unwrap();
        assert_eq!(second["state"], "needs_confirmation");
        assert_eq!(second["candidates"][0]["feedback_id"], item_id);
        let submission_two = second["submission_id"].as_i64().unwrap();

        let admin_detail = with_identity(
            client.get(format!(
                "{base}/v1/admin/feedback/submissions/{submission_two}"
            )),
            first_user,
            "owner",
        )
        .send()
        .await
        .unwrap();
        assert_eq!(admin_detail.status(), StatusCode::OK);
        let admin_detail: Value = admin_detail.json().await.unwrap();
        assert_eq!(admin_detail["data"]["submission_id"], submission_two);
        assert_eq!(admin_detail["data"]["state"], "pending_confirmation");
        assert_eq!(
            admin_detail["data"]["context"]["recent"]["error_reason"],
            format!("FeedbackTest{suffix}")
        );
        assert!(admin_detail["messages"].as_array().unwrap().is_empty());
        assert!(
            admin_detail["audit"]
                .as_array()
                .unwrap()
                .iter()
                .any(|event| event["event_type"] == "submission_created")
        );

        let question = with_identity(
            client.post(format!(
                "{base}/v1/admin/feedback/submissions/{submission_two}/messages"
            )),
            first_user,
            "owner",
        )
        .json(&json!({ "message": "Which import format was used?" }))
        .send()
        .await
        .unwrap();
        assert_eq!(question.status(), StatusCode::CREATED);

        let user_inbox = with_identity(
            client.get(format!("{base}/v1/feedback")),
            second_user,
            "demo",
        )
        .send()
        .await
        .unwrap();
        assert_eq!(user_inbox.status(), StatusCode::OK);
        let user_inbox: Value = user_inbox.json().await.unwrap();
        let requested = user_inbox["pending"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["submission_id"] == submission_two)
            .unwrap();
        assert_eq!(requested["state"], "needs_information");
        assert_eq!(requested["messages"][0]["author_kind"], "admin");
        assert_eq!(
            requested["messages"][0]["body"],
            "Which import format was used?"
        );

        let answer = with_identity(
            client.post(format!(
                "{base}/v1/feedback/submissions/{submission_two}/messages"
            )),
            second_user,
            "demo",
        )
        .json(&json!({ "message": "CSV exported from the bank." }))
        .send()
        .await
        .unwrap();
        assert_eq!(answer.status(), StatusCode::CREATED);

        let admin_detail = with_identity(
            client.get(format!(
                "{base}/v1/admin/feedback/submissions/{submission_two}"
            )),
            first_user,
            "owner",
        )
        .send()
        .await
        .unwrap();
        assert_eq!(admin_detail.status(), StatusCode::OK);
        let admin_detail: Value = admin_detail.json().await.unwrap();
        assert_eq!(admin_detail["data"]["state"], "pending_confirmation");
        assert_eq!(admin_detail["data"]["message_count"], 2);
        assert_eq!(admin_detail["messages"][0]["author_kind"], "admin");
        assert_eq!(admin_detail["messages"][1]["author_kind"], "user");

        let cross_user = with_identity(
            client.post(format!(
                "{base}/v1/feedback/submissions/{submission_two}/confirm"
            )),
            first_user,
            "demo",
        )
        .json(&json!({ "same_as": item_id }))
        .send()
        .await
        .unwrap();
        assert_eq!(cross_user.status(), StatusCode::NOT_FOUND);

        for expected_occurrences in [2, 2] {
            let confirmed = with_identity(
                client.post(format!(
                    "{base}/v1/feedback/submissions/{submission_two}/confirm"
                )),
                second_user,
                "demo",
            )
            .json(&json!({ "same_as": item_id }))
            .send()
            .await
            .unwrap();
            assert_eq!(confirmed.status(), StatusCode::OK);
            let confirmed: Value = confirmed.json().await.unwrap();
            assert_eq!(confirmed["occurrences"], expected_occurrences);
        }

        let response = with_identity(
            client.post(format!("{base}/v1/feedback")),
            first_user,
            "demo",
        )
        .json(&create_body(&key_three))
        .send()
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let third: Value = response.json().await.unwrap();
        let submission_three = third["submission_id"].as_i64().unwrap();
        assert!(
            third["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .any(|candidate| candidate["feedback_id"] == item_id)
        );

        let confirmed = with_identity(
            client.post(format!(
                "{base}/v1/feedback/submissions/{submission_three}/confirm"
            )),
            first_user,
            "demo",
        )
        .json(&json!({ "same_as": item_id }))
        .send()
        .await
        .unwrap();
        assert_eq!(confirmed.status(), StatusCode::OK);
        let confirmed: Value = confirmed.json().await.unwrap();
        assert_eq!(confirmed["occurrences"], 3);

        let expected_times = verification_pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT min(created_at)::text AS first_seen,
                        max(created_at)::text AS last_seen,
                        max(last_seen_at) > max(created_at) AS interaction_time_is_later
                 FROM abei_ai.feedback_submissions
                 WHERE item_id = $1 AND state IN ('linked', 'needs_information')",
                &[&item_id],
            )
            .await
            .unwrap();
        assert!(expected_times.get::<_, bool>("interaction_time_is_later"));

        let first_user_list = with_identity(
            client.get(format!("{base}/v1/feedback")),
            first_user,
            "demo",
        )
        .send()
        .await
        .unwrap();
        assert_eq!(first_user_list.status(), StatusCode::OK);
        let first_user_list: Value = first_user_list.json().await.unwrap();
        let listed_item = first_user_list["data"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["feedback_id"] == item_id)
            .unwrap();
        assert_eq!(listed_item["occurrences"], 3);
        assert_eq!(listed_item["affected_users"], 2);
        assert_eq!(
            listed_item["my_submission_ids"],
            json!([submission_one, submission_three])
        );
        assert_eq!(
            listed_item["first_seen"],
            expected_times.get::<_, String>("first_seen")
        );
        assert_eq!(
            listed_item["last_seen"],
            expected_times.get::<_, String>("last_seen")
        );

        let forbidden = with_identity(
            client.get(format!("{base}/v1/admin/feedback/items")),
            second_user,
            "demo",
        )
        .send()
        .await
        .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

        let missing_update = with_identity(
            client.patch(format!("{base}/v1/admin/feedback/items/{item_id}")),
            first_user,
            "owner",
        )
        .json(&json!({ "status": "completed" }))
        .send()
        .await
        .unwrap();
        assert_eq!(missing_update.status(), StatusCode::BAD_REQUEST);

        let completed = with_identity(
            client.patch(format!("{base}/v1/admin/feedback/items/{item_id}")),
            first_user,
            "owner",
        )
        .json(&json!({
            "status": "completed",
            "severity": "high",
            "update": "The import flow has been fixed."
        }))
        .send()
        .await
        .unwrap();
        assert_eq!(completed.status(), StatusCode::OK);
        let completed: Value = completed.json().await.unwrap();
        assert_eq!(completed["data"]["status"], "completed");
        assert_eq!(completed["data"]["severity"], "high");
        assert_eq!(completed["updates"].as_array().unwrap().len(), 1);

        let cleared = with_identity(
            client.patch(format!("{base}/v1/admin/feedback/items/{item_id}")),
            first_user,
            "owner",
        )
        .json(&json!({ "severity": null }))
        .send()
        .await
        .unwrap();
        assert_eq!(cleared.status(), StatusCode::OK);
        let cleared: Value = cleared.json().await.unwrap();
        assert!(cleared["data"]["severity"].is_null());

        let audit_count = cleared["audit"].as_array().unwrap().len();
        let updated_at = cleared["data"]["updated_at"].clone();
        let no_op = with_identity(
            client.patch(format!("{base}/v1/admin/feedback/items/{item_id}")),
            first_user,
            "owner",
        )
        .json(&json!({ "title": cleared["data"]["title"] }))
        .send()
        .await
        .unwrap();
        assert_eq!(no_op.status(), StatusCode::OK);
        let no_op: Value = no_op.json().await.unwrap();
        assert_eq!(no_op["audit"].as_array().unwrap().len(), audit_count);
        assert_eq!(no_op["data"]["updated_at"], updated_at);

        let oversized_reason = with_identity(
            client.post(format!("{base}/v1/admin/feedback/items/{item_id}/archive")),
            first_user,
            "owner",
        )
        .json(&json!({ "reason": "x".repeat(MAX_MESSAGE_CHARS) }))
        .send()
        .await
        .unwrap();
        assert_eq!(oversized_reason.status(), StatusCode::BAD_REQUEST);

        let before_archive = with_identity(
            client.get(format!("{base}/v1/admin/feedback/items/{item_id}")),
            first_user,
            "owner",
        )
        .send()
        .await
        .unwrap();
        assert_eq!(before_archive.status(), StatusCode::OK);
        let before_archive: Value = before_archive.json().await.unwrap();
        assert!(before_archive["data"]["archived_at"].is_null());
        assert!(
            before_archive["audit"]
                .as_array()
                .unwrap()
                .iter()
                .all(|event| event["event_type"] != "item_archived")
        );

        for action in ["archive", "restore"] {
            let response = with_identity(
                client.post(format!("{base}/v1/admin/feedback/items/{item_id}/{action}")),
                first_user,
                "owner",
            )
            .json(&json!({ "reason": format!("integration test {action}") }))
            .send()
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            if action == "archive" {
                let archived_update = with_identity(
                    client.patch(format!("{base}/v1/admin/feedback/items/{item_id}")),
                    first_user,
                    "owner",
                )
                .json(&json!({ "public_summary": "should not be saved" }))
                .send()
                .await
                .unwrap();
                assert_eq!(archived_update.status(), StatusCode::CONFLICT);

                let archived_publish = with_identity(
                    client.post(format!("{base}/v1/admin/feedback/items/{item_id}/updates")),
                    first_user,
                    "owner",
                )
                .json(&json!({ "body": "should not be published" }))
                .send()
                .await
                .unwrap();
                assert_eq!(archived_publish.status(), StatusCode::CONFLICT);
            }
        }

        let visible = with_identity(
            client.get(format!("{base}/v1/feedback/{item_id}")),
            second_user,
            "demo",
        )
        .send()
        .await
        .unwrap();
        assert_eq!(visible.status(), StatusCode::OK);
        let visible: Value = visible.json().await.unwrap();
        assert_eq!(visible["data"]["status"], "completed");
        assert_eq!(
            visible["updates"][0]["body"],
            "The import flow has been fixed."
        );
        assert!(visible["audit"].as_array().unwrap().is_empty());

        let redacted = with_identity(
            client.patch(format!(
                "{base}/v1/admin/feedback/submissions/{submission_two}"
            )),
            first_user,
            "owner",
        )
        .json(&json!({ "state": "redacted", "reason": "privacy request" }))
        .send()
        .await
        .unwrap();
        assert_eq!(redacted.status(), StatusCode::OK);
        let redacted: Value = redacted.json().await.unwrap();
        assert_eq!(redacted["data"]["message"], "[redacted]");
        assert!(
            redacted["messages"]
                .as_array()
                .unwrap()
                .iter()
                .all(|message| message["body"] == "[redacted]")
        );

        let redacted_latest = with_identity(
            client.patch(format!(
                "{base}/v1/admin/feedback/submissions/{submission_three}"
            )),
            first_user,
            "owner",
        )
        .json(&json!({ "state": "redacted", "reason": "aggregate filter test" }))
        .send()
        .await
        .unwrap();
        assert_eq!(redacted_latest.status(), StatusCode::OK);

        let filtered_detail = with_identity(
            client.get(format!("{base}/v1/admin/feedback/items/{item_id}")),
            first_user,
            "owner",
        )
        .send()
        .await
        .unwrap();
        assert_eq!(filtered_detail.status(), StatusCode::OK);
        let filtered_detail: Value = filtered_detail.json().await.unwrap();
        assert_eq!(filtered_detail["data"]["occurrences"], 1);
        assert_eq!(filtered_detail["data"]["affected_users"], 1);
        assert_eq!(
            filtered_detail["data"]["first_seen"],
            filtered_detail["data"]["last_seen"]
        );

        let dismissed_key = format!("feedback-test-{suffix}-dismissed");
        let after_dismiss_key = format!("feedback-test-{suffix}-after-dismiss");
        let mut dismissed_nonce = String::with_capacity(64);
        for byte in Sha256::digest(format!("dismissed:{suffix}").as_bytes()) {
            write!(dismissed_nonce, "{byte:02x}").unwrap();
        }
        let dismissed_message = format!("dismissed fingerprint probe {dismissed_nonce}");
        let dismissed_context = json!({
            "recent": {
                "capability_id": "feedback.dismissed-fingerprint-test",
                "result": "error",
                "error_code": format!("DismissedFingerprint{suffix}")
            }
        });
        let dismissed_source = with_identity(
            client.post(format!("{base}/v1/feedback")),
            first_user,
            "demo",
        )
        .json(&json!({
            "kind": "bug",
            "message": dismissed_message.clone(),
            "idempotency_key": dismissed_key,
            "context": dismissed_context.clone()
        }))
        .send()
        .await
        .unwrap();
        assert_eq!(dismissed_source.status(), StatusCode::CREATED);
        let dismissed_source: Value = dismissed_source.json().await.unwrap();
        let dismissed_submission = dismissed_source["submission_id"].as_i64().unwrap();

        let dismissed = with_identity(
            client.patch(format!(
                "{base}/v1/admin/feedback/submissions/{dismissed_submission}"
            )),
            first_user,
            "owner",
        )
        .json(&json!({ "state": "dismissed", "reason": "not actionable" }))
        .send()
        .await
        .unwrap();
        assert_eq!(dismissed.status(), StatusCode::OK);

        let after_dismiss = with_identity(
            client.post(format!("{base}/v1/feedback")),
            second_user,
            "demo",
        )
        .json(&json!({
            "kind": "bug",
            "message": dismissed_message,
            "idempotency_key": after_dismiss_key,
            "context": dismissed_context
        }))
        .send()
        .await
        .unwrap();
        assert_eq!(after_dismiss.status(), StatusCode::CREATED);
        let after_dismiss: Value = after_dismiss.json().await.unwrap();
        assert_eq!(after_dismiss["state"], "linked");
    }
}
