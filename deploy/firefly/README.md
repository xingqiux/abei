# Firefly AI Accounting Docker 部署

这是给 JD `xkqq` 服务器准备的最小部署方案：Firefly、abei-api、阿贝前端、AI Agent、PostgreSQL、预算 cron 和账单邮箱 worker。

> **cron 容器只跑 `--create-auto-budgets`，不要改回不带参数的 `firefly-iii:cron`。**
> 不带参数会执行全部六项，其中 `--create-recurring` 会自动生成定期交易。本项目的
> 「订阅」建在定期交易上，交易由用户在界面点「记这一笔」手动触发，而定期交易又必须
> 保持 `active=true` 才允许手动触发，所以一旦自动生成打开，每笔订阅会变成一天两条。
> 详见 `docs/implementation-plan.md` 的「阶段 0 验证结论」第 2 条。

`bill-worker` 每 5 分钟执行一次邮箱同步和任务解析。它只读取已启用用户的账单邮箱设置，
并与 `app` 共用 `storage`；不需要在浏览器里保持页面打开。

## 1. 本地构建镜像

以下构建命令均从仓库根目录执行。

```bash
docker buildx build --platform linux/amd64 \
  -t docker.xkqq.top/firefly/firefly-ai-accounting:latest \
  --push ./firefly-iii
```

JD 是 `x86_64`，本机 Mac/OrbStack 是 `arm64`，所以这里必须 build `linux/amd64`。JD 磁盘只剩不多，建议在本机或 CI 构建，JD 只 pull。

## 2. 服务器目录

```bash
ssh xkqq
mkdir -p /home/ziyu/services/firefly-ai-accounting
cd /home/ziyu/services/firefly-ai-accounting
```

复制这些文件到服务器：

```text
deploy/firefly/docker-compose.yml -> /home/ziyu/services/firefly-ai-accounting/docker-compose.yml
deploy/firefly/.env.example       -> /home/ziyu/services/firefly-ai-accounting/.env
```

然后编辑服务器上的 `.env`：

```text
APP_URL=https://firefly.xkqq.top
APP_KEY=复制本地 firefly-iii/.env 里的 APP_KEY
DB_PASSWORD=一个新长密码
POSTGRES_PASSWORD=和 DB_PASSWORD 一样
```

不要把真实 `.env` 提交进 Git。

## 3. 复制持久化文件

从本地复制：

```text
firefly-iii/storage/app
firefly-iii/storage/oauth-private.key
firefly-iii/storage/oauth-public.key
firefly-iii/storage/database/database.sqlite
```

到服务器：

```text
/home/ziyu/services/firefly-ai-accounting/storage/app
/home/ziyu/services/firefly-ai-accounting/storage/oauth-private.key
/home/ziyu/services/firefly-ai-accounting/storage/oauth-public.key
/home/ziyu/services/firefly-ai-accounting/import/database.sqlite
```

## 4. 迁移 SQLite 到 PostgreSQL

先只启动数据库：

```bash
cd /home/ziyu/services/firefly-ai-accounting
docker compose up -d db
```

用 pgloader 做一次性迁移：

```bash
set -a
. ./.env
set +a

docker run --rm \
  --network firefly-ai-accounting_default \
  -v "$PWD/import:/import:ro" \
  dimitri/pgloader:latest \
  pgloader sqlite:////import/database.sqlite "postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}"
```

迁完再启动应用并修复 PostgreSQL 自增序列：

```bash
docker compose up -d app
docker compose exec app php artisan firefly-iii:upgrade-database
docker compose exec app php artisan upgrade:600-pgsql-sequences
docker compose up -d
```

迁移后核对数量，至少这几项要和本地 SQLite 一致：

```bash
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
select 'users', count(*) from users
union all select 'accounts', count(*) from accounts
union all select 'transaction_groups', count(*) from transaction_groups
union all select 'bill_tasks', count(*) from bill_tasks
union all select 'bill_artifacts', count(*) from bill_artifacts
union all select 'bill_statement_imports', count(*) from bill_statement_imports
union all select 'bill_statement_rows', count(*) from bill_statement_rows
union all select 'bill_mail_messages', count(*) from bill_mail_messages;
"
```

当前本地参考值：

```text
users: 1
accounts: 125
transaction_groups: 194
bill_tasks: 20
bill_artifacts: 24
bill_statement_imports: 8
bill_statement_rows: 439
bill_mail_messages: 32
```

## 5. 接域名

在 JD 的 OpenResty/1Panel 里把 `firefly.xkqq.top` 反代到：

```text
http://127.0.0.1:18001
```

Cloudflare 添加 `firefly.xkqq.top` DNS 记录，指向 JD 服务器。

