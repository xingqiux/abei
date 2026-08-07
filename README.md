# Firefly AI Accounting

个人记账系统。Firefly III 作为后端引擎提供 API，abaku-web 是唯一界面，firefly-cli 面向命令行和 AI agent。

## 目录结构

- `firefly-iii/`: 后端引擎。Firefly III 的定制 fork，另含自建的账单收件箱子系统（邮箱拉取支付宝/微信/招行/中行账单并解析入账）。
- `abaku-web/`: 前端界面；业务接口直连 Firefly，AI 流式接口走可信 Agent 服务。
- `firefly-cli/`: 命令行工具 `ffc`，同时提供 MCP 能力面和 `abaku-agent` 服务进程。
- `granary-server/`: Rust 后端，2026-07 起封存，不参与构建、测试和 CI。代码留着备查，原因见它自己的 README。

## 本地开发与测试

根目录是唯一入口，需要 Make、Docker Compose v2；`make dev` 另需本机装 PHP 与 Composer。

```bash
make dev          # db/mail 容器 + 本机 Firefly/worker/agent + vite (5173)
make dev-web      # 后端、worker、agent 用容器跑，本机只起 vite (5173)
make up           # 完整本地形态起 6 个容器
make down         # 停容器（保留数据）
make logs         # 跟随 app、bill-worker、abaku-agent 与 abaku-web 日志
make test         # 全部测试：abaku-web vitest + Firefly PHPUnit + CLI vitest
make test-e2e     # 浏览器主路径：起 db/mail/app + playwright
make build        # 出产物：abaku-web 静态文件 + firefly-cli 打包 + composer 装依赖
make build-image  # 构建 app、abaku-agent 与 abaku-web 镜像
make help
```

`make dev` 会停掉 app、bill-worker 和 abaku-agent 容器，把端口让给本机开发进程，之后 `make up` 可恢复。
`bill-worker` 会随 `make up`、`make dev-web` 一起启动；`make dev` 则在本机运行同一组同步/解析命令。
它默认每 5 分钟执行一次，可通过 `BILL_WORKER_INTERVAL` 调整。

`APP_KEY` 是 Firefly 加密邮箱密码等敏感配置所用的应用主密钥，必须在同一数据库的整个生命周期内保持不变。
更换它不会自动迁移旧数据，只会让旧密文无法解密。

启动后：

- abaku-web: http://localhost:18002 （`make dev` 下前端在 http://localhost:5173）
- Firefly III: http://localhost:18001
- abaku-agent: http://localhost:18003 （健康检查 `/api/ai/health`）
- PostgreSQL: `127.0.0.1:15432`
- 测试 IMAP/SMTP: `127.0.0.1:13143` / `127.0.0.1:13025`

端口在 `.env` 改。改 `FIREFLY_PORT` 要同步改 `abaku-web/vite.config.ts` 的 proxy 目标。`APP_URL` 默认跟随 `FIREFLY_PORT`，只有用自定义主机名或反向代理时才需要显式设置。

abaku-web 不在构建期注入令牌。首次打开会要求粘贴 Firefly PAT，存在 sessionStorage；开发期可以在 `abaku-web/.env.local` 放 `VITE_FIREFLY_TOKEN` 兜底。

### AI 与 FFC 平台能力

在根目录 `.env` 设置模型。默认是 OpenAI：

```dotenv
AI_PROVIDER=openai
AI_MODEL=gpt-5.4-mini
OPENAI_API_KEY=...
# OpenAI 兼容服务才需要：
OPENAI_BASE_URL=https://example.com/v1
```

也支持 `anthropic`、`google`、`cloudflare-ai-gateway`、`cloudflare-workers-ai` 和
`ollama`，对应变量已列在 `.env.example`。模型密钥只进入 `abaku-agent`，不会进浏览器；
浏览器的 Firefly PAT 只在当前 Agent 请求内使用，不写入 `abaku_ai` schema。

外部 Agent 要复用同一组受限能力时运行 `ffc mcp`。正式入账与账单密码必须回到
Abaku 审批；`ffc api`、删除、用户管理、配置和邮箱凭证不会暴露给模型。

### 浏览器 e2e

`make test-e2e` 跑 `abaku-web/e2e/` 下的 playwright 主路径（登录 → 今天页待办 → 交易筛选 →
键盘操作 → 批量改分类 → 订阅记一笔 → 账户归档），打的是真的 Firefly，不 mock。

- 数据：跑之前调 `php artisan system:seed-e2e`（见 `firefly-iii/app/Console/Commands/System/SeedsE2EEnvironment.php`），
  它建 `e2e@example.test` 这个专用用户、发 PAT，并把该用户的账本清空重建。主路径会写数据，所以每次都重播。
- 前端：playwright 自己拉 vite 到 5174（跟 `make dev-web` 的 5173 岔开，可以同时开），
  并强制清掉 `.env.local` 的兜底令牌，好让登录这一步真的走一遍 TokenGate。
- 只要 db/mail/app 三个容器，不需要 abaku-web 容器。
  想改打 nginx 产物（`make up` 起的容器）：`cd abaku-web && E2E_BASE_URL=http://127.0.0.1:18002 npx playwright test`。

## 文档

- `docs/design/redesign-decisions.md`：功能取舍、视觉与交互的已定决策
- `docs/design/feature-inventory.md`：Firefly 全部接口，哪些接、哪些不接
- `docs/implementation-plan.md`：这批重构做了什么，以及几条查代码查出来的结论（recurrence、cron、令牌筛选）

## 当前方向

目标是能用的记账系统：邮箱自动导入账单、AI 参与归类与入账。Firefly 提供 API 与账单子系统，界面统一在 abaku-web，AI 与 MCP 共用 firefly-cli 的受限能力注册表。

生产数据只在服务器上，本机不操作。任何 dump、附件、密钥和真实 `.env` 都不得进入 Git 或 CI。

GitHub Actions 配置在 `.github/workflows/ci.yml`，在 `main` push 和 Pull Request 上运行 abaku-web / firefly-cli 检查、Firefly PHPUnit 和镜像构建。CI 只使用合成数据与测试密钥。

## 许可证说明

`firefly-iii/` 保留 Firefly III 原项目的 AGPL-3.0-or-later 许可证与版权声明。
`firefly-cli/` 保留其自身许可证与版权声明。
