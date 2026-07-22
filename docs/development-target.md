# Firefly AI Accounting 历史实现与验收基线

状态：历史基线；不再作为当前产品方向或任务来源

最后更新：2026-07-22

适用范围：`firefly-iii/`、`granary-web/`、`firefly-cli/` 和根目录开发基础设施

> 本文保留 Rust `granary-server` 启动前，Firefly III、Granary Web 和 Firefly CLI 的实现范围与验收证据，供迁移和行为核对使用。当前产品方向以产品所有者维护的《谷仓产品方向》为唯一来源，当前实现状态以代码、测试和 Git 历史为准。

## 1. 文档用途

本文记录上一阶段让 Granary Web、Firefly III 后端和 Firefly CLI 形成日常账务闭环时采用的范围、验收标准和结果。它不是 `granary-server` 的开发清单，也不得覆盖当前产品方向。

本文后续只在需要更正历史事实时修改。新的产品范围、优先级和决策不再写入本文。

## 2. 完成定义

本阶段只有同时满足以下条件才算完成：

1. 根目录 `Makefile`、`compose.yml` 和 `.env.example` 是统一的开发、测试和发布入口。
2. 开发数据库、PHPUnit 数据库、E2E 数据库、开发邮箱和 E2E 邮箱相互隔离；自动化测试不读取或修改个人数据。
3. 后端、CLI、Granary 单元/组件测试、类型检查、静态 lint、格式检查、依赖审计、生产构建和浏览器 E2E 均可从根目录执行；全上游 Mago analyzer 作为显式诊断债务单独保留。
4. 本文第 6 节的 Granary 功能可直接完成，不依赖旧版页面兜底、隐藏入口或静态假数据。
5. 单笔和多拆分交易在金额、币种、账户流向、组标题、编辑、删除、报表和对账中保持一致。
6. 账单导入只提交完整、可入账的行；dry-run、确认导入和拆分操作使用结构化结果且不会扩大用户确认范围。
7. 所有请求都有可区分的加载、空数据、成功和失败状态；权限或解析失败不得伪装成空数据。
8. Token 新增、替换或清除后不会显示上一个用户的缓存数据，也不会让旧请求污染新会话。
9. 桌面和移动视口的关键写操作 E2E 全部通过，测试结束后临时容器、网络、卷和 PAT 均被清理。
10. 最终证据来自同一份工作树完整执行的一次 `make release`；不同时间、不同代码状态的分段通过不能替代该门禁。

### 2.1 当前判定

- 当前状态是“P0 完成；P1 持续治理”。
- 同一份工作树的整条 `make release` 已成功，最终退出码为 0；第 11 节已回填该次执行的完整证据。
- P0 功能、隔离测试环境和发布门禁均已验收；历史分段结果只保留为问题收敛记录，不替代本次 release 证据。
- 镜像精确 digest、Firefly v2 direct-eval 依赖和 Mago analyzer 基线仍属于 P1，不影响本次 P0 完成判定。

## 3. 系统边界和安全原则

### 3.1 组件职责

- Firefly III 后端是账务、账单解析、导入、附件、对账和自动化执行的唯一事实来源。
- Granary Web 负责输入、展示、交互编排和调用后端契约，不复制后端财务规则。
- Firefly CLI 是用户和 agent 的命令行控制面；缺少专用命令时可调用通用 API，但不在 CLI 内解析银行账单。
- PostgreSQL 保存开发账务数据；测试 PostgreSQL 只保存单次测试产生的合成数据。
- GreenMail 只承载合成 SMTP/IMAP 流程，不连接真实邮箱。

### 3.2 不可违反的约束

- 不在前端或 CLI 中重新实现支付宝、微信或银行账单解析器。
- 不在日志、测试快照、仓库或 URL 中暴露 PAT、邮箱密码、账单密码、远程下载令牌、原始邮件或账单文件。
- API 和 Web 路径只能处理当前认证用户的数据；全局处理只允许出现在明确的维护命令中。
- 不用 `transactions[0]`、固定页数或静默截断近似完整财务数据。
- 不用中文提示文案推断业务状态；状态来自结构化字段和 HTTP 契约。
- 金额使用十进制字符串和定点逻辑，不用二进制浮点比较财务值。
- mutation 成功后必须刷新或更新所有受影响的查询。
- 不为未出现的复用需求增加额外框架或抽象层。

## 4. 历史本地开发与测试基线

本节到第 11 节记录的是 Rust 后端切换前的 Firefly 阶段证据，其中 `e2e-app`、`e2e-seed`、`cli-contract` 和 Playwright `22/22` 均是历史拓扑与历史结果，不是当前 Granary E2E 的服务或数量。切换后的当前入口和证据见第 12 节。

### 4.1 根目录命令

