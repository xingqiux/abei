-- 配对从「只算个分数」变成一件能做完的事。
--
-- bill_row_links 原先只有 confidence 和 evidence：分数算出来了，人确认或否掉之后
-- 没地方记，下一轮重算又把同一条建议提一遍。这里给它补状态，配对才有闭环。
ALTER TABLE abei_ai.bill_row_links
    ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'suggested',
    ADD COLUMN IF NOT EXISTS decided_at timestamptz,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE abei_ai.bill_row_links
    DROP CONSTRAINT IF EXISTS bill_row_links_state_check;
ALTER TABLE abei_ai.bill_row_links
    ADD CONSTRAINT bill_row_links_state_check
    CHECK (state IN ('suggested', 'confirmed', 'rejected'));

CREATE INDEX IF NOT EXISTS bill_row_links_user_state_idx
    ON abei_ai.bill_row_links (user_id, state);
