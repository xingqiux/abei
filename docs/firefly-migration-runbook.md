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

`core_import_ready=false` 表示当前 Granary 数据模型或导入器还不能无损表达源数据，不能用手工 SQL 绕过。例如，同一分类同时用于收入和支出时，必须先让 Granary 分类模型支持该语义，再开放写入导入。

## 导入与核对门禁

正式导入器必须满足以下条件后才允许对隔离 Granary 目标库执行：

1. 使用稳定的 source instance ID、快照指纹和源记录 ID 建立幂等映射。
2. 单次领域导入在目标 PostgreSQL 事务中整体成功或整体回滚。
3. Firefly expense/revenue account 转为交易方，不复制为用户账户。
4. Firefly 软删除的已入账交易转为原交易、冲正交易和回收站记录，不能物理丢弃。
5. 原始交易时间、金额、币种、posting 符号、分类、标签、备注、外部标识和重复检测证据可追溯。
6. 认证凭据和邮箱密码明确排除，并在报告中列为重建项。
7. 账单任务、行、事件、产物和 storage 对象在 Rust 账单域及 S3 模型完成后整体迁移。

每次演练至少核对：

- 每个用户账户按币种的期末余额。
- 有效和软删除交易数量、posting 数量及借贷平衡。
- 收入、支出和转账数量与金额。
- 分类、标签和预算的记录数、关联数和汇总金额。
- 交易方合并规则及源 ID 覆盖率。
- 备注、附件、账单任务、账单行、产物和对象校验和。
- 未映射记录、重复映射、金额差异和缺失对象必须全部为零。

最终切换时先停止 Firefly 写入，再生成最终快照、导入空的 Granary 目标库并完成零差异核对。Granary 开始写入后不建设长期双写，也不承诺无损切回 Firefly。
