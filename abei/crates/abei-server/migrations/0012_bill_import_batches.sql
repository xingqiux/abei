-- 「这几笔是同一次入账写进去的」以前没地方记。
--
-- 一次批量入账在库里留下的只有 N 条各自独立的 bill_import_attempts：每条有自己的
-- created_at、自己的 transaction_group_id。界面想给「整批撤回」，只能拿时间窗口去猜
-- 哪几条算一批——两次相隔三秒的入账会被并成一批，一次跑了两分钟的大批量会被切成好几段。
-- 猜错的后果是从账本里删掉不该删的交易，所以不猜：入账那一刻就把这一批的编号写下来。
--
-- 可空：这一列上线之前入的账没有批次，界面按「更早的入账」单独成组、不给整批撤回，
-- 逐行撤销照旧。回填不做——历史数据里没有任何可靠依据能还原当时的分批。
ALTER TABLE abei_ai.bill_import_attempts
  ADD COLUMN IF NOT EXISTS batch_id UUID;

-- 已完成层按批次分组时按这个走：user_id 先筛，再按批次聚。
CREATE INDEX IF NOT EXISTS bill_import_attempts_batch_idx
  ON abei_ai.bill_import_attempts (user_id, batch_id)
  WHERE batch_id IS NOT NULL;
