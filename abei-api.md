# abei API 开发规范

> 状态：有效，按 2026-08-10 的工作区实现整理。
>
> 配套文档：[abei-cli.md](./abei-cli.md)。改动共享契约时，两份文档与测试必须一起更新。

本文规定 `abei-api` 的路由、参数、认证、风险状态、错误、后端分派和开发流程。能力清单、参数 schema、风险档与后端归属以 `abei-core` 为可执行真源；OpenAPI 是导出产物，不是真源。

## 1. 定位与边界

`abei-api` 是 CLI、web、agent 与未来移动端的统一服务入口。这里的“统一”不等于把任意 HTTP API 交给 agent：agent 只能看到能力目录中经过建模的窄接口，不能获得原始路径、方法或通用 HTTP 调用能力。

`abei-api` 不是无逻辑反代，必须统一承担：

- 能力目录与稳定路由。
- Bearer 认证。
- 输入校验与严格字段检查。
- `read / draft / confirm` 风险状态。
- dry-run 与正式确认。
- RFC 9457 problem+json。
- Firefly 与 `abei-server` 的执行分派。
- OpenAPI 导出与请求追踪。

过渡期账本能力由 Firefly 执行，反馈能力由 `abei-server` 执行。CLI 和 agent 只知道能力契约，不知道后端地址，也不能拼任意 API 请求。后端迁移只能改 API 内部和目录的 `backend`，不得要求客户端换路径。

`abei-api` 不缓存、不镜像 Firefly 账目。自己的状态只保存自己产生的数据；当前 API 进程只缓存短期令牌校验结果。

## 2. CLI 与 API 的共同契约

| 契约 | `abei-core` | CLI 形态 | API 形态 |
| --- | --- | --- | --- |
| 稳定标识 | `resource.verb` | `abei <resource> <verb>` | OpenAPI `operationId` |
| 参数 | JSON Schema | 位置参数与 flags | GET query / 写请求 JSON body |
| 风险 | `read / draft / confirm` | `--dry-run`、`--yes` | `dry_run=true`、`confirm=true` |
| 后端 | `firefly / abei / server` | 对调用者透明 | handler 内部分派 |
| 文案 | label、description、examples | help、explain、guide | catalog、OpenAPI |

以下内容只有一份：

- `resource` 与 `verb` 直接计算 capability id、CLI 命令、agent 工具名和 HTTP 路由。
- 参数结构由 Rust 类型与 schemars 生成；所有消费者读同一份 schema。
- 风险档与后端归属写在能力目录，不在路由层复制清单。
- `x-abei-human-only`、`x-abei-positional` 与 fixed params 是通用机制，不是客户端特例。
- 中文标签、说明和示例来自目录。

## 3. 请求处理顺序

一条受保护的能力请求按以下顺序处理：

```text
request id / trace
  -> Bearer token 提取与校验
  -> 路由匹配
  -> path/query/body 解析
  -> 通用与领域校验
  -> 风险闸门
  -> backend 调用
  -> JSON 成功响应或 problem+json
```

实际 handler 可以先校验 path id 再检查闸门，让无效 id 得到明确的 400；但任何外部副作用必须发生在校验和闸门之后。

## 4. 路由与方法

### 4.1 系统路由

| 路径 | 鉴权 | 用途 |
| --- | --- | --- |
| `GET /health` | 否 | 存活、版本、配对页 `web_url` |
| `GET /v1/openapi.json` | 否 | OpenAPI 3.1 导出 |
| `GET /v1/catalog` | 是 | 完整能力目录 |

除 `/health` 与 `/v1/openapi.json` 外，当前所有路由都必须经过认证中间件。内部 web 迁移代理不属于系统公开接口，约束见 11.2。

### 4.2 能力路由

路由由 `resource`、`verb`、`Target` 和 `Method` 计算：

| 动词类型 | 集合 | 单项 |
| --- | --- | --- |
| CRUD | `/v1/{resource}` | `/v1/{resource}/{id}` |
| 意图动词 | `/v1/{resource}/{verb}` | `/v1/{resource}/{id}/{verb}` |

方法固定：

| 动词 | HTTP 方法 |
| --- | --- |
| `list / get / show / summary / search / review` | GET |
| `create / import / ignore / retry / sync / process / unlock / split` | POST |
| `update` | PATCH |
| `delete` | DELETE |