| 命令 | 当时职责 |
| --- | --- |
| `make help` | 列出根目录开发、测试和发布入口 |
| `make bootstrap` | 缺少 `.env` 时从 `.env.example` 创建，并构建源码镜像和 CLI |
| `make up` | 构建并启动 PostgreSQL、GreenMail、Firefly III 和 Granary Web |
| `make down` | 停止默认开发栈并保留开发数据卷 |
| `make clean` | 删除默认、test、empty-start、E2E 项目的容器、网络和数据卷；这是破坏性恢复入口 |
| `make reset` | 删除默认开发栈的数据卷并重建；这是破坏性本地操作 |
| `make ps` | 查看 Compose 服务状态 |
| `make logs` | 跟踪 Firefly III 和 Granary Web 日志 |
| `make test` | 依次运行完整后端、CLI 和 Granary 自动化测试 |
| `make test-backend` | 在隔离 PostgreSQL `test-db` 上运行完整 PHPUnit |
| `make test-cli` | 在 Node 22 中执行 CLI typecheck 和 Vitest |
| `make test-web` | 在 Node 22 中执行 Granary Vitest |
| `make lint` | 以 warning 为失败级别运行 Mago lint，并运行 CLI ESLint/Prettier 和 Granary oxlint |
| `make analyze-backend` | 独立运行全 Firefly 源码 Mago analyzer；用于治理上游历史基线，不属于当前 release 门禁 |
| `make audit` | 审计 Firefly Composer、Firefly npm、CLI npm 和 Granary npm 依赖 |
| `make build` | 构建 Firefly production/test、Granary production 镜像和经过 typecheck 的 CLI |
| `make test-empty-start` | 强制读取 `.env.example`，用独立 Compose project 和空卷验证默认开发栈、数据库、HTTP、SMTP 和 IMAP readiness，结束后清理 |
| `make test-e2e` | 用独立空卷运行初始化、真实 CLI 预算 CRUD 契约和 Playwright 验收，退出时清理全部临时资源 |
| `make migrate` | 在已启动的后端容器内执行迁移 |
| `make shell` | 进入已启动的后端容器 |
| `make config` | 展开 `test`、`e2e` profiles 并校验 Compose 配置 |
| `make release` | 按固定顺序执行全部发布门禁，任一步失败即停 |

`make release` 的准确顺序是：

```text
config -> test-e2e -> test -> lint -> audit -> build -> test-empty-start
```

E2E 紧跟配置校验，优先使用干净的宿主资源预算；它仍从当前源码构建 production 后端和 Granary 镜像。后续 test、lint、audit、build 和 empty-start 不修改工作树，因此整条 release 仍验证同一实现状态。

### 4.2 默认端口

- Granary Web：`http://localhost:18002`
- Firefly III：`http://localhost:18001`
- PostgreSQL：`127.0.0.1:15432`
- SMTP：`127.0.0.1:13025`
- IMAP：`127.0.0.1:13143`

端口可在 `.env` 中修改。E2E Web 只在 Compose 内部网络访问，不占用宿主机端口。

### 4.3 Compose 服务和隔离边界

| Profile | 服务 | 职责与隔离 |
| --- | --- | --- |
| 默认 | `db` | PostgreSQL 17 开发库，唯一使用持久化 `dev-postgres` 数据卷的数据库 |
| 默认 | `mail` | GreenMail 2.1.3 合成 SMTP/IMAP，具备端口 readiness healthcheck |
| 默认 | `app` | 当前后端源码的 production target，等待数据库和邮件健康，自动迁移并生成 OAuth key |
| 默认 | `granary-web` | 当前 Granary 源码的 nginx production runtime，等待后端健康 |
| `test` | `test-db` | PHPUnit PostgreSQL，数据目录使用 `tmpfs`，不挂载开发卷 |
| `test` | `backend-test` | Firefly test target，挂载当前源码；`make test-backend` 运行完整 PHPUnit，`make lint` 另行调用 Mago lint |
| `test` | `cli-test` | Node 22 CLI typecheck、测试、lint、格式和审计环境 |
| `test` | `web-test` | Node 22 Granary 测试、lint、构建和审计环境 |
| `test` | `firefly-composer-audit` | 对 `composer.lock` 运行安全公告审计 |
| `test` | `firefly-node-audit` | 审计 Firefly npm 生产依赖和完整依赖树 |
| `e2e` | `e2e-db` | 使用 `tmpfs` 的独立 PostgreSQL 空环境数据库 |
| `e2e` | `e2e-mail` | 独立 GreenMail 合成邮箱，具备 SMTP/IMAP readiness healthcheck |
| `e2e` | `e2e-app` | 测试配置下的 production 后端，使用隔离数据库和存储 |
| `e2e` | `e2e-web` | 仅在 E2E 内部网络提供 Granary，不暴露宿主机端口 |
| `e2e` | `e2e-seed` | 创建合成用户、PAT、币种、账户、交易、规则、周期任务和邮件夹具 |
| `e2e` | `cli-contract` | 构建真实 CLI，对隔离后端执行认证、ping 和预算 create/read/delete 契约 |
| `e2e` | `e2e` | 固定 Playwright 浏览器镜像，运行桌面和移动验收 |

E2E 与 empty-start 使用独立 project name。入口开始前和退出时都删除自己的容器、网络和卷，不接触默认开发卷；清理命令失败会使对应门禁失败，不能以成功状态掩盖资源残留。

## 5. 历史阶段状态与开发重心

