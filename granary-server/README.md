# granary-server（已封存）

Rust 后端，2026-07 起停止开发，不参与构建、测试和 CI。

原本的计划是用它替掉 Firefly III：自己的 PostgreSQL schema、借贷平衡的日记账、
完整的账本 API。写到 18000 多行、14 个 migration，能跑，但没接上界面。

**为什么停**：Firefly 已经能满足记账本身的需求，而这个项目真正缺的是自动导入和
AI 归类。继续把 Firefly 的功能在 Rust 里重写一遍，是把力气花在已经解决的问题上。
所以路线改成 Firefly 当引擎，abaku-web 当界面，力气投到账单收件箱和 CLI/AI 那条线。

代码留着不删，因为里面的 schema 设计和财务不变量是想清楚过的，将来如果真要换后端，
从这里接着做比从零开始省事。

## 现状

- 不在 `Makefile`、`compose.yml`、`.github/workflows/ci.yml` 里。以前 README 写的
  `make up-server` / `make test-server` 已经没有了。
- 最后一次提交是 2026-07-29（Firefly 快照的一次性核心导入）。
- 依赖没有跟进升级，`cargo build` 能不能过没有人在看。

想单独跑起来的话得自己准备 PostgreSQL 和环境变量，参考 `src/` 里的配置读取和
`migrations/`，README 不再维护一份会过期的启动步骤。

## 里面有什么

服务端边界：本地密码登录、Session/CSRF、PAT scope、TOTP 两步验证、密码重置、
邀请注册与可选的公开注册、实例/组织/账本管理、账本共享角色、不可变的平衡日记账。

账本 API：账户、分类、交易对手、标签、月度预算、多币种金额、克隆、
带过期预览的原子批量替换/删除、通过冲销加重建做类型转换、回收站恢复、
带部分退款/报销金额的固定交易链接、跨账本转账链接、带显式调整分录的账户对账。

财务不变量在 PostgreSQL 和 HTTP 两层都设了约束：已入账的金额和维度不可改、
批量操作全成或全败并校验版本、已归档的维度仍可用于历史冲销、已完成的对账不可改、
已清算的分录必须属于某次对账。

主要路径：

- `/api/v1/auth`、`/api/v1/admin`、`/api/v1/instance`
- `/api/v1/organizations`、`/api/v1/books`
- `/api/v1/books/{book_id}/accounts`、`categories`、`counterparties`、`tags`、`budgets`
- `/api/v1/books/{book_id}/transactions` 与 `transactions/batches`
- `/api/v1/books/{book_id}/transaction-links`
- `/api/v1/books/{book_id}/reconciliations`
- `GET /health/live`、`GET /health/ready`
