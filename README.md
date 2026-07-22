# Firefly AI Accounting

个人财务管理项目，正在以 Rust `granary-server` 完整替代 Firefly III 后端，同时保留现有 Granary Web、命令行工具和迁移来源。

## 目录结构

- `firefly-iii/`: 现有 Firefly III 实现，作为迁移来源和行为核对基线保留。
- `granary-server/`: 新的 Rust 账务后端，拥有独立 PostgreSQL schema。
- `granary-web/`: 面向日常使用的 Granary Web 前端；认证、账本、账户、交易、搜索、基础资料和概览已接入 `granary-server`。
- `firefly-cli/`: 面向用户和 AI agent 的命令行工具，提供更顺手的记账操作入口。
- `docs/development-target.md`: Rust 后端启动前的 Firefly/Web/CLI 历史验收基线，不是当前产品方向来源。

## 本地开发与测试

根目录是唯一的开发入口，只需要 Make、Docker Engine 与 Docker Compose v2。Firefly III 和 Granary Web 镜像从当前源码构建，其他运行环境由 Compose 提供；测试数据库与本地账本数据库完全隔离。

```bash
make bootstrap
make up
make up-server
make test
make test-empty-start
make test-e2e
make audit
make release
# 需要删除默认、测试、empty-start 和 E2E 数据时：make clean
```

启动后：

- Granary Web: http://localhost:18002
- Granary Server: http://localhost:18003
- Firefly III: http://localhost:18001
- PostgreSQL: `127.0.0.1:15432`
- Granary PostgreSQL: `127.0.0.1:15433`
- 测试 IMAP/SMTP: `127.0.0.1:13143` / `127.0.0.1:13025`

这些端口可在 `.env` 中修改。`APP_URL` 默认跟随 `FIREFLY_PORT`，并同时用于 Granary 的“旧版界面”入口；只有使用自定义主机名或反向代理时才需要显式设置。

`make up` 会启动 Firefly 迁移基线和 Granary 新链路；只开发 Rust 后端时可使用 `make up-server`。`make test-empty-start` 强制使用 `.env.example`，通过独立 Compose project 和端口从空卷验证两套开发栈，结束后删除自己的临时卷。

`make test-e2e` 同样固定使用 `.env.example`，但只验收 Granary 新链路：`e2e-db -> e2e-migrate -> e2e-server -> e2e-web -> Playwright`。浏览器从空数据库完成实例初始化、登录、Session/CSRF、基础资料、账户和交易写入、多账本隔离、刷新恢复及退出，并检查安全响应头；不读取本机 `.env`、Firefly PAT 或个人数据。

`make test` 覆盖 Rust/PostgreSQL、Firefly PHPUnit、CLI 和 Granary Web 自动化测试。`make audit` 覆盖 Firefly Composer、Firefly npm、CLI npm 和 Granary npm；`make release` 依次执行配置校验、隔离 E2E、测试、lint、依赖审计、镜像构建和默认栈空卷启动。常用命令可运行 `make help` 查看。

`make down` 只停止默认开发栈并保留数据。`make reset` 会删除默认开发数据后立即重建；`make clean` 会删除默认、测试、empty-start 和 E2E 项目的容器、网络及数据卷。这两个命令都是破坏性操作，只应在确认不需要相关数据时使用。

## 当前目标

现有 Firefly III 和 `firefly-cli` 继续作为迁移来源及行为核对基线。当前开发重心是完整实现 `granary-server`，逐个纵向打通 Server、Web、数据库约束和验收测试；Granary Web 的核心日常流程已经切换到新 API，CLI 尚未切换。生产数据迁移必须使用隔离的只读快照和可重复核对报告，任何 dump、附件、密钥和真实 `.env` 都不得进入 Git 或 CI。

GitHub Actions 配置位于 `.github/workflows/ci.yml`，在 `main` push 和 Pull Request 上运行 Rust 静态检查、PostgreSQL 集成测试、Web/CLI 检查、Compose 浏览器 E2E 和 Granary 镜像构建。CI 只使用合成数据与测试密钥。

## 许可证说明

`firefly-iii/` 保留 Firefly III 原项目的 AGPL-3.0-or-later 许可证与版权声明。
`firefly-cli/` 保留其自身许可证与版权声明。
