# 改名残留全扫（阶段 0 · 盘点）

2026-08-09 · 对应 `docs/design/abei-refactor.md` §九、§十

扫描词（大小写敏感）：`abaku` / `Abaku` / `ABAKU` / `算珠` / `ffc`（词边界）/ `firefly-cli` / `FIREFLY_CLI` / `abaku_ai`。
排除：`.git`、`node_modules`、`dist`、`build`、lockfile、二进制资源、`granary-server/`（继续封存）、`firefly-iii/` 中对 Firefly III 引擎自身的称呼。

**总量：135 个文件，781 处。**

| 组 | 文件数 | 出现处 |
|---|---:|---:|
| A CLI 包名/bin/配置/env（`firefly-cli/`） | 25 | 342 |
| B/C web 文案与代码标识符（`abaku-web/`） | 71 | 196 |
| D 编排 / CI / 部署 | 8 | 78 |
| E 文档（README、docs/） | 6 | 75 |
| F 设计稿（`designs/`） | 8 | 12 |
| G firefly-iii 里的 abaku 附加物 | 14 | 68 |
| H 品牌 SVG | 3 | 10 |

---

## A. CLI 包名 / bin / 配置路径 / env（25 文件 / 342 处）

改名后这些全部消失或迁走：`firefly-cli/` 目录本身收缩为 `abei-agent/`，commander 命令树退役（§六），
所以本组中大部分 `ffc` 出现在**将被删除的代码**里，不需要逐个替换——但仍需确认删除边界。

**真正的硬契约（必须改，不能只删）**

| 文件 | 内容 |
|---|---|
| `firefly-cli/package.json:2,6-7` | `"name": "firefly-cli"`、`"bin": { "ffc": "./dist/cli.js" }` |
| `firefly-cli/src/core/config-store.ts:31` | `process.env.FIREFLY_CLI_CONFIG ?? join(homedir(), '.config', 'firefly-cli', 'config.json')` |
| `firefly-cli/tests/core/config-store.test.ts`（`firefly-cli`×3、`FIREFLY_CLI`×6） | 配置路径与 env 的回归 |
| `firefly-cli/tests/commands/{auth,base,bills,platform,resources}.test.ts` | `FIREFLY_CLI_CONFIG` 各 4–5 处 |
| `.gitignore:7,16,17` | `firefly-cli/node_modules/`、`dist/`、`coverage/` |

> 配置路径与 env 变量名是**用户机器上的既有状态**。硬切后旧 `~/.config/firefly-cli/config.json`
> 不再被读取，用户需要重新 `abei auth login`。方案已定「不留过渡别名」，这里只是提醒把它写进发布说明。

**将被删除的代码里的 `ffc`（不必替换，随删除消失）**

- `firefly-cli/src/cli.ts`（`ffc`×8，含 `.name('ffc')` 与 help 示例）
- `firefly-cli/src/commands/platform.ts`（×6，`ffc config` 用法块）
- `firefly-cli/src/services/system-overview.ts`（×4，能力清单里的示例命令）
- `firefly-cli/src/capabilities/mcp-server.ts`（×2，`{ name: 'ffc', version: '1.0.0' }`）——本文件按 §七 整体删除
- `firefly-cli/src/core/command-context.ts:27`：`'No active Firefly profile configured. Run "ffc auth set-token" first.'`
- `firefly-cli/src/services/local-doctor.ts:190`：`.ffc-doctor-write-check-<pid>` 探针文件名
- `firefly-cli/src/agent/server.ts:37`：系统提示词里「不声称自己能执行未提供的 shell、**ffc api**……」——**这条会留下**（agent 保留），必须改

**保留但要改的（agent 侧）**

- `firefly-cli/src/agent/store.ts`：`abaku`×64 / `abaku_ai`×63 —— 见 F 组，DB schema。
- `firefly-cli/src/agent/{autofill,backfill}.ts`：`Abaku`×1 各，提示词/注释。
- `firefly-cli/README.md`：`ffc`×76、`firefly-cli`×2、`FIREFLY_CLI`×1、`abaku_ai`×1、`Abaku`×3 —— 整篇重写。
- `firefly-cli/docs/superpowers/specs/2026-06-02-firefly-cli-design.md`：`ffc`×38 —— 历史设计稿，建议整份归档而非逐字替换。

---

## B. web 界面文案（算珠 / Abaku）

用户可见文案，逐条改为「阿贝 / abei」：

