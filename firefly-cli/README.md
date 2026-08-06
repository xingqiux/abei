# firefly-cli

命令行客户端 `ffc`，对着 Firefly III 的 `/api/v1` 说话，Bearer 令牌认证。
常用资源有专门的子命令，没覆盖到的用 `ffc api` 直接打。

这是 AI 接入这条线的落脚点：`--format json` 的输出是给程序读的，后续的 MCP 层会架在它上面。

## 装和跑

```bash
npm install
npm run build
node dist/cli.js --help
```

想在全局用 `ffc`：

```bash
npm run build && npm link
ffc --help
```

link 指回这个目录，所以在这里重新 build 就等于更新了全局命令。开发时另开一个终端
挂 `npm run build:watch`。不 build 直接跑源码用 `npm run dev -- --help`。

## 认证

在 Firefly 里建个人访问令牌，存成一个 profile：

```bash
ffc auth set-token --profile local --url http://127.0.0.1:18001 --token <token>
ffc auth use local
ffc auth status
```

配置默认落在 `~/.config/firefly-cli/config.json`，用 `FIREFLY_CLI_CONFIG` 或
`--config <file>` 改路径。

18001 是本仓库 `make up` / `make dev` 起 Firefly 的端口，跟着根目录 `.env` 的
`FIREFLY_PORT` 走。

全局参数：

```
--profile <name>      用哪个 profile
--format table|json|raw
--config <file>
--trace-id <uuid>     带上 X-Trace-Id
--timeout <ms>
```

`table` 是交互用的默认值；`json` 把响应格式化打印；`raw` 原样输出字符串，
其余情况打紧凑 JSON。

## 探活

```bash
ffc ping                  # 打 /about，通了就行
ffc about --format json
ffc me --format json
```

## 账单收件箱

`bill-inbox` 是账单邮件导入的命令行操作面。任务状态、附件、事件、密码挑战都存在
Firefly 后端，`ffc` 只是调接口。

```bash
ffc bill-inbox settings show --format json
ffc bill-inbox settings set --enabled --provider gmail --email bills@example.com --password <app-password>

ffc bill-inbox sync --limit 50            # 扫邮箱建任务，顺手推进能推进的
ffc bill-inbox process --limit 25
ffc bill-inbox list
ffc bill-inbox show <taskId>

ffc bill-inbox artifacts <taskId>
ffc bill-inbox artifact download <artifactId> --output ./statement.zip
ffc bill-inbox events <taskId>
ffc bill-inbox secret submit <taskId> --value <password>

ffc bill-inbox rows <taskId> --status pending
ffc bill-inbox rows <taskId> --summary --limit 20
ffc bill-inbox review <taskId>
ffc bill-inbox row show <rowId>
ffc bill-inbox row update <rowId> --set category_name=通讯 --set firefly_description=手机充值
ffc bill-inbox row split <rowId>          # 支付宝组合支付：一行拆成多笔

ffc bill-inbox import <taskId> --all                     # 试算
ffc bill-inbox import <taskId> --all --include-payload   # 试算并打出生成的 Firefly payload
ffc bill-inbox import <taskId> --all --confirm           # 真写

ffc bill-inbox retry <taskId>
ffc bill-inbox ignore <taskId>
ffc bill-inbox archive <taskId>
ffc bill-inbox cleanup-stale
```

`sync` 用内置的支付宝、微信、招行规则扫信箱。支付宝的账单邮件是带密码的 ZIP 附件；
微信的是正文里一个财付通下载链接，Firefly 会先把加密 ZIP 抓下来再问密码。
`secret submit` 之后解析出的 CSV/XLSX/PDF 行可以 `rows --summary` 或 `review` 看，
`row update` 改，`import` 试算，`--confirm` 落库。

试算输出默认是精简的：只有计数、行 ID、状态、错误和脱敏预览。要看生成的 Firefly
payload 才加 `--include-payload`。

## 资源

标准 CRUD：

```bash
ffc accounts list
ffc accounts get <id>
ffc accounts create --name "现金" --type asset
ffc accounts update <id> --name "钱包" --set order=1
ffc accounts delete <id>
```

同一套形状还覆盖 `budgets`、`categories`、`tags`、`bills`、`currencies`、
`webhooks`、`transactions`。

> `bills`、`currencies`、`webhooks` 在 abaku-web 界面上是明确不做的（理由见
> `../docs/design/redesign-decisions.md`），CLI 这边留着，因为它们是 Firefly 的
> 原生接口，偶尔要手工查一下。

列表命令的通用参数：

```bash
ffc accounts list --page 1 --limit 50 --sort name --filter type=asset
```

要发完整的 Firefly payload 就传 JSON：

