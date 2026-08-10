# abei-agent

阿贝的 AI 服务进程。它只做一件事：给 abei-web 提供 `/api/ai`——聊天流、会话、
人工审批、模型连接配置，外加账单预填与历史回填两个后台循环。

命令行已经由 abei-cli（二进制 `abei`）接管，这个包里不再有子命令，也不再有 MCP。
外部 AI 要用这套能力就装 abei-cli：对模型来说命令行比 MCP 省 token。

## 代码怎么分的

| 文件                | 管什么                                                 |
| ------------------- | ------------------------------------------------------ |
| `server.ts`         | 进程生命周期：装配依赖、起 HTTP、收摊                  |
| `routes.ts`         | `/api/ai` 路由表：认令牌、分发、错误翻译               |
| `chat.ts`           | 聊天流：一轮对话跑成 NDJSON 事件                       |
| `tools.ts`          | 按能力目录生成模型工具，confirm 档转成待人确认的审批   |
| `abei-api.ts`       | abei-api 客户端：取目录、按目录调用、带闸门参数        |
| `model-settings.ts` | 模型连接配置的解析与状态                               |
| `store.ts`          | PostgreSQL `abei_ai` schema 里的会话、审批、规则、建议 |
| `autofill.ts` 等    | 后台循环：账单预填、历史回填、词表扫描                 |

## 跑起来

```bash
npm install
npm run dev            # 跑源码
npm run build && node dist/main.js
```

可选参数：`--host`、`--port`、`--firefly-url`、`--abei-url`。默认值来自环境变量。

```bash
AI_PROVIDER=openai AI_MODEL=gpt-5.4-mini OPENAI_API_KEY=... \
FIREFLY_URL=http://127.0.0.1:18001 ABEI_API_URL=http://127.0.0.1:18002 \
npm run dev
```

| 环境变量                   | 默认值                   | 用途                                          |
| -------------------------- | ------------------------ | --------------------------------------------- |
| `AI_HOST` / `AI_PORT`      | `127.0.0.1` / `18003`    | 监听地址                                      |
| `ABEI_API_URL`             | `http://127.0.0.1:18002` | abei-api 地址，能力目录与能力调用都打这里     |
| `FIREFLY_URL`              | `http://127.0.0.1:18001` | Firefly 地址，用于识别当前用户和跑后台预填    |
| `DB_*`                     | 见 compose               | 会话与审批落在 PostgreSQL 的 `abei_ai` schema |
| `APP_KEY`                  | —                        | 加密存起来的模型凭证和后台 PAT                |
| `AI_PROVIDER` / `AI_MODEL` | `openai` / —             | 没有按用户保存配置时的兜底模型                |

Firefly 个人访问令牌由浏览器逐请求带上，服务端不持久化，只用来识别当前用户、
透传给 abei-api、以及执行本轮工具。

## 工具从哪来

启动后第一次用到时拉一次 abei-api 的 `GET /v1/catalog`，缓存五分钟，
按每条能力的 `tool_name` 和 `params` 直接生成模型工具，执行时按 `method` + `path`
打回 abei-api。**能力目录是唯一真源**，这边不再养第二份能力表：目录加一条能力，
助手就多一个工具，不用改代码。

## 写操作怎么落地

风险闸在 abei-api 服务端，这里只是如实把闸门参数带过去：

- `risk=read`：直接执行。
- `risk=draft`：直接执行，写进去的是草稿，会标成 AI 建议等人确认。
- `risk=confirm`：模型调用时只带 `dry_run=true` 拿预览，然后落一条待确认的审批停下来。
  真正执行只发生在人点了页面上的确认按钮之后，那一步才带 `confirm=true`。
  **模型拿不到 `confirm`。**

abei-api 回 409 `ConfirmationRequired` 时不当错误报，走同一条「等人确认」的路——
这条兜底是给目录缓存过期准备的。

账单密码这类只能由人填的参数（目录里用 `x-abei-human-only` 标着，目前是 `secret`）不出现在模型看到的参数模式里，
模型就算硬塞也会被丢掉；审批卡上的 `needs_user_input` 告诉页面该弹哪个输入框，
密码在审批那一次请求里经手，不进日志、不进对话。

## 接口

| 方法与路径                                                                  | 说明                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `GET /api/ai/health`                                                        | 探活，不需要令牌                                                                                 |
| `GET/PUT/DELETE /api/ai/config`                                             | 模型连接配置                                                                                     |
| `POST /api/ai/models`                                                       | 按填写的凭证列出可用模型                                                                         |
| `POST /api/ai/chat`                                                         | NDJSON 聊天流：`meta` / `text_delta` / `tool_start` / `tool_end` / `approval` / `done` / `error` |
| `GET /api/ai/sessions`、`GET /api/ai/sessions/{id}`                         | 会话列表与历史                                                                                   |
| `POST /api/ai/approvals/{id}`                                               | 人工确认或驳回，`user_input` 里带人填的参数                                                      |
| `GET/POST /api/ai/autofill-config`、`POST /api/ai/autofill/run`             | 账单预填                                                                                         |
| `POST /api/ai/backfill/run`、`GET /api/ai/backfill/suggestions`             | 历史回填与建议                                                                                   |
| `GET/PATCH/DELETE /api/ai/category-rules`、`POST /api/ai/category-feedback` | 纠正即学习的分类规则                                                                             |
| `GET/POST /api/ai/vocab-suggestions`                                        | 分类词表建议                                                                                     |

## 后台循环

`autofill` 按用户设置的周期跑：拉待处理账单，用规则和模型填空，写回时一律带
`as_suggestion`。它用的是用户自己存下来的 PAT，直连 Firefly——因为它要按任务翻
流水行，那是能力目录还没有的形状。目录补上以后这条路也该收进 abei-api。

## 提交前

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test:run
npm run build
```
