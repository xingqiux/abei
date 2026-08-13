//! 各能力的参数类型。schema 从这里生成，CLI 的 flag、agent 的工具参数、
//! HTTP 的查询参数都以它为准；`deny_unknown_fields` 保证拼错的字段会报错而不是被悄悄丢掉。
//!
//! `x-abei-positional` 标记「命令行上这个值不带 `--` 直接写」：`abei tx search 星巴克`。
//! 一条能力最多标一个，且不能和查询串（有 start/end 的那些）并存，否则命令行上分不清谁是谁。
//!
//! `x-abei-human-only` 标记「这个值只能由人现场输入」：密码、验证码这类东西。
//! 带这个标记的字段不会出现在模型看到的参数模式里，模型自己填了也会被丢掉。
//! **名单只有这一份**——agent 那边不许再养一张手工维护的敏感字段表，否则以后新增
//! 敏感字段时忘了同步就是静默泄漏。

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// `transactions list` 的参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TransactionsListParams {
    /// 起始日期，格式 YYYY-MM-DD，含当天。
    pub start: Option<String>,
    /// 结束日期，格式 YYYY-MM-DD，含当天。
    pub end: Option<String>,
    /// 交易类型：withdrawal 支出、deposit 收入、transfer 转账、all 全部。
    #[serde(rename = "type")]
    pub kind: Option<String>,
    /// 页码，从 1 开始。
    pub page: Option<u32>,
    /// 每页条数，1 到 100。
    pub limit: Option<u32>,
}

/// `transactions show` 的参数。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TransactionsShowParams {
    /// 交易组 id，正整数。
    pub id: String,
}

/// `transactions summary` 的参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TransactionsSummaryParams {
    /// 起始日期，格式 YYYY-MM-DD，含当天。
    pub start: Option<String>,
    /// 结束日期，格式 YYYY-MM-DD，含当天。
    pub end: Option<String>,
    /// 额外排除的分类名，在默认排除表之外追加。
    pub exclude_category: Option<Vec<String>>,
}

/// `transactions search` 的参数。
///
/// 跟 `list` 的区别：这里是服务端全文检索，`list` 的位置参数是本地过滤。
/// 要在整个账本里找「上次这家店记的什么分类」就用它。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TransactionsSearchParams {
    /// 搜什么。摘要、对方、备注都在检索范围里，最多 500 字。
    #[schemars(extend("x-abei-positional" = true))]
    pub query: String,
    /// 每页条数，1 到 100。
    pub limit: Option<u32>,
    /// 页码，从 1 开始。
    pub page: Option<u32>,
}

/// `accounts list` 的参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AccountsListParams {
    /// 账户类型：asset 资产、expense 支出、revenue 收入、liability 负债、all 全部。
    #[serde(rename = "type")]
    pub kind: Option<String>,
    /// 页码，从 1 开始。
    pub page: Option<u32>,
    /// 每页条数，1 到 100。
    pub limit: Option<u32>,
}

/// `bills list` 的参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BillsListParams {
    /// 来源渠道，例如 alipay、wechat、cmb、boc。
    pub source: Option<String>,
    /// 任务状态，例如 pending、needs_secret、failed、imported、ignored。
    pub status: Option<String>,
    /// 页码，从 1 开始。
    pub page: Option<u32>,
    /// 每页条数，1 到 100。
    pub limit: Option<u32>,
}

/// 只按 id 取一个对象的能力共用这一个参数类型。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct IdParams {
    /// 对象 id，正整数。
    pub id: String,
}

/// `feedback create` 的 AI 输入。幂等 key 与安全运行上下文由 CLI 自动注入。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackCreateParams {
    /// 1/bug=已有行为失败或结果错误；2/experience=能完成但难用、慢或提示不清；3/suggestion=希望增加不存在的能力。
    pub kind: String,
    /// 直接描述现象或诉求，1 到 4000 字纯文本；不要粘贴 Token、财务正文或完整工具输出。
    pub message: String,
    /// 可选目标面：1/cli、2/app、3/web；省略时 CLI 自动设为 cli。
    pub target: Option<String>,
    /// bug 且用户明确说出预期时填写。
    pub expected: Option<String>,
    /// bug 且 message 没有表达实际结果时填写。
    pub actual: Option<String>,
}

/// `feedback confirm` 的参数。same_as 与 new 必须且只能选一个。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackConfirmParams {
    /// create 返回的 submission_id，正整数。
    pub id: String,
    /// 用户确认相同时，填写 create 候选中的 feedback_id。
    pub same_as: Option<u64>,
    /// 用户确认不是同一事项时使用 --new。
    #[serde(rename = "new")]
    pub create_new: Option<bool>,
}