| 位置 | 原文 |
|---|---|
| `abaku-web/index.html:7` | `<title>Abaku 算珠</title>` |
| `abaku-web/src/components/layout/Sidebar.tsx:30,33` | `Abaku` / `算珠` 两行品牌名 |
| `abaku-web/src/components/TokenGate.tsx:80` | `<span …>Abaku 算珠</span>` |
| `abaku-web/src/features/settings/SettingsPage.tsx:200,209` | `关于 Abaku`、`Abaku Web` |
| `abaku-web/src/features/settings/SettingsPage.tsx:27` | 分区描述 `AI 服务与 ffc` |
| `abaku-web/src/features/settings/TokensPanel.tsx:39,92,169,190` | `ffc 连接` / `ffc 一键配对` / `连接 ffc` / `在安装了 ffc 的终端运行…` |
| `abaku-web/src/lib/format.ts:40` | 注释「按 Abaku 规范格式化…」 |
| `abaku-web/src/assets/lottie/README.md`、`raw/sources.txt` | 「改色成 Abaku 设计 token」 |

**§九 点名的 TokensPanel 配对命令**（这是本组里唯一有行为的一处，不是纯文案）：

```
abaku-web/src/features/settings/TokensPanel.tsx:32
  return `ffc auth set-token --profile abaku --url ${shellQuote(...)} --token ...`
abaku-web/src/features/settings/TokensPanel.tsx:51
  const token = await createApiToken('ffc CLI')
abaku-web/src/api/firefly.ts:1226
  export async function createApiToken(name = 'ffc AI')
```

配套测试须同步：`TokensPanel.test.tsx`（`ffc`×7、`abaku`×5，断言里写死了
`/^ffc auth set-token --profile abaku --url '.+' --token 'pat-abc-/`）。
按 §九，这里要收敛成一条 `abei auth login`，`auth set-token` / `config` 双轨一并消灭——
所以不是替换字符串，是重写这段 UI 与测试。

---

## C. web 代码标识符（71 文件 / 196 处，其中约 150 处是同一件事）

**大头是目录名 `src/components/abaku/`。** 196 处里绝大多数形如：

```
import { Modal }      from '../../components/abaku/Modal'        (×14)
import { Skeleton }   from '../../components/abaku/Skeleton'     (×14)
import { ErrorState } from '../../components/abaku/ErrorState'   (×20)
vi.mock('../../components/abaku/Skeleton', () => ({ … }))        (×5)
```

这是纯路径重命名（`components/abaku/` → `components/abei/`，或干脆借机改成
`components/ui-abei/` 之类中性名），一次 `git mv` + 全局替换即可，**机械、零风险**。

**非路径的标识符（要逐个看）**

- **API 前缀 `v1/abaku`**（`abaku-web/src/api/firefly.ts:1090-1104`、`schemas.ts:797,822`）：
  ```
  const raw = await fireflyFetch('/api/v1/abaku/category-stats')
  const raw = await fireflyFetch('/api/v1/abaku/budget-groups', { start, end })
  await fireflyPut(`/api/v1/abaku/budget-groups/${categoryId}`, { amount })
  ```
  与 G 组的 `firefly-iii/routes/api.php` 是同一条契约，必须成对改（或按 §八 一步到位迁进 abei-api）。
- **组件名 `AbakuMark`**：`src/components/abaku/AbakuMark.tsx`（定义）+ `Sidebar.tsx:4,27`、`TokenGate.tsx:13,79`、`EmptyState.tsx:3,23`（引用）。
- **localStorage 键 `abaku.today.insight.dismissed`**（`src/features/today/TodayPage.tsx:33`）：
  **⚠ 这不在 `granary.*` 豁免名单里。** 现存三个豁免键是 `granary.density` / `granary.theme` / `granary.token`
  （见下方「不改」）。`abaku.today.*` 是唯一一个用 `abaku.` 前缀的存储键，改名会丢用户的「今日洞察已关闭」状态。
  需要一条明确决定：跟着改（可接受地丢一次状态）还是同样冻结。
- **注释里的服务名 `abaku-agent`**：`src/api/assistant.ts:117,170`、`schemas.ts:843`、`queries.ts:1040`、`ModelConnectionPanel.tsx:378`。
- **失效文档引用**：`src/api/client.ts:2` 指向 `docs/design/abaku-web-plan.md`（该文件已不存在）。
- **e2e 与 fixture 常量**：`e2e/abaku-journey.desktop.spec.ts`（文件名 + `Abaku E2E …` 常量×2）、
  `src/api/__fixtures__/recurrences.live.json:11`。这些与 G 组 `SeedsE2EEnvironment.php` 的常量**必须同步改**，否则 e2e 直接红。