集合级静态路径必须在 `/{id}` 前挂载，例如 `/v1/transactions/search` 和 `/v1/bills/sync`，防止被当成 id。

`get` 与 `show` 都表示读取单项，不能在同一资源同时存在，否则会生成相同方法和路径。当前交易与账单使用 `show`，反馈使用 `get`；新增资源先选一个，不造双轨。

### 4.3 参数位置

| 参数 | HTTP 位置 |
| --- | --- |
| 单项 `id` | path |
| GET 业务参数 | query |
| 写业务参数 | JSON body |
| `dry_run` / `confirm` | query |

GET 数组参数通过重复 key 表达，例如：

```text
?exclude_category=房租&exclude_category=信用借还
```

写能力的共享 schema 里可以要求 `id`，API 的 `ValidJson` 会用 path 参数补齐后再反序列化：

- 空 body 按 `{}` 处理。
- body 也带 `id` 时，以 path 为准。
- OpenAPI request body 必须删除 `id`，避免客户端被要求重复传值。

## 5. 当前能力状态

当前共有 22 条目录能力：10 条 `read`、5 条 `draft`、7 条 `confirm`。

| capability | 方法与路径 | 风险 | 后端 |
| --- | --- | --- | --- |
| `transactions.list` | `GET /v1/transactions` | read | firefly |
| `transactions.show` | `GET /v1/transactions/{id}` | read | firefly |
| `transactions.summary` | `GET /v1/transactions/summary` | read | firefly |
| `transactions.search` | `GET /v1/transactions/search` | read | firefly |
| `accounts.list` | `GET /v1/accounts` | read | firefly |
| `bills.list` | `GET /v1/bills` | read | firefly |
| `bills.show` | `GET /v1/bills/{id}` | read | firefly |
| `bills.review` | `GET /v1/bills/{id}/review` | read | firefly |
| `bills.import` | `POST /v1/bills/{id}/import` | confirm | firefly |
| `bills.unlock` | `POST /v1/bills/{id}/unlock` | confirm | firefly |
| `bills.ignore` | `POST /v1/bills/{id}/ignore` | confirm | firefly |
| `bills.retry` | `POST /v1/bills/{id}/retry` | draft | firefly |
| `bills.sync` | `POST /v1/bills/sync` | draft | firefly |
| `bills.process` | `POST /v1/bills/process` | draft | firefly |
| `rows.update` | `PATCH /v1/rows/{id}` | draft | firefly |
| `rows.split` | `POST /v1/rows/{id}/split` | draft | firefly |
| `feedback.create` | `POST /v1/feedback` | confirm | server |
| `feedback.update` | `PATCH /v1/feedback/{id}` | confirm | server |
| `feedback.retry` | `POST /v1/feedback/{id}/retry` | confirm | server |
| `feedback.delete` | `DELETE /v1/feedback/{id}` | confirm | server |
| `feedback.list` | `GET /v1/feedback` | read | server |
| `feedback.get` | `GET /v1/feedback/{id}` | read | server |

`backend` 表示当前执行归属，不表示成熟度。能力是否可发布，以路由、校验、风险闸、dry-run、错误形状和端到端测试全部通过为准。

## 6. 统一风险状态

| 风险 | 语义 | API 行为 |
| --- | --- | --- |
| `read` | 不改变任何状态 | 不读取闸门参数，直接执行 |
| `draft` | 写草稿、建议或可重跑任务 | 默认可执行；必须支持 `dry_run=true` |
| `confirm` | 正式入账、忽略待办、提交密码、提交或处理反馈等人工确认动作 | 缺 `confirm=true` 且非 dry-run 时返回 409 |

写能力统一接受：

```text
dry_run=true  只校验和预览，不产生外部副作用
confirm=true  明确执行 confirm 能力
```

共同规则：

- 两者同时为 true 时，dry-run 优先。
- dry-run 成功响应必须带顶层 `dry_run: true`。
- dry-run 不能只跳过本地写入，却仍触发上游邮件、GitHub issue、密码提交或其它副作用。
- `draft` 不要求 confirm；调用方多传 confirm 也不能改变能力语义。
- `confirm` 闸必须在 API，不能只依赖 CLI 或 web。
- 新增写能力前先实现预览；没有可信预览就不能声称支持 `--dry-run`。