服务健康检查地址：

```text
http://127.0.0.1:18001/health
```

## 6. 更新

```bash
docker buildx build --platform linux/amd64 \
  -t docker.xkqq.top/firefly/firefly-ai-accounting:latest \
  --push ./firefly-iii

ssh xkqq
cd /home/ziyu/services/firefly-ai-accounting
docker compose pull
docker compose up -d
docker compose exec app php artisan migrate --force
docker compose exec app php artisan firefly-iii:upgrade-database
docker compose exec app php artisan upgrade:600-pgsql-sequences
```

## 7. 回滚

本地 SQLite 和本地 `storage/app` 先不要删。上线失败时，停掉服务器容器，继续用本机 `make up`。

服务器端回滚镜像就是把 `.env` 里的 `FIREFLY_IMAGE` 改回旧 tag，然后：

```bash
docker compose pull
docker compose up -d
```

## 阿贝前端与 API（abei-web / abei-api / abei-agent）

前端是纯静态 nginx 镜像，构建期**不注入任何令牌**（运行时由 TokenGate 存进浏览器 sessionStorage）。
账本请求不再直连 Firefly：nginx 把 `/v1` 反代给 `abei-api`，所以 **`abei-api` 是必需服务**，
少了它前端一条数据都读不出来。

### 构建推送

三个镜像都要推。`abei-api` 的构建上下文是 `abei/` 这个 Rust workspace 根：

```bash
docker buildx build --platform linux/amd64 \
  -t docker.xkqq.top/firefly/abei-api:latest \
  --target runtime \
  --push ./abei

docker buildx build --platform linux/amd64 \
  -t docker.xkqq.top/firefly/abei-web:latest \
  --push ./abei-web

docker buildx build --platform linux/amd64 \
  -t docker.xkqq.top/firefly/abei-agent:latest \
  --target runtime \
  --push ./abei-agent
```

命令行 `abei` 不进任何镜像——它装在人的机器上，用 `cargo install --path abei/crates/abei-cli`，
再 `abei auth login --url https://abei.xkqq.top --token <PAT>` 对上服务器。

### 服务器配置

`.env` 追加：

```text
ABEI_API_IMAGE=docker.xkqq.top/firefly/abei-api:latest
ABEI_WEB_IMAGE=docker.xkqq.top/firefly/abei-web:latest
ABEI_AGENT_IMAGE=docker.xkqq.top/firefly/abei-agent:latest
ABEI_AGENT_PORT=18003
ABEI_WEB_PORT=18004
AI_PROVIDER=openai
AI_MODEL=gpt-5.4-mini
OPENAI_API_KEY=替换成真实密钥
# 使用 OpenAI 兼容服务时再填写：
OPENAI_BASE_URL=https://example.com/v1
```

`docker compose up -d abei-api abei-agent abei-web` 后，反向代理把新域名（如 abei.xkqq.top）
指向 `127.0.0.1:18004`。宿主端口分配：`18001` Firefly、`18003` abei-agent、`18004` abei-web；
`abei-api` 只在 compose 内网监听 18002，不对外发端口，外面只需要看见 abei-web 一个入口。

容器内 nginx 的同域反代：`/v1` → `abei-api`（账本数据面），`/api/ai` → `abei-agent`
（模型密钥不进浏览器），`/api` 与 `/oauth` → `app`（令牌签发与逃生舱）。
旧界面 `firefly.xkqq.top` → `18001` 保留为过渡期兜底。

健康检查：

```text
abei-api    http://127.0.0.1:18002/health   （只在 compose 内网，用 docker compose exec 探）
abei-agent  http://127.0.0.1:18003/api/ai/health
```

agent 返回 `configured: false` 表示服务已启动但模型密钥或模型名还没配好。

### 首次打开

页面会显示令牌设置页（TokenGate）。**Firefly 的网页界面已经删除**，第一个令牌只能从服务器签发：

```bash
docker compose exec app php artisan user:create-pat
```

把打印出来的令牌粘进 TokenGate 保存即可。之后在 阿贝 的 设置 → 访问令牌 里可以列出和撤销
（走 `GET`/`DELETE /api/v1/tokens`），不必再登服务器。

令牌存在 **sessionStorage**，只在当前标签页有效——关掉浏览器要重新粘一次。这是有意的：
自托管记账数据敏感，不留长期凭证在磁盘上。

回滚：`.env` 里 `ABEI_API_IMAGE`、`ABEI_WEB_IMAGE`、`ABEI_AGENT_IMAGE` 改回旧 tag 后
`docker compose up -d abei-api abei-agent abei-web`。
