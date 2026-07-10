# Firefly III API 能力盘点与 granary-web 接入差距

> 2026-07-09。方法：解析 `firefly-iii/routes/api.php`（277 个 v1 端点、37 个资源域，含本项目自建）
> 对照 `granary-web/src/api/firefly.ts` 实际调用。定位依据规范 §0：记账主要靠 CLI/AI/收件箱，
> Web 是审阅、对账、分析的工作台——价值判断全部围绕这个定位。

## 1. 概览表

| 资源域 | 服务端能力 | 前端状态 | 备注 |
|---|---|---|---|
| transactions | 增删改查、附件、储蓄罐事件 | **部分** | 已接：列表/创建/搜索/编辑/删除/详情 GET；未接：附件 |
| accounts | 增删改查、账户流水/储蓄罐/附件 | **部分** | 已接：分类型列表、**详情+流水+单账户余额趋势**；未接：写操作、附件 |
| bill-tasks / bill-statement-rows / bill-inbox / bill-artifacts（自建） | 任务列表/详情/行/审阅/入账/忽略/重试/归档/验证码；行编辑/拆分；邮箱同步/处理/设置；附件下载 | **部分** | 已接：summary、列表、rows、import、ignore、sync、secret、retry、**行 PATCH**；未接：split、settings、artifacts |
| daily-reconciliation（自建） | 逐日汇总 | **已接** | 标记对账/调整交易依赖 Firefly 原生 reconcile 流（无独立 API，见 §5） |
| budgets / budget-limits / available-budgets | 增删改查、限额、无预算交易 | **部分** | 已接：只读列表+limits；未接：全部写操作、transactions-without-budget |
| bills(=subscriptions) | 增删改查、关联交易/规则 | **部分** | 已接只读列表（subscriptions 是 bills 的新别名，同资源） |
| piggy-banks | 增删改查、事件 | **部分** | 已接只读列表 |
| categories / tags | 增删改查、关联交易 | **部分** | 已接只读列表（设置页概览） |
| rules / rule-groups / recurrences | 增删改查、**test/trigger** | **部分** | 已接只读列表；触发/测试未接 |
| insight（expense 11 / income 7 / transfer 6） | 多维度聚合 | **部分** | 已接 3 个；tag/bill/no-budget/no-category/total 等未接 |
| chart（account/balance/budget/category） | 现成图表数据源 | **部分** | 已接 `chart/account/overview`（总览余额面积线）；balance/budget/category 未接 |
| summary | basic | **已接** | |
| search | transactions / count / accounts | **部分** | 已接 transactions；count 与 accounts 未接 |
| autocomplete（17 端点） | 账户/分类/标签/币种等补全 | **部分** | 已接：accounts/categories/tags/transactions（记一笔 Combobox）；其余 13 个未接 |
| attachments | 上传/下载/增删改 | **未接** | 收据凭证场景 |
| preferences | 用户偏好读写 | **部分** | 已接 `granary.date_range`（顶栏日期范围）；主题等未接 |
| data/export | 10 类 CSV 导出 | **未接** | |
| currencies / exchange-rates | 币种启停/主币种/汇率管理 | 部分（只读列表） | 单币种使用为主 |
| transaction-journals / -links / link-types | 拆分明细、交易关联 | **未接** | |
| object-groups | 储蓄罐/订阅分组 | **未接** | |
| webhooks / users / user-groups / configuration / data-destroy·purge·bulk / cron | 管理与危险操作 | **未接** | 建议不接，见 §6 |

## 2. 已接入端点明细（19 组 + 子资源）

| 端点 | 用途 |
|---|---|
| GET summary/basic | 总览/报表 KPI |
| GET/POST/PUT/DELETE transactions · GET transactions/{id} | 列表、记一笔、行内编辑/删除、详情 |
| GET search/transactions | 命令面板搜索 |
| GET insight/expense/category · expense/asset · income/revenue | 总览/报表条形图 |
| GET chart/account/overview | 总览账户余额面积线（最多 4 条） |
| GET/POST preferences（granary.date_range） | 顶栏日期范围持久化 |
| PATCH bill-statement-rows/{id} | 收件箱行内改描述/分类/金额 |
| GET accounts?type= · GET accounts/{id} · GET accounts/{id}/transactions | 账户列表/详情/流水 |
| GET accounts?type=（记一笔） | 资产+负债账户下拉 |
| GET bill-inbox/summary | 徽标、待办卡、渠道卡 |
| GET bill-tasks · /{id}/rows · POST /{id}/import · /{id}/ignore · /{id}/secret · /{id}/retry | 收件箱列表/审阅/入账/忽略/验证码/重试 |
| POST bill-inbox/sync | 渠道卡触发邮箱同步（验证时点一次） |
| GET daily-reconciliation/summary | 对账日历带 |
| GET budgets · /{id}/limits · bills · piggy-banks | 预算与订阅页 |
| GET categories · tags · rules · recurrences · currencies · about | 设置页概览 |
| GET autocomplete/accounts · categories · tags · transactions | 记一笔 Combobox 补全（纯数组响应，非 JSON:API） |

## 3. 未接入能力详述（按价值排序）