```bash
ffc budgets create --json '{"name":"日用"}'
ffc bills update 12 --body bill.json
```

建账户有几个省事的快捷方式：

```bash
ffc accounts create --asset --name 微信钱包 --balance 798 --currency CNY
ffc accounts create --liability --name 花呗 --debt 2026.24 --liability-type debt
ffc accounts create --liability --name 助学贷款 --debt 56000 --liability-type loan --notes "2022-08-08 12000; 2023-08-04 12000"
```

快捷方式带的默认值：资产账户 `account_role=defaultAsset`；负债账户
`liability_direction=debit`、`interest=0`、按月计息（除非 `--liability-type loan`）。
`--currency` 默认 CNY，`--date` 默认今天。

## 交易

```bash
ffc transactions create --type withdrawal --source 1 --destination 2 --amount 12.34 --description "咖啡"
```

批量导入，先试算再写：

```bash
ffc transactions import --input transactions.json --dry-run --format json
ffc transactions import --input transactions.json --timezone Asia/Shanghai --confirm --format json
```

输入可以是 JSON 数组，也可以是带 `transactions` 数组的对象。每行认这些字段：
`type`、`date`、`source_id` 或 `source_name`、`destination_id` 或 `destination_name`、
`amount`、`description`、`category_name`、`notes`、`tags`。试算会把每行标成
`create`、`duplicate` 或 `ambiguous`，确认时只提交 `create` 的那些。

账单时间戳是本地时间（支付宝、微信、银行流水都是），要带 `--timezone Asia/Shanghai`；
发生转换时试算输出里会同时给出 `originalDate` 和 `fireflyDate`。

只读的消费汇总：

```bash
ffc transactions summary --start 2026-07-01 --end 2026-07-31 --format json
ffc transactions summary --start 2026-07-01 --end 2026-07-31 --exclude-category 房租
```

给出按交易类型的合计、日常消费口径的支出（支出减去转账和排除分类）、分类和商户
排行、支付账户分布，以及逐日明细。`--exclude-category` 在默认排除项之外再加，可重复。

## 平台操作

管理员命令要 owner/admin 权限的令牌：

```bash
ffc admin users list
ffc admin users get <id>
ffc admin users create --email user@example.com --password <password>
ffc admin users update <id> --email new@example.com
ffc admin users delete <id>

ffc config list
ffc config get <key>
ffc config set <key> <value>

ffc data export transactions --output transactions.json
ffc cron run --token <cliToken>
```

`cron run` 对本项目要注意：Firefly 的 cron 默认会跑全部六项，其中 `create-recurring`
会自动生成定期交易，和界面上「订阅点一下记这一笔」撞车导致重复入账。部署里跑的是
`firefly-iii:cron --create-auto-budgets`，只保留预算按月续期。手工调这个命令前先看
`../docs/implementation-plan.md` 的阶段 0 结论。

## 打任意接口

```bash
ffc api GET /api/v1/accounts --format json
ffc api POST /api/v1/accounts --json '{"name":"现金","type":"asset"}'
ffc api PUT /api/v1/accounts/1 --body account.json
ffc api DELETE /api/v1/accounts/1
ffc api GET /api/v1/accounts --query page=1 --query limit=50
```

请求带 `Accept: application/json`，配了令牌就带 `Authorization: Bearer <token>`，
写 JSON 时带 JSON 的 `Content-Type`。

## doctor local 目前不可用

```bash
ffc doctor local --root ../firefly-iii --url http://127.0.0.1:18001
```

这个命令是按早期形态写的，现在三项检查已经对不上了，修好之前别信它的结论：

- 查的是 SQLite 数据库文件，但现在跑的是容器里的 PostgreSQL。
- 查 `public/build/manifest.json` 和 `public/v1/js/app.js`，但 Firefly 自带的 Web
  前端已经整个删掉了（界面是 abaku-web），这两个产物本来就不该存在。
- `frontpageAccounts` 偏好也是从 SQLite 里读的，同上。

`APP_URL`、`TZ`、HTTP 可达性这三项还是对的，但默认 URL 写的是 8000，要手动传 18001。

## 出错时

- `Authentication failed`：看 `ffc auth status`、令牌值、令牌有没有过期。
- `Permission denied`：这个接口多半要 owner/admin 权限。
- `Not found`：确认 profile 里的 base URL 和接口路径。
- `Unsupported content type`：写 JSON 要用 `--json` 或 `--body`。
- `Validation failed`：Firefly 拒了 payload，加 `--format json` 看它说了什么。
- `Could not reach Firefly III`：服务没起，或者 profile 里的 URL 不对。

## 提交前

```bash
npm test -- --run
npm run build
npm run lint
npm run format:check
```
