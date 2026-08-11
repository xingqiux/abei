# abei CLI 开发规范

> 状态：有效，按 2026-08-10 的工作区实现整理。
>
> 配套文档：[abei-api.md](./abei-api.md)。改动共享契约时，两份文档与测试必须一起更新。

本文规定 `abei-cli` 的命令形态、参数、输出、认证、风险状态和开发流程。能力清单、参数 schema、风险档与后端归属以 `abei-core` 为可执行真源；本文负责解释这些字段在 CLI 里的统一行为。实现与本文冲突时，不在调用点加特例，先修共同机制。

## 1. 定位与边界

`abei` 的第一批用户是 AI agent，同时也要让人能直接使用。设计顺序固定为：

1. agent 能稳定调用：命令可预测、参数严格、输出可解析、错误可分流。
2. 人能快速理解：默认人话、示例可复制、错误指出修法。
3. CLI 保持薄：业务校验和安全闸在 `abei-api`，CLI 只负责解析、请求和呈现。

CLI 只访问 `abei-api`，不直接访问 Firefly、`abei-server` 或数据库。CLI 不提供原始 HTTP 命令（2026-08-10 移除 `abei api`）：请求面只来自能力目录，未建模的接口走建模流程补能力，缺口用 `feedback` 反馈。

## 2. CLI 与 API 的共同契约

一条能力只定义一次：

| 契约 | `abei-core` | CLI 形态 | API 形态 |
| --- | --- | --- | --- |
| 稳定标识 | `resource.verb` | `abei <resource> <verb>` | OpenAPI `operationId` |
| 参数 | JSON Schema | 位置参数与 flags | GET query / 写请求 JSON body |
| 风险 | `read / draft / confirm` | `--dry-run`、`--yes` | `dry_run=true`、`confirm=true` |
| 后端 | `firefly / abei / server` | 对调用者透明 | API 内部分派 |
| 文案 | label、description、examples | `--help`、`explain`、`guide` | `/v1/catalog`、OpenAPI |

以下内容禁止在 CLI 另存一份：

- 资源和动词的翻译表。
- 参数名、必填关系、类型与字段说明。
- 能力风险档、后端归属和中文标签。
- 密码、验证码等“只能人填”的字段名单。
- 调用方不能修改的固定参数值。

CLI 可以拥有的本地契约只有两类：人类输出的稳定字段，以及 CLI 专属的查询语法。

## 3. 当前能力状态

当前目录共有 22 条能力：10 条 `read`、5 条 `draft`、7 条 `confirm`。16 条由 Firefly 执行，6 条反馈能力由 `abei-server` 执行，暂时没有 `backend=abei` 的能力。

| 资源 | 生成命令 | 风险 | 后端 |
| --- | --- | --- | --- |
| `transactions` | `list / show / summary / search` | read | firefly |
| `accounts` | `list` | read | firefly |
| `bills` | `list / show / review / import / unlock / ignore / retry / sync / process` | read / draft / confirm | firefly |
| `rows` | `update / split` | draft | firefly |
| `feedback` | `create / update / retry / delete / list / get` | confirm / read | server |

资源命令由目录生成。手写命令只有：

| 命令 | 用途 | 是否访问服务 |
| --- | --- | --- |
| 裸 `abei` | 当月汇总与资产账户概览 | 是 |
| `auth` | 登录、状态、退出 | login 是 |
| `explain` | 展开一个资源的能力与参数 | 否 |
| `guide` | 输出给 agent 的一页说明 | 否 |
| `completion` | 生成 shell 补全 | 否 |

新增账本或业务动作时，默认加目录能力，不加手写命令。只有不代表业务资源的工具命令才允许手写。

man 页属于发布产物，不进入用户或 agent 的命令树。开发者使用 `make man` 生成 `abei/target/man/abei.1`。

## 4. 命令命名

### 4.1 资源命令

固定形态是：

```text
abei <资源> <动词> [ID] [参数]
```

规则如下：

- 资源在前，动词在后：`abei transactions list`，不用 `abei list transactions`。
- 资源使用英文名词：`transactions`、`accounts`、`bills`、`rows`、`feedback`。
- 资源别名只用于输入宽容，例如 `tx`、`acc`、`bill`、`row`、`fb`；帮助和错误回显使用正名。
- 动词来自 `Verb` 固定表。同一资源不得同时暴露语义重复的 `get` 与 `show`。
- 作用于单个对象的能力把 `id` 放在位置参数：`abei bills show 42`。
- schema 标记 `x-abei-positional` 的必填字段也放在位置参数，目前是 `abei transactions search 星巴克`。
- 未知资源、动词、flag 和字段必须报错；能判断时给 did-you-mean。

