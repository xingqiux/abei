# Firefly AI Accounting

个人记账系统。Firefly III 作为后端引擎提供 API，granary-web 是唯一界面，firefly-cli 面向命令行和 AI agent。

## 目录结构

- `firefly-iii/`: 后端引擎。Firefly III 的定制 fork，另含自建的账单收件箱子系统（邮箱拉取支付宝/微信/招行/中行账单并解析入账）。
- `granary-web/`: 前端界面，直接调用 Firefly API（PAT Bearer 认证）。
- `firefly-cli/`: 命令行工具 `ffc`，同样对着 Firefly API。
- `granary-server/`: Rust 后端，已封存不参与构建与测试，长期计划仍是替换 Firefly。

## 本地开发与测试

根目录是唯一入口，需要 Make、Docker Compose v2；`make dev` 另需本机装 PHP 与 Composer。

```bash
make dev          # 本地开发：起 db/mail 容器 + 本机 artisan serve (18001) + vite (5173)
make dev-web      # 只开发前端：Firefly 用容器跑，本地只起 vite (5173)
make up           # 生产形态起 4 个容器：db mail app granary-web
make down         # 停容器（保留数据）
make logs         # 跟随 app 与 granary-web 日志
make test         # 全部测试：granary-web vitest + Firefly PHPUnit + CLI vitest
make build        # 出产物：granary-web 静态文件 + firefly-cli 打包 + composer 装依赖
make build-image  # 构建 app 与 granary-web 镜像
make help
```

`make dev` 会停掉 app 容器把 18001 端口让给本机 artisan serve，之后 `make up` 可恢复。

启动后：

- granary-web: http://localhost:18002 （`make dev` 下前端在 http://localhost:5173）
- Firefly III: http://localhost:18001
- PostgreSQL: `127.0.0.1:15432`
- 测试 IMAP/SMTP: `127.0.0.1:13143` / `127.0.0.1:13025`

端口在 `.env` 改。改 `FIREFLY_PORT` 要同步改 `granary-web/vite.config.ts` 的 proxy 目标。`APP_URL` 默认跟随 `FIREFLY_PORT`，只有用自定义主机名或反向代理时才需要显式设置。

granary-web 不在构建期注入令牌。首次打开会要求粘贴 Firefly PAT，存在 sessionStorage；开发期可以在 `granary-web/.env.local` 放 `VITE_FIREFLY_TOKEN` 兜底。

## 当前方向

目标是能用的记账系统：邮箱自动导入账单、AI 参与归类与入账。Firefly 提供 API 与账单子系统，界面统一在 granary-web，AI 接入走 firefly-cli 与后续的 MCP 层。

生产数据只在服务器上，本机不操作。任何 dump、附件、密钥和真实 `.env` 都不得进入 Git 或 CI。

GitHub Actions 配置在 `.github/workflows/ci.yml`，在 `main` push 和 Pull Request 上运行 granary-web / firefly-cli 检查、Firefly PHPUnit 和镜像构建。CI 只使用合成数据与测试密钥。

## 许可证说明

`firefly-iii/` 保留 Firefly III 原项目的 AGPL-3.0-or-later 许可证与版权声明。
`firefly-cli/` 保留其自身许可证与版权声明。