### 3.1 autocomplete 组 — 记一笔表单补全 · 估级 S · **部分完成**
已接 4 个：`accounts`（types=Expense/Revenue account）、`categories`、`tags`、`transactions`（描述历史）。
`Combobox` 防抖 200ms + 自由文本；标签只补全最后一个逗号后 token。其余 13 个端点与命令面板深化待后续。

### 3.2 transactions 编辑/删除/详情 — 审阅闭环刚需 · 估级 M · **部分完成**
已接 `GET/PUT/DELETE transactions/{id}`：交易页与总览近期交易行操作；编辑复用记一笔 Modal
（多拆分 group 提示走旧版）；删除确认框（规范 §5）。命令面板深链见任务 9；附件未接。

### 3.3 收件箱动作补全 — 核心工作流 · 估级 M~L · **部分完成**
已接：`POST bill-inbox/sync`（渠道卡同步按钮 + loading Lottie）、`POST bill-tasks/{id}/secret`（needs_secret
行内表单，body.`value`）、`POST /{id}/retry`（failed/unknown + 错误信息）。
已接：`PATCH bill-statement-rows/{id}`（描述/分类/金额行内编辑）。
未接：split（组合支付拆分 UI 另立任务，见任务 5 结论）、settings、review、artifacts。

### 3.4 chart/account/overview + chart/balance — 总览余额趋势 · 估级 S~M · **部分完成**
已接 `GET chart/account/overview`（`preselected=assets` + 自适应 period，Top 4 面积线，D3 坐标 + GSAP clip 揭示）。
`chart/balance/*` 与 budget/category chart 未接。

### 3.5 accounts/{id}/transactions — 账户详情页 · 估级 M · **已完成**
`/accounts/$accountId`：基本信息 + `chart/account/overview?accounts[]=` 余额趋势（复用 BalanceAreaChart）+
`accounts/{id}/transactions` 流水（分页/行编辑删除）。账户列表行可点进详情。

### 3.6 preferences — 偏好持久化 · 估级 S · **部分完成**
已接：`GET/POST preferences` 读写自定义键 `granary.date_range`（preset + start/end）；
顶栏日期范围选择器（近7/30 天、本月、上月、自定义）；滚动预设每次 hydrate 按今天重算。
主题偏好未接。

### 3.7 budgets/available-budgets 写操作 — Web 建预算 · 估级 M
`POST budgets`、`POST budgets/{id}/limits`、available-budgets CRUD。预算页从只读升级为可建可调，
超支进度条才有实际意义。`GET budgets/transactions-without-budget` 可做"无预算支出"审阅入口。

### 3.8 search/transactions/count + search/accounts — 命令面板深化 · 估级 S
结果计数（"共 42 条，显示前 10"）与账户搜索分区。

### 3.9 insight 扩展维度 — 报表增强 · 估级 S
tag / no-category / no-budget / total 系列：报表加"标签维度""未分类支出"块，
transfer 系列可做转账流向分析。

### 3.10 attachments — 凭证 · 估级 M
交易详情页展示/上传附件（收据照片）。依赖 3.2 的详情页先行。

### 3.11 其余中低价值
piggy-banks 写+events（储蓄操作）、rules/recurrences 的 test/trigger（自动化手动触发按钮，S）、
data/export（设置页导出卡，S）、transaction-journals/links（拆分与关联，低频）、
object-groups（分组）、currencies 写/exchange-rates（单币种下暂缓）。

## 4. 推荐接入顺序 Top 10

1. autocomplete → 记一笔补全（S，日常输入体验）
2. transactions PUT/DELETE/详情 → 行操作+编辑（M，闭环刚需）
3. bill-inbox sync + bill-tasks secret/retry（M，收件箱自动化闭环）
4. ~~chart/account/overview → 总览余额面积线~~（已完成）
5. ~~bill-statement-rows PATCH → 收件箱行内编辑~~（已完成；split 不同批，见结论）
6. ~~preferences + 日期范围选择器~~（已完成：granary.date_range + 顶栏选择器）
7. ~~accounts/{id}/transactions → 账户详情页~~（已完成）
8. budgets 写操作（M）
9. search count/accounts + 命令面板深链（S，依赖 2）
10. insight 扩展 + data/export（S）

## 5. 特别说明：对账写操作
"标记已对账/生成调整交易"没有独立 API——Firefly 原生对账是 Web 流程
（`/accounts/{id}/reconcile` 提交，写 `transactions.reconciled` 并生成 Reconciliation 交易）。
接入方案二选一：a) 在 firefly-iii 补一个自建端点包装该 service（延续阶段 0 模式，推荐）；
b) granary-web 直调交易 PUT 把 reconciled 置位（PUT transactions 支持 reconciled 字段，需实测）。

## 6. 建议不接入

| 能力 | 理由 |
|---|---|
| webhooks 管理 | 单用户自托管无消费方；需要时 CLI 配一次即可 |
| users / user-groups（账套） | 单用户单账套，界面徒增复杂度 |
| configuration | 系统级配置，留旧界面/CLI |
| data/destroy · purge · bulk | 危险批量操作不该有 Web 按钮；bulk 是 CLI/AI 的领域 |
| link-types 管理 | 极低频，默认类型够用 |
| cron/{cliToken} | 部署层已由 cron 容器调用 |
