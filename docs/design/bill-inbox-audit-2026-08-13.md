# 账单收件箱产品化差距诊断

2026-08-13 · 三线审查汇总(前端 / 服务端 / 端到端)。结论:功能链路已通,但离「产品」差三层——安全与架构上有一票否决项,体验上有结构性缺陷,代码上状态机与测试裸奔。

## 总判断

服务端不是随手原型:两阶段提交、SKIP LOCKED、租约、XChaCha20Poly1305 分域加密都在。问题是这些机制是零散点状实现,没有升成架构——状态机散在 40 处 SQL 字符串里,一次入账的事务横跨两个服务,清扫逻辑藏在校验函数里等用户手点。前端同理:组件能跑,但数据层是「全量拉 + 全库刷新」,每个操作的代价都是一次冷启动。

## A. 一票否决项(多用户开放前必须解决)

### A1. abei-server 零鉴权,只信 HTTP 头
- `abei-server/src/lib.rs:23-25, 552-576`:`authenticated_user_id()` 直接 parse 请求头 `x-abei-authenticated-user-id`;`build_app`(`lib.rs:137`)无任何 auth 中间件。
- abei-api(`routes/server.rs:57-58`)验完 Firefly token 注入可信头,但两服务间**没有共享密钥或 mTLS**,只靠 compose 不发布 18005 端口兜底。能触达 18005 就能一行 curl 冒充任意 user_id 读全部邮件和账单。
- 改法:服务间共享密钥签名(或 abei-server 自验 token),身份提取改成 Axum Extractor。

### A2. `/v1/firefly/{*path}` 透传仍是前端主要依赖
- `abei-api/src/routes/proxy.rs:12` 全方法全路径透传;`abei-web/src` 有 **26 处** `v1/firefly` 引用。
- 与 2026-08-10「多用户开放前清零」裁定直接冲突;能力目录「唯一 API 面」在这条路由上失效。
- 改法:盘点 26 处各要什么能力 → abei-api 补正式端点 → proxy 白名单收窄 → 删除。

### A3. 入账 saga 横跨两个服务,没有所有者
- 流程:abei-api(`bill_imports.rs:336 import_one`)调 server prepare → mark_sending → 写 Firefly → 回报 complete/fail/uncertain。状态机数据在 abei-server,编排在 abei-api,中间 3-4 个 HTTP 往返。
- abei-api 在「已写 Firefly、未回报」间崩溃,流水永久卡 `sending`。
- 改法:Firefly 写入下沉到 abei-server 独占整条 saga,或加 import worker 负责推进对账。

### A4. 卡死状态清扫是惰性的
- `billing/imports.rs:462-482`:超时清扫藏在 `validate_import_row` 里,WHERE 只扫当前行——卡在 `sending` 的流水除非用户再点它,否则永远转圈。邮箱同步残留同理(`mailbox.rs:381-395`)。
- 改法:全局定时清扫器,不带 row_id/user_id 过滤。

### A5. 同步调度脆弱
- `mailbox.rs:355-368`:enqueue 循环里 `?` 短路,一个用户失败,该 tick 后面所有用户全跳过,只打一行日志。
- `mailbox.rs:420, 478`:每用户同步是游离 `tokio::spawn`,无并发上限、无 per-provider 限速退避;graceful shutdown 不等这些任务,进程停了留 `running` 残留。
- 改法:逐用户 continue + 有界 worker 池(JoinSet)+ 退避 + 关停收尾。

### A6. 应用内权限:owner 校验只覆盖 feedback 一个模块
- `lib.rs:577 owner()` 全仓被调 11 次,**全部在 feedback.rs**。`billing/api.rs`(36 个 handler)、`mail/api.rs`、`parser/api.rs` 只调 `authenticated_user_id`(验「登录了没」不验「是谁」)。
- 后果:任何登录用户都能发布/修改邮件规则、发布回滚解析流程、删账单任务——这些是影响所有人解析结果的全局配置。前端把工作台藏进 admin 只是障眼法,端点本身敞开。
- 改法:先给 mail/parser/billing 写端点补 owner 校验,再谈前端摆放。