- 配置类：`abaku-web/{Dockerfile,nginx.conf,package.json,playwright.config.ts,README.md}`。

---

## D. compose / Makefile / CI 服务名（8 文件 / 78 处）

| 文件 | 要改的 |
|---|---|
| `compose.yml` | 服务 `abaku-agent:`(L100)、`abaku-web:`(L139)；`context: ./firefly-cli`(L102)、`./abaku-web`(L141)；env `${ABAKU_AGENT_PORT:-18003}`、`${ABAKU_WEB_PORT:-18002}`；挂载 `./firefly-cli:/workspace`、`./abaku-web:/workspace`。**另需新增 `abei-api` 服务（§二）** |
| `.env.example` | `ABAKU_WEB_PORT=18002`、`ABAKU_AGENT_PORT=18003` |
| `Makefile` | `WEB_DIR := abaku-web`、`CLI_DIR := firefly-cli`，以及 `up/logs/dev/build/build-image` 五处目标里写死的服务名（共 12 处 `abaku`） |
| `.github/workflows/ci.yml` | 矩阵 `project: Abaku Web` / `directory: abaku-web` / `directory: firefly-cli`；job 名 `Abaku Web Playwright`；缓存路径 `abaku-web/package-lock.json`；产物路径 `abaku-web/test-results/`；镜像 `image: abaku-web` / `image: abaku-agent` |
| `deploy/firefly/docker-compose.yml` | 服务 `abaku-web` / `abaku-agent`，`${ABAKU_WEB_IMAGE}` / `${ABAKU_AGENT_IMAGE}`，注释「Abaku 算珠 新前端」 |
| `deploy/firefly/.env.example` | `ABAKU_WEB_IMAGE=docker.xkqq.top/firefly/abaku-web:latest`、`ABAKU_AGENT_IMAGE=…/abaku-agent:latest` |
| `deploy/firefly/README.md` | 12 处 `abaku` + 5 处 `ABAKU` + 3 处 `Abaku` + 1 处 `算珠` |
| `.gitignore` | `firefly-cli/{node_modules,dist,coverage}/` |

⚠ `deploy/firefly/.env.example` 里的**镜像 tag 是已发布的远程制品名**（`docker.xkqq.top/firefly/abaku-web`）。
改名意味着推新 tag；已部署实例的 `.env` 不会自动跟着变。

---

## E. 文档（6 文件 / 75 处）

- `README.md`：`abaku`×19、`firefly-cli`×6、`ffc`×3、`abaku_ai`×1、`Abaku`×1。含 §七 要删的「MCP 与 Abaku Agent」节。
- `firefly-cli/README.md`：`ffc`×76 —— 全篇重写（CLI 已换成 Rust 的 abei-cli，这份文档整体作废）。
- `firefly-cli/docs/superpowers/specs/2026-06-02-firefly-cli-design.md`：`ffc`×38 —— 历史规格，建议归档。
- `docs/design/ai-cli-line.md`：`ffc`×4、`firefly-cli`×1。§六已声明其「§三 MCP 工具面结论作废」。
- `docs/design/feature-inventory.md`（`abaku`×4）、`docs/design/redesign-decisions.md`（`abaku`×5 / `Abaku`×4 / `算珠`×4）、`docs/implementation-plan.md`（`Abaku`×3 / `abaku`×1）。
- `docs/design/abei-refactor.md` 本身有 `abaku`×5 等 —— **是方案文本，不要扫**。
- `AGENT.md`：**零命中**，无需改。

`designs/`（8 文件 / 12 处）是历史设计稿原型（`bill-inbox-redesign`、`today-transactions-redesign`），
含 `Abaku 算珠` 字样。优先级最低，可与品牌重画一并处理。

---

## F. DB schema `abaku_ai` → `abei_ai`

**唯一持有者：`firefly-cli/src/agent/store.ts`（`abaku_ai`×63、`abaku`×64）。**
该文件自己 `CREATE SCHEMA IF NOT EXISTS abaku_ai`（L125）并建 8 张表：

```
abaku_ai.sessions / messages / approvals / model_configs /
abaku_ai.autofill_config / category_rules / feedback_samples / backfill_suggestions / vocab_suggestions
```