| 领域 | 最终状态 | 后续工作 |
| --- | --- | --- |
| Make/Compose 发布基础 | `make config`、empty-start 和完整 `make release` 均通过，隔离与严格清理已实测 | P0 无剩余项 |
| CLI 质量门禁 | typecheck、Vitest、ESLint、Prettier 和 build 全部通过 | P0 无剩余项 |
| 后端静态检查 | Mago lint `No issues found` | P1：为 31,807 项上游 analyzer 历史问题建立基线 |
| 依赖审计 | Composer、生产 npm、CLI 和 Granary 均为 0；Firefly 完整开发树无 high/critical | P1：治理 legacy 9 low / 10 moderate |
| CLI 真实契约 | 空卷预算 create/read/delete 及删除后不可读取全部通过 | P0 无剩余项 |
| GreenMail readiness | empty-start 与 E2E 的 SMTP/IMAP readiness 均通过 | P0 无剩余项 |
| 多拆分交易 | 组标题、稳定 `order`、金额规范化、完整 payload、类型切换防护和已对账禁编辑通过最终 release | P0 无剩余项 |
| 预算 | `spent` 数组响应、创建/限额流程和 CLI CRUD 通过最终 release | P0 无剩余项 |
| 账单行安全 | nullable 响应、完整行门控、dry-run 快照和 Split 防护通过最终 release | P0 无剩余项 |
| 对账安全 | 首笔调整、空金额初始化、批量对账和已对账组禁编辑通过最终 release | P0 无剩余项 |
| E2E | CLI 契约和 Playwright `22/22` 通过，临时容器、网络和卷无残留 | P0 无剩余项 |
| npm lock 来源 | 三份 lockfile 的镜像源计数为 0，容器内 `npm ci`、audit 和 build 全通过 | P0 无剩余项 |
| 镜像复现性 | 主要系列/tag 已固定 | P1：继续固定精确 patch 或 digest |

当前开发重心已从 P0 功能收口转为 P1 持续治理：固定镜像精确版本或 digest、解决 Firefly v2 direct-eval 依赖债、为全树 Mago analyzer 建立“无新增问题”基线。任何新增功能都必须继续保持本次 release 门禁全绿。

## 6. 完整开发任务

### 6.1 P0：测试、审计和发布基础

要求：

- 根目录命令覆盖 test、typecheck、lint、format、audit、build、empty-start 和 E2E，并提供独立的全树 analyze 诊断入口。
- PHP 测试使用隔离 PostgreSQL；CLI/Granary 使用容器内干净 `npm ci`。
- CLI 的 `tsup` 构建不能替代类型检查，必须执行 `tsc --noEmit`。
- Mago lint 以 warning 为失败级别进入发布门禁；CLI ESLint、Prettier 和 Granary oxlint 都必须通过。全树 Mago analyzer 在建立可维护的上游基线前不得伪装成可通过的 release 门禁。
- Composer、Firefly npm、CLI npm 和 Granary npm 都进入依赖审计。
- E2E 从空卷完成迁移、OAuth key、合成用户、PAT、币种和数据 seed，无需手工进入容器修补。
- CLI 契约必须真实创建、读取、删除预算，并验证删除后不可读取；只做 ping 不足以验收写操作。
- GreenMail 必须在 SMTP/IMAP 都 ready 后才允许依赖服务启动。
- E2E 内部 Web 不暴露无用宿主机端口。
- test、empty-start 和 E2E 的退出清理失败必须传播非零状态；`make clean` 提供中断后的统一恢复入口。

验收：同一工作树的 `make release` 全部成功；测试结束后开发数据不变，临时资源无残留。

状态：P0 完成；最终 `make release` 全部通过。

### 6.2 P0：交易组、多拆分和编辑安全

要求：

- 列表、详情、账户、Dashboard、搜索、报表和对账不得丢失任何 split。
- 同币种组总额按所有 split 的绝对金额精确求和；混合币种分币种展示，不做隐式换算。
- 创建多拆分交易至少包含两条完整 split；编辑现有组保留 journal ID 和未编辑元数据。
- 每条 split 显式发送从 0 开始的稳定 `order`；创建、编辑、刷新和重新打开后保持用户顺序。
- 多拆分创建和更新始终发送非空 `group_title`；用户原组标题可编辑并在刷新后保留，空输入才回退到第一条描述。
- 每条 split 保留日期、类型、来源、目标、币种、分类、预算、账单、标签、外币和备注。
- 切换 withdrawal/deposit/transfer 时清除不再兼容的账户 ID 和名称，避免提交陈旧关系。
- 任何 split 已标记 `reconciled` 时，整个用户交易组只读；Opening balance、Reconciliation 等系统类型也不可通过普通编辑器修改。

验收：桌面和移动端均能创建、编辑、刷新并重新打开多拆分 withdrawal/deposit/transfer；API 中 split 数量、顺序、规范化金额、流向、元数据和组标题完全一致；已对账组没有编辑入口。

状态：P0 完成；代码、单元测试和最终 release 的空卷完整 E2E 均通过。

### 6.3 P0：认证、缓存、分页和错误状态

要求：

- PAT 新增、替换和清除时取消旧请求并清空用户级 Query Cache。
- 旧 Token 的响应和并发 401 不得清除或污染新会话。
- 无 Token 时不挂载依赖用户数据的 Router 和查询。
- 列表使用服务端 pagination meta；需要全量的数据逐页读取至 `total_pages`，或改用后端聚合。
- mutation 明确刷新交易、账户、Dashboard、预算、报表、对账、搜索和详情等受影响查询。
- 首次加载、后台刷新、空数据和错误可区分，错误可重试且不丢失表单输入。

验收：用户 A/B 连续切换无数据串扰；超过一页的数据读取、编辑、删除和深链接无重复或遗漏；主要失败路径有自动化测试。

状态：P0 完成；代码、定向测试和最终 release 均通过。

### 6.4 P0：按天对账和调整交易