Firefly 写能力使用统一 Gate。全部 feedback 写能力的 Gate 与 dry-run 在拥有数据库和 GitHub 副作用的 `abei-server` 内落实；`abei-api` 负责验证 PAT、注入可信身份并安全代理。代理边界不能削弱服务端闸门。

## 7. 输入校验

### 7.1 Schema 规则

参数类型放在 `abei-core/src/params.rs`：

- 所有对象保留 `#[serde(deny_unknown_fields)]`。
- 字段说明写在 Rust doc 上，由 schemars 进入目录和 OpenAPI。
- 可选值、长度和跨字段约束不能只写说明，API handler 必须执行校验。
- schema 在 core 统一展开 `$ref`，对外不留 `$defs`；客户端不各自做解引用。
- 密码、验证码等字段标 `x-abei-human-only`。
- CLI 位置参数标 `x-abei-positional`，一条能力最多一个且必须必填。

### 7.2 通用校验

当前公共规则：

| 项目 | 规则 |
| --- | --- |
| id | 正整数，不接受 0、负数、前导 0 或非数字 |
| 日期 | `YYYY-MM-DD`，月 1-12、日 1-31 |
| page | 从 1 开始 |
| limit | 1-100 |
| enum | 明确列出允许值 |
| 搜索词 | 非空，最多 500 字 |
| 拆分 | 2-20 笔，每笔金额为正数且最多 8 位小数 |

错误必须指出字段、收到的值和允许范围。不要把可在 API 边界发现的问题交给上游返回含糊的 422。

### 7.3 受保护字段

- `rows.update` 只允许“这笔该怎么记”的建议字段，不允许修改银行原文。
- `rows.update` 服务端强制 `as_suggestion=true`，调用方不能关闭。
- `bills.unlock` 的 secret 只在正式请求中转发；dry-run 不把 secret 发送上游，也不回显。
- 请求体与 Authorization 不进入日志。
- 固定来源等客户端政策在目录声明；API 仍要校验直接调用者传入的值。
- `submitted_by` 只表示反馈由谁提交，不参与授权；处理权限和审计 actor 必须来自已验证 PAT。

## 8. 认证

认证使用 Firefly 个人访问令牌：

```http
Authorization: Bearer <PAT>
```

流程如下：

1. 严格解析 Bearer scheme，scheme 大小写不敏感，空令牌拒绝。
2. 调 Firefly `GET /api/v1/about/user` 验证令牌。
3. 成功结果缓存 60 秒，减少每个请求都打一次 Firefly。
4. 缓存达到 256 条时清理过期项；这是清理阈值，不是持久存储。
5. 把令牌与已验证用户的标识、角色放入 request extension；Firefly handler 只取令牌，反馈代理只取身份。

API 不签发令牌、不保存密码、不把 PAT 发给 `abei-server`。反馈代理必须剥掉 `Authorization`，只保留统一入口的认证结果。

令牌撤销最多受 60 秒缓存窗口影响。除非有明确安全需求，不增加第二套 session、JWT 或用户表。

## 9. 成功响应与状态码

建模能力默认返回 JSON。不要为了统一外观改写有意义的成功状态：

- 普通读取和同步执行通常是 200。
- `bills.sync` 可以保留上游 202 Accepted。
- `feedback.create` 保留 `abei-server` 的 201 Created。
- 空上游成功响应可以规范化为 JSON `null`。

Firefly 建模接口可以保留上游数据体；API 自己计算的 `transactions.summary` 使用自己的稳定响应。任何被 CLI 投影、web 类型或 agent 依赖的字段都属于契约，不能无测试改名。

## 10. 错误契约

建模接口错误统一使用 `Content-Type: application/problem+json`：

```json
{
  "type": "https://abei.local/problems/invalid-params",
  "title": "参数不对",
  "status": 400,
  "reason": "InvalidParams",
  "detail": "limit 只能是 1 到 100，收到的是 200。",
  "resource": "transactions",
  "verb": "list"
}
```

字段规则：

- `type`、`title`、`status`、`reason` 必填。
- `reason` 是稳定的驼峰机读码；客户端按它分流，不解析 `detail`。
- `detail` 给人和 agent 修正请求。
- 能力错误尽量带 `resource` 与 `verb`。
- `upstream` 只用于有限排障，不得包含令牌、密码或完整敏感请求。

