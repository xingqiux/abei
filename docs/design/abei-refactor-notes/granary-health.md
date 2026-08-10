# granary-server 体检（阶段 0 · 盘点）

2026-08-09 · 为 §八-3「远期账本切换」备档。**本次只读不改**，未动 granary-server 任何代码。

---

## 一、构建结果

| 项 | 结果 |
|---|---|
| `rustc` | **1.93.1** (01f6ddf75 2026-02-11) |
| `cargo` | 1.93.1 (083ac5135 2025-12-15) |
| `cargo build` | ✅ **干净通过**，exit 0 |
| 耗时 | 24.17 s（全量编译约 220 个 crate，含下载） |
| 编译错误 | **0** |
| 编译警告 | **0** |
| `cargo test --no-run` | ✅ exit 0，8 个集成测试二进制全部产出，**0 警告** |

```
Compiling granary-server v0.1.0 (/Users/youla/proj/abaku/granary-server)
 Finished `dev` profile [unoptimized + debuginfo] target(s) in 24.17s
```

**没有依赖腐烂，也没有代码错误。** README 里写的「依赖没有跟进升级，`cargo build` 能不能过没有人在看」
这句现在可以划掉了——封存 4 个月后仍然一次过。

实际解析到的关键依赖版本（`Cargo.toml` 声明 → 实编译）：
`axum 0.8 → 0.8.9`、`sqlx 0.8 → 0.8.6`、`tokio 1 → 1.53.1`、`clap 4.5 → 4.6.4`、
`time 0.3 → 0.3.54`、`rust_decimal 1.39 → 1.42.1`、`rand 0.10 → 0.10.2`（依赖树里同时存在 0.8.7 / 0.9.5 的传递副本）。
`edition = "2024"`、`rust-version = "1.93"`。

> 能一次过的原因是版本约束都写的 caret（`"0.8"` / `"1"`），语义化版本内自动跟进；
> 且**全部 SQL 走运行时 `sqlx::query(...)` / `query_as::<_, T>`，没有一处 `sqlx::query!` 编译期宏**——
> 所以不需要 `DATABASE_URL` 或 `.sqlx` 离线缓存就能编译。这对将来平移是个便利，但也意味着
> **SQL 与 schema 的一致性没有编译期保障**，只能靠那 5297 行集成测试兜。

最后一次涉及 granary-server 的提交：`1f81bde 2026-08-05 docs: 重写四份过期文档`（仅文档）。
代码层面最后一次实质提交是 README 记的 2026-07-29（Firefly 快照一次性核心导入）。

---

## 二、规模与结构

**src/ 20 个文件 / 13128 行**

| 文件 | 行 | 内容 |
|---|---:|---|
| `api.rs` | 2910 | 组织/账本/账户/分类/交易对手/标签/交易 CRUD 主体 |
| `firefly_import.rs` | 1351 | Firefly III 快照 → granary schema 的一次性迁移 |
| `auth.rs` | 1169 | bootstrap/注册/登录/会话/CSRF/PAT，`ApiError` 定义 |
| `planning.rs` | 1079 | 预算、预算限额、预算报表 |
| `reconciliation.rs` | 845 | 账户对账（草稿/完成/取消） |
| `advanced_transactions.rs` | 747 | 克隆、冲销、批量预览+执行、回收站 |
| `ledger.rs` | 667 | 过账原语：`post_journal` / `reverse_journal` / `trash_journal` / 审计 |
| `admin.rs` | 627 | 实例管理员：用户禁用/恢复/PAT/会话/MFA 重置 |
| `access.rs` | 627 | 鉴权与授权：session vs PAT、scope 校验 |
| `invitation.rs` | 616 | 邀请注册 |
| `transaction_links.rs` | 603 | 固定交易链接（部分退款/报销）、跨账本转账链接 |
| `mfa.rs` | 560 | TOTP 两步验证 + 恢复码 |
| `http.rs` | 381 | **唯一的 router**（81 条 `.route()`），中间件层 |
| `instance.rs` | 301 | 实例设置 |
| `password_reset.rs` | 216 | 密码重置 |
| `reports.rs` | 153 | 汇总报表、按分类支出 |
| 其余 | 306 | `main.rs` / `config.rs` / `mail.rs` / `lib.rs` |

**tests/ 8 个文件 / 5297 行**：`core_api`(1690) `auth_api`(786) `management_api`(687)
`planning_api`(645) `transaction_links_api`(568) `reconciliation_api`(412)
`database_invariants`(299) `firefly_import`(210)。
（全部需要真 PostgreSQL，本次只编译未运行。）

**migrations/ 14 个 SQL / 1194 行**，纯 SQL，`sqlx migrate` 驱动：
`core`(330) → `auth` → `ledger_lifecycle`(136) → `transaction_recycle_bin` → `invitations` →
`mfa` → `password_reset` → `management_lifecycle` → `instance_settings` →
`tags_budgets`(97) → `advanced_transactions`(91) → `transaction_links` →
`reconciliations`(122) → `neutral_categories`(190)。