当前 `show` 用于交易和账单，`get` 用于反馈。这是现有命名，不应继续扩散为同一资源的双轨。若统一动词，要一次硬切目录、CLI、API 与文档，不加兼容别名。

### 4.2 Flag 转换

schema 字段到 CLI flag 的默认转换是 snake_case 变 kebab-case：

```text
exclude_category -> --exclude-category
firefly_type      -> --firefly-type
```

少量纯展示缩写可以集中定义，例如 `labels -> --label`、`submitted_by -> --by`。不在各能力分支里散落改名。

参数类型统一映射：

| schema 类型 | CLI 形态 |
| --- | --- |
| string | `--name VALUE` |
| integer / number | 数字参数，本地先做类型检查 |
| boolean | 开关 flag |
| array of scalar | 同一 flag 重复多次 |
| array of object | 重复 `key=value,key=value`，或传完整 JSON 对象 |

对象数组示例：

```bash
abei rows split 7 \
  --splits amount=30.00,description=餐费,payment_method=余额 \
  --splits amount=15.00,description=餐费,payment_method=招行卡
```

值里含逗号时，改传完整 JSON；不要再发明一套转义语法。

### 4.3 固定参数与人填参数

- 调用方不能选择的值用目录的 fixed param 声明。CLI 隐藏该 flag，并在请求前注入固定值；当前 `feedback.create` 固定 `source=cli`。
- 密码、验证码等字段在 schema 标 `x-abei-human-only`。CLI 帮助必须标出“人填”，agent 不得生成这些值。
- 人填字段接受 `-` 从 stdin 读取，例如 `abei bills unlock 42 --secret - --yes`，避免进入 shell history。
- 固定参数与人填参数都属于目录契约，不允许用 capability id 的 if 分支复制名单。

## 5. 查询语法

带 `start` 和 `end` 的能力自动接受 hledger 风格的位置查询串：

```bash
abei tx list 餐饮 date:2026-07 amt:'>100' not:cat:房租
```

| 写法 | 含义 |
| --- | --- |
| 裸词 | 描述、账户或分类包含该文本 |
| `date:` | 年、月、日或闭区间 |
| `desc:` | 描述包含 |
| `acct:` / `account:` | 账户包含 |
| `cat:` / `category:` | 分类包含 |
| `cur:` / `currency:` | 币种相等 |
| `amt:` / `amount:` | 金额比较，支持 `>`、`>=`、`<`、`<=`、等于 |
| `not:` | 对紧随其后的一个条件取反 |

并列条件是“且”。比较号必须用引号包住，避免被 shell 当成重定向。

日期支持：

```text
date:2026
date:2026-07
date:2026-07-15
date:2026-07-01..2026-07-31
date:..2026-07-31
```

`date:` 转成 `start/end` 下推 API；其余条件目前在 API 返回的当页结果上本地过滤。发生本地过滤时，人类模式要在 stderr 说明过滤条数，机器模式保持安静。要做全账本文本检索，用 `transactions search`，不要把本地过滤误当全文搜索。

## 6. 全局参数

| 参数 | 语义 |
| --- | --- |
| `--url URL` | 覆盖 `ABEI_API_URL` 与配置文件 |
| `--token TOKEN` | 覆盖 `ABEI_TOKEN` 与本机令牌文件 |
| `--json` | 列出这条资源命令可投影的字段 |
| `--json=字段,字段` | 输出指定字段的 JSON；带字段时必须写等号 |
| `--jq EXPR` | 对 API 原始响应执行 jq 表达式 |
| `--month YYYY-MM` | 只用于裸 `abei` 的月份概览 |

`--json` 强制使用等号，是为了不吞掉后面的查询词：

```bash
abei tx list --json 餐饮            # 餐饮仍是查询词；输出字段清单
abei tx list --json=amount,category # 投影数据
```

## 7. 输出契约

### 7.1 通道

- 数据只写 stdout。
- 错误、进度、预览提示和本地过滤提示只写 stderr。
- TTY 可以有颜色和表格；管道输出必须稳定、无控制字符。
- `NO_COLOR` 等终端约定交给 `anstream`，不另造配置。
- 下游提前关闭管道是正常结束：`abei tx list | head` 不报错、不 panic。

### 7.2 三种机器输出

| 模式 | 输入对象 | 输出 |
| --- | --- | --- |
| 默认 | 摊平后的 rows | 人类表格或报表 |
| `--json=...` | 摊平后的 rows | 稳定字段投影 |
| `--jq` | API 原始响应 | jq 结果 |

裸 `--json` 返回字段名数组，让 agent 自发现。请求不存在的字段时退出 3，并列出合法字段。发布后的投影字段名是 CLI 对外契约；改名必须视为破坏性改动。