当前码表：

| HTTP | reason | 含义 |
| --- | --- | --- |
| 400 | `InvalidParams` | 参数、类型、边界或组合不合法 |
| 400 | `InvalidDate` | 日期格式不合法 |
| 401 | `MissingToken` | 缺 Bearer PAT |
| 401 | `InvalidToken` | Firefly 拒绝 PAT |
| 403 | `Forbidden` | 已认证，但不是允许处理反馈的 owner |
| 404 | `NotFound` | 资源或路由不存在 |
| 409 | `ConfirmationRequired` | confirm 能力缺确认 |
| 409 | `Conflict` | 当前外部同步配置或资源状态不允许该操作 |
| 502 | `UpstreamError` | Firefly 返回非预期错误 |
| 502 | `ServerUnavailable` | 反馈服务不可用 |
| 503 | `UpstreamUnavailable` | 无法连接 Firefly |
| 500 | `Internal` | API 内部错误 |

Firefly 422 映射为 400 `InvalidParams`，并保留安全的上游说明。401/403 统一映射为 `InvalidToken`。

内部 web 迁移代理会保留 Firefly 原始状态、header 和响应流；反馈代理保留 `abei-server` 响应。这两处的上游错误格式由其拥有者保持 problem+json，反馈参数错误统一为 400 `InvalidParams`。

## 11. 后端与代理

| backend | 含义 |
| --- | --- |
| `firefly` | Firefly 仍拥有执行与数据 |
| `abei` | abei-api 自己实现；当前目录尚无此归属 |
| `server` | 独立 `abei-server` 执行 |

### 11.1 Firefly 建模接口

建模 handler 负责把阿贝参数转换成 Firefly 请求、执行阿贝校验，并把错误收进统一 problem。转换只能存在 API handler，不进入 CLI、web 或 agent。

`transactions.summary` 虽从 Firefly 拉数据，但聚合逻辑在 API；目录当前仍标 `firefly`，表示数据与主要执行来源尚未迁出。

### 11.2 内部 Firefly 迁移代理

`/v1/firefly/{*path}` 是已有 web 页面迁移期间的内部实现，不是产品 API，也不是能力：

- 保留方法、query、body 和端到端响应流。
- 剥掉逐跳 header、Host、Content-Length 和调用方 Authorization。
- 使用已验证的 PAT 重新设置上游 Authorization。
- 请求体上限 16 MiB。
- 不进入 `/v1/catalog`、OpenAPI、`abei help`、`abei guide` 或 agent 工具 schema。
- CLI 不提供 `abei api`、任意 path、任意 method 或任意 body 的入口。
- 唯一合法调用方是当前 `abei-web` 中尚未迁完的既有页面；不得新增 CLI、agent、移动端或第三方调用方。
- 它绕过能力建模、字段校验和风险闸，因此不能视为安全边界。每迁完一个域就删除对应调用，全部清零后删除路由。

### 11.3 反馈代理

`/v1/feedback` 与 `/v1/feedback/{id}` 代理到 `ABEI_SERVER_URL`：

- `abei-api` 负责入口认证，`abei-server` 不接收 Firefly PAT。
- `abei-api` 从 Firefly 的 `/about/user` 取得已验证的用户标识与角色，用内部 header 传给 `abei-server`；调用方同名 header 会被覆盖。
- 容器部署中 `abei-server` 不发布宿主端口，也不与 agent 共享网络；只有 `abei-api` 与数据库位于它的内部网络。
- 请求体上限 2 MiB。
- 网络失败映射为 502 `ServerUnavailable`。
- 业务状态和响应由 `abei-server` 保留。
- 风险闸和 dry-run 仍必须在拥有副作用的一层落实，不能因为是代理而跳过。

### 11.4 Feedback 生命周期

业务处理状态与外部同步状态必须分开：

| 字段 | 允许值 | 语义 |
| --- | --- | --- |
| `status` | `open / planned / started / completed / declined / duplicate` | 产品处理进度 |
| `sync_status` | `local / synced / failed` | 当前快照与 GitHub 的同步结果 |

规则如下：

