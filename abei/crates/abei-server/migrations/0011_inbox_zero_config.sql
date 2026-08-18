-- 收件箱去配置化：账户不再要人先配，高置信重复不再要人一条条点。
--
-- 两件事各加一列：
--
-- 1) bill_account_mappings.state —— 入账时渠道还没对上账户，系统会替用户在 Firefly
--    建一个同名资产账户并写下映射。但「Firefly 里已经有一个同名账户」不能静默绑定：
--    那可能是用户自己早就在用的账户，也可能只是重名。这种映射先落成
--    pending_confirmation，不参与给流水盖账户，等用户在收件箱横幅上点一次才转 active。
--
-- 2) bill_row_links.decided_by —— 最高置信档（0.98，两边订单号/交易号对得上）的重复
--    由系统自动确认，不再进待办。自动和人工必须分得开：界面上要能把自动合并的那些
--    单独摆出来给人撤回，否则「系统悄悄并掉了一笔」就成了一件查不出来的事。
--    suggested 状态没有决定者，所以这一列可空。

ALTER TABLE abei_ai.bill_account_mappings
    ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active';

ALTER TABLE abei_ai.bill_account_mappings
    DROP CONSTRAINT IF EXISTS bill_account_mappings_state_check;
ALTER TABLE abei_ai.bill_account_mappings
    ADD CONSTRAINT bill_account_mappings_state_check
    CHECK (state IN ('active', 'pending_confirmation'));

ALTER TABLE abei_ai.bill_row_links
    ADD COLUMN IF NOT EXISTS decided_by text;

ALTER TABLE abei_ai.bill_row_links
    DROP CONSTRAINT IF EXISTS bill_row_links_decided_by_check;
ALTER TABLE abei_ai.bill_row_links
    ADD CONSTRAINT bill_row_links_decided_by_check
    CHECK (decided_by IS NULL OR decided_by IN ('user', 'auto'));

-- 这一列之前的每一个决定都是人做的：那时候还没有自动确认这条路。
UPDATE abei_ai.bill_row_links
   SET decided_by = 'user'
 WHERE state <> 'suggested' AND decided_by IS NULL;

CREATE INDEX IF NOT EXISTS bill_account_mappings_user_state_idx
    ON abei_ai.bill_account_mappings (user_id, state);
