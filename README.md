# Firefly AI Accounting

个人财务管理项目，正在以 Rust `granary-server` 完整替代 Firefly III 后端，同时保留现有 Granary Web、命令行工具和迁移来源。

## 目录结构

- `firefly-iii/`: 现有 Firefly III 实现，作为迁移来源和行为核对基线保留。
- `granary-server/`: 新的 Rust 账务后端，拥有独立 PostgreSQL schema。
- `granary-web/`: 面向日常使用的 Granary Web 前端，当前仍待切换到 `granary-server` API。
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

`make test-empty-start` 强制使用 `.env.example`，通过独立 Compose project 和端口从空卷验证默认开发栈，结束后删除自己的临时卷；`make test-e2e` 同样固定使用 `.env.example`，从另一套空卷验证 CLI 契约和完整浏览器工作流。`make audit` 覆盖 Firefly Composer、Firefly npm、CLI npm 和 Granary npm：Firefly 生产依赖所有等级零容忍，完整开发树阻止 high/critical 并保留 legacy low/moderate 输出。`make release` 依次执行配置校验、隔离 E2E、测试、lint、依赖审计、镜像构建和默认栈空卷启动；优先执行资源最敏感的浏览器门禁，避免前序构建页缓存影响测试稳定性。常用命令可运行 `make help` 查看。

`make down` 只停止默认开发栈并保留数据。`make reset` 会删除默认开发数据后立即重建；`make clean` 会删除默认、测试、empty-start 和 E2E 项目的容器、网络及数据卷。这两个命令都是破坏性操作，只应在确认不需要相关数据时使用。

## 当前目标

现有 Firefly III、Granary Web 和 `firefly-cli` 闭环继续作为迁移基线。当前开发重心是 `granary-server`：先建立账本隔离、双重记账内核、认证和完整迁移验证，再把 Web 与 CLI 切换到新 API。产品方向由产品所有者维护，仓库只记录当前实现事实和可运行验证。

## 许可证说明

`firefly-iii/` 保留 Firefly III 原项目的 AGPL-3.0-or-later 许可证与版权声明。
`firefly-cli/` 保留其自身许可证与版权声明。
