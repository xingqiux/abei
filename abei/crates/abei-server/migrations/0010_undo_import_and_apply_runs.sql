-- 两处「做过的事没地方记」。
--
-- 一、撤销入账。以前撤销是前端直接删 Firefly 交易组，abei 这边什么都不知道：行永远
-- 停在 imported，导入尝试永远是 succeeded，「查看交易」指向一笔已经不存在的交易。
-- 要让行回到待处理，那条 succeeded 就必须离开「已落定」这一组，否则
-- bill_import_attempts_success_row_idx 会一直挡着这一行不让重新入账。直接改状态或者
-- 删记录都会把审计痕迹抹掉，所以新增一个终态 undone：账撤回了，记录还在。
ALTER TABLE abei_ai.bill_import_attempts
    DROP CONSTRAINT IF EXISTS bill_import_attempts_status_check;
ALTER TABLE abei_ai.bill_import_attempts
    ADD CONSTRAINT bill_import_attempts_status_check
    CHECK (status IN ('prepared', 'sending', 'succeeded', 'rejected',
                      'retryable', 'uncertain', 'reconciled', 'undone'));

-- 二、批量重归类的进度。以前 apply 在请求 handler 里同步跑 500 封，客户端一超时断连，
-- axum 就把这个 future 丢掉——252 封只处理了 5 封，跑到哪儿了没人知道，连「跑过」
-- 这件事都不存在。进度落到这张表上，任务才独立于连接，进程崩了也看得出是中断。
CREATE TABLE IF NOT EXISTS abei_ai.mail_rule_apply_runs (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  mail_rule_id BIGINT NOT NULL REFERENCES abei_ai.mail_rules(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('unclassified', 'all')),
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'succeeded', 'failed')),
  total_scanned INTEGER NOT NULL DEFAULT 0 CHECK (total_scanned >= 0),
  matched INTEGER NOT NULL DEFAULT 0 CHECK (matched >= 0),
  rerouted INTEGER NOT NULL DEFAULT 0 CHECK (rerouted >= 0),
  reparse_jobs INTEGER NOT NULL DEFAULT 0 CHECK (reparse_jobs >= 0),
  failed INTEGER NOT NULL DEFAULT 0 CHECK (failed >= 0),
  error_message TEXT,
  -- 跑着的任务每处理一封就更新一次。进程没了心跳就停在原地，读的时候据此判断
  -- 「还在跑」还是「中断了」，而不是让一条永远 running 的记录骗人。
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

-- 同一条规则同时只能有一个 apply 在跑。心跳失联的那条会先被回收成 failed，
-- 所以这个索引不会因为一次进程崩溃就把这条规则永久锁死。
CREATE UNIQUE INDEX IF NOT EXISTS mail_rule_apply_runs_active_idx
    ON abei_ai.mail_rule_apply_runs (mail_rule_id)
    WHERE state = 'running';

CREATE INDEX IF NOT EXISTS mail_rule_apply_runs_user_created_idx
    ON abei_ai.mail_rule_apply_runs (user_id, created_at DESC);
