use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::capability::{Backend, Capability, CapabilityView, Risk, Verb};
use crate::params::{
    AccountsListParams, BillsBatchParams, BillsImportParams, BillsListParams, BillsUnlockParams,
    FeedbackCreateParams, FeedbackDeleteParams, FeedbackListParams, FeedbackUpdateParams, IdParams,
    RowsSplitParams, RowsUpdateParams, TransactionsListParams, TransactionsSearchParams,
    TransactionsShowParams, TransactionsSummaryParams,
};

/// 一个资源。别名用于 CLI 的宽容解析和 did-you-mean。
#[derive(Debug, Clone)]
pub struct ResourceDef {
    pub name: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub aliases: &'static [&'static str],
}

impl ResourceDef {
    pub fn view(&self) -> ResourceView {
        ResourceView {
            name: self.name.to_owned(),
            label: self.label.to_owned(),
            description: self.description.to_owned(),
            aliases: self.aliases.iter().map(|a| (*a).to_owned()).collect(),
        }
    }

    /// 名字或别名命中都算。
    pub fn matches(&self, input: &str) -> bool {
        self.name == input || self.aliases.contains(&input)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResourceView {
    pub name: String,
    pub label: String,
    pub description: String,
    pub aliases: Vec<String>,
}

/// 目录对外形态。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogView {
    pub version: String,
    pub resources: Vec<ResourceView>,
    pub capabilities: Vec<CapabilityView>,
}

pub struct Catalog {
    resources: Vec<ResourceDef>,
    capabilities: Vec<Capability>,
}

impl Catalog {
    pub fn resources(&self) -> &[ResourceDef] {
        &self.resources
    }

    pub fn capabilities(&self) -> &[Capability] {
        &self.capabilities
    }

    pub fn get(&self, resource: &str, verb: Verb) -> Option<&Capability> {
        self.capabilities
            .iter()
            .find(|c| c.resource == resource && c.verb == verb)
    }

    pub fn by_id(&self, id: &str) -> Option<&Capability> {
        self.capabilities.iter().find(|c| c.id() == id)
    }

    /// 按名字或别名找资源。
    pub fn resolve_resource(&self, input: &str) -> Option<&ResourceDef> {
        self.resources.iter().find(|r| r.matches(input))
    }

    /// 某个资源支持哪些动词。CLI 的 `--help` 与 explain 靠它列举。
    pub fn verbs_for(&self, resource: &str) -> Vec<Verb> {
        let mut verbs: Vec<Verb> = self
            .capabilities
            .iter()
            .filter(|c| c.resource == resource)
            .map(|c| c.verb)
            .collect();
        verbs.sort_unstable();
        verbs
    }

    pub fn view(&self) -> CatalogView {
        CatalogView {
            version: env!("CARGO_PKG_VERSION").to_owned(),
            resources: self.resources.iter().map(ResourceDef::view).collect(),
            capabilities: self.capabilities.iter().map(Capability::view).collect(),
        }
    }
}

static CATALOG: LazyLock<Catalog> = LazyLock::new(build);

/// 全局目录。
pub fn catalog() -> &'static Catalog {
    &CATALOG
}