为新能力增加专门的 normalize 分支，只在默认 generic 输出不能形成稳定、可读行时做。不要为“可能以后会用”预先定义整套字段。

### 7.3 预览

API 返回 `dry_run: true` 时，CLI 必须在 stderr 明确写“这是预览，没有真的改数据”，并提示把 `--dry-run` 换成 `--yes`。该提示不得进入 JSON 数据管道。

## 8. 统一风险状态

风险档描述的是能力语义，不是 HTTP 方法：

| 风险 | 含义 | CLI 行为 | API 强制规则 |
| --- | --- | --- | --- |
| `read` | 不改变任何状态 | 不显示写闸门 flags | 直接执行 |
| `draft` | 写草稿、建议或可重跑任务 | 可直接执行；支持 `--dry-run`，`--yes` 可选 | 不要求 `confirm=true` |
| `confirm` | 正式入账、忽略待办、提交密码等需要人确认的动作 | 无 `--yes` 或 `--dry-run` 时退出 6 | 无 `confirm=true` 或 `dry_run=true` 时返回 409 |

共同规则：

- 所有 `draft` 和 `confirm` 能力都必须有真实的 dry-run 语义；不能只接受参数后照常写入。
- `dry_run` 与 `confirm` 同时出现时，`dry_run` 优先，永远走不落库的一侧。
- CLI 的 `--yes` 不是安全边界；真正的 `confirm` 闸在 API。
- `draft` 不得因为调用方带了 `--yes` 就升级成正式写入。
- 敏感输入不得出现在响应、错误、日志或预览里。

`feedback.create` 的 dry-run 在拥有数据库和 GitHub 副作用的 `abei-server` 内执行：完成参数校验后直接返回预览，不连接数据库，也不创建 GitHub issue。

### 8.1 反馈生命周期

反馈的业务状态与 GitHub 同步状态分开：

| 字段 | 值 | 回答的问题 |
| --- | --- | --- |
| `status` | `open / planned / started / completed / declined / duplicate` | 产品上处理到哪一步 |
| `sync_status` | `local / synced / failed` | 当前快照是否同步到 GitHub |

CLI 工作流：

```bash
# 提交会写数据库，并可能创建 GitHub issue，所以必须确认
abei feedback create --title '提示不清楚' --body '...' --kind friction --by codex --yes

# 标记解决；completed / declined 必须留下处理说明
abei feedback update 42 --status completed --response '已在 0.2.0 修复' --yes

# 重开
abei feedback update 42 --status open --yes

# 标记重复时必须指出原反馈
abei feedback update 42 --status duplicate --duplicate-of 17 --yes

# GitHub 同步失败后显式重试
abei feedback retry 42 --yes

# 删除必须说明原因；服务端软删除并保留审计事件
abei feedback delete 42 --reason '包含个人隐私' --yes
```

`update / retry / delete` 只允许 Firefly `owner`。`submitted_by` 只是“这条反馈由谁或哪个 AI 提交”的展示归因，不用于授权；处理人与删除人的审计身份来自 PAT 验证结果。关联了 GitHub issue 的删除会先删除外部 issue；GitHub 配置缺失或删除失败时，本地反馈不会假装删除成功。

### 8.2 CLI 写入链路

CLI 没有一套隐藏的写入 API。一次写操作固定经过：

```text
abei-core risk/schema
  -> tree.rs 生成命令和参数
  -> hooks.rs 做本地 --yes / --dry-run 提示
  -> client.rs 把参数放 JSON body，把闸门放 query
  -> abei-api / abei-server 再做认证、校验和服务端闸门
  -> 具体后端执行
```

本地 `--yes` 只负责阻止误敲，并转换为 `confirm=true`；安全边界始终在服务端。agent 只能拿到 catalog 中明确建模的能力，`confirm` 能力先 dry-run 并进入人工审批，模型本身不能发送 `confirm=true`。`fixed_params` 不进入模型 schema，调用时由客户端强制注入且覆盖模型输入。

## 9. 认证与配置

地址优先级：

```text
--url > ABEI_API_URL > XDG 配置文件 > http://127.0.0.1:18002
```

令牌优先级：

```text
--token > ABEI_TOKEN > 本机令牌文件
```

约定如下：

