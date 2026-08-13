ALTER TABLE abei_ai.mail_rules
  ADD COLUMN IF NOT EXISTS builtin_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS mail_rules_user_builtin_key_idx
  ON abei_ai.mail_rules (user_id, builtin_key)
  WHERE builtin_key IS NOT NULL;