/// `feedback reply` 的参数。回复只属于本次 Submission，不广播给其他用户。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackReplyParams {
    /// 要回复的 submission_id，正整数。
    pub id: String,
    /// 补充说明，1 到 4000 字纯文本。
    pub message: String,
}

/// `feedback list` 的筛选与分页参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackListParams {
    /// 按反馈类型筛选：bug、experience 或 suggestion。
    pub kind: Option<String>,
    /// 按产品面筛选：cli、app 或 web。
    pub target: Option<String>,
    /// 按业务状态筛选。
    pub status: Option<String>,
    /// 返回条数，1 到 100，默认 50。
    pub limit: Option<u32>,
    /// 跳过条数，默认 0。
    pub offset: Option<u32>,
}

/// `profile-doc list` 没有筛选参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileDocListParams {}

/// `profile-doc get` 的稳定文档标识。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileDocGetParams {
    /// 小写字母、数字和中划线组成的 slug，最多 64 个字符。
    pub slug: String,
}

/// `profile-doc create` 的参数。Markdown 按原字节内容保存，CLI 固定 source=cli。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileDocCreateParams {
    /// 小写字母、数字和中划线组成的 slug，最多 64 个字符。
    #[schemars(extend("x-abei-positional" = true))]
    pub slug: String,
    /// 文档标题，最多 200 字。
    pub title: String,
    /// Markdown 正文，最多 1 MiB。
    #[schemars(extend("x-abei-file-input" = true))]
    pub content_md: String,
    /// 来源：cli 或 web。CLI 固定填 cli。
    pub source: String,
}

/// `profile-doc update` 的参数。expected_version 防止覆盖别人刚保存的版本。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileDocUpdateParams {
    /// 小写字母、数字和中划线组成的 slug，最多 64 个字符。
    pub slug: String,
    /// 当前读到的版本号；服务端不匹配时返回 409。
    #[schemars(range(min = 1, max = 2_147_483_647))]
    pub expected_version: u32,
    /// 新标题；不提供就保持原值。
    pub title: Option<String>,
    /// 新 Markdown 正文；不提供就保持原值，最多 1 MiB。
    #[schemars(extend("x-abei-file-input" = true))]
    pub content_md: Option<String>,
    /// 来源：cli 或 web。CLI 固定填 cli。
    pub source: String,
}

/// `profile-doc delete` 的参数。expected_version 防止删除别人刚更新的版本。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ProfileDocDeleteParams {
    /// 小写字母、数字和中划线组成的 slug，最多 64 个字符。
    pub slug: String,
    /// 当前读到的版本号；服务端不匹配时返回 409。
    #[schemars(range(min = 1, max = 2_147_483_647))]
    pub expected_version: u32,
}

/// `bills import` 的参数。all 与 row_ids 二选一。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BillsImportParams {
    /// 账单任务 id，正整数。
    pub id: String,
    /// 导入这份账单里全部待处理的流水。与 row_ids 二选一。
    pub all: Option<bool>,
    /// 只导入这些流水行。与 all 二选一。
    pub row_ids: Option<Vec<u64>>,
    /// 返回体里带上将要写进账本的完整字段，排障用。
    pub include_payload: Option<bool>,
}

/// `bills unlock` 的参数。密码只经手不落日志。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BillsUnlockParams {
    /// 账单任务 id，正整数。
    pub id: String,
    /// 账单文件的打开密码或验证码。由人在可信界面输入，不要让模型自己编。
    #[schemars(extend("x-abei-human-only" = true))]
    pub secret: String,
}

/// `bills sync` 的参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BillsBatchParams {
    /// 这一轮最多处理多少封，默认 100。
    pub limit: Option<u32>,
    /// 等待这次同步运行结束并返回最终统计。
    pub wait: Option<bool>,
    /// wait=true 时最多等待多少秒，默认 120，最大 600。
    pub timeout_seconds: Option<u32>,
}

/// `mail-sync-runs list` 的参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MailSyncRunsListParams {
    /// 返回最近多少次运行，1 到 100。
    pub limit: Option<u32>,
}

/// `bill-account-mappings list` 的参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BillAccountMappingsListParams {
    /// 只看某个账单渠道。
    pub channel: Option<String>,
}