要求：

- 后端按认证用户和日期事务性标记完整交易范围，不存在静默 200 条上限。
- 重复标记已对账交易是幂等成功，并返回总数、更新数和已处理数。
- 中途失败必须整体回滚，不能留下半完成状态。
- 第一次对账调整不依赖已有差异流水；打开调整窗口时金额为空，不复制上一笔调整金额。
- 调整金额必须为正十进制字符串，账户必须有效且币种匹配；增加/减少方向映射正确。
- 任一 split 已对账后，整个交易组禁止通过普通交易编辑器修改。

验收：超过 200 个交易组完整对账；重复执行稳定；注入失败后无部分写入；没有历史调整时可创建第一笔调整；已对账组只读。

状态：P0 完成；后端、前端、组件防护和最终 release 均通过。

### 6.5 P0：预算一致性

要求：

- 创建预算和首个限额由后端事务完成，失败不遗留孤立预算，重试不产生重复项。
- 多个重叠限额分别展示和编辑，不能把合计写回第一条。
- Budget limit 的 `spent` 按真实 API 数组解析，`spent: []` 是合法空数据而不是加载失败。
- 删除预算、修改限额后刷新预算、Dashboard 和报表。
- CLI 预算 CRUD 契约在隔离后端创建唯一预算、读取并核对名称、删除并验证不可读取。

验收：桌面和移动预算创建/修改闭环通过；真实空 `spent` 响应正常显示；限额失败无残留；CLI 契约清理创建的数据。

状态：P0 完成；代码、组件测试和最终 release 的空卷完整 E2E 均通过。

### 6.6 P0：账单行解析、门控、dry-run 和拆分

后端契约包括：

- `GET /api/v1/bill-tasks/{id}/rows`
- `PATCH /api/v1/bill-statement-rows/{id}`
- `POST /api/v1/bill-statement-rows/{id}/split`
- `POST /api/v1/bill-tasks/{id}/import`

要求：

- 前端 schema 接受后端真实 nullable 字段，包括日期、金额、交易映射、账户、分类、标签和错误信息；null 不得导致整页解析失败。
- 只有 `pending + unique` 且具备有效类型、日期、正金额、描述、来源和目标的完整行可以勾选入账。
- `firefly_date` 缺失时可以使用合法 `occurred_at`；非法日期、空金额、零/负金额、缺账户或缺描述必须阻止入账。
- `needs_split` 行始终可见但不可直接导入；`duplicate`、`conflict`、`failed` 和 `imported` 有明确状态。
- dry-run 返回的 `would_import` row ID 是确认范围快照；确认提交只发送该快照，不使用之后变化的选中集合，也不把 skipped/failed 行加入。
- 账单行拆分至少保留两项；每项账户、描述和正金额必填，精确合计必须等于原始正金额。
- 拆分成功后刷新行、任务详情、review、summary、events 和可导入范围；失败保留输入并展示服务端错误。

验收：nullable 合成响应可展示和编辑；不完整行不能选中；dry-run 后确认范围不扩大；有效组合支付可拆分并导入；金额不符、少于两项、缺账户、零/负金额和重复提交均有确定行为与测试。

状态：P0 完成；nullable schema、完整行门控、dry-run 快照和 Split 防护已通过最终 release/E2E。

### 6.7 收件箱设置、同步、处理和清理

后端契约：

- `GET/PUT /api/v1/bill-inbox/settings`
- `POST /api/v1/bill-inbox/sync`
- `POST /api/v1/bill-inbox/process`
- `POST /api/v1/bill-inbox/cleanup-stale`

要求：

- 邮箱主机、端口、加密、用户名、密码、文件夹和同步范围可配置。
- 密码只允许替换，不从 API 回显；设置加载失败时不得展示可保存的空默认表单。
- 同步、处理和清理是三个独立动作，并展示结构化结果。
- Retry 后任务继续处理，不能永久停在 `received`。
- `received`、`ready`、`needs_secret`、`parsed`、`failed`、`imported`、`ignored` 等状态可筛选和打开。

验收：向 E2E GreenMail 投递合成邮件后，可从 Web 同步、提交 secret、解析、review、导入、忽略或重试；清理只影响符合条件的过期任务。

状态：P0 完成；代码和最终 release 的空卷完整 E2E 均通过。

### 6.8 任务证据、Review、事件、产物和下载

要求：

- 任务详情展示 review 摘要、问题和修复入口。
- 事件时间线展示时间、类型和安全说明。
- 产物列表展示文件名、类型、大小和阶段。
- 下载使用认证 blob 请求，正确处理文件名、MIME、失败和对象 URL 回收。
- DOM、日志和 API metadata 不暴露 secret、真实存储路径或远程下载令牌。

验收：多产物可逐个下载；无权限、文件不存在和中断有可恢复错误；`needs_split` 证据始终可见。

状态：P0 完成；代码和最终 release 的空卷完整 E2E 均通过。

### 6.9 交易附件

要求：

- 在交易详情查看附件，按“创建 metadata -> 上传二进制”完成上传。
- 前端在请求前拦截后端不接受的大小和类型；任何一步失败均可恢复。
- 下载不把 PAT 放入 URL；编辑文件名、标题和备注；删除前确认。
- 同一交易多个附件互不覆盖，失败附件不得显示为成功。

验收：上传、刷新、下载、改名和删除闭环可用，错误路径有组件或 E2E 测试。

