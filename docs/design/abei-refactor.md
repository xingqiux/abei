# 阿贝（abei）重构方案

2026-08-09 · 状态：历史方案与实施记录。当前约束以根目录 `abei-cli.md`、`abei-api.md` 为准。

这次重构做四件事：项目改名阿贝/abei；新建 **abei-api（Rust）** 作为全系统唯一 API 面，CLI 和 web 都只对接它；在能力目录之上新建 **abei-cli（Rust）**（以 AI 为主要使用者设计）；Firefly 的能力经由 abei-api 逐步剥离。MCP 整个清除。

## 一、已拍板的决策

1. 产品与 CLI 全量硬切改名 **阿贝 / abei**，不留 ffc/abaku 过渡别名（存储键 `granary.*` 仍按既有决定保留）。
2. **删除 MCP**：`ffc mcp` 命令、mcp-server.ts、SDK 依赖、文档相关章节。对外部 AI 的接口就是 CLI 本身。
3. 命令词序：名词在前，`abei <资源> <动词>`。
4. **新起 abei-api 与 abei-cli，都用 Rust**；CLI 与 web（含未来移动端）都只对接 abei-api。granary-server **不现在复活**，继续封存，留作远期账本阶段的种子（同族栈 axum + sqlx，届时平移）。
5. 原 TS 包 firefly-cli 收缩为 **abei-agent**：只留 pi-agent 运行时与 `/api/ai`，commander 命令全部退役。
6. 声明式配置（`apply -f`）延后；输出模型走 gh 式（默认人话文本，`--json` 显式开启）。

## 二、目标架构

```
客户端    abei-cli(Rust)      abei-web             Android/iOS(未来)
              │                  │ │                     │
              └────────┬─────────┘ └───────┬─────────────┘
                       ▼                   ▼
服务      abei-api (Rust: axum+sqlx) :18002      abei-agent (TS: pi-agent) :18003
          资源 API · 能力目录 /v1/catalog          /api/ai：聊天流、会话、审批、模型配置
          统一错误 · 风险闸 · dry-run              工具从 /v1/catalog 生成，
          内部 web 迁移代理                        执行只走 catalog 建模能力
                       │ 账本/账单操作委托（过渡期）        │
                       ▼                                  │
引擎      Firefly III(REST) :18001 —— 逐步瘦身 ◄───────────┘
后台      bill-worker(PHP 循环) —— 剥离后变 abei-api 内 tokio 任务
封存      granary-server —— 远期账本阶段的种子，不参与本轮
```

仓库布局：

```
abei/                 # Rust workspace
  crates/abei-core/   # 领域类型 + 能力目录（唯一真源）
  crates/abei-api/    # axum 服务
  crates/abei-cli/    # clap CLI
abei-agent/           # 原 firefly-cli 收缩：pi-agent + /api/ai（TS）
abei-web/             # 原 abaku-web
firefly-iii/          # 引擎，随剥离回归近原生
granary-server/       # 继续封存
```

abei-api 不是无功能转发层：它承载能力目录、统一错误、风险闸、dry-run，并且是剥离 Firefly 的控制面。过渡期未建模的端点只允许现有 web 页面走内部迁移代理，再逐域换成建模后的资源 API；该代理不进入 catalog、OpenAPI、CLI 或 agent 工具。建模能力的风险闸（read/draft/confirm）在服务端统一执行。

## 三、能力目录（唯一真源）

目录活在 `abei-core`，Rust 类型 + `schemars` 直出 JSON Schema（2020-12）：

| 字段 | 说明 |
|---|---|
| `resource` / `verb` | **一等字段**。命令路径 `abei bills review`、agent 工具名、API 路由都由此直接得出，不存在需要人工翻译的 operationId（Oxide 的教训：他们为此维护着一张 431 行的手写映射表） |
| `schema` | 参数 JSON Schema，未知字段严格拒绝 |
| `risk` | `read / draft / confirm` 三档（现状语义沿用） |
| `backend` | `firefly / abei / server`——**剥离 = 改这一格的指向，客户端无感** |
| 其余 | 中文 label、description、examples、preview/execute 实现 |

