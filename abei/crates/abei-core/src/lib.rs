//! 阿贝能力目录。
//!
//! 一条能力就是「资源 × 动词 × 参数 schema」加上风险档和当前后端。
//! resource 和 verb 是一等字段：命令路径、agent 工具名、HTTP 路由都由它们直接算出，
//! 不存在需要人工维护的翻译表。

mod capability;
mod catalog;
mod params;

pub use capability::{
    Backend, Capability, CapabilityBuilder, CapabilityView, Example, FixedParam, Method, Risk,
    Target, Verb, VerbParseError,
};
pub use catalog::{Catalog, CatalogView, ResourceDef, ResourceView, catalog};
pub use params::{
    AccountsListParams, BillsBatchParams, BillsImportParams, BillsListParams, BillsUnlockParams,
    FeedbackCreateParams, FeedbackDeleteParams, FeedbackListParams, FeedbackStatus,
    FeedbackUpdateParams, IdParams, RowSplit, RowsSplitParams, RowsUpdateParams,
    TransactionsListParams, TransactionsSearchParams, TransactionsShowParams,
    TransactionsSummaryParams,
};