**API 面**：81 条路由，`/api/v1/{auth,admin,instance,me,currencies,organizations,books/...}` + `/health/{live,ready}`。
路由全部平铺在 `http.rs`，没有 `nest()`。

---

## 三、可直接复用的部分

### 1. schema 设计与「不变量在数据库层」的做法 —— **最高价值，几乎可以原样搬**

`migrations/202607220001_core.sql` 把财务不变量做成了 PostgreSQL 约束和触发器，而不是应用层的 if：

```sql
-- 已过账的日记账必须至少两条分录且借贷为零，DEFERRABLE 允许事务内分步写
CREATE CONSTRAINT TRIGGER postings_balance_check
    AFTER INSERT OR UPDATE OR DELETE ON postings
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_balanced_journal();
CREATE CONSTRAINT TRIGGER journal_status_balance_check
    AFTER INSERT OR UPDATE OF status ON journal_entries …;
```

同一文件里还有：
- `journal_entries` 状态机做成 CHECK：`status IN ('draft','posted','reversed')`，
  `(status='draft' AND posted_at IS NULL) OR (status<>'draft' AND posted_at IS NOT NULL)`，
  `status='draft' OR trashed_at IS NULL`；
- `postings.amount <> 0` 与 `book_amount <> 0`；
- `books.base_currency_code` 一旦有非草稿日记账就不能改（`protect_book_currency`）；
- `audit_events` **append-only**，UPDATE/DELETE 直接 RAISE（`protect_audit_event`）；
- 每个可变实体带 `version bigint CHECK (version > 0)` 做乐观锁，`api.rs` 里 114 处引用；
- 软删除用 `archived_at IS NULL` 的**部分唯一索引**（`ledger_accounts_active_name_unique` 等），
  归档后同名可复用、历史仍可引用；
- `outbox_events`（事务性发件箱，带 `attempts` 与 pending 部分索引）——现成的可靠事件外发骨架。

`202607220003_ledger_lifecycle.sql` 三个触发器同样值钱：
`protect_account_dimensions`（账户维度过账后不可改）、
`require_leaf_category_posting`（只能记到叶子分类）、
`protect_posted_journal`（已过账日记账不可改）。

`202607220013_reconciliations.sql`：
`postings_cleared_requires_reconciliation`（`cleared_at IS NULL OR reconciliation_id IS NOT NULL`）、
`postings_reconciliation_same_book`、`protect_finalized_reconciliation`（完成后不可改）、
`validate_posting_reconciliation`。

**这套东西正好补 Firefly 的短板**：Firefly 侧的对账状态是从 `transactions.reconciled` 布尔位
外加 `type=Reconciliation` 调整交易**反推**出来的（见 `channels-and-fixtures.md` §四），
granary 这边是有显式 `account_reconciliations` 表 + 数据库级不可变约束的。

### 2. `firefly_import.rs`（1351 行）—— 迁移路径的现成蓝图

`inspect_firefly()` + `migrate_firefly()` 两个公开入口，先盘点再迁。
`REQUIRED_TABLES` 常量列了 24 张 Firefly 表，**其中 7 张正是 bill-inbox 的表**
（`bill_tasks / bill_mail_messages / bill_artifacts / bill_task_events / bill_secret_challenges /
bill_statement_imports / bill_statement_rows`），已经会统计它们的行数并在报告里标注
`bill_records_not_imported` / `bill_secret_challenges_not_imported`——也就是说
**「账单收件箱数据不随账本迁移」这个决定当时已经想过并写进代码了**，与 §八-2 的剥离顺序天然对齐。

`FireflyMigrationReport` 的字段值得照抄（迁移报告该报什么）：
`source_inventory_fingerprint`（源快照指纹，防重复迁）、`contains_personal_values`、
`ledger_accounts/counterparties/categories/tags/original_journals/reversal_journals/postings/recycle_bin_entries`、
`journal_notes_preserved` / `account_notes_preserved` / `account_notes_unmapped`、
**`balance_mismatches`**（迁完对不上的账数）、`legacy_audit_events_not_imported`。

### 3. 技术栈完全同族，平移零换轨

`abei-refactor.md` §五 选的是 axum 0.8 + sqlx 0.8，granary-server 已经在这上面跑了 13k 行。
`ledger.rs` 的 `post_journal_in_tx` / `reverse_journal` / `trash_journal_in_tx` 以及
`AuditActorKind{User,Pat,System,Import,Job}` 可以直接变成 abei-core 的领域原语。

### 4. 集成测试的写法