对外形态：
- **`GET /v1/catalog`**（运行时 discovery）：abei-agent（TS）只从这里构造 LLM 工具，web 取标签、审批文案与表单校验。Rust CLI 与 API 直接共享 `abei-core`，不在运行时复制契约。
- **OpenAPI 是导出产物不是真源**（utoipa 顺手导出），用途只有一个：给 abei-web 生成 TS 类型与 Zod 校验（hey-api/openapi-ts），杀掉 Rust↔TS 的 schema 漂移。
- Rust 侧 CLI 与 API 之间**共享 crate、零 codegen**，改类型立刻编译报错。

## 四、命令系统规范

**动词表**（跨资源含义一致，绝不同义并存）：`list / get / show / create / update / delete` + 意图动词 `search / review / import / ignore / retry / summary / sync / process / unlock / split`。资源名宽容解析短别名（`tx`、`acc`）。

**查询语法**借 hledger：位置参数即描述/账户子串，前缀限定 `date:2026-07`、`amt:'>100'`、`cur:CNY`、`not:` 取反，空格并列。

```
abei                                    # 财务概览（保留现有裸命令行为）
abei tx list 餐饮 date:2026-07 amt:'>100'
abei bills review 42
abei bills import 42 --dry-run          # 先看会改什么
abei bills import 42 --yes              # 再落库
abei tx list --json=amount,category
abei tx list --jq 'map(.amount)|add'
abei explain bills                      # 从共享能力目录出文档
abei guide                              # 一页 agent 说明书，可直接进 AGENTS.md/skill
make man                                # 开发者生成 abei/target/man/abei.1
```

**输出**：默认人话文本（TTY 才上色/表格）；`--json [字段]` 转 JSON 且不带参数时列出全部可用字段名（agent 自发现）；`--jq` 内置；数据走 stdout、进度提示走 stderr；非 TTY 不弹交互。**`--json` 字段名算 API 契约，纳入版本管理**。

**退出码**：0 成功 / 1 通用失败 / 2 中断 / 3 参数校验失败 / 4 未认证 / 5 上游不可达 / 6 需确认但未给 `--yes`（此时把补全了 `--yes` 的完整命令打印出来）。

**错误形状**三端统一，HTTP 层用 RFC 9457 problem+json（手写 20 行结构体，不引依赖），扩展字段带机读 `reason`（驼峰码）与 `resource`/`verb`；CLI 呈现人话 message + reason。

**以 AI 为主的包容设计**：命令/flag 拼错 clap 自带 did-you-mean，目录里的动态资源名用 Damerau-Levenshtein 自做建议（抄 SpacetimeDB 的 `edit_distance.rs`）；未知字段严格报错并附纠正建议（财务工具里静默丢弃字段是最危险的失败）；查询语法解析错误用 miette 带波浪线指到具体字符；所有写操作支持 `--dry-run`；help 全带示例（示例存在目录里，与 web 助手起手语同源）。

**实现结构**（抄 Oxide 的结构，不抄代码）：命令树由目录在 clap **builder** API 上生成；手写命令只保留 `auth`、`explain`、`guide`、`completion` 等本地工具，不提供原始 API 或 man 子命令。human/`--json` 双输出、`--dry-run`、`--yes` 集中放在通用钩子，不散进每个命令。man page 由开发侧 `make man` 从同一命令树生成。stdout 全部走防 EPIPE 打印宏，`abei bills list | head` 不得 panic。

## 五、技术选型（2026-08 调研结论）

| 件 | 选择 | 理由 |
|---|---|---|
| API 框架 | **axum 0.8 + sqlx 0.8** | 与 granary-server 同族，远期账本平移零换轨；生态最大 |
| Schema | **schemars 1.x 为主线**，utoipa 5.x 只作 OpenAPI 导出 | 能力目录要的是干净的 JSON Schema 2020-12（LLM 工具同款），OpenAPI 是副产品，不让它反向定义领域 |
| 校验 | garde | 条件校验、上下文注入、字段级错误路径 |
| 错误 | 手写 RFC 9457 结构体 | 格式简单到不值得引依赖，且要塞自定义扩展字段 |
| CLI | **clap 4.6**（builder 生成 + derive 嫁接）+ clap_complete；开发依赖 clap_mangen | did-you-mean 在默认 features 里；man page 只在 `make man` 时生成 |
| 终端 | anstream/anstyle（clap 已依赖，零成本）、comfy-table、indicatif | NO_COLOR/管道检测全自动 |
| `--jq` | jaq-core | 2026 唯一成熟的纯 Rust jq，可嵌入 |
| 凭据/路径 | etcetera | PAT 存配置目录下 0600 令牌文件；XDG 规范路径（弃钥匙串：授权绑二进制哈希，重编译即重弹窗） |
| 查询语法报错 | miette（仅此处） | span 波浪线定位，配 hledger 式语法 |
| TS 生成 | hey-api/openapi-ts | 一次产出 SDK + Zod + TanStack Query hooks，Zod 给 agent 校验 LLM 输出复用 |

