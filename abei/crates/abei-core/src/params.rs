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
use std::fmt;

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

/// `feedback create` 的参数。CLI 会把 source 固定成 cli。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackCreateParams {
    /// 一句话说清问题，最多 120 字。
    pub title: String,
    /// Markdown 正文，分为现象、期望、复现、环境。
    pub body: String,
    /// 标签，可重复；优先参考 bug、friction、idea。
    pub labels: Option<Vec<String>>,
    /// 反馈类型：bug、friction 或 idea。
    pub kind: String,
    /// 提交者的 AI 名字或人名。
    pub submitted_by: String,
    /// 来源：cli 或 web。CLI 固定填 cli。
    pub source: String,
}

/// 反馈的业务状态。GitHub 同步是否成功由独立的 `sync_status` 表示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackStatus {
    Open,
    Planned,
    Started,
    Completed,
    Declined,
    Duplicate,
}

impl FeedbackStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Planned => "planned",
            Self::Started => "started",
            Self::Completed => "completed",
            Self::Declined => "declined",
            Self::Duplicate => "duplicate",
        }
    }
}

impl fmt::Display for FeedbackStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// `feedback update` 的参数。把状态改回 open 就是重开。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackUpdateParams {
    /// 反馈 id，正整数。
    pub id: String,
    /// 新状态：open、planned、started、completed、declined 或 duplicate。
    pub status: FeedbackStatus,
    /// 给提交者看的处理说明。completed 与 declined 必填。
    pub response: Option<String>,
    /// 原反馈 id；status=duplicate 时必填，其余状态不能填写。
    pub duplicate_of: Option<u64>,
}

/// `feedback delete` 的参数。服务端采用可审计的软删除。
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackDeleteParams {
    /// 反馈 id，正整数。
    pub id: String,
    /// 删除原因，供审计与误删排查。
    pub reason: String,
}

/// `feedback list` 的筛选与分页参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackListParams {
    /// 按反馈类型筛选：bug、friction 或 idea。
    pub kind: Option<String>,
    /// 按业务状态筛选。
    pub status: Option<FeedbackStatus>,
    /// 按同步状态筛选：local、synced 或 failed。
    pub sync_status: Option<String>,
    /// 返回条数，1 到 100，默认 50。
    pub limit: Option<u32>,
    /// 跳过条数，默认 0。
    pub offset: Option<u32>,
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

/// `bills sync` 与 `bills process` 的参数。
#[derive(Debug, Clone, Default, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BillsBatchParams {
    /// 这一轮最多处理多少封，默认 100。
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
    /// 收款账户名。
    pub destination_name: Option<String>,
    /// 分类名。
    pub category_name: Option<String>,
    /// 备注。
    pub notes: Option<String>,
    /// 标签。
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
