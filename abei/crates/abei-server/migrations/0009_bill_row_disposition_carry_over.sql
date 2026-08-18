-- 两处「处置结果丢了」的数据损坏，都缺一根指回原行的线。
--
-- 一、重解析开新 revision 时，旧 revision 里已经入账/已忽略的那一行，处置结果没地方
-- 交接，新行只能一律以 pending 出生——已经记进 Firefly 的账于是重新出现在待入账里，
-- 再入一次就是双记。inherited_from_row_id 记住「我接的是哪一行的处置」，
-- 部分唯一索引保证一行的处置最多被继承一次，两条新行不可能同时认领同一笔已入账的账。
--
-- 二、确认重复时被并掉的那一行，link 上没记，撤回只能按 dismissed_reason 猜，
-- 结果把别的 link 并掉的行、甚至不相干的行一起放回来。merged_row_id 记住这条 link
-- 自己并掉的是谁，撤回就只放回它。

ALTER TABLE abei_ai.bill_rows
    ADD COLUMN IF NOT EXISTS inherited_from_row_id BIGINT
        REFERENCES abei_ai.bill_rows(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS bill_rows_inherited_from_idx
    ON abei_ai.bill_rows (inherited_from_row_id)
    WHERE inherited_from_row_id IS NOT NULL;

ALTER TABLE abei_ai.bill_row_links
    ADD COLUMN IF NOT EXISTS merged_row_id BIGINT
        REFERENCES abei_ai.bill_rows(id) ON DELETE SET NULL;

-- 迁移之前确认的配对没有这条线。能唯一认出来的（这条 link 的两侧里正好有一侧是被
-- 「确认重复」并掉的）就补上；认不出来的留空，撤回时宁可什么都不放回，也不放错行。
UPDATE abei_ai.bill_row_links l
SET merged_row_id = m.id
FROM abei_ai.bill_rows m
WHERE l.state = 'confirmed'
  AND l.merged_row_id IS NULL
  AND m.id IN (l.left_row_id, l.right_row_id)
  AND m.status = 'dismissed'
  AND m.dismissed_reason = 'duplicate_confirmed'
  AND NOT EXISTS (
    SELECT 1 FROM abei_ai.bill_rows other
    WHERE other.id IN (l.left_row_id, l.right_row_id)
      AND other.id <> m.id
      AND other.status = 'dismissed'
      AND other.dismissed_reason = 'duplicate_confirmed'
  );