状态：P0 完成；代码、定向测试和最终 release 均通过。

### 6.10 账户 CRUD

要求：

- 创建、编辑和删除后端允许的资产、现金、负债及其他主要账户类型。
- 编辑名称、角色、币种、期初余额、启用状态和必要字段。
- 非法类型组合不提交；有关联数据删除失败时保留页面和后端原因。
- 禁用账户默认不进入普通记账候选，但可在账户管理中筛选。
- 写操作刷新账户、交易候选、Dashboard、报表、预算和搜索。

验收：主要账户类型 CRUD 通过组件和 E2E；权限、校验和有关联数据删除行为符合后端契约。

状态：P0 完成；代码和最终 release 的空卷完整 E2E 均通过。

### 6.11 搜索、数量和深链接

要求：

- 命令面板搜索交易和账户，展示各自数量、加载和失败状态。
- 查询语法和特殊字符正确编码。
- 交易跳转到 `/transactions?transaction={positiveIntegerGroupId}`；只接受 URL 可用的正整数 ID，不编码带引号值。
- 账户跳到对应详情；直接刷新深链接仍能定位非第一页目标。

验收：目标不在第一页时仍能打开；无结果、超时和部分搜索失败可区分；深链接中不出现 `%22ID%22`。

状态：P0 完成；代码和最终 release 的空卷完整 E2E 均通过。

### 6.12 完整报表

要求：

- 收入、支出、净额、余额趋势和 Top 结果基于完整日期区间与账户筛选。
- 不允许 250 条或固定页数截断；大数据量使用后端聚合。
- 多拆分、退款/负数、转账和不同币种计入规则明确并有测试。
- 币种和日期时区来自用户及数据设置，不硬编码 CNY、`¥` 或 UTC+8。
- 图表具备空数据、失败状态和可读文本数值。

验收：固定夹具结果与独立期望值一致；超过 250 条仍准确；多币种不错误合计。

状态：P0 完成；代码、定向测试和最终 release/E2E 均通过。

### 6.13 CSV 导出

要求：

- 支持后端 accounts、bills/subscriptions、budgets、categories、piggy-banks、recurring、rules、tags 和 transactions 导出。
- 交易导出传递正确的日期和账户参数。
- 使用认证下载、解析服务端文件名并展示等待和失败状态。
- Token 不进入 query string，内容不进入缓存日志。

验收：所有入口调用正确端点；UTF-8 中文、Content-Type、文件名、空导出和服务端错误行为明确。

状态：P0 完成；代码和最终 release 的空卷完整 E2E 均通过。

### 6.14 规则、规则组和周期任务

要求：

- Rule/RuleGroup 未指定 `accounts` 时不发送空账户过滤；显式账户范围才进入请求。
- dry-run 只读取匹配结果，不修改交易，并保存本次匹配数量作为执行确认依据。
- Trigger 显示范围、日期和匹配数量并二次确认，防止重复点击。
- 执行使用结构化结果，不解析中文提示；成功后刷新交易、账户、预算、Dashboard 和报表。
- 周期任务手动触发后展示生成数量和深链接。
- 金额断言先规范化十进制字符串；不能要求后端把 `12.340000000000` 全局改成 `12.34`。

验收：dry-run 前后数据不变；执行只影响预览范围；规则标签落库；周期任务生成交易可从深链接打开；金额精度比较稳定。

状态：P0 完成；业务执行和金额规范化已通过最终 release 的空卷完整 E2E。

### 6.15 通用交互、可访问性和安全

要求：

- Modal 支持焦点锁定、Esc/关闭按钮、关闭后焦点恢复和 body 滚动锁定。
- 图标按钮具备可访问名称和 tooltip，表单错误关联对应输入。
- 桌面和移动端无文字、控件和底部导航重叠。
- Granary nginx 提供与资源兼容的 CSP、`X-Content-Type-Options`、Referrer Policy 和 frame 限制。
- Granary 不包含 Lottie direct-eval 路径，按实际收益控制首屏 bundle。
- 金额和日期按用户 locale、币种和时区显示。

验收：键盘可完成主要工作流；桌面/移动 Playwright 通过；Granary 构建无 direct-eval；安全 header 自动验证。

状态：P0 完成；最终 release 的 Granary 构建主包 `409.31 KB`、gzip `132.07 KB`。Firefly v2 既有 `json2.js` direct-eval 构建警告列为 P1 依赖债，不得误写为全仓库无警告。

### 6.16 P1：依赖和镜像复现性

要求：

- Firefly、CLI、Granary 三份 npm lockfile 不包含 `registry.npmmirror.com`；当前计数均为 0。
- 容器中的 `npm ci`、audit 和 build 必须验证 lockfile 可从目标 registry 完整安装。
- Node、PHP、PostgreSQL、nginx、Composer、GreenMail 和 Playwright 镜像逐步固定精确 patch 或 digest。
- Firefly v2 `json2.js` direct-eval 警告通过上游升级、替换或删除真实依赖路径解决，不用关闭构建警告掩盖。
- 为全树 Mago analyzer 建立可维护的上游基线，再把“新增 analyzer 错误为 0”升级为发布门禁；当前已知基线为 31,807 项，不能用忽略退出码冒充通过。

验收：全新机器可得到相同依赖和镜像内容；镜像 tag 漂移不会改变 release 结果；P1 未完成项持续保留在第 10 节。