**重点参照项目**：oxidecomputer/oxide.rs + progenitor（`CliConfig` 钩子、`add_custom` 嫁接、生成物签入+CI 校验；progenitor 本体不用——它为跨组织分发 SDK 设计，同仓 workspace 里共享 crate 更简单）；SpacetimeDB CLI（`edit_distance.rs`）；SurrealDB CLI（自定义 clap value parser，对应查询语法解析）。Railway CLI 的通用 API 逃生舱做法已明确拒绝：对 agent 暴露任意 HTTP 面超出能力目录的安全边界。

## 六、pi-agent 融合与多端同步

- **abei-agent（原 firefly-cli 收缩）**：删全部 commander 命令与 MCP，留 pi-agent 运行时、`/api/ai` HTTP 面（手写 if 链路由换 Hono）、autofill/backfill 等后台建议循环。
- **工具来源**：按需拉 `GET /v1/catalog` 构造 LLM 工具；执行统一走 catalog 声明的 abei-api 建模路由。confirm 调用先 dry-run、再由人审批，模型不能直接发送 `confirm=true`。
- **同步机制**：目录加一条能力 → CLI 命令、agent 工具、web 助手标签与审批卡同时出现。专门的页面 UI 仍手写，这是诚实的边界。
- **移动端契约**（与 web 完全同源）：① 配对 `POST /v1/tokens` 换 PAT；② 数据走 abei-api 资源 API；③ AI 走 `/api/ai` 的会话、NDJSON 聊天流（`meta/text_delta/tool_start/tool_end/approval/done/error` 事件表已定型）与审批端点。AI 逻辑全在服务端，客户端只渲染事件流。
- 后排可选：`abei ask "..."`，终端里走同一 `/api/ai`。
- `docs/design/ai-cli-line.md` §三 关于 MCP 工具面的结论按本方案作废。

## 七、MCP 清除

删：mcp-server.ts、`mcp` 子命令、SDK 依赖、README「MCP 与 Abaku Agent」节。内建助手从未走 MCP（工具是进程内调用），删除零功能损失。外部 agent（如 Claude Code）改用 abei-cli + `abei guide`，token 成本低于 MCP 全量工具注册。将来若真要接没有 shell 的远程客户端，从目录再生成一个门面约百行，现在不留代码。

## 八、剥离路线

abei-api 从第一天起就是唯一 API 面，但**初期大量委托**：账本操作 → Firefly REST；账单收件箱 → fork 里的扩展 API；web 尚未建模的既有调用 → 内部迁移代理。CLI 与 agent 不得使用该代理。然后逐域内迁，每迁一域改目录 `backend` 指向：

1. **只读统计先行**：category-stats、budget-groups、spending summary 迁入 abei-api（练手 + 立约定）。
2. **剥 bill-inbox**：约 9.5k 行 PHP（38 个服务 + 控制器）+ 7 张表迁出 Firefly schema。**按渠道移植**（支付宝/微信/招行/中行/招行信用管家），每渠道金样本（含 ~180 封招行历史邮件）回归通过后切换并删对应 PHP；worker 循环变 abei-api 内 tokio 任务。fork 随之回归近原生 Firefly。
3. **远期账本切换**（不排期）：granary-server 的账本 API、财务不变量、firefly_import 是种子，届时再定并入 abei-api 还是独立进程；鉴权那时才切自有认证。

纪律与风险：abei-api 不缓存、不镜像 Firefly 账目（自己的表只放自己算的东西，避免第二份真相）；鉴权过渡期对 Firefly 验 PAT（同 abei-agent 现状）；importer 移植保真靠金样本回归；过渡期三语言并存，PHP 随剥离消失，稳态 Rust + TS。`abaku_ai` schema 随改名 `ALTER SCHEMA` 为 `abei_ai`。