### A7. admin 是孤立页面,不是容器
- `/admin/feedback`(`router.tsx:156`,969 行)不在导航里,唯一入口是反馈页 `is_owner` 才显示的按钮;**路由无守卫**,非 owner 直接输地址能打开,只见后端 403 报错屏;无独立 admin 外壳,挂在用户 AppShell 下。不存在 abei-admin crate,所谓 admin 后端是 abei-server 的 `/v1/admin/feedback/*`。
- 改法:建 `/admin` 路由段 + 守卫 + 独立外壳,feedback/mail/parser 三工作台平级挂入,一级导航砍到 8 项(概况/收件箱/交易/助手/账户/预算/分类/分析),反馈收进设置或用户菜单。

## B. 体验/流程硬伤

### B1. 前端数据层三症一根
1. **假滚动加载**:`api/firefly.ts:434 getAllBillRows` 并发拉完所有页,`BillInboxPage.tsx:169` 只是内存切片。历史回灌(招行 ~180 封待灌)后单渠道破万行 = 几 MB JSON 一次进浏览器。
2. **一屏 ~17 个请求**:四状态 count 各发 `limit=1` 请求只为读 total(`queries.ts:417-431`),每渠道再一个 count(`queries.ts:427`);而服务端**已有** `/v1/bill-inbox/summary`(`abei-server/src/lib.rs:263`)没被用。计数与列表数据源分裂,会出现「tab 写 12 条点进去 11 行」。
3. **零乐观更新 + 全库失效**:`queries.ts:367 invalidateBillInbox` 一次失效 7 个 queryKey 前缀,dismiss/restore/import 全调它。点一下「忽略」= 重新冷启动。
- 改法:数据源收敛到 summary 端点 + 游标分页(`queries.ts:797 useInfiniteAccountTransactions` 已有现成范式)+ 单行操作乐观更新。

### B2. 失败对用户是黑盒
- 同步侧有 `mail_sync_runs` 状态展示,但解析失败(ParseJob)无任何主动通知,用户发现路径是「这个月的账怎么没出来」→ 去 MailWorkbench 一封封翻。「不用一条条看」的产品承诺在失败路径上恰好退化成一条条看。
- 改法:做「这批邮件的处理结果」收敛视图:同步几封/解析成功几封/失败几封为什么/多少行待处理。同时解决操作历史缺失(服务端已有 `/v1/bills/{id}/events` 事件流,前端没接)。

### B3. 新用户第一小时全是配置
- 从零到第一笔可入账:5 个 env → Google Cloud 建 OAuth → 连邮箱 → 等同步 → 命中内置规则(仅招行×2/支付宝/微信/中行 5 条)→ 未命中要进 ParserWorkbench 手写 DSL → 配账户映射 → 入账。只有 3 步有界面,渠道没覆盖的用户卡死且系统不告诉他卡在哪。

### B4. 开发者工具混进用户导航
- `routes/navItems.ts` 一级导航里「账单收件箱」「邮件工作台」「解析工作台」平级。后两个(1142 行 / 688 行)是规则编辑、解析流程发版回滚、EML 测试——运维台不是用户功能。
- 改法:一级导航只留收件箱,工作台收进设置/维护区。

### B5. 移动端基本没做
- `BillInboxPage.tsx` 全文 1 处断点,`QueueRow.tsx:277` 固定列宽单行,行内动作靠 `group-hover`(`:340`)——触屏永远出不来「忽略/编辑/确认」,而项目有 BottomTabBar 移动外壳。宽屏侧 `designs/bill-inbox-redesign/panes-v2.jsx` 多栏设计稿也没实现。

### B6. 跨渠道配对只打分,无闭环
- `billing/analysis.rs` 是全项目质量最高的代码(证据要求、退款文案、余额链容差、4 个单测),但产物只是 issue + `duplicate_state` 字段——系统能说「它们可能是一对」,用户不能确认「就是一对」并从此按一条处理。
- 改法:配对需要可确认/可撤销的实体和状态,不只是分数。

### B7. 撤销只活 8 秒
- 入账/忽略的撤销挂 toast action(`BillInboxPage.tsx:408-410`,`UNDO_TOAST_DURATION=8000`),过期即永久失去;「已入账」tab 无反悔入口(`QueueRow.tsx:360` 只有查看交易)。

## C. 代码层

### C1. 状态机只存在于 SQL 字符串,Rust 零建模
- 4 套生命周期状态(bill_rows / bill_import_attempts 7 态 / parse_jobs 6 态 / mail_sync_runs)唯一枚举点是迁移文件 CHECK 约束;合法流转靠 40+ 处 `WHERE status = 'prepared'` 字面量。加状态靠 grep,编译器帮不上忙。
- 改法:每套状态 Rust enum + `can_transition`,SQL 字面量从 enum 渲染。

