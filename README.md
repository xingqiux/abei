# 阿贝 / abei

个人记账系统。Firefly III 是后端引擎，`abei-api` 是统一账本 API 面；前端和命令行的
账本数据、AI agent 的能力调用都经它访问 Firefly III。

## 目录结构

- `abei/`: Rust workspace。`abei-core` 放能力目录，`abei-api` 是统一 API 面（:18002），`abei-server` 负责邮箱收取和反馈（:18005），`abei-cli` 是命令行 `abei`。
- `abei-web/`: 前端界面。账本数据走 abei-api，AI 流式接口走 abei-agent。
- `abei-agent/`: AI 服务进程（:18003），只提供 `/api/ai`。工具清单从 abei-api 的能力目录生成；命令行归 abei-cli，MCP 已删除。
- `firefly-iii/`: 后端引擎。保留账单下载、解密、解析和入账；邮箱收取、MIME/EML 与附件落盘已迁到 Rust。

曾经的自研 Rust 账本后端 granary-server（2026-07 封存）已于 2026-08 删除，代码在 git 历史里；它的位置将来由 `abei-server` 接替。

## 本地开发与测试

根目录是唯一入口，需要 Make、Docker Compose v2；`make dev` 另需本机装 PHP、Composer 与 Rust。

```bash
make dev          # db/mail 容器 + 本机 Firefly/abei-api/agent/worker + vite (5173)
make dev-web      # Firefly、worker、abei-api、agent 用容器跑，本机只起 vite (5173)
make up           # 完整本地形态起 8 个容器（含内部 feedback 后端）
make down         # 停容器（保留数据）
make logs         # 跟随 app、bill-worker、abei-server、abei-api、abei-agent 与 abei-web 日志
make man          # 开发者生成 abei/target/man/abei.1（不是 abei 子命令）
make test         # 全部测试：web vitest + Firefly PHPUnit + agent vitest + abei 三道闸
make test-e2e     # 浏览器主路径：起 db/mail/app/abei-api + playwright
make build        # 出产物：abei-web 静态 + abei-agent 打包 + abei release 二进制 + composer 装依赖
make build-image  # 构建 app、abei-api、abei-agent 与 abei-web 镜像
make help
```

`make dev` 会停掉容器版 app、abei-api、agent 与 web，把端口交给本机进程；`make dev-web`
只停 abei-web，后端继续跑容器。之后 `make up` 可恢复完整形态。
`bill-worker` 会随 `make up`、`make dev-web` 一起启动；`make dev` 则在本机运行同一组同步/解析命令。
它默认每 5 分钟执行一次，可通过 `BILL_WORKER_INTERVAL` 调整。

`APP_KEY` 是 Firefly 加密邮箱密码等敏感配置所用的应用主密钥，必须在同一数据库的整个生命周期内保持不变。
更换它不会自动迁移旧数据，只会让旧密文无法解密。

### Gmail OAuth2

Gmail 不接收密码，只走 Google OAuth2。部署者在 Google Cloud 创建 **Web application**
OAuth 客户端，并把下面的回调地址原样加入 Authorized redirect URIs：

- `make dev` / `make dev-web`：`http://127.0.0.1:5173/oauth/google/callback`
- `make up`：`http://127.0.0.1:18004/oauth/google/callback`
- 正式部署：`https://你的域名/oauth/google/callback`

然后在 `.env` 填写：

```dotenv
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URL=https://你的域名/oauth/google/callback
```

OAuth consent screen 处于 Testing 时，还要把实际 Gmail 账号加入 Test users。配置完成后，
用户只需在账单收件箱的邮箱设置里点「连接 Google」；主机、端口、`INBOX`、token 刷新和
IMAP `XOAUTH2` 都由 `abei-server` 处理。`https://mail.google.com/` 是 restricted scope，
若把服务公开给任意 Google 用户，需要按 Google 要求完成应用验证。

启动后：

- abei-web: http://localhost:18004 （`make dev` 下前端在 http://localhost:5173）
- abei-api: http://localhost:18002 （健康检查 `/health`，能力目录 `/v1/catalog`）
- Firefly III: http://localhost:18001
- abei-agent: http://localhost:18003 （健康检查 `/api/ai/health`）
- PostgreSQL: `127.0.0.1:15432`
- 测试 IMAP/SMTP: `127.0.0.1:13143` / `127.0.0.1:13025`

端口在 `.env` 改。`18002` 是 abei-api 的号，容器版和本机 `cargo run` 版只能开一个。
改 `FIREFLY_PORT` 要同步改 `abei-web/vite.config.ts` 的 proxy 目标。`APP_URL` 默认跟随
`FIREFLY_PORT`，只有用自定义主机名或反向代理时才需要显式设置。