/// `bill-account-mappings update` 的参数。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BillAccountMappingUpdateParams {
    /// 账单渠道。
    pub channel_key: String,
    /// 账单中出现的原始账户名称或别名。
    pub account_hint: String,
    /// Firefly 资产、现金或负债账户 id。
    pub firefly_account_id: String,
}

/// `rows dismiss/restore` 的参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RowsBulkParams {
    /// 要操作的流水 id，最多 500 条；dismiss 可配合 filter。
    #[serde(default)]
    pub row_ids: Vec<u64>,
    /// dismiss 的机器重复过滤器。
    pub filter: Option<String>,
    /// dismiss 的人工原因；restore 会忽略该字段。
    pub reason: Option<String>,
}

/// `mail-messages list` 的参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MailMessagesListParams {
    /// 归类状态：unclassified、matched、ignored 或 error。
    pub classification: Option<String>,
    /// 搜索发件人、主题、Message-ID 或附件信息。
    pub search: Option<String>,
    /// 返回数量，1 到 100。
    pub limit: Option<u32>,
    /// 跳过数量，最大 100000。
    pub offset: Option<u32>,
}

/// `mail-rules test` 的参数。conditions 可由 CLI 从 JSON 文件读取。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MailRuleTestParams {
    /// 结构化规则条件 JSON；CLI 支持 `@文件` 或标准输入 `-`。
    #[schemars(extend("x-abei-file-input" = true, "x-abei-json-input" = true))]
    pub conditions: serde_json::Value,
    /// 只对指定邮件 id 测试；不填时使用最近邮件。
    pub message_ids: Option<Vec<u64>>,
    /// 最大测试数量，1 到 500。
    pub limit: Option<u32>,
}

/// `mailboxes rescan` 的参数。CLI 固定使用当前用户邮箱。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MailboxRescanParams {
    /// 邮箱 id；CLI 自动使用 current。
    pub id: String,
    /// 开始日期，格式 YYYY-MM-DD，含当天。
    pub from: String,
    /// 结束日期，格式 YYYY-MM-DD，含当天。
    pub to: Option<String>,
    /// 本轮最多扫描多少封，1 到 500。
    pub limit: Option<u32>,
}

/// `rows update` 的参数。
///
/// 只开放「这笔该记成什么」这一组字段：银行原文（交易时间、对方、订单号等）不给改，
/// 那是账单本身说的话。写入一律记成 AI 建议，由人在收件箱确认。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RowsUpdateParams {
    /// 流水行 id，正整数。
    pub id: String,
    /// 记账类型：withdrawal 支出、deposit 收入、transfer 转账。
    pub firefly_type: Option<String>,
    /// 记账日期，格式 YYYY-MM-DD。
    pub firefly_date: Option<String>,
    /// 记账金额，正数。
    pub firefly_amount: Option<String>,
    /// 记账摘要。
    pub firefly_description: Option<String>,
    /// 付款账户名。
    pub source_name: Option<String>,
    /// 付款 Firefly 账户 id。
    pub source_account_id: Option<u64>,
    /// 收款账户名。
    pub destination_name: Option<String>,
    /// 收款 Firefly 账户 id。
    pub destination_account_id: Option<u64>,
    /// 分类名。
    pub category_name: Option<String>,
    /// 备注。
    pub notes: Option<String>,
    /// 标签。
    pub tags: Option<Vec<String>>,
}

/// `rows update-many` 的参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RowsBatchUpdateParams {
    /// 要更新的待处理流水 id，最多 500 条。
    pub row_ids: Vec<u64>,
    pub firefly_type: Option<String>,
    pub firefly_date: Option<String>,
    pub firefly_amount: Option<String>,
    pub firefly_description: Option<String>,
    pub source_name: Option<String>,
    pub source_account_id: Option<u64>,
    pub destination_name: Option<String>,
    pub destination_account_id: Option<u64>,
    pub category_name: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<Vec<String>>,
}

/// 一次拆分里的一笔。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RowSplit {
    /// 这一笔的金额，正数。
    pub amount: String,
    /// 这一笔的摘要，必填——拆出来的每笔都得说清楚是什么。
    pub description: String,
    /// 这一笔的分类名。
    pub category_name: Option<String>,
    /// 这一笔的收/付款方式。
    pub payment_method: Option<String>,
    /// 这一笔的付款账户名。
    pub source_name: Option<String>,
}

/// `rows split` 的参数。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RowsSplitParams {
    /// 流水行 id，正整数。
    pub id: String,
    /// 拆成哪几笔，至少两笔，最多二十笔。
    pub splits: Vec<RowSplit>,
}