### C2. 核心路径零测试
- `billing/store.rs` 1235 行(仓储+服务+展示三合一)、`billing/api.rs` 883 行、`billing/worker.rs` 391 行、`billing/mappings.rs` 375 行——**全部 0 测试**。测试集中在纯函数(engine 11 个、analysis 4 个、rules 5 个):算法有测试,状态流转裸奔。入账落库和 worker claim/lease 出错直接是钱记错。

### C3. 上帝组件/巨石文件
- 前端:`BillInboxPage.tsx` 997 行(14 个 useState、8 个 async handler、4 个内嵌子组件),`QueueRow.tsx` 650 行 11 个 useState 手搓编辑表单;`:563` eslint-disable exhaustive-deps 捕获旧闭包是真 bug 温床。
- 后端:`feedback.rs` 3376、`legacy_bills.rs` 2339(一次性迁移工具常驻编译)、`parser/engine.rs` 2316、`billing/rows.rs` 1859、`mail/mod.rs` ~1800。
- **legacy_bills 处置(2026-08-13 拍板)**:旧表数据是测试数据,邮件原件都在邮件服务器上可重新拉取,账单数据无搬迁价值——**迁移不做,`legacy_bills.rs`(2339 行)连同 main.rs 的 legacy-bills 子命令直接删除**,旧表随后清理。

## 已拍板决策(2026-08-13)
- 服务间鉴权走**共享密钥签名**(abei-api 对可信头签名,abei-server 验签)。
- 邮件工作台/解析工作台/反馈管理**独立成 abei-admin 项目**(独立前端应用,架构与选型独立),不塞进 abei-web 的 /admin 段;abei-web 一级导航砍到 8 项用户功能。
- 收件箱迁入的 5 个提交已推送 origin/main(基线 9c1ba37)。
- 旧账单数据不迁移,legacy_bills 整体删除(见上)。

### C4. 错误可辨别性不足
- `lib.rs:680` problem+json 格式规范,但 `reason` 只有 Invalid/NotFound/Conflict 等几种粗粒度;三种 409 走同一出口(`imports.rs:424-460`),前端要区分「账户未映射/已有导入/金额非法」只能字符串匹配中文 detail。根因是内部层大量 `Result<_, String>` 把错误拍扁。
- 改法:reason 换机器码(`account_unmapped`、`import_in_flight`…)。

### C5. 文档漂移
- `abei-api.md`(权威文档)只写了 33 个 `/v1` 路径,实际 57 个;账单收件箱核心端点(bill-rows、bill-inbox/summary、parse-jobs、bill-documents、parser-flows、mail-sync-runs)几乎全部无文档;反向还有写了但不存在的端点。AI 是第 0 批用户,这份漂移直接损害 AI 可用性。

### C6. abei-web 全局一致性(补查)
- 好的一面:CRUD 闭环(queries.ts 28 个写 hook,accounts/budgets/reference-data/transactions 增改删齐);TodayPage 首屏待办(`TodayPage.tsx:155-159`)做得对;`/reports` 重定向和 `$` 兜底页没问题。
- **破坏性操作三套做法且多数无确认**:全仓只 4 处用 ConfirmDialog;删交易(`TransactionSidePanel.tsx:157`)、删资料(`ProfilePage.tsx:305`)、删账户直接 onClick 执行零确认;附件删除又自搓一套 pendingDelete。→ 统一走一个 ConfirmDialog。
- 三态缺口:today/assistant/reference-data/settings 缺空状态,assistant 连错误态都缺(最裸)。
- `ProfilePage.tsx` 数据层脱队:裸写 useMutation 不走 queries.ts 具名 hook。

### C7. 其他
- `handledCount` 假进度(切渠道不清零,`BillInboxPage.tsx:97,196`);复选框绕开受控语义(`QueueRow.tsx:279-286`,shift 区间选键盘不可达);无障碍缺 tabpanel/aria-live;干跑阈值写死 20 笔与日常 9 笔/封错配(`:55`);骨架屏固定 6 行;文案总体合规,「映射账户」「工作台」两词需按说人话改。
- 配置:`APP_KEY` 默认 `SomeRandomStringOf32CharsExactly`(compose.yml:111)管着邮箱密码和 refresh token 加密,无轮换路径;worker 魔法数字(20 次、5 次、5min/2min 租约)散落 SQL 字面量;JSON 响应手工 `json!` 拼装,与 openapi.rs 无类型约束。
- 亮点反哺:`feedback.rs:106-119` 是唯一实现幂等键的模块,该机制值得移植到入账链路。