## 九、改名清单（硬切）

新建 `abei/` workspace（core/api/cli 三 crate）；`firefly-cli/` → `abei-agent/`（收缩，见 §六）；`abaku-web/` → `abei-web/`；compose 服务 `abaku-agent` → `abei-agent`、`abaku-web` → `abei-web`，新增 `abei-api`；`v1/abaku` 前缀由 abei-api 承接；DB schema `abaku_ai` → `abei_ai`；UI 文案 算珠/Abaku → 阿贝/abei（含 TokensPanel 配对命令文案，改为 `abei auth login` 一条，消灭 `auth set-token`/`config` 双轨）；README、AGENT.md、docs 全扫。不动：`granary.*` 存储键（既定决定）。仓库目录 `proj/abaku` 由用户自行改名。品牌标志是否随新名重画，另行决定。

## 十、分期

| 阶段 | 内容 | 可并行派发 | 验证门 |
|---|---|---|---|
| 0 盘点 | 渠道格式与金样本清单；abaku/ffc/firefly-cli 残留全扫；granary-server 体检（为远期账本备档） | 三个子任务并行 | 清单与体检报告 |
| 1 Rust 立根 | `abei/` workspace：abei-core 目录结构 + abei-api 骨架（PAT 透传鉴权、RFC 9457 错误、`/v1/catalog`、内部 web 迁移代理、首批只读能力） | core / api / 代理 分件 | cargo test + 对本机 Firefly 冒烟 |
| 2 abei-cli ✅ | 目录→clap builder 生成器、钩子层（双输出/--dry-run/--yes）、查询语法（miette 报错）、explain/guide、did-you-mean、补全；man 由 Makefile 生成 | 生成器 / 输出层 / 查询语法 并行 | 全命令冒烟 + 文档示例即测试 |
| 3 接源切流 | web 切 abei-api（先透传换址、后逐域用 hey-api 类型）；abei-agent 收缩（删命令与 MCP、Hono 重写路由、工具改走 catalog+invoke）；web 删硬编码标签；改名硬切全仓落地 | web / agent / 改名清扫 并行 | web 五条验证命令 + 助手页 e2e |
| 4 剥 bill-inbox | 按渠道 PHP→Rust + 表迁移 + worker tokio 化，每渠道金样本回归后删 PHP | 一渠道一子任务 | 金样本全绿 |
| 远期 | 账本切换（granary 种子）、自有认证 | — | 不排期 |

## 十一、阶段 2 的落地与偏离（2026-08-09）

CLI 已经能跑，`abei/crates/abei-cli`，二进制名 `abei`。三条质量门全绿，174 条测试。

**与本文规范的偏离**，都是实现时发现原方案不成立：

- `--json` 改成必须写等号（`--json=amount,category`）。原来写成 `--json 字段` 会把后面的查询词吃掉，`abei tx list --json 餐饮` 会把「餐饮」当字段名。加等号后裸 `--json` 仍然是「列字段名」。
- `auth login` 不再自带 `--url` / `--token`，直接用全局的那两个。clap 不允许同名长选项在同一条命令上出现两次，而全局选项会下发到每个子命令。用法没变：`abei auth login --token <令牌>` 照样能敲。
- `--jq` 作用在原始响应体上，`--json=字段` 作用在摊平后的行上。两者不是一回事：前者要全保真，后者要字段契约。
- 多了一个依赖 `jiff`：裸 `abei` 要按本机时区算「本月」。jaq-std 本来就把它编进来了，不额外增加编译。
- 假 Firefly 从 abei-api 的测试里提到了 `abei_api::testkit`（`testkit` feature 后面），CLI 的端到端测试打的是同一个 router。

**留给阶段 3 的接口点**：

- **写闸门**：`Hooks::gate()` 已经就位——`capability.risk.is_write()` 为真时，没有 `--yes` 也没有 `--dry-run` 就退 6，并把补好 `--yes` 的整条命令打出来给人/agent 照抄。目录里现在还没有写能力，加第一条写能力（`bills import` / `bills ignore`）时不用改 CLI，只要在 `abei-core::catalog` 里把 `risk` 标成 `Draft` 或 `Confirm`，命令树自动长出 `--dry-run` 和 `--yes` 两个开关。
- **`--dry-run` 的服务端约定**：CLI 会在请求上加 `dry_run=true`。abei-api 这边要在写路由上认这个参数，返回「会改什么」而不落库。现在只读能力用不上，接口先空着。
- **字段名即契约**：`normalize.rs` 里 `rows_for()` 按 capability id 分派，加新能力就在那里加一支。字段名一旦发布就不能改名，web 那边要对齐同一套名字。
- **web/agent 复用**：`abei guide` 的正文全部由目录现渲染，可以直接塞进 agent 的 system prompt 或 skill 文件，不需要另写一份说明。

