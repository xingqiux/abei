//! 阿贝能力目录。
//!
//! 一条能力就是「资源 × 动词 × 参数 schema」加上风险档和当前后端。
//! resource 和 verb 是一等字段：命令路径、agent 工具名、HTTP 路由都由它们直接算出，
//! 不存在需要人工维护的翻译表。
//!
//! [`internal_auth`] 是搭在这里的另一件东西：abei-api 与 abei-server 之间的可信身份
//! 签名。它放在本 crate 只因为这两个服务都依赖它，签名格式必须两边同一份实现。

mod capability;
mod catalog;
pub mod internal_auth;
mod params;

pub use capability::{
    Backend, Capability, CapabilityBuilder, CapabilityView, Example, FixedParam, Method, Risk,
    Target, Verb, VerbParseError,
};
pub use catalog::{Catalog, CatalogView, ResourceDef, ResourceView, catalog};
pub use params::{
    AccountsListParams, BillAccountMappingUpdateParams, BillAccountMappingsListParams,
    BillsBatchParams, BillsImportParams, BillsListParams, BillsUnlockParams, FeedbackConfirmParams,
    FeedbackCreateParams, FeedbackListParams, FeedbackReplyParams, IdParams,
    MailSyncRunsListParams, RowSplit, RowsBatchUpdateParams, RowsBulkParams, RowsSplitParams,
    RowsUpdateParams, TransactionsListParams, TransactionsSearchParams, TransactionsShowParams,
    TransactionsSummaryParams,
};
