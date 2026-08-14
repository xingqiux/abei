-- 撤销旧账单迁移留下的脚手架。迁移已取消：旧表里是测试数据，邮件原件都能从邮件服务器
-- 重拉，账单数据没有搬迁价值。legacy_bills.rs 与 legacy-bills 子命令已删除，
-- 下面这些列、表、触发器再没有任何代码读写。
--
-- 注意：legacy_channel_key 和 feedback_*.legacy_feedback_id 是另外两条还在用的路径，
-- 与旧账单迁移无关，不在这里动。

-- CHECK 约束引用了下面要删的列，先解开。
ALTER TABLE abei_ai.mail_messages
  DROP CONSTRAINT IF EXISTS mail_messages_mailbox_or_legacy_check;

-- 0005 加的列（索引随列一起消失）。
ALTER TABLE abei_ai.mail_messages
  DROP COLUMN IF EXISTS legacy_bill_mail_message_id;

ALTER TABLE abei_ai.mail_messages
  DROP COLUMN IF EXISTS legacy_bill_task_id;

ALTER TABLE abei_ai.bill_artifacts
  DROP COLUMN IF EXISTS legacy_bill_artifact_id;

-- 0003 为同一条迁移预留的外键列，同样再无代码读写。
ALTER TABLE abei_ai.bill_documents
  DROP COLUMN IF EXISTS legacy_bill_task_id;

ALTER TABLE abei_ai.bill_rows
  DROP COLUMN IF EXISTS legacy_bill_statement_row_id;

-- mailbox_user_id 当初放开 NOT NULL，只是为了容纳迁移进来的、不属于任何邮箱的旧邮件；
-- 补位的 CHECK 约束刚才已经删掉，这里必须把 NOT NULL 收回来，否则这一列就彻底没有约束了。
-- 真出现 NULL 行只可能是迁移残留，按「旧数据不要」的决定直接清掉。
DELETE FROM abei_ai.mail_messages WHERE mailbox_user_id IS NULL;

ALTER TABLE abei_ai.mail_messages
  ALTER COLUMN mailbox_user_id SET NOT NULL;

-- 迁移报告表：DROP TABLE 会连它的不可变触发器一起带走，之后函数才能删。
DROP TABLE IF EXISTS abei_ai.legacy_bill_migration_runs;
DROP FUNCTION IF EXISTS abei_ai.reject_legacy_bill_migration_run_mutation();

-- Firefly/PHP 时代账单收件箱留下的孤儿表。建它们的那批 Laravel migration 已经在
-- 7f64afa「删除账单收件箱与 bill-worker」里删掉，Firefly 自己也不再认识它们；
-- 新实现全部在 abei_ai schema 下。public.bills 是 Firefly III 官方的订阅表，仍在使用，
-- 不在下面这份名单里。
DROP TABLE IF EXISTS public.bill_statement_rows CASCADE;
DROP TABLE IF EXISTS public.bill_statement_imports CASCADE;
DROP TABLE IF EXISTS public.bill_artifacts CASCADE;
DROP TABLE IF EXISTS public.bill_task_events CASCADE;
DROP TABLE IF EXISTS public.bill_secret_challenges CASCADE;
DROP TABLE IF EXISTS public.bill_tasks CASCADE;
DROP TABLE IF EXISTS public.bill_mail_messages CASCADE;
DROP TABLE IF EXISTS public.bill_mailbox_sync_states CASCADE;