## 十二、阶段 3A 的落地：账单收件箱接源与写闸门（2026-08-09）

三条质量门全绿，**227 条测试**。这一波把「AI 能不能真的动账」这件事从设计变成了代码。

### 写闸门是服务端的事

`abei-api/src/extract.rs` 的 `Gate` 提取器只认两个查询参数：`dry_run` 和 `confirm`。风险档决定放不放行：

- `read`：不设闸。
- `draft`（写的是建议、草稿、重跑）：服务端直接放行，CLI 那边仍要 `--yes`。
- `confirm`（会真的动钱或提交密码）：不带 `confirm=true` 也不带 `dry_run=true` 就是 **409 ConfirmationRequired**。

**CLI 的 `--yes` 只是本地礼貌，真正拦住的是服务端这一道。** 之前 CLI 只发 `dry_run`，`--yes` 停在本地，写能力必然被 409 挡回来——这一波补上了 `confirm=true`。三个客户端（CLI、web、agent）撞的是同一道闸，绕不过去。

`dry_run` 与 `confirm` 同时给时 `dry_run` 优先：先看再改，永远走安全的那一侧。

### 新增的两个资源、十一条能力

`bills`（别名 bill/task/tasks/inbox）与 `rows`（row/line/lines）：

| 能力 | 风险 | 说明 |
|---|---|---|
| bills.list / show / review | read | review 是分好桶、脱过敏的审阅视图，是改流水前的主入口 |
| bills.import / unlock / ignore | confirm | 会真的写账本、提交密码、改待办状态 |
| bills.retry / sync / process | draft | 重跑解析、收邮件、推进一轮 |
| rows.update / split | draft | 写的是建议，等人在收件箱确认 |

动词表加了 `Unlock` 和 `Split`。没有把它们藏进 `update` 里——「避免简单包装、不搞隐藏机制」，`abei bills unlock 42` 人和 agent 都读得懂。路由由 `Verb` 推导（`/v1/bills/{id}/unlock`、`/v1/rows/{id}/split`），不存在手工翻译表。

### 三条不给调用方选的事

1. **机器写入永远是建议。** `rows.update` 服务端强制 `as_suggestion: true`，参数模式里根本没有这个字段。否则「AI 猜的」和「人确认的」会混在一起。
2. **银行原文不给改。** `RowsUpdateParams` 只开放记账字段（firefly_type/date/amount/description、账户名、分类、备注、标签）。`occurred_at`、`counterparty`、`platform_order_no`、`amount` 一概不在里面——那是账单本身说的话。拼错的字段会连同「应该是哪些」一起报回去，不会被悄悄丢掉。
3. **密码只经手不留痕。** `bills unlock` 干跑**不把密码递给上游**，只回「这条命令会干什么」；请求体不进日志。

### 实现时发现原方案不成立的几处

- **参数模式里 `id` 是必填，但 `id` 走 URL 不走请求体。** 没有为每条写能力再养一个「去掉 id 的」结构体，而是让 `ValidJson` 提取器**用路径参数补全请求体**再解析。顺带两点包容：空请求体当 `{}`（`abei bills retry 42` 这种不带参数的写命令），请求体里也写了 `id` 时以路径为准（agent 习惯把参数摊成一个对象发过来）。
- **目录里的模式现在全量摊平 `$ref`。** schemars 把嵌套类型放进 `$defs`，CLI、agent、web 三边都得自己解引用等于同一件事写三遍。改成在唯一真源 `Capability::params()` 里展开一次，`$defs` 随后丢掉。OpenAPI 那边的 `hoist_defs` 因此删掉了。
- **OpenAPI 之前把写参数写成查询串**，而服务端从请求体收——照这份文档生成的 web 客户端会是坏的。改成读操作进 query、写操作进 `requestBody`，并把 `dry_run`/`confirm` 和 409 响应也写进文档。
- **对象数组参数在命令行上写成 `键=值,键=值`**，可重复，也接受整段 JSON（值里带逗号时用）。`abei rows split 7 --splits amount=20.00,description=菜 --splits amount=25.00,description=酒 --yes`。键名和类型都从模式来，键写错会把能填的列出来。这是通用规则，将来别的对象数组参数自动获得。
- **上游 `import` 端点原生的 `confirm` 布尔本来就是干跑开关**，所以闸门直接落在它上面：`dry_run` 时发 `confirm:false` 拿预览，确认后才发 `confirm:true`。不用另造一套。
- **预览必须自报是预览。** 服务端给干跑响应打 `dry_run: true`，但那记号在表格和 `--json` 投影里会被摊掉——一份「还没发生的事」看起来跟「已经发生的事」一模一样是要出事的。`Hooks::emit` 统一在 stderr 补一句「这是预览，没有真的改数据」，不脏数据管道，所有能力自动继承。