fn build() -> Catalog {
    let resources = vec![
        ResourceDef {
            name: "transactions",
            label: "交易",
            description: "账本里的收入、支出和转账。",
            aliases: &["tx", "txn", "transaction"],
        },
        ResourceDef {
            name: "accounts",
            label: "账户",
            description: "资产、支出、收入与负债账户。",
            aliases: &["acc", "account"],
        },
        ResourceDef {
            name: "bills",
            label: "账单任务",
            description: "收件箱里的一份份账单：一封邮件、一个附件，解析后等着入账。",
            aliases: &["bill", "task", "tasks", "inbox"],
        },
        ResourceDef {
            name: "rows",
            label: "账单流水",
            description: "账单解析出来的一条条流水，入账前的草稿。",
            aliases: &["row", "line", "lines"],
        },
        ResourceDef {
            name: "feedback",
            label: "产品反馈",
            description: "把使用中遇到的问题和想法交给产品团队。",
            aliases: &["fb"],
        },
    ];

    let capabilities = vec![
        Capability::define("transactions", Verb::List)
            .risk(Risk::Read)
            .backend(Backend::Firefly)
            .label("查看交易")
            .description("按日期区间和类型翻阅交易。")
            .example(
                "看这个月的支出",
                "abei transactions list --start 2026-08-01 --end 2026-08-31 --type withdrawal",
                json!({ "start": "2026-08-01", "end": "2026-08-31", "type": "withdrawal" }),
            )
            .params::<TransactionsListParams>(),
        Capability::define("transactions", Verb::Show)
            .risk(Risk::Read)
            .backend(Backend::Firefly)
            .label("查看单笔交易")
            .description("按 id 读一笔交易的全部字段。")
            .example(
                "看第 42 号交易",
                "abei transactions show 42",
                json!({ "id": "42" }),
            )
            .params::<TransactionsShowParams>(),
        Capability::define("transactions", Verb::Summary)
            .risk(Risk::Read)
            .backend(Backend::Firefly)
            .label("汇总消费")
            .description(
                "统计区间内的消费：按类型合计、日常消费口径、分类/商户/付款账户排行和每日流水。",
            )
            .example(
                "这个月花了多少",
                "abei transactions summary --start 2026-08-01 --end 2026-08-31",
                json!({ "start": "2026-08-01", "end": "2026-08-31" }),
            )
            .example(
                "排除房租再看一次",
                "abei transactions summary --start 2026-08-01 --end 2026-08-31 --exclude-category 房租",
                json!({ "start": "2026-08-01", "end": "2026-08-31", "exclude_category": ["房租"] }),
            )
            .params::<TransactionsSummaryParams>(),
        Capability::define("transactions", Verb::Search)
            .risk(Risk::Read)
            .backend(Backend::Firefly)
            .label("搜交易")
            .description(
                "在整个账本里全文检索交易，摘要、对方、备注都算。\
                 `list` 的查询串是在当页结果上本地过滤，找历史记录要用这条。",
            )
            .example(
                "以前在这家店都记的什么分类",
                "abei transactions search 星巴克",
                json!({ "query": "星巴克" }),
            )
            .example(
                "翻第二页",
                "abei transactions search 星巴克 --page 2 --limit 20",
                json!({ "query": "星巴克", "page": 2, "limit": 20 }),
            )
            .params::<TransactionsSearchParams>(),
        Capability::define("accounts", Verb::List)
            .risk(Risk::Read)
            .backend(Backend::Firefly)
            .label("查看账户")
            .description("列出账户，可按类型筛选。")
            .example(
                "看所有资产账户",
                "abei accounts list --type asset",
                json!({ "type": "asset" }),
            )
            .params::<AccountsListParams>(),
        Capability::define("bills", Verb::List)
            .risk(Risk::Read)
            .backend(Backend::Firefly)
            .label("查看账单任务")
            .description("列出收件箱里的账单任务，可按渠道和状态筛选。")
            .example(
                "看还没处理完的账单",
                "abei bills list --status pending",
                json!({ "status": "pending" }),
            )
            .example(
                "只看支付宝的",
                "abei bills list --source alipay",
                json!({ "source": "alipay" }),
            )
            .params::<BillsListParams>(),
        Capability::define("bills", Verb::Show)
            .risk(Risk::Read)
            .backend(Backend::Firefly)
            .label("查看单份账单")
            .description("按 id 读一份账单任务的状态、来源和处理进度。")
            .example("看第 42 号账单", "abei bills show 42", json!({ "id": "42" }))
            .params::<IdParams>(),
        Capability::define("bills", Verb::Review)
            .risk(Risk::Read)
            .backend(Backend::Firefly)
            .label("审阅账单")
            .description(
                "读一份账单已分好桶、脱过敏的审阅视图。改流水之前先看这个，别去逐行拉原始数据。",
            )
            .example(
                "审阅第 42 号账单",
                "abei bills review 42",
                json!({ "id": "42" }),
            )
            .params::<IdParams>(),
        Capability::define("bills", Verb::Import)
            .risk(Risk::Confirm)
            .backend(Backend::Firefly)
            .label("导入账单")
            .description(
                "把选中的流水写进账本。这一步会真的产生交易，必须人工确认；\
                 先干跑一次看会写什么。",
            )
            .example(
                "先看看会写什么",
                "abei bills import 42 --all --dry-run",
                json!({ "id": "42", "all": true }),
            )
            .example(
                "确认导入这两行",
                "abei bills import 42 --row-ids 7 --row-ids 8 --yes",
                json!({ "id": "42", "row_ids": [7, 8] }),
            )
            .params::<BillsImportParams>(),
        Capability::define("bills", Verb::Unlock)
            .risk(Risk::Confirm)
            .backend(Backend::Firefly)
            .label("提交账单密码")
            .description(
                "给加密的账单文件提交打开密码或验证码。密码由人在可信界面输入，\
                 不进日志、不回显给模型。",
            )
            .example(
                "提交第 42 号账单的密码（密码由人现敲，模型不要自己编）",
                "abei bills unlock 42 --secret 这里填密码 --yes",
                json!({ "id": "42", "secret": "这里填密码" }),
            )
            .params::<BillsUnlockParams>(),
        Capability::define("bills", Verb::Ignore)
            .risk(Risk::Confirm)
            .backend(Backend::Firefly)
            .label("忽略账单")
            .description("把这份账单移出待办队列，不再提示。")
            .example(
                "忽略第 42 号账单",
                "abei bills ignore 42 --yes",
                json!({ "id": "42" }),
            )
            .params::<IdParams>(),
        Capability::define("bills", Verb::Retry)
            .risk(Risk::Draft)
            .backend(Backend::Firefly)
            .label("重跑账单")
            .description("重新解析一份处理失败的账单。")
            .example(
                "重跑第 42 号账单",
                "abei bills retry 42 --yes",
                json!({ "id": "42" }),
            )
            .params::<IdParams>(),
        Capability::define("bills", Verb::Sync)
            .risk(Risk::Draft)
            .backend(Backend::Server)
            .label("收取账单邮件")
            .description("提交一次邮箱同步任务；任务在后台拉取并解析新账单邮件。")
            .example("现在收一次", "abei bills sync --yes", json!({}))
            .params::<BillsBatchParams>(),
        Capability::define("bills", Verb::Process)
            .risk(Risk::Draft)
            .backend(Backend::Firefly)
            .label("解析账单")
            .description("立刻推进一轮账单解析，把待处理的任务往前走一步。")
            .example("现在解析一轮", "abei bills process --yes", json!({}))
            .params::<BillsBatchParams>(),
        Capability::define("rows", Verb::Update)
            .risk(Risk::Draft)
            .backend(Backend::Firefly)
            .label("填写账单建议")
            .description(
                "填一条流水该记成什么：类型、日期、金额、摘要、账户、分类、标签。\
                 写入一律记成 AI 建议，等人在收件箱确认；银行原文不给改。",
            )
            .example(
                "把第 7 行记成餐饮支出",
                "abei rows update 7 --firefly-type withdrawal --category-name 餐饮 --yes",
                json!({ "id": "7", "firefly_type": "withdrawal", "category_name": "餐饮" }),
            )
            .params::<RowsUpdateParams>(),
        Capability::define("rows", Verb::Split)
            .risk(Risk::Draft)
            .backend(Backend::Firefly)
            .label("拆分组合支付")
            .description("把一条组合支付的流水拆成两笔以上的草稿，比如一半余额一半银行卡。")
            .example(
                "把第 7 行拆成两笔",
                "abei rows split 7 --splits amount=30.00,description=餐费,payment_method=余额 \
                 --splits amount=15.00,description=餐费,payment_method=招行卡 --yes",
                json!({ "id": "7", "splits": [
                    { "amount": "30.00", "description": "餐费", "payment_method": "余额" },
                    { "amount": "15.00", "description": "餐费", "payment_method": "招行卡" }
                ]}),
            )
            .params::<RowsSplitParams>(),
        Capability::define("feedback", Verb::Create)
            .risk(Risk::Confirm)
            .backend(Backend::Server)
            .label("提交反馈")
            .fixed_param("source", "cli")
            .description(
                "标题一句话说清问题；正文分 现象/期望/复现/环境。确认后写入本地，并按配置同步 GitHub issue。",
            )
            .example(
                "记录一处 CLI 摩擦",
                "abei feedback create --title '错误提示缺少字段名' --body '## 现象\n...\n## 期望\n...\n## 复现\n...\n## 环境\n...' --label friction --kind friction --by codex --yes",
                json!({
                    "title": "错误提示缺少字段名",
                    "body": "## 现象\n...\n## 期望\n...\n## 复现\n...\n## 环境\n...",
                    "labels": ["friction"],
                    "kind": "friction",
                    "submitted_by": "codex",
                    "source": "cli"
                }),
            )
            .params::<FeedbackCreateParams>(),
        Capability::define("feedback", Verb::Update)
            .risk(Risk::Confirm)
            .backend(Backend::Server)
            .label("处理反馈")
            .description(
                "更新业务状态并留下处理说明；改回 open 表示重开，duplicate 必须指定原反馈。",
            )
            .example(
                "确认第 42 条反馈已解决",
                "abei feedback update 42 --status completed --response '已在 0.2.0 修复' --yes",
                json!({
                    "id": "42",
                    "status": "completed",
                    "response": "已在 0.2.0 修复"
                }),
            )
            .params::<FeedbackUpdateParams>(),
        Capability::define("feedback", Verb::Retry)
            .risk(Risk::Confirm)
            .backend(Backend::Server)
            .label("重试反馈同步")
            .description("重新把当前反馈内容和状态同步到 GitHub。")
            .example(
                "重试第 42 条反馈",
                "abei feedback retry 42 --yes",
                json!({ "id": "42" }),
            )
            .params::<IdParams>(),
        Capability::define("feedback", Verb::Delete)
            .risk(Risk::Confirm)
            .backend(Backend::Server)
            .label("删除反馈")
            .description("从反馈列表中删除一条反馈；必须说明原因，服务端保留审计记录。")
            .example(
                "删除一条包含隐私的反馈",
                "abei feedback delete 42 --reason '包含个人隐私' --yes",
                json!({ "id": "42", "reason": "包含个人隐私" }),
            )
            .params::<FeedbackDeleteParams>(),
        Capability::define("feedback", Verb::List)
            .risk(Risk::Read)
            .backend(Backend::Server)
            .label("查看反馈")
            .description("倒序列出反馈，可按类型、业务状态和同步状态筛选。")
            .example(
                "看同步失败的反馈",
                "abei feedback list --sync-status failed",
                json!({ "sync_status": "failed" }),
            )
            .params::<FeedbackListParams>(),
        Capability::define("feedback", Verb::Get)
            .risk(Risk::Read)
            .backend(Backend::Server)
            .label("查看单条反馈")
            .description("按 id 查看一条反馈及其 GitHub 同步结果。")
            .example(
                "看第 42 条反馈",
                "abei feedback get 42",
                json!({ "id": "42" }),
            )
            .params::<IdParams>(),
    ];

    Catalog {
        resources,
        capabilities,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capability::Method;

    /// 路由由资源和动词直接算出。
    #[test]
    fn route_is_derived_from_resource_and_verb() {
        let list = catalog().get("transactions", Verb::List).unwrap();
        assert_eq!(list.route_path(), "/v1/transactions");
        assert_eq!(list.method(), Method::Get);

        let show = catalog().get("transactions", Verb::Show).unwrap();
        assert_eq!(show.route_path(), "/v1/transactions/{id}");

        // 意图动词追加动词段，不占用 {id} 的位置。
        let summary = catalog().get("transactions", Verb::Summary).unwrap();
        assert_eq!(summary.route_path(), "/v1/transactions/summary");
    }

    /// 作用在单个对象上的意图动词，路径里带 {id}。
    #[test]
    fn item_scoped_intent_verbs_carry_id() {
        let review = Capability::define("bills", Verb::Review)
            .label("审阅账单")
            .description("测试用")
            .params::<TransactionsShowParams>();
        assert_eq!(review.route_path(), "/v1/bills/{id}/review");

        let import = Capability::define("bills", Verb::Import)
            .label("导入账单")
            .description("测试用")
            .params::<TransactionsShowParams>();
        assert_eq!(import.method(), Method::Post);
        assert_eq!(import.route_path(), "/v1/bills/{id}/import");
    }

    /// 命令路径、工具名、id 同源。
    #[test]
    fn command_tool_and_id_share_one_source() {
        let cap = catalog().get("transactions", Verb::Summary).unwrap();
        assert_eq!(cap.command_path(), ["transactions", "summary"]);
        assert_eq!(cap.tool_name(), "transactions_summary");
        assert_eq!(cap.id(), "transactions.summary");
    }

    /// 每条能力都要有中文标签、说明和示例。
    #[test]
    fn every_capability_has_label_description_examples() {
        for cap in catalog().capabilities() {
            assert!(!cap.label.is_empty(), "{} 缺标签", cap.id());
            assert!(!cap.description.is_empty(), "{} 缺说明", cap.id());
            assert!(!cap.examples.is_empty(), "{} 缺示例", cap.id());
        }
    }

    /// 能力用到的资源必须在资源表里声明。
    #[test]
    fn capability_resources_are_declared() {
        for cap in catalog().capabilities() {
            assert!(
                catalog().resolve_resource(cap.resource).is_some(),
                "{} 的资源没在资源表里",
                cap.id()
            );
        }
    }

    /// 目录里不允许有重复能力。
    #[test]
    fn no_duplicate_capabilities() {
        let mut ids: Vec<String> = catalog()
            .capabilities()
            .iter()
            .map(Capability::id)
            .collect();
        let total = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), total, "目录里有重复能力");
    }

    /// 资源别名可解析。
    #[test]
    fn resource_aliases_resolve() {
        assert_eq!(
            catalog().resolve_resource("tx").unwrap().name,
            "transactions"
        );
        assert_eq!(catalog().resolve_resource("acc").unwrap().name, "accounts");
        assert!(catalog().resolve_resource("nope").is_none());
    }

    /// 动词表可往返解析。
    #[test]
    fn verbs_round_trip() {
        for verb in Verb::ALL {
            assert_eq!(verb.as_str().parse::<Verb>().unwrap(), *verb);
        }
        assert!("frobnicate".parse::<Verb>().is_err());
    }

    /// 参数 schema 必须拒绝未知字段。
    #[test]
    fn params_schema_rejects_unknown_fields() {
        let cap = catalog().get("transactions", Verb::List).unwrap();
        let schema = serde_json::to_value(&cap.params).unwrap();
        assert_eq!(schema["additionalProperties"], serde_json::json!(false));
        assert!(schema["properties"]["start"].is_object());
        // serde 的 rename 必须体现在 schema 里，否则 agent 会拼错字段。
        assert!(schema["properties"]["type"].is_object());
    }

    /// 目录视图可序列化并读回。
    #[test]
    fn catalog_view_round_trips() {
        let view = catalog().view();
        let json = serde_json::to_string(&view).unwrap();
        let back: CatalogView = serde_json::from_str(&json).unwrap();
        assert_eq!(back.capabilities.len(), catalog().capabilities().len());
        assert_eq!(back.resources.len(), catalog().resources().len());

        let summary = back
            .capabilities
            .iter()
            .find(|c| c.id == "transactions.summary")
            .unwrap();
        assert_eq!(summary.label, "汇总消费");
        assert_eq!(summary.path, "/v1/transactions/summary");

        let feedback = back
            .capabilities
            .iter()
            .find(|c| c.id == "feedback.create")
            .unwrap();
        assert_eq!(feedback.fixed_params["source"], "cli");
        assert_eq!(summary.risk, Risk::Read);
        assert_eq!(summary.backend, Backend::Firefly);
        assert_eq!(summary.command, vec!["transactions", "summary"]);
    }

    /// 一个资源支持的动词可枚举。
    #[test]
    fn verbs_for_resource_are_enumerable() {
        assert_eq!(
            catalog().verbs_for("transactions"),
            vec![Verb::List, Verb::Show, Verb::Summary, Verb::Search]
        );
        assert_eq!(catalog().verbs_for("accounts"), vec![Verb::List]);
        assert_eq!(catalog().verbs_for("rows"), vec![Verb::Update, Verb::Split]);
        assert!(catalog().verbs_for("budgets").is_empty());
    }

    /// 风险档决定闸门：只读的不设闸，confirm 的必须显式确认。
    #[test]
    fn bill_capabilities_carry_the_right_risk() {
        let cases = [
            ("bills.list", Risk::Read),
            ("bills.show", Risk::Read),
            ("bills.review", Risk::Read),
            ("bills.import", Risk::Confirm),
            ("bills.unlock", Risk::Confirm),
            ("bills.ignore", Risk::Confirm),
            ("bills.retry", Risk::Draft),
            ("rows.update", Risk::Draft),
            ("rows.split", Risk::Draft),
        ];
        for (id, expected) in cases {
            let cap = catalog()
                .by_id(id)
                .unwrap_or_else(|| panic!("{id} 不在目录里"));
            assert_eq!(cap.risk, expected, "{id} 的风险档不对");
        }
    }

    /// 账单能力的路由与现有 fork 接口一一对得上。
    #[test]
    fn bill_routes_are_derived_not_translated() {
        let cases = [
            ("bills.list", "/v1/bills"),
            ("bills.show", "/v1/bills/{id}"),
            ("bills.review", "/v1/bills/{id}/review"),
            ("bills.import", "/v1/bills/{id}/import"),
            ("bills.unlock", "/v1/bills/{id}/unlock"),
            ("bills.sync", "/v1/bills/sync"),
            ("rows.update", "/v1/rows/{id}"),
            ("rows.split", "/v1/rows/{id}/split"),
        ];
        for (id, path) in cases {
            assert_eq!(catalog().by_id(id).unwrap().route_path(), path, "{id}");
        }
    }

    /// 银行原文不在可改字段里：那是账单说的话，不该被模型改写。
    #[test]
    fn rows_update_does_not_expose_bank_originals() {
        let schema = serde_json::to_value(&catalog().by_id("rows.update").unwrap().params).unwrap();
        let properties = schema["properties"].as_object().unwrap();
        for forbidden in ["occurred_at", "counterparty", "platform_order_no", "amount"] {
            assert!(
                !properties.contains_key(forbidden),
                "{forbidden} 不该开放给 rows update"
            );
        }
        assert!(properties.contains_key("firefly_amount"));
        // as_suggestion 由服务端强制，不是调用方能选的。
        assert!(!properties.contains_key("as_suggestion"));
    }

    /// 密码这类只能人填的参数，标记在目录里，agent 不许再养第二份名单。
    #[test]
    fn secrets_are_marked_human_only_in_the_catalog() {
        let unlock = catalog().by_id("bills.unlock").unwrap();
        assert_eq!(unlock.human_only(), vec!["secret".to_owned()]);

        // 标记要能一路传到目录输出：agent 读的是这份 JSON。
        let view = serde_json::to_value(unlock.view()).unwrap();
        assert_eq!(view["human_only"], serde_json::json!(["secret"]));
        assert_eq!(
            view["params"]["properties"]["secret"]["x-abei-human-only"],
            serde_json::json!(true)
        );

        // 别的参数不该被误标。
        assert!(
            catalog()
                .by_id("bills.import")
                .unwrap()
                .human_only()
                .is_empty()
        );
        assert!(
            catalog()
                .by_id("rows.update")
                .unwrap()
                .human_only()
                .is_empty()
        );
    }

    /// 位置参数的三条规矩，命令行能不能解析全靠它们。
    #[test]
    fn positional_params_stay_unambiguous() {
        assert_eq!(
            catalog().by_id("transactions.search").unwrap().positional(),
            Some("query".to_owned())
        );

        for capability in catalog().capabilities() {
            let Some(field) = capability.positional() else {
                continue;
            };
            let id = capability.id();
            let properties = capability.params.as_value()["properties"]
                .as_object()
                .unwrap();

            // 一、只能标一个：clap 按声明顺序排位置参数，多标一个就成了猜。
            let marked = properties
                .values()
                .filter(|schema| schema.get("x-abei-positional") == Some(&serde_json::json!(true)))
                .count();
            assert_eq!(marked, 1, "{id} 标了 {marked} 个位置参数");

            // 二、必须是必填：可选的位置参数省略时没法判断下一个词属于谁。
            let required = capability.params.as_value()["required"]
                .as_array()
                .map(|items| items.iter().any(|item| item.as_str() == Some(&field)))
                .unwrap_or(false);
            assert!(required, "{id} 的 {field} 是位置参数就得必填");

            // 三、不能和查询串并存：有 start/end 的能力已经吃掉了裸词。
            let has = |name: &str| properties.contains_key(name);
            assert!(
                !(has("start") && has("end")),
                "{id} 既收查询串又标位置参数，命令行上分不清"
            );
        }
    }

    /// 新加敏感字段忘了标记，就是静默泄漏给模型。这条测试替人记着。
    ///
    /// 名字像密码的参数必须带 `x-abei-human-only`；真有不敏感的同名字段，
    /// 到时候改这里的判断，而不是默默放过。
    #[test]
    fn nothing_that_looks_like_a_secret_slips_through_unmarked() {
        const SMELLS: &[&str] = &[
            "secret",
            "password",
            "passcode",
            "pin",
            "otp",
            "token",
            "verification_code",
            "captcha",
        ];

        for capability in catalog().capabilities() {
            let marked = capability.human_only();
            let properties = serde_json::to_value(&capability.params).unwrap();
            let Some(properties) = properties.get("properties").and_then(|p| p.as_object()) else {
                continue;
            };
            for name in properties.keys() {
                if SMELLS.iter().any(|smell| name.contains(smell)) {
                    assert!(
                        marked.contains(name),
                        "{} 的参数 {name} 看着像敏感字段，却没标 x-abei-human-only",
                        capability.id()
                    );
                }
            }
        }
    }

    /// 目录里的模式不留 `$ref`：CLI、agent、web 三边都不用自己解引用。
    #[test]
    fn schemas_are_fully_inlined() {
        for capability in catalog().capabilities() {
            let schema = serde_json::to_value(&capability.params).unwrap();
            let text = schema.to_string();
            assert!(
                !text.contains("$ref"),
                "{} 的模式里还有 $ref",
                capability.id()
            );
            assert!(
                !text.contains("$defs"),
                "{} 的模式里还有 $defs",
                capability.id()
            );
        }

        // 展开后嵌套对象的属性要在原地看得见。
        let split = serde_json::to_value(&catalog().by_id("rows.split").unwrap().params).unwrap();
        let item = &split["properties"]["splits"]["items"];
        assert_eq!(item["type"], "object");
        assert!(item["properties"]["amount"].is_object());
        assert_eq!(
            item["required"],
            serde_json::json!(["amount", "description"])
        );
    }
}
