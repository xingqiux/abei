# Firefly III 数据迁移操作手册

本文只记录生产快照的工程操作、安全边界和核对流程，不定义产品范围。产品方向仍以产品所有者维护的《谷仓产品方向》为唯一来源。

## 安全边界

- 只使用 PostgreSQL 当前运行库的 `pg_dump -Fc` 快照，旧 `import/database.sqlite` 不是迁移来源。
- dump、完整备份、`.env`、OAuth key、附件和账单原件不得进入 Git、GitHub Actions artifact 或公开对象存储。
- 日常开发库、自动化测试库、Firefly 迁移源库和 Granary 迁移目标库必须彼此隔离。
- GitHub Actions 只使用合成夹具，不读取本机快照或生产凭据。
- 旧密码、Session、PAT、OAuth token、MFA secret 和邮箱密码不迁移。
- 任何正式导入前必须先生成不含个人字段的结构盘点；存在 blocker 时禁止写入目标库。

## 准备输入

从完整备份中只提取 `postgres.dump` 和后续文件迁移需要的 `storage.tar.gz`，放在仓库外、仅当前用户可读的目录。不要把 `.env` 解包到项目目录。

确认 dump 是 PostgreSQL custom format：

```bash
pg_restore --list /absolute/path/postgres.dump >/dev/null
```

## 恢复隔离源库

根目录提供独立 Compose project 中的 `migration` profile。恢复命令会删除并重建该 project 自己的 `firefly_source` 数据库，不会连接或修改 Firefly 开发库、Granary 开发库和测试库：

```bash
make migration-source-restore FIREFLY_SOURCE_DUMP=/absolute/path/postgres.dump
```

恢复完成后，数据库默认事务模式设为只读，默认只监听 `127.0.0.1:15445`。停止容器但保留本地迁移卷：

```bash
make migration-source-down
```

`make clean` 会删除包括迁移源库在内的项目本地卷。这是破坏性操作，执行前必须确认仓库外仍有可验证的原始备份。

## 脱敏结构盘点

```bash
make migration-source-inspect
```

输出只允许包含：

- 表和记录数量。
- Firefly 系统账户类型、交易类型和已使用币种。
- 分类使用方向的聚合数量。
- 不平衡分录、多 journal 交易组、软删除交易和外币等迁移风险数量。
- 不含业务字段的结构盘点指纹和是否允许进入核心导入阶段。备份文件本身仍以 SHA-256 单独校验。

输出禁止包含账户名、交易方名称、分类名、标签名、交易描述、邮箱、备注、外部标识、文件名、对象路径和原始账单字段。

`core_import_ready=false` 表示当前 Granary 数据模型或导入器还不能无损表达源数据，不能用手工 SQL 绕过。Granary 分类是记录在 posting 上的方向中立分析维度，同一分类可用于收入、支出和转账；转账分类不计入收入或支出。因此 Firefly 的双向分类和转账分类不再构成 blocker。多 journal 交易组、单 journal 多分类拆分、外币金额等仍须由盘点器按当前导入能力判定。

## 一次性核心迁移

本项目不建设长期维护的通用导入平台。`granary-server migrate-firefly` 是生产替换期间使用一至两次的一次性迁移命令，Make 入口为：

```bash
make migration-core-import GRANARY_TARGET_USER_EMAIL=user@example.com
```

执行前必须满足：

1. `make migration-source-inspect` 输出 `core_import_ready=true`。
2. 目标用户存在、未禁用，并且只关联一个未归档账本。
3. 目标账本没有交易、可见账户、交易方、标签或预算，只允许保留初始化生成的一个“未分类”分类和隐藏系统科目。
4. 先用 `pg_dump -Fc` 备份 Granary 目标数据库，并用 `pg_restore --list` 验证备份可读。

命令会在一个目标 PostgreSQL 事务中完成全部写入和核对，任一步失败都会整体回滚。成功后不能对同一账本重复执行；需要重新演练时应创建新的空目标数据库或从导入前备份恢复。

当前一次性命令迁移：

- 资产、现金、借款、贷款和信用负债账户；期初余额账户合并到 Granary 隐藏系统科目。
- Firefly expense/revenue account 合并为 Granary 交易方，同名收入和支出交易方合并。
- 分类、标签及其交易关联。
- 交易组标题、journal 描述和 journal 备注。
- Firefly 软删除交易对应的原交易、冲正交易和回收站记录。
- 源端已停用或软删除的账户、分类、标签和交易方归档状态。

当前明确不迁移：

- Firefly 密码、Session、PAT、OAuth token、MFA secret 和邮箱密码。
- Firefly 历史审计事件；目标端只生成迁移动作自身的审计记录。
- 账单收件箱任务、邮件、导入批次、账单行、产物、任务事件和密码挑战。
- 用户账务账户备注。Granary 账户目前没有对应备注字段，迁移报告必须给出未映射数量。
- 附件、预算、预算限额和已对账 posting。源快照出现这些记录时，核心迁移会直接拒绝执行，不能静默丢弃。

每次演练至少核对：

- 每个用户账户按币种的期末余额。
- 有效和软删除交易数量、posting 数量及借贷平衡。
- 收入、支出和转账数量与金额。
- 分类和标签的记录数与关联数。
- 交易方合并规则及源 ID 覆盖率。
- journal 备注保存数量，以及账户备注、历史审计和账单域记录的明确未迁移数量。
- 金额差异、缺失账户、缺失分类、缺失标签和未消费 posting 必须全部为零。

最终切换时先停止 Firefly 写入，再生成最终快照、导入空的 Granary 目标库并完成零差异核对。Granary 开始写入后不建设长期双写，也不承诺无损切回 Firefly。