### 新增的两道防漂移测试

- **目录里的示例真的会被解析一遍**（`every_catalog_example_actually_parses`）。示例是给人和 agent 照抄的，抄了跑不通就是坑。它当场抓出两处：`rows split` 的示例漏了 `--splits`，`bills unlock` 的示例命令与它声明的参数对不上。
- **每条能力的路由都要真的挂上，方法也要对**（`every_capability_route_is_mounted`）。404 说明路径没挂，405 说明方法挂错了。

### 交付物

`abei/Dockerfile`（多阶段，runtime 是 debian-slim，`EXPOSE 18002`，带 `/health` 健康检查，`ABEI_API_HOST` 默认 `0.0.0.0`——容器里监听 127.0.0.1 等于谁都连不上）。**没有动 compose**，下一波编排接入时再挂。

## 十三、阶段 3B-1 的落地：firefly-cli 收缩成 abei-agent（2026-08-09）

命令行、MCP、手写能力表全部删除；`/api/ai` 的工具改成从 `GET /v1/catalog` 现取。
目录名和包名还叫 `firefly-cli`，改名硬切留给下一波。

### 删了什么

40 个文件、6914 行：`cli.ts` 与 `commands/` 六个文件、`capabilities/`（mcp-server 与手写注册表）、
`core/` 七个只服务于命令行的模块（config-store、command-context、output、query、request-body、key-value、pagination）、
`services/` 五个（local-doctor、resource-service、system-overview、transaction-import、transaction-summary）、
`schemas/endpoint-catalog.ts`，以及配套的 15 个测试文件和 CLI 的旧设计稿。
依赖去掉 `commander`、`@modelcontextprotocol/sdk`、`typebox`（package-lock 少了 1080 行）。
`package.json` 的 `bin` 入口取消，`tsup` 入口换成新的 `src/main.ts`。

### 留了什么、为什么

- `agent/` 整个留下：`/api/ai` 的 HTTP 面、会话与审批存储（`abaku_ai` schema 本波不改名）、
  模型运行时与发现、autofill/backfill/vocab-scan 三个后台循环。
- `core/http-client.ts`、`core/errors.ts`：后台循环和用户识别还要直连 Firefly。顺手删了没人用的
  `download()`、`FireflyInputError`、`FireflyConfigError`。
- `services/bill-task-service.ts` 从 20 个方法砍到 4 个（list / rows / review / suggestRow），
  就是 autofill 用到的那些。

### 工具怎么接上目录

`agent/abei-api.ts` 是新的 abei-api 客户端：拉目录（首次用到时拉，缓存五分钟，
并发的首次调用共用一次请求）、按 `method` + `path` 调用能力、把 problem+json 变成带
`reason` 的错误。`agent/tools.ts` 按 `tool_name` 和 `params` 生成工具定义，
`label` 直接用目录里的中文标签。目录加一条能力，助手就多一个工具，不用改代码。

参数校验不在 agent 这边做第二遍：`deny_unknown_fields` 和边界检查都在 abei-api，
拼错的字段会连同「应该是哪些」一起报回模型，正好是它改参重试要的反馈。

### 闸门在页面链路上怎么走