`tests/database_invariants.rs`（299 行）专门测数据库层约束本身，
`tests/firefly_import.rs`（210 行）测迁移。这两份是「不变量当一等公民」的示范，值得沿用。

---

## 四、需要返工的部分

### 1. 错误形状不合 §五 的 RFC 9457

现在是自定义扁平结构（`auth.rs:277-290`）：
```rust
Json(ErrorBody { error: ErrorDetail { code, message } })
// 例：{ "error": { "code": "internal_error", "message": "服务器处理请求失败" } }
```
方案要的是 `application/problem+json` + 机读 `reason`（驼峰码）+ `resource`/`verb` 扩展字段。
`ApiError` 遍布 20 个文件，改形状是全仓机械替换，工作量不大但必须一次做完。

### 2. 没有能力目录，也没有 schema 导出

`api.rs` 是手写 handler + 手写路由，**没有 `resource`/`verb` 一等字段，没有 `risk` 档，没有 `backend` 指向，
没有 schemars/utoipa**，因此也没有 `/v1/catalog`、没有 OpenAPI 导出、没有 dry-run、没有风险闸。
这些恰恰是 §二 里「abei-api 不是无功能转发层」的全部内容。
换句话说：**granary 是「资源 API 层」的成品，不是「控制面」的成品**，控制面得从零建。

### 3. 鉴权模型不是过渡期要的那个

`access.rs` 是自有认证：本地密码 + Session/CSRF + PAT scope（`organizations:manage` 这类字符串 scope）+ TOTP。
§二/§八 明确「鉴权过渡期对 Firefly 验 PAT，自有认证等远期账本阶段才切」。
所以 `auth.rs`(1169) + `access.rs`(627) + `mfa.rs`(560) + `invitation.rs`(616) + `password_reset.rs`(216) +
`admin.rs`(627) ≈ **3815 行，本轮完全用不上**，是远期资产而非近期资产。

### 4. 多租户模型比现在需要的重

`organizations` → `organization_memberships`(owner/admin/member) → `books` → `book_memberships`(manager/editor/viewer)
两层组织 + 两套角色。当前产品是单人自用（§一「将来给别人用」但没排期）。
平移时要么保留（承担复杂度）要么压平（改 schema）——**得先做决定，不能边写边定**。

### 5. 领域模型与 Firefly 对不齐，迁移不是恒等映射

granary 是**真复式记账**：`journal_entries` + `postings`（借贷必须为零、至少两条分录、只能记叶子分类、
账户有 `class IN (asset,liability,equity,income,expense)`）。
Firefly 是「交易组 + 交易」的简化模型。`firefly_import.rs` 里的
`SUPPORTED_ACCOUNT_TYPES`、`balance_mismatches`、`account_notes_unmapped` 就是这个落差的证据。
远期切换时这些映射规则要重新按当时的 Firefly 数据验一遍，不能假设四个月前验过的仍然成立。

### 6. 与账单收件箱无衔接

granary 完全不认识 bill-inbox 的领域（只在迁移里数一下行数就跳过）。
§八 的顺序是先剥 bill-inbox 再切账本，所以到了远期这一步时，
**bill-inbox 已经是 Rust 的了，要反过来让它去写 granary 的 `journal_entries`/`postings`**——
`BillStatementRowImportService` 现在依赖的 `TransactionGroupRepositoryInterface::store()`
届时要换成 `ledger::post_journal`。这层适配现在不存在。

### 7. 没有 CI，没有跑过测试

不在 `Makefile` / `compose.yml` / `.github/workflows/ci.yml` 里。5297 行集成测试**编译得过但从未在本轮验证过**
（需要 PostgreSQL + 环境变量，README 已声明不再维护启动步骤）。
「能编译」≠「行为正确」，复活时第一件事应是把测试真跑一遍。

---

## 五、结论

granary-server 的健康状况比 README 自述的要好：**零错误、零警告、24 秒编译通过，测试也编译得过。**
它作为「远期账本阶段的种子」是站得住的，且价值集中在两处而非全部 13k 行：

1. **`migrations/` 的 1194 行 SQL**（schema 设计 + 数据库层不变量）——含金量最高，可近乎原样搬。
2. **`ledger.rs` + `firefly_import.rs`**（约 2000 行：过账原语 + 迁移蓝图与报告字段）。

而 `auth/access/mfa/invitation/password_reset/admin` 约 3800 行属于自有认证，
按方案要到远期才用得上；`api.rs` 的 2910 行 handler 需要按能力目录 + RFC 9457 + 风险闸重写外壳
（SQL 与领域逻辑可留，HTTP 层要换）。

**本轮（阶段 1-4）不需要动它，但建议现在做一件低成本的事**：把 granary-server 的
`cargo build` 加进 CI 的一个 allow-failure job。它已经能过，加进去只是防止再漂四个月后
真的腐烂到需要考古——这与「不复活」的决定不冲突。