abei-web 不在构建期注入令牌。首次打开会要求粘贴 Firefly PAT，存在 sessionStorage；
开发期可以在 `abei-web/.env.local` 放 `VITE_FIREFLY_TOKEN` 兜底。

### 命令行 abei

```bash
cargo install --path abei/crates/abei-cli
abei auth login --url http://localhost:18002 --token <PAT>
abei transactions list --start 2026-08-01
abei explain transactions  # 查看资源的能力和参数
abei guide                 # 输出 agent 使用说明
abei feedback list --status open
```

`abei feedback create ... --yes` 会经 abei-api 写入本地 PostgreSQL；配置 GitHub 仓库与令牌后还会自动同步成 issue。处理、重试同步和删除同样是 confirm 能力，必须由 Firefly owner 确认。

未配对时直接运行 `abei` 会自动打开网页配对页；复制页面生成的完整命令粘回终端即可。

默认输出是给人看的文本；要机器读就显式开 `--json=字段` 或 `--jq <表达式>`。
draft 档直接写草稿；confirm 档必须带 `--yes`（否则退出码 6 并打印补好的命令）。

### AI 与平台能力

在根目录 `.env` 设置模型。默认是 OpenAI：

```dotenv
AI_PROVIDER=openai
AI_MODEL=gpt-5.4-mini
OPENAI_API_KEY=...
# OpenAI 兼容服务才需要：
OPENAI_BASE_URL=https://example.com/v1
```

也支持 `anthropic`、`google`、`cloudflare-ai-gateway`、`cloudflare-workers-ai` 和
`ollama`，对应变量已列在 `.env.example`。模型密钥只进入 `abei-agent`，不会进浏览器；
浏览器的 Firefly PAT 只在当前 Agent 请求内使用，不写入 `abei_ai` schema。

网页助手和外部 Agent 用的是同一份能力目录：网页助手从 abei-api 取，外部 Agent 装 abei-cli
就行——对模型来说命令行比 MCP 省 token。`abei` 不提供原始 HTTP/API 命令；模型只能看到已建模能力。
正式入账、账单密码与 feedback 写操作必须回到界面上人工审批；用户管理、配置和邮箱凭证不在能力目录里。

### 浏览器 e2e

`make test-e2e` 跑 `abei-web/e2e/` 下的 playwright 主路径（登录 → 今天页待办 → 交易筛选 →
键盘操作 → 批量改分类 → 订阅记一笔 → 账户归档），打的是真的 Firefly，不 mock。

- 数据：跑之前调 `php artisan system:seed-e2e`（见 `firefly-iii/app/Console/Commands/System/SeedsE2EEnvironment.php`），
  它建 `e2e@example.test` 这个专用用户、发 PAT，并把该用户的账本清空重建。主路径会写数据，所以每次都重播。
- 前端：playwright 自己拉 vite 到 5174（跟 `make dev-web` 的 5173 岔开，可以同时开），
  并强制清掉 `.env.local` 的兜底令牌，好让登录这一步真的走一遍 TokenGate。
- 要 db/mail/app/abei-api 四个容器，不需要 abei-web 容器——账本请求由 vite 代理到 18002 的 abei-api。
  想改打 nginx 产物（`make up` 起的容器）：`cd abei-web && E2E_BASE_URL=http://127.0.0.1:18004 npx playwright test`。

## 文档

- `docs/design/abei-refactor.md`：当前架构与重构方案（能力目录、命令系统、剥离路线、分期）
- `docs/design/redesign-decisions.md`：功能取舍、视觉与交互的已定决策
- `docs/design/feature-inventory.md`：Firefly 全部接口，哪些接、哪些不接
- `docs/implementation-plan.md`：早前那批重构做了什么，以及几条查代码查出来的结论（recurrence、cron、令牌筛选）
- `abei-cli.md` / `abei-api.md`：当前有效的 CLI 与 API 开发规范

## 当前方向

目标是能用的记账系统：邮箱自动导入账单、AI 参与归类与入账。能力目录是唯一真源，命令行、
网页助手和未来的移动端共用它；剥离 Firefly 等于改目录里的 backend 指向，客户端无感。
界面统一在 abei-web。

生产数据只在服务器上，本机不操作。任何 dump、附件、密钥和真实 `.env` 都不得进入 Git 或 CI。

GitHub Actions 配置在 `.github/workflows/ci.yml`，在 `main` push 和 Pull Request 上运行
abei-web / abei-agent 检查、abei 三道闸（fmt/clippy/test）、Firefly PHPUnit 和镜像构建。
CI 只使用合成数据与测试密钥。

## 许可证说明

`firefly-iii/` 保留 Firefly III 原项目的 AGPL-3.0-or-later 许可证与版权声明。
`abei-agent/` 保留其自身许可证与版权声明。