模型永远拿不到 `confirm`。`risk=confirm` 的工具调用时只带 `dry_run=true` 取预览，
落一条 pending 审批就停下，把 `approval` 事件推给页面；人点确认后走
`POST /api/ai/approvals/{id}`，那一步才带 `confirm=true` 打 abei-api。
abei-api 回 409 `ConfirmationRequired` 时不当错误报，走同一条「等人确认」的路——
这条兜底是给目录缓存过期准备的（目录说 draft、服务端已经调成 confirm）。

审批和 `tool_start`/`tool_end` 事件都补上了目录里的 `label`，审批还带 `needs_user_input`，
web 端可以据此删掉硬编码的能力名到中文的映射表。

### Hono 没换，理由

`server.ts` 的路由是一条 if 链加几个路径正则，约 280 行里真正属于分发的不到 60 行，
其余是参数校验和业务，换框架一行都省不掉。换过去要付的代价是：NDJSON 流式响应现在直接
写 `ServerResponse`，并靠 `response.once('close')` 调 `agent.abort()` 中断模型——这套
中断语义在 Hono 的 `stream()` 上得重写并重新验证，而它是这个服务里最不能出错的一段。
用一次重写换 60 行 if，不划算。等路由多到需要中间件分层时再说。

### 实现时发现原方案不成立的几处

- **`/v1/catalog` 要鉴权**（abei-api 拿令牌打 Firefly 校验），所以做不到「进程启动时拉目录」。
  改成首次用到时拿调用方的令牌拉，然后进程内缓存。目录内容与用户无关，缓存不按令牌分。
- **目录没有「这个字段只能人填」的标记。** `bills.unlock` 的 `secret` 在目录里是普通必填参数，
  而旧注册表用 `userInputParameters` 把它和模型隔开。现在这份名单（`HUMAN_ONLY_PARAMS`）留在
  agent 侧：这些字段从模型看到的参数模式里摘掉，模型硬塞也会被丢，改由审批那一次请求带上。
  这是 agent 的安全策略，不是第二份能力表；但目录里新增敏感字段要同步。
- **人填参数的能力干跑不了。** abei-api 的 `bills unlock` 在闸门之后先校验 `secret` 非空，
  没密码连预览都拿不到。这类能力直接落审批、预览留空。
- **能力面少了一条模糊搜索。** 旧注册表有 `search_transactions`（Firefly `/search/transactions`），
  目录里没有对应能力，`transactions.list` 只能按日期和类型翻页。「上次这家店记的什么分类」
  这类问题现在答不好，要么在 abei-core 补一条 `transactions.search`，要么承认助手退化。
- **「agent 不再进程内直连 Firefly」目前只对模型工具成立。** autofill 要按任务翻流水行
  （`GET /bill-tasks/{id}/rows`），目录里没有这条能力；它又用自己存的 PAT 定时跑。
  所以后台循环仍走 `FireflyHttpClient`。补上「列某份账单的流水行」之后这条路才能收进 abei-api。
- **web 助手页会被这一波打断。** 它按旧工具名硬编码：`approval.capability === 'submit_bill_secret'`、
  `approval.input.task_id`、以及一张 `CAPABILITY_LABELS` 表。现在能力 id 是 `bills.unlock`、
  参数是 `id`，`bills.ignore` 还多了一张审批卡（旧注册表里没有 ignore）。web 那一波必须同步改。
- **目录的 schema 是 schemars 的 JSON Schema，不是 TypeBox。** pi-ai 的 `validateToolArguments`
  对非 TypeBox schema 有专门分支，实测 15 条能力的示例参数全部通过，所以 `typebox` 直接依赖删掉了。
  测试里留了一条盯着这个假设：目录快照里每条示例都要能过一遍工具参数校验。
- **Makefile 还在传 `npm run dev -- agent serve`**，而本波不许动 Makefile。入口因此忽略裸词参数，
  只认 `--host/--port/--firefly-url/--abei-url`，拼错的选项照样报错。Dockerfile 已经改成
  `node dist/main.js --host 0.0.0.0`。
- **compose 里还没有 abei-api 服务**，`ABEI_API_URL` 默认 `http://127.0.0.1:18002`，
  容器形态下要等编排接入那一波才连得上。本波按约定没动 compose。

## 十四、阶段 3B-2 的落地：网页改吃 abei-api（2026-08-09）

交易、账户、账单、流水行、能力目录五个域改打 `/v1/*`；web 当时没建模的既有能力暂走内部迁移代理
（预算限额、分类标签、货币、附件、`summary/basic`、`insight/*`、令牌、
账户的 `cash` 类型、行的 `duplicate_state`），只加前缀不改路径。