- create 初始状态是 `open`；它会写数据库并可能创建 GitHub issue，因此是 `confirm`，不是 `draft`。
- update 改为 `open` 表示重开；`completed`、`declined` 必须填写给提交者看的 `response`；`duplicate` 必须填写另一个有效的 `duplicate_of`。
- update、retry、delete 只允许已验证的 Firefly `owner`。请求体里的 `submitted_by` 不能授予权限。
- 每次创建、状态变化、同步重试和删除都追加到 `feedback_events`；事件只追加，不覆盖历史 actor、状态和说明。
- delete 必须填写原因并采用软删除。关联 GitHub issue 时先删除外部 issue；外部删除失败时不得把本地记录标成已删除。
- GitHub 创建或更新失败时保留本地反馈，把 `sync_status` 置为 `failed` 并保存安全截断后的错误；owner 通过 retry 显式重试。
- get 返回当前反馈与按时间排列的审计事件；list 默认排除软删除记录，并支持按业务状态、同步状态和类型筛选。

### 11.5 设计依据

Feedback 没有自造一套状态词：

- 开源项目 [getfider/fider](https://github.com/getfider/fider) 的 [Posts API](https://docs.fider.io/api/posts) 使用 `open / planned / started / completed / declined / duplicate`，处理结果有 response，duplicate 指向原反馈，删除要求原因。阿贝沿用这组清晰语义，同时把 GitHub 同步结果拆成独立字段，避免“同步失败”伪装成“业务未处理”。
- 开源项目 [cli/cli](https://github.com/cli/cli) 的 [issue close](https://cli.github.com/manual/gh_issue_close) 把关闭原因和 comment 显式化，[issue reopen](https://cli.github.com/manual/gh_issue_reopen) 是独立动作，[issue delete](https://cli.github.com/manual/gh_issue_delete) 默认要求确认。阿贝对应为显式 status/response、改回 open 重开，以及 confirm + reason 的删除。

当前没有加入评论线程、投票、合并反馈 UI 或复杂工作流配置；已有状态、说明、审计、软删除和同步重试足以闭合“提交 -> 处理 -> 通知结果 -> 重开/删除”的主流程。

## 12. 能力目录与 OpenAPI

### 12.1 `/v1/catalog`

目录返回 version、resources 和 capabilities。每条 capability 至少包括：

```text
id, resource, verb, risk, backend,
label, description, method, path,
tool_name, command, human_only, fixed_params,
examples, params
```

`fixed_params` 是参数名到固定字符串值的对象，例如 `feedback.create` 返回 `{ "source": "cli" }`。动态 CLI 和 agent 必须隐藏这些模型输入，并在调用前自动注入；不得要求模型猜测或填写。

CLI 与 API 在同一 Rust workspace 内直接共享 `abei-core`。web 与 agent 运行时读取 `/v1/catalog`。目录当前需要认证，因为它位于受保护路由组。

Agent 侧还必须满足：只从 catalog 生成工具；fixed params 不进入模型 schema 且调用时强制覆盖；`confirm` 工具只能先 dry-run 并形成待人工审批，模型调用本身不能发送 `confirm=true`。人工审批端点才可执行确认请求。

### 12.2 OpenAPI

OpenAPI 3.1 从目录生成并签入 `abei/openapi.json`，用途是 web 端代码生成和契约检查。生成命令：

```bash
cd abei
cargo run -p abei-api -- --dump-openapi openapi.json
```

规则如下：

- `operationId` 等于 capability id。
- 写参数进入 request body，id 保留 path，闸门参数保留 query。
- 风险与后端分别写入 `x-abei-risk`、`x-abei-backend`。
- `human-only` 等 schema 扩展不得丢失。
- 签入文件必须字节级与代码生成结果一致。
- OpenAPI 不是修改入口；不要手改 JSON。

当前成功响应 schema 仍是通用 object，只能可靠生成请求侧类型。需要生成响应侧强类型时，再为真实稳定响应补 schema，不预先为透传数据造一套镜像模型。

## 13. 配置、超时与生命周期

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ABEI_API_HOST` | `127.0.0.1` | 监听地址 |
| `ABEI_API_PORT` | `18002` | 监听端口 |
| `FIREFLY_URL` | `http://127.0.0.1:18001` | Firefly 地址 |
| `ABEI_WEB_URL` | `http://127.0.0.1:18004` | `/health` 公布的配对页来源 |
| `ABEI_SERVER_URL` | `http://127.0.0.1:18005` | 反馈服务地址 |
| `ABEI_LOG` | `info` | tracing 过滤级别 |

URL 读取时去掉末尾 `/`，空值启动失败。Firefly 与 `abei-server` HTTP 客户端超时均为 30 秒。

每个请求设置并向下游响应传播 `x-request-id`，HTTP trace 走 `TraceLayer`。不得记录 Authorization 和请求体。进程收到 Ctrl+C 或 SIGTERM 时优雅停机。

## 14. 代码职责

| 文件 | 只负责什么 |
| --- | --- |
| `lib.rs` | 路由挂载、中间件与公开/受保护分组 |
| `auth.rs` | Bearer 提取与认证中间件 |
| `extract.rs` | query/body 解析、通用校验与 Gate |
| `problem.rs` | problem+json 与稳定 reason 码表 |
| `state.rs` | 共享客户端与短期令牌缓存 |
| `firefly.rs` | Firefly HTTP、错误映射与透传 |
| `routes/*.rs` | 每个资源的转换和领域校验 |
| `summary.rs` | 交易汇总纯逻辑与翻页读取 |
| `openapi.rs` | 从目录导出 OpenAPI |
| `testkit.rs` | API 与 CLI 共用的假 Firefly |
| `main.rs` | 配置、监听、日志、OpenAPI dump 与停机 |

通用行为只放一处：参数提取进 extractor，错误进 Problem，Firefly HTTP 进 Firefly，风险判断进 Gate。资源 handler 不复制这些机制。

## 15. 新增或修改能力

按这个顺序做：

1. 在 `abei-core/src/params.rs` 定义参数，保留严格字段检查和字段说明。
2. 在 catalog 声明 resource、verb、risk、backend、label、description、examples。
3. 检查自动推导的 capability id、HTTP method、route path、CLI command 与 tool name。
4. 在对应 `routes/*.rs` 实现 handler；先校验，再 Gate，再调用后端。
5. 在 `lib.rs` 挂载推导出的同一方法和路径，静态意图路由放在 `/{id}` 前。
6. 写能力实现真实 dry-run；confirm 能力验证无确认时没有上游调用。
7. 错误用 `Problem` 并补 `resource/verb`；不得返回临时 JSON 错误形状。
8. 加最小的路由/校验/副作用测试，并让全目录路由漂移测试覆盖它。
9. 确认 CLI 命令自动生成；只有输出不适合 generic rows 时才补 normalize。
10. 重新生成 `openapi.json`，跑三道质量门。

## 16. 验收门

在 `abei/` 下运行：

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
```

API 改动至少确认：

- `/health` 与 OpenAPI 免鉴权，其余路由需要 PAT。
- 目录每条能力都有正确方法和实际挂载路由。
- GET 参数在 query，写参数在 body，id 在 path。
- 未知字段、无效 id、日期、enum 和分页边界在 API 层失败。
- draft 可直接执行；confirm 无确认返回 409 且零上游调用。
- dry-run 带顶层标记且零外部副作用。
- 敏感字段不进日志、响应、错误和预览。
- Firefly、server 与内部错误都映射到稳定 problem reason。
- feedback 的业务状态、同步状态和审计事件互不混用；owner 权限取自验证身份。
- catalog 与 OpenAPI 不包含内部 Firefly 迁移代理；agent 无法构造任意 API 请求。
- `openapi.json` 与代码一致。

## 17. 禁止事项

- 不让客户端绕过 abei-api 直连后端。
- 不把原始 HTTP、内部迁移代理或 OpenAPI 操作包装成 CLI/agent 能力。
- 不手写 resource/verb 到路径的翻译表。
- 不在多个 handler 复制闸门、认证、错误或 HTTP 客户端。
- 不静默忽略未知字段。
- 不把 dry-run 实现成“接受参数但照常写入”。
- 不在日志、problem `upstream` 或 tracing field 中放令牌、密码、验证码和完整请求体。
- 不把 Firefly 账目复制成第二份本地真相。
- 不手改 `openapi.json`。
- 不为旧路径、旧字段或旧错误格式加兼容层；需要改变时一次硬切代码、客户端、测试与文档。