SQL 全部是**内联字符串字面量**（`FROM abaku_ai.sessions`、`UPDATE abaku_ai.approvals`、
`JOIN abaku_ai.sessions`、`ON abaku_ai.category_rules` …），没有集中的 schema 常量。

另有两处文档提及：`README.md:62`、`firefly-cli/README.md:220`。

⚠ **这一组必须原子改**：`ALTER SCHEMA abaku_ai RENAME TO abei_ai` 与代码里 63 处字面量
是一件事，分两次提交会让运行中的 agent 直接炸。建议改法：先把 schema 名抽成一个常量
（`const SCHEMA = 'abei_ai'`）+ 一次 `ALTER SCHEMA`，同一次提交落地。

---

## G. firefly-iii 里的 abaku 附加物（14 文件 / 68 处）

引擎本身叫 Firefly III 不动；下列是 fork 里加的 abaku 专属物：

**API 前缀 + 控制器命名空间**

```
firefly-iii/routes/api.php:599   'namespace' => 'FireflyIII\Api\V1\Controllers\Abaku',
firefly-iii/routes/api.php:600   'prefix'    => 'v1/abaku',
firefly-iii/routes/api.php:601   'as'        => 'api.v1.abaku.',
```
- `app/Api/V1/Controllers/Abaku/CategoryStatsController.php`（namespace）
- `app/Api/V1/Controllers/Abaku/BudgetGroupController.php`（namespace + `AbakuGroupBudget`×3）

按 §九 该前缀由 abei-api 承接；按 §八-1 `category-stats` / `budget-groups` 是首批内迁的只读统计。
**建议不要在 fork 里改名，直接随内迁删除**——否则等于改两遍。

**模型与表**

- `app/Models/AbakuGroupBudget.php`：`class AbakuGroupBudget`，`protected $table = 'abaku_group_budgets'`
- `app/Services/Category/GroupBudgetService.php`：`AbakuGroupBudget`×5
- `database/migrations/2026_08_08_000000_add_domain_to_categories.php`：`Schema::create('abaku_group_budgets', …)`、`dropIfExists`
- `app/Console/Commands/Abaku/ResetCategories.php`：namespace `…\Console\Commands\Abaku`、
  `$signature = 'abaku:reset-categories …'`、审计日志文案

**E2E 夹具常量（与 web e2e 强耦合）**

`app/Console/Commands/System/SeedsE2EEnvironment.php`（`Abaku`×12、`abaku`×4）：
`'Abaku E2E Recurrence Source/Title'`、`'Abaku E2E Synthetic Rules'`、`'abaku-e2e-reviewed'`、
`'Abaku E2E Tag Synthetic Lunch'`、临时文件前缀 `abaku-e2e-`、PAT 名 `abaku-e2e`、
合成支付宝邮件主题 `'Abaku E2E 的支付宝交易流水明细'`。
配套 `tests/integration/Console/Commands/System/SeedsE2EEnvironmentTest.php`（`abaku`×9 / `Abaku`×6）
与 `abaku-web/e2e/abaku-journey.desktop.spec.ts` **三处必须同一次改**。

**PAT 名（有运行时含义）**

- `app/Console/Commands/CreatePersonalAccessToken.php:38-39`：`$user->tokens()->where('name','abaku-web')->update(['revoked'…])`、`createToken('abaku-web')`
- `app/Api/V1/Controllers/User/TokenController.php:45`：`$name = (string) $request->input('name', 'abaku-web')`
- 配套 `tests/integration/Api/User/TokenControllerTest.php`（×3）

⚠ 改这个名会让**已签发的 `abaku-web` PAT 失去被 revoke-by-name 的锚点**（旧 token 不会被新代码撤销），
且浏览器里已存的 token 仍然有效。属于「需要小心」的一格。

**纯注释（低风险）**

- `app/Api/V1/Controllers/DailyReconciliation/SummaryController.php:17`：「供 abaku-web 新前端使用」
- `app/Api/V1/Controllers/Models/BillTask/BillInboxController.php:28`：同上
- `routes/api.php:987`：`// … for first-party web clients (abaku-web).`

---

## H. 品牌 SVG（3 文件 / 10 处 + web 侧 2 处）

- `docs/design/brand/abaku-mark.svg`、`abaku-mark-16.svg`、`abaku-appicon.svg`
  （文件名 + 内部 `Abaku 算珠` 注释与 `aria-label="Abaku"`）