请求侧的类型从 `abei/openapi.json` 用 hey-api 生成（`npm run gen:api` → `src/api/generated/`），
不生成 SDK 和 fetch 客户端：所有请求必须过 `src/api/client.ts`，那里有令牌轮换、
身份校验和 problem+json 解析。

`src/api/problem.ts` 把 `reason` 映射成语气：`MissingToken`/`InvalidToken` 不给重试按钮、
只给「重新登录」；`UpstreamUnavailable` 说「阿贝在，但它连不上后面的账本」并给重试；
`ConfirmationRequired` 走「这一步需要你确认」而不是报错。

`CAPABILITY_LABELS` 那张硬编码表删了，中文标签来自 `GET /v1/catalog`；
「这条要不要人填密码」也从能力的参数模式读，不再是 `id === 'submit_bill_secret'` 的分支。

### 实现时发现原方案不成立的几处

- **codegen 只挡得住请求侧漂移。** `openapi.json` 里每个 200 响应都是裸 `{"type":"object"}`，
  生成出来的响应 zod 是 `z.record(z.string(), z.unknown())`。响应校验只能继续靠手写的
  `schemas.ts`。设计稿里「codegen 消灭 schema 漂移」这句话，对查询/路径/请求体和
  problem+json 成立，对响应不成立。
- **`check_limit` 上限 100**，页面原来一页取 200 会吃 400。
- **`accounts.list` 覆盖不住页面的账户页签**：阿贝收 `asset|expense|revenue|liability|all`，
  页面用的是 `asset|cash|liabilities`。查过 `AccountFilter.php`，`liability` 与 `liabilities`
  解析成同一集合，重映射行为等价；`cash` 没有对应能力，当时回落内部 web 迁移代理。
- **`/v1/transactions/summary` 不是 Firefly 的 `/api/v1/summary/basic`**，形状完全不同
  （前者是阿贝自己的分类报告），`getSummaryBasic` 继续走代理。
- **干跑响应形状不统一**：只有 `bills.import` 回真实预览，其余写能力回
  `{dry_run, would, message?}`，页面因此另有一个 `dryRunPreviewSchema`。
- **`bills.ignore` 页面没有调用方**：页面上的「忽略这封邮件」是 `archive`，
  `ignore` 会把行丢下不管。这条目前只服务助手的审批路径。

## 十五、能力面补齐：人填标记、位置参数、全文检索（2026-08-09）

3B-1 报的两处退化在这一波补上，都补在目录里，不在客户端。

**`x-abei-human-only`。** 密码、验证码这类只能由人现敲的参数，标记写在 `params.rs` 的字段上，
`Capability::human_only()` 读出来，一路进 `/v1/catalog` 的 `human_only` 字段。
agent 侧那张手工维护的 `HUMAN_ONLY_PARAMS` 因此可以删——名单只有目录这一份。
`catalog.rs` 里有一条测试拿 secret/password/passcode/pin/otp/token/verification_code/captcha
这些词去闻参数名，闻到了却没标记就失败，替人记着「新增敏感字段要标」。
CLI 的 `explain` 把这一格写成「人填」而不是「必填」（后者会被模型读成「你去想一个」），
`guide` 里单开一节点名这些参数。

**`x-abei-positional`。** `abei transactions search 星巴克` 比 `--query 星巴克` 顺口，
而「哪个参数不带 `--`」这件事只该在参数定义里说一次。`id` 不用标（路径里有 `{id}` 就自动是位置参数）。
三条规矩由测试守着：一条能力最多标一个、被标的必须必填、不能和查询串（有 start/end 的那些）并存——
并存的话命令行上分不清裸词属于谁。

**`transactions.search`。** `Verb::Search` → `GET /v1/transactions/search`，委托 Firefly 的
`/api/v1/search/transactions`。这条和 `list` 的查询串容易混，所以目录描述、`explain`、`guide`
三处都写清楚：`abei tx list 餐饮` 是在**当页结果**上本地过滤，`abei tx search 餐饮` 是
服务端全文检索、不受翻页限制。搜索词上限 500 字在 abei-api 就地挡掉（按字数不是字节），
免得换回一个含糊的上游 422。