## 修复顺序建议

1. **批次一(安全,改动小)**:A1 服务间鉴权;A6 mail/parser/billing 写端点补 owner 校验;A2 透传盘点+收窄启动。
2. **批次二(可靠性)**:A4 全局清扫器 + A5 同步循环不短路/有界并发——直接消除「永远转圈」「我的邮箱不同步」。
3. **批次三(前端数据层重做 + admin 段)**:B1 三症一起治(summary 端点 + 分页 + 乐观更新),顺手拆 C3 前端上帝组件;A7 建 /admin 段收纳三工作台,B4 一级导航砍到 8 项;C6 统一 ConfirmDialog、补三态。
4. **批次四(架构归位)**:A3 saga 下沉 abei-server;C1 状态 enum 化 + C2 补 imports/worker 集成测试;C4 错误码细化(前端交互改造的前置)。
5. **批次五(产品补全)**:B2 处理结果收敛视图 + 操作历史;B6 配对闭环实体;B5 响应式/多栏;B3 onboarding 界面化。

---

## 附录：/v1/firefly 透传盘点（2026-08-13）

批次一收窄透传时做的盘点。abei-web 是唯一用透传的客户端（abei-cli、abei-agent 都没有）。
前端所有调用都经 `api/firefly.ts` 的 `proxy*` helper，共 **44 条路径模板**，按域分组如下。
这份清单已落成 `abei-api/src/routes/proxy.rs` 的 `ALLOWED` 白名单，表外一律 404；
两条测试锁着它：一条断言 44 条路径都在表内（漏一条前端白屏），一条断言用户管理、
系统配置这类从没用过的接口打不通。

| 域 | 路径 | 前端用途 |
|---|---|---|
| 账户 | `/api/v1/accounts`、`/accounts/{}`、`/accounts/{}/transactions` | 账户页、账户详情、账户流水 |
| 交易 | `/api/v1/transactions`、`/transactions/{}`、`/transactions/{}/attachments` | 交易增改删与附件列表 |
| 附件 | `/api/v1/attachments`、`/attachments/{}`、`/{}/download`、`/{}/upload` | 交易详情的附件上传下载 |
| 预算 | `/api/v1/budgets`、`/budgets/{}`、`/budgets/with-limit`、`/budgets/{}/limits`、`/budgets/{}/limits/{}` | 预算页与额度 |
| 分类标签 | `/api/v1/categories`、`/categories/{}`、`/tags`、`/tags/{}` | 分类与标签页 |
| 阿贝扩展 | `/api/v1/abei/budget-groups`、`/abei/budget-groups/{}`、`/abei/category-stats` | 装在 Firefly 里的两个自研接口 |
| 补全搜索 | `/api/v1/autocomplete/{accounts,categories,tags}`、`/search/{accounts,transactions}` | 录入交易时的补全 |
| 分析 | `/api/v1/chart/account/overview`、`/insight/expense/{asset,category,tag,budget,no-category,no-budget}`、`/insight/income/revenue`、`/insight/report/overview`、`/summary/basic` | 分析页图表 |
| 订阅 | `/api/v1/recurrences`、`/recurrences/{}/trigger` | 订阅页与「立刻记一笔」 |
| 设置 | `/api/v1/currencies`、`/about`、`/tokens`、`/tokens/{}`、`/data/export/{}` | 币种、关于、令牌管理、数据导出 |

**盘点时的一个坑**：`insight/expense` 里的 tag、budget、no-category、no-budget 四条不是
字面量，藏在 `getInsightRanking(path, range)` 的间接调用里，只扫 `proxy*(` 的字面量参数会漏掉。
后续继续收窄时，先确认没有新的间接调用层。

**这份表是待办清单，不是配置**：每在 abei-api 上建模一个域，就从 `ALLOWED` 删掉对应几行；
表空了 `proxy.rs` 整个删掉，A2 才算真正清零。当前 44 条 ≈ 还欠多少建模。
