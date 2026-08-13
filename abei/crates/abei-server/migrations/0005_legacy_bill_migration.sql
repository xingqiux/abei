ALTER TABLE abei_ai.mail_messages
  ALTER COLUMN mailbox_user_id DROP NOT NULL;

ALTER TABLE abei_ai.mail_messages
  ADD COLUMN IF NOT EXISTS legacy_bill_mail_message_id BIGINT;

ALTER TABLE abei_ai.mail_messages
  ADD COLUMN IF NOT EXISTS legacy_bill_task_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_legacy_message_idx
  ON abei_ai.mail_messages (legacy_bill_mail_message_id)
  WHERE legacy_bill_mail_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS mail_messages_legacy_task_idx
  ON abei_ai.mail_messages (legacy_bill_task_id)
  WHERE legacy_bill_task_id IS NOT NULL;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mail_messages_mailbox_or_legacy_check'
      AND conrelid = 'abei_ai.mail_messages'::regclass
  ) THEN
    ALTER TABLE abei_ai.mail_messages
      ADD CONSTRAINT mail_messages_mailbox_or_legacy_check
      CHECK (
        mailbox_user_id IS NOT NULL
        OR legacy_bill_mail_message_id IS NOT NULL
        OR legacy_bill_task_id IS NOT NULL
      );
  END IF;
END
$constraint$;

ALTER TABLE abei_ai.bill_artifacts
  ADD COLUMN IF NOT EXISTS legacy_bill_artifact_id BIGINT;

CREATE UNIQUE INDEX IF NOT EXISTS bill_artifacts_legacy_artifact_idx
  ON abei_ai.bill_artifacts (legacy_bill_artifact_id)
  WHERE legacy_bill_artifact_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS abei_ai.legacy_bill_migration_runs (
  id BIGSERIAL PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode = 'apply'),
  source_counts JSONB NOT NULL,
  target_counts JSONB NOT NULL,
  comparison JSONB NOT NULL,
  report JSONB NOT NULL,
  report_checksum CHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS legacy_bill_migration_runs_created_idx
  ON abei_ai.legacy_bill_migration_runs (created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION abei_ai.reject_legacy_bill_migration_run_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'legacy bill migration runs are immutable';
END
$function$;

DO $trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'legacy_bill_migration_runs_immutable'
      AND tgrelid = 'abei_ai.legacy_bill_migration_runs'::regclass
  ) THEN
    CREATE TRIGGER legacy_bill_migration_runs_immutable
      BEFORE UPDATE OR DELETE ON abei_ai.legacy_bill_migration_runs
      FOR EACH ROW EXECUTE FUNCTION abei_ai.reject_legacy_bill_migration_run_mutation();
  END IF;
END
$trigger$;