状态：lock 镜像源整改已通过最终 release；镜像 digest、Firefly v2 direct-eval 和 Mago analyzer 基线治理仍为 P1 未完成项。

## 7. API 和数据契约

### 7.1 分页

- 列表读取 `meta.pagination.current_page`、`total_pages`、`per_page` 和 `total`。
- 禁止只用“返回数量等于 limit”判断还有下一页。
- 后端缺少 `total_pages` 时可由有效 `total/per_page` 推导；元数据不可用时必须有明确的有限行为。

### 7.2 金额和币种

- API 金额保持十进制字符串，比较、求和和规范化使用定点逻辑。
- UI 格式化不改变提交精度。
- 不同币种不直接求和；交易组、预算、报表、拆分和对账均覆盖负数、小数位和大金额。

### 7.3 时间

- API 时间保留时区；按用户时区确定账务日和报表边界。
- 业务组件禁止硬编码 UTC+8。
- 本地日编辑不通过 UTC `Date` 转换造成偏一天；DST、月末和跨年至少有自动化覆盖。

### 7.4 错误

- API client 保留 HTTP 状态、后端 message 和字段 validation errors。
- 401/403 处理认证上下文，但旧 Token 的 401 不得影响新 Token。
- 409/422 作为可恢复业务错误展示，UI 保留输入。
- JSON 和 blob 下载错误分别解析。

### 7.5 Cache key 和失效

- Query key 包含会改变结果的 Token 身份、筛选、分页、账户、日期和状态参数。
- Token 边界切换时清空全部用户数据。
- 每个 mutation 在测试中声明并验证受影响查询。

## 8. 自动化测试与真实历史

### 8.1 测试矩阵

| 领域 | 后端 | CLI/Granary 单元与组件 | E2E |
| --- | --- | --- | --- |
| 发布基础 | PHPUnit/PostgreSQL、Mago lint | typecheck、lint、format、audit、build | empty-start、资源清理 |
| 认证隔离 | API 权限 | Token 竞态、cache 清理 | 合成用户切换 |
| 单笔/多拆分 | payload、事务 | 汇总、标题、编辑和禁编辑 | 桌面/移动创建、编辑、刷新 |
| 对账 | >200、回滚、幂等 | 首笔调整、已对账只读 | 标记一天并核对 API |
| 预算 | 原子创建、限额 | `spent` schema、多限额 | 桌面/移动创建修改 |
| 账单行 | nullable、导入校验 | 完整门控、dry-run 快照、拆分 | 合成邮件到入账 |
| 收件箱 | 设置、同步、处理、清理 | 状态、错误和 retry | GreenMail 全流程 |
| 产物/附件 | 权限、下载、CRUD | 上传、下载和错误状态 | 合成文件闭环 |
| 账户 | CRUD 校验 | 表单和 cache | 主要类型 CRUD |
| 搜索 | count/accounts | ID 和 deep link | 非第一页定位 |
| 报表/导出 | 聚合、参数、响应头 | 图表、blob 和错误 | 固定数据/CSV 核对 |
| 自动化 | dry-run/trigger | 确认、防重复、金额规范化 | 规则执行和周期触发 |
| CLI 契约 | 真实 API | typecheck/build | 预算 create/read/delete |

### 8.2 E2E 历史

以下结果来自不同时点，只用于说明问题收敛过程，不能相互拼接成发布成功：

| 阶段 | 结果 | 结论 |
| --- | --- | --- |
| 旧精简套件 | `5 passed / 1 skipped` | 仅覆盖早期主路径，不能代表扩展后的 22 个用例 |
| 扩展套件第一轮 | `12 passed / 10 failed` | 10 个失败归并为 5 个共享根因，随后已修 |
| 扩展套件第二轮 | `17 passed / 5 failed` | 5 个失败归并为 3 个根因，随后继续整改 |
| 本轮旧执行配置 | `19 passed / 3 failed` | 剩余桌面多拆分、移动多拆分和移动预算失败；触发本轮附加防护 |
| 剩余路径定向复验 | `4 passed / 0 failed` | 桌面/移动多拆分和预算均通过；仍不能替代完整 22 用例空卷执行 |
| 独立空卷完整执行 | `22 passed / 0 failed` | CLI 契约同时通过，退出码为 0，临时容器、网络和卷无残留 |
| 最终 `make release` 内执行 | `22 passed / 0 failed` | 桌面 12 条、移动 10 条和 CLI 契约全部通过，随后完整 release 退出码为 0 |

第一轮 5 个真实根因：

1. 多拆分编辑器在非安全 HTTP 环境调用 `crypto.randomUUID()`，运行时不可用。
2. PHP 8.5 下 IMAP socket 属性/参数初始 `null` 类型不兼容。
3. 交易深链接接受带引号或非正整数 ID，产生 `%22ID%22`。
4. 两个隔离 E2E 用户没有都明确启用并使用 CNY，夹具币种不稳定。
5. Rule/RuleGroup 未传 `accounts` 时仍添加空账户过滤，导致 dry-run/execute 匹配异常。

第二轮 3 个真实根因：

1. 多拆分创建漏传 Firefly 强制要求的 `group_title`，桌面和移动均返回 422。
2. Budget limit 的真实 `spent: []` 被前端 schema 声明成标量，导致整个响应解析失败。
3. 自动化规则和周期任务实际成功，测试却把 `12.340000000000` 硬断言为 `12.34`。