- `abaku-web/public/favicon.svg:1,4`：注释 `Abaku 算珠 · 16px 专用简化稿`、`aria-label="Abaku"`
- `abaku-web/src/components/abaku/AbakuMark.tsx:1-2`：`/** Abaku 算珠主标志：算盘的一根档。*/` + `export function AbakuMark`

§九 已写「品牌标志是否随新名重画，另行决定」。**「算盘的一根档」这个图形语义直接来自「算珠」**，
名字改成阿贝之后图形就失去出处。建议把「文件名/aria-label/注释改名」与「图形重画」拆开：
前者随硬切走，后者等重画决定。

---

## 不改（明确列出，防止扫过头）

1. **`granary.*` 存储键**（§一、§九 既定决定）。全仓 3 个键、14 处引用：
   `granary.density` / `granary.theme` / `granary.token`，见
   `abaku-web/src/{api/client.ts, main.tsx, lib/dateRange.ts, store/…, components/…, features/settings/SettingsPage.tsx}`。
2. **`granary-server/`** 整个目录（README 里 1 处 `abaku` 也不动）。
3. **Firefly III 引擎自身的称呼**：`FireflyIII\` 命名空间、`firefly-iii:` artisan 命令、
   `firefly_import`、`fireflyFetch/fireflyPost` 等 —— 这些指的是引擎，不是 CLI 包名。
   注意区分：`firefly-cli` / `FIREFLY_CLI_CONFIG` 要改，`firefly-iii:process-bill-tasks` 不改。
4. `docs/design/abei-refactor.md`（方案本身）。

---

## 建议的清扫顺序

**第 1 批 · 纯机械，可脚本化，单独一次提交（约 160 处）**

1. `abaku-web/src/components/abaku/` → 新目录名 + 全局 import 路径替换。`git mv` 后 `npm run typecheck` 即可自证。
2. `designs/` 与历史文档里的字样（无代码依赖）。
3. 各处纯注释里的 `abaku-web` / `abaku-agent`。

**第 2 批 · 成对改，一次提交内闭环**

4. **API 前缀** `v1/abaku`：`routes/api.php` + `Controllers/Abaku/` 命名空间 + `abaku-web/src/api/{firefly,schemas}.ts` 三处同改。
   —— 或按 §八-1 直接跳过改名、把 category-stats/budget-groups 迁进 abei-api 一步到位（**推荐**，省一次改）。
5. **E2E 夹具常量**：`SeedsE2EEnvironment.php` + `SeedsE2EEnvironmentTest.php` + `abaku-web/e2e/abaku-journey.desktop.spec.ts`。
   任一漏改，e2e 立刻红——这是它自己的验证门。
6. **编排三件套**：`compose.yml` + `.env.example` + `Makefile` + `ci.yml` 一起改，`make up` 冒烟。
   `deploy/firefly/` 另算一次（涉及远程镜像 tag，见 D 组警示）。

**第 3 批 · 需要小心，各自单独一次提交**

7. **`abaku_ai` → `abei_ai`**：`ALTER SCHEMA` + `store.ts` 63 处字面量抽常量，**必须原子**。
   落地前确认 agent 已停；这是全清单里唯一会导致运行时数据不可达的一格。
8. **`abaku_group_budgets` 表 + `AbakuGroupBudget` 模型**：Laravel migration `Schema::rename` + 模型/服务/控制器 4 个文件。
   同样是 schema+代码耦合，但比 7 小得多。
9. **PAT 名 `abaku-web` / `abaku-e2e`**：改之前先决定旧 token 怎么办（G 组警示）。
10. **CLI 配置路径与 env**（`FIREFLY_CLI_CONFIG`、`~/.config/firefly-cli/`）：随 abei-cli 新建，
    旧路径不迁移、不兼容，只在发布说明里写清楚。

**第 4 批 · 随删除消失，不要花时间替换**

11. `firefly-cli/src/{cli.ts, commands/, capabilities/mcp-server.ts, services/system-overview.ts}` 里的 `ffc`（§六、§七 整体删）。
12. `firefly-cli/README.md`（×76）与 `docs/superpowers/specs/2026-06-02-firefly-cli-design.md`（×38）——重写/归档，不逐字替换。
    **例外**：`src/agent/server.ts:37` 的系统提示词里的 `ffc api` 会随 agent 留下来，别漏。

**最后 · 待决**

13. 品牌 SVG 重画（§九 已挂起）。
14. `abaku.today.insight.dismissed` 这个存储键跟不跟着改（C 组警示，`granary.*` 豁免不覆盖它）。