- 地址写入配置目录的 `config.json`，Firefly PAT 写入同目录的 `token` 文件。
- 配置目录默认是 XDG 的 `abei/`；`ABEI_CONFIG_DIR` 可以整体覆盖，供测试与多环境使用。
- Unix 上令牌文件必须是 0600；重写已有文件时也要把过宽权限收回 0600。
- 不用系统钥匙串：本地开发反复重编译会触发新的二进制授权，影响开发流程。
- agent、CI 与无状态环境优先使用 `ABEI_TOKEN`，绕开磁盘配置。
- `abei auth login` 先检查 `/health`，再用令牌读取 `/v1/catalog`；两步都成功才保存。
- `abei auth status` 只显示脱敏令牌。
- `abei auth logout` 只删除 `token` 文件，不删除 API 地址。
- `abei auth login --token -` 从 stdin 读 PAT。

未配对且处于人类 TTY 时，CLI 可以打开 `<web_url>/settings?pair=1`。`web_url` 优先取 `ABEI_WEB_URL`，否则读 API `/health`。存在 `CI`、`ABEI_NO_BROWSER` 或非 TTY 时绝不打开浏览器。

## 10. 错误与退出码

人类模式在 stderr 输出一句可执行的人话，并保留服务端 `reason`。机器模式在 stderr 输出 problem JSON；服务端错误原样保留，再补 `exit` 字段。

| 码 | 含义 | agent 行为 |
| --- | --- | --- |
| 0 | 成功 | 继续 |
| 1 | 通用失败 | 读 `reason/detail`，不要盲目重试 |
| 2 | 用户中断 | 需要时重试 |
| 3 | 参数或用法错误 | 修参数后重试 |
| 4 | 未认证或令牌失效 | 重新配对或换令牌 |
| 5 | API 或上游不可达 | 稍后重试或检查服务 |
| 6 | confirm 能力缺人工确认 | 展示确认；人同意后补 `--yes` |

不得用中文文本决定退出码。服务端错误由稳定 `reason` 映射；本地 clap、查询解析和连接错误映射到同一组退出码。

## 11. 代码职责

| 文件 | 只负责什么 |
| --- | --- |
| `app.rs` | 根命令、全局参数、分发与退出流程 |
| `tree.rs` | 目录 schema 到 clap 命令树与参数对象 |
| `client.rs` | 能力到 HTTP 请求；GET query、写 body、闸门 query |
| `hooks.rs` | 输出模式、预览提示与本地确认闸 |
| `normalize.rs` | API 响应到稳定 rows |
| `render.rs` | 人类表格与汇总报表 |
| `query.rs` | CLI 查询语法与本地过滤 |
| `error.rs` / `exit.rs` | problem、错误文案与退出码 |
| `config.rs` / `commands/auth.rs` | 配置目录、令牌文件与配对命令 |
| `commands/docs.rs` | 从目录生成 explain 与 guide |

跨文件规则放在最靠近共同入口的位置。不要给每条能力各写一套请求、闸门或输出代码。

## 12. 新增或修改能力

按这个顺序做：

1. 在 `abei-core/src/params.rs` 定义参数类型，保留 `deny_unknown_fields`，写清字段说明。
2. 在目录声明资源、动词、风险、后端、标签、说明和至少一个可执行示例。
3. 需要位置参数、人填参数或固定参数时，在目录/schema 建模，不在 CLI 写 capability id 特例。
4. 在 `abei-api` 实现并挂载对应路由，先保证服务端校验、风险闸和 dry-run。
5. 运行目录示例解析测试，确认帮助里的命令能复制执行。
6. 只有响应需要稳定人类表格时，才在 `normalize.rs` 增加最小分支。
7. 为跨层行为留一条端到端测试：命令解析、HTTP 请求、API 路由和输出至少贯通一次。
8. 重新生成 `abei/openapi.json`，再跑质量门。

## 13. 验收门

在 `abei/` 下运行：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

CLI 改动至少确认：

- 正名和别名到达同一能力。
- `--help` 中的示例能解析。
- 未知字段严格失败并给出合法字段。
- 人类输出与机器输出不互相污染。
- confirm 缺 `--yes` 退出 6；dry-run 不写入；`--yes` 变成 `confirm=true`。
- problem `reason` 正确映射退出码。
- 敏感字段不回显，`-` 能从 stdin 读取。
- broken pipe 正常退出。

## 14. 禁止事项

- 不从 CLI 直连 Firefly、`abei-server` 或数据库。
- 不提供 `api` 之类的原始 HTTP 命令；任何请求面必须来自能力目录。
- 不为业务资源写手工子命令绕过目录。
- 不按 capability id 复制风险闸、参数名单或后端分派。
- 不静默忽略未知字段、未知 JSON 投影或查询语法错误。
- 不把人类提示写进 stdout。
- 不把 `--jq` 改成作用于摊平行。
- 不把 PAT、密码、验证码写入日志、配置文件、错误或 shell 示例。
- 不为旧命令或旧字段加兼容层；需要改名时一次硬切并更新测试与文档。