最后 3 条失败的根因是：移动预算弹窗/列表布局不适配窄视口；多拆分没有发送稳定 `order`，同日交易被后端按 ID 逆序返回；API 金额返回固定小数位而测试和编辑器未先规范化。修复后桌面/移动多拆分及预算定向 E2E `4/4` 通过。期间一次 OrbStack 停止导致 tmpfs 数据库和 token 失效，该次基础设施中断已作废，恢复空数据库并重新 seed 后的结果才作为证据。

本轮还加入组标题创建/编辑保留、nullable 账单行、完整行门控、dry-run row ID 快照、Split 最少项与金额/账户防护、首笔对账调整和已对账组禁编辑。它们已通过针对性代码测试，并由最终 `make release` 串行复验。

### 8.3 测试和依赖审计证据

| 检查 | 最终 release 实测结果 | 门禁结论 |
| --- | --- | --- |
| 后端 PHPUnit | 隔离 PostgreSQL 全量 `586 tests / 2295 assertions` 通过 | 通过 |
| CLI Vitest | `14 files / 100 tests` 通过；ESLint、Prettier、typecheck、build 通过 | 通过 |
| Granary Vitest | `24 files / 86 tests` 通过；oxlint、`tsc -b`、production build 通过 | 通过 |
| Granary build | 主包 `409.31 KB`，gzip `132.07 KB` | 通过 |
| Composer audit | 0 advisories | 通过 |
| Firefly npm 完整树 | `19`（9 low / 10 moderate / 0 high / 0 critical） | 通过；legacy low/moderate 转 P1 |
| Firefly npm production | 0 vulnerabilities | 通过 |
| CLI / Granary npm | 0 / 0 | 通过 |
| lock registry | 三份 lockfile 的 `registry.npmmirror.com` 计数均为 0；容器内 `npm ci`、audit、build 通过 | 通过 |
| 静态检查 | Mago lint `No issues found`；全树 analyzer 基线 31,807 项不进入当前 release | 通过；analyzer 转 P1 |
| Firefly v2 build | 仍有既有 `json2.js` direct-eval 警告 | P1 跟踪，不得描述为全仓库无警告 |

`make audit` 的目标门禁是：Firefly production 依赖以 `audit-level=low` 全级别零容忍；Firefly 完整依赖树以 `audit-level=high` 阻止 high/critical，同时把允许暂存的 19 个 legacy low/moderate 完整输出；Composer、CLI 和 Granary 保持 0。

## 9. 收口执行记录

2026-07-21 已按最终固定顺序完成同一份工作树的整体验收：

1. `make config` 校验 Compose 配置。
2. 空卷执行 `make test-e2e`，取得 CLI 契约和 Playwright `22/22`。
3. 顺序执行后端、CLI、Granary 全量测试和 typecheck。
4. 执行 Mago、ESLint、Prettier、oxlint 和四类依赖审计。
5. 构建 Firefly、Granary、测试镜像和 CLI。
6. 从 `.env.example` 空卷执行 `make test-empty-start`。
7. release 退出码为 0 后检查 E2E/empty-start 无资源残留，`git diff --check` 通过，并回填第 11 节。

## 10. 验收清单

### 10.1 已落地并通过整体验证

- [x] 根目录 Make/Compose、隔离数据库和合成邮箱已建立。
- [x] CLI typecheck、Mago lint warning 门禁、CLI format check 已进入根目录流程。
- [x] 清理失败会传播非零状态，并提供破坏性的统一 `make clean` 恢复入口。
- [x] empty-start 强制使用 `.env.example`，不继承用户当前 `.env` 的数据库和应用配置。
- [x] Composer、Firefly npm、CLI npm 和 Granary npm 审计入口已建立。
- [x] GreenMail 默认/E2E healthcheck 和健康依赖已建立。
- [x] E2E Web 不再占用宿主机端口。
- [x] CLI 预算 create/read/delete 真实契约已建立。
- [x] 三份 npm lockfile 的 `registry.npmmirror.com` 已清零。
- [x] 组标题保留、nullable 账单行、完整行门控、dry-run 快照、Split 防护、首笔对账调整和已对账组禁编辑已落地。
- [x] 多拆分稳定 `order` 和金额规范化已通过桌面/移动定向 E2E。

### 10.2 不阻塞当前 P0 release 的后续债务

- [ ] 镜像精确 patch/digest 固定完成。
- [ ] Firefly v2 `json2.js` direct-eval 依赖债解决。
- [ ] 全树 Mago analyzer 建立上游 baseline，并以“无新增问题”进入后续 release。

### 10.3 最终发布门禁

- [x] `make config` 在最终工作树通过。
- [x] `make test` 在最终工作树通过，并回填后端、CLI、Granary 最新数量。
- [x] `make lint` 在最终工作树通过，包含 Mago lint、ESLint、Prettier 和 oxlint；CLI typecheck 由 test/build、Granary typecheck 由 build 覆盖。
- [x] `make audit` 按第 8.3 节策略通过，并回填最终漏洞分布。
- [x] `make build` 在最终工作树通过，并回填最终 bundle 数字和已知警告。
- [x] `make test-empty-start` 从空卷通过，数据库、HTTP、SMTP 和 IMAP 健康。
- [x] 最终空卷 `make test-e2e` 中 CLI 契约通过，Playwright 桌面和移动用例达到 `22/22`。
- [x] E2E 和 empty-start 的容器、网络、卷、临时 PAT 与合成数据已清理。
- [x] README 命令说明与最终 Make/Compose 行为一致。
- [x] `git diff --check` 通过，工作树没有失败测试生成物，也没有恢复用户删除的旧 docs。
- [x] 同一份工作树完整执行一次 `make release` 成功。

