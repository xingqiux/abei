# Firefly AI Accounting

基于 Firefly III 的 AI 记账项目，包含账本后端、Granary Web 和命令行工具。

## 目录结构

- `firefly-iii/`: Firefly III 本体，本项目用作账本后端。
- `granary-web/`: 面向日常使用的 Granary Web 前端。
- `firefly-cli/`: 面向用户和 AI agent 的命令行工具，提供更顺手的记账操作入口。
- `docs/development-target.md`: 当前完整开发范围、验收标准和执行顺序。

## 本地开发与测试

根目录是唯一的开发入口，只需要 Make、Docker Engine 与 Docker Compose v2。Firefly III 和 Granary Web 镜像从当前源码构建，其他运行环境由 Compose 提供；测试数据库与本地账本数据库完全隔离。

```bash
make bootstrap
make up
make test
make test-empty-start
make test-e2e
make audit
make release
# 需要删除默认、测试、empty-start 和 E2E 数据时：make clean
```

启动后：

- Granary Web: http://localhost:18002
- Firefly III: http://localhost:18001
- PostgreSQL: `127.0.0.1:15432`
- 测试 IMAP/SMTP: `127.0.0.1:13143` / `127.0.0.1:13025`

这些端口可在 `.env` 中修改。`APP_URL` 默认跟随 `FIREFLY_PORT`，并同时用于 Granary 的“旧版界面”入口；只有使用自定义主机名或反向代理时才需要显式设置。

`make test-empty-start` 强制使用 `.env.example`，通过独立 Compose project 和端口从空卷验证默认开发栈，结束后删除自己的临时卷；`make test-e2e` 同样固定使用 `.env.example`，从另一套空卷验证 CLI 契约和完整浏览器工作流。`make audit` 覆盖 Firefly Composer、Firefly npm、CLI npm 和 Granary npm：Firefly 生产依赖所有等级零容忍，完整开发树阻止 high/critical 并保留 legacy low/moderate 输出。`make release` 依次执行配置校验、隔离 E2E、测试、lint、依赖审计、镜像构建和默认栈空卷启动；优先执行资源最敏感的浏览器门禁，避免前序构建页缓存影响测试稳定性。常用命令可运行 `make help` 查看。

`make down` 只停止默认开发栈并保留数据。`make reset` 会删除默认开发数据后立即重建；`make clean` 会删除默认、测试、empty-start 和 E2E 项目的容器、网络及数据卷。这两个命令都是破坏性操作，只应在确认不需要相关数据时使用。

## 当前目标

当前 P0 收口目标已完成：Firefly III 账本后端、Granary Web、`firefly-cli`、账单邮件采集和多渠道账单导入已经由同一份工作树的完整 `make release` 验收，最终退出码为 0。当前开发重心转为 P1 持续治理，包括镜像精确版本或 digest、Firefly v2 direct-eval 依赖债和 Mago analyzer 基线；自然语言记账和 MCP 接入仍属于后续扩展方向。完整结果和后续任务以 `docs/development-target.md` 为准。

## 许可证说明

`firefly-iii/` 保留 Firefly III 原项目的 AGPL-3.0-or-later 许可证与版权声明。
`firefly-cli/` 保留其自身许可证与版权声明。