## 11. 最终证据回填

以下字段只能使用最后一次成功的 `make release`，以及紧接其后的同工作树标识、残留资源和 `git diff --check` 结果填写：

| 项目 | 最终结果 |
| --- | --- |
| 工作树/提交标识 | 2026-07-21 release 基于 `main@ac4ed56c8981` 的未提交工作树；同一源码随后按组件固化到 Git 历史 |
| 后端 PHPUnit tests/assertions | `586 tests / 2295 assertions`，通过 |
| CLI Vitest files/tests | `14 files / 100 tests`，通过 |
| Granary Vitest files/tests | `24 files / 86 tests`，通过 |
| Mago lint | `No issues found` |
| Mago analyzer 历史基线 | `31,807` 项，P1 待治理，不属于当前 release 成功条件 |
| CLI/Granary lint、format、typecheck | CLI ESLint、Prettier、`tsc --noEmit` 通过；Granary oxlint 0 warning/0 error、`tsc -b` 通过 |
| Composer audit | 0 advisories |
| Firefly npm production/完整树 | production 0；完整树 19（9 low / 10 moderate / 0 high / 0 critical） |
| CLI/Granary npm audit | 0 / 0 |
| 生产构建和 Granary bundle | Firefly、Granary、backend-test 镜像和 CLI 构建通过；主 JS `409.31 KB`，gzip `132.07 KB` |
| empty-start | PostgreSQL、后端 HTTP、Granary HTTP、SMTP、IMAP 全部健康；退出码 0 并完成清理 |
| CLI 预算 CRUD 契约 | create/read/delete 及删除后不可读取通过 |
| Playwright 桌面/移动 | `22 passed / 0 failed`（桌面 12、移动 10），约 1.2 分钟 |
| 临时资源清理 | E2E/empty-start 容器、网络、卷无残留；Playwright last-run 为 passed、失败列表为空；`git diff --check` 通过 |
| `make release` | 2026-07-21 完整执行成功，最终退出码 0 |

第 10.3 节已全部关闭，P0 状态完成。第 10.2 节三项 P1 债务继续保留，不得因本次发布成功从目标文档中删除。

## 12. Granary 切换后的当前实现快照

本节只记录 2026-07-22 代码和测试可证明的实现事实，不承载产品范围、优先级或长期任务。产品方向仍以产品所有者维护的《谷仓产品方向》为唯一来源。

### 12.1 当前根目录入口

| 命令 | 当前职责 |
| --- | --- |
| `make up` | 启动 Firefly 迁移基线、Granary PostgreSQL、Rust Server、Granary Web 和本地合成邮箱 |
| `make up-server` | 只启动 Granary PostgreSQL、迁移、Rust Server 及其邮件依赖 |
| `make test-server` | 在独立临时 PostgreSQL 上运行 Rust 单元和集成测试 |
| `make test-web` | 在 Node 22 容器内运行 Granary Web Vitest |
| `make test-cli` | 在 Node 22 容器内运行现有 Firefly CLI 测试 |
| `make test-e2e` | 从空卷运行 Granary Session、多账本和核心账务浏览器验收 |
| `make test-empty-start` | 从空卷验证 Firefly 基线与 Granary 新链路均可启动且依赖健康 |
| `make config` | 展开 `test`、`e2e`、`granary` 和 `granary-test` profiles 并校验 Compose |

### 12.2 当前 E2E 拓扑和覆盖

当前 E2E 服务链为：

```text
e2e-db
  -> e2e-migrate
  -> e2e-server
  -> e2e-web
  -> Playwright
```

它不再启动 Firefly `e2e-app`，不再创建 PAT，不再运行旧 `cli-contract`，也不读取默认开发数据库。桌面与移动用例都从空数据库开始，覆盖首次初始化、邮箱密码登录、HttpOnly Session Cookie、刷新后的 CSRF 轮换、分类/交易方/账户/交易创建、总览与交易读取、第二账本创建与数据隔离、切回账本、退出和安全响应头。

当前同工作树证据：Rust fmt 和 Clippy 通过；Granary Web lint 通过、Vitest `85/85`、production build 通过；Compose E2E `2/2` 通过。E2E 实际发现过币种表字段 `exponent` 被错误读取为 `minor_units` 导致的 HTTP 500，并在修复后增加 PostgreSQL 集成断言，因此当前门禁验证了真实 Server/数据库契约，而不是只检查页面能否打开。

### 12.3 当前切换边界

- Granary Web 的 Session、账本、账户、交易、搜索、概览和分类/标签/交易方基础管理已接入 `granary-server`。
- `firefly-cli` 仍以 Firefly API 为目标，后续才切换到 Granary API。
- Firefly III 及其历史 E2E 证据继续作为迁移核对基线，不再是 Granary Web 当前运行后端。
- 生产迁移只能使用隔离的 PostgreSQL/storage 只读快照；真实 `.env`、dump、附件、OAuth key、Session、PAT、MFA seed 和密码不得进入仓库、CI 或测试产物。
