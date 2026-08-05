# Abaku 重构实施计划

编制日期：2026-08-05。上游文档：`docs/design/redesign-decisions.md`（决策）、`docs/design/feature-inventory.md`（接口对照）。
本文只回答三件事：**这批要做哪些活、按什么顺序做、每一阶段做完是什么样**。

---

## 总览

| 阶段 | 内容 | 改动面 | 做完的效果 |
|---|---|---|---|
| 0 | 验证与补接口（后端） | Firefly 一个控制器 + 三个结论 | 后面两个功能不会做到一半发现方案不成立 |
| 1 | 改名 Abaku | 目录 + 十来个配置文件 | 一个纯改名 commit，之后的活都落在新名字下 |
| 2 | 视觉地基 | 58 个文件 / 1030 处颜色 | 界面一次性脱离半成品观感 |
| 3 | 骨架与首屏 | 路由 + 侧栏 + 今天页 | 打开就知道该干什么 |
| 4 | 交易工作台 | 新建 DataTable + 交易页重写 | 天天用的那页能筛、能批量改、能纯键盘 |
| 5 | 订阅闭环 | 预算页加 tab | 订阅提醒 → 点一下 → 生成交易 |
| 6 | 账户与设置收口 | 账户页 + 设置页 | 不会再误删账户，令牌能自助撤销 |
| 7 | 清库存与收尾 | 删约 110 个适配函数 + 卸两个依赖 | 维护面缩到只剩真正在用的 |

**并行关系**：阶段 0 是后端 PHP，可以和阶段 1、2 同时进行。阶段 2 是 3/4/5/6 的前置，必须先做完。阶段 5 和 6 之间无依赖，可换顺序。阶段 7 收尾。

---

## 阶段 0 · 验证与补接口

不产出任何界面，但它决定后面两个功能能不能按现在的设计做。

**要做的**

1. 拿真实数据验 recurrence 的三个问题：
   - `active=false` 的 recurrence 还能不能手动 trigger
   - Firefly 的 cron 会自动生成 active 的 recurrence，怎么关掉——是不跑 cron，还是靠 `repeat_until` / repetitions 配置
   - `POST /recurrences/{id}/trigger` 的 `date` 参数语义：按这个日期生成一笔，还是生成截至这个日期的所有期次
2. 查数据库里存量的 rules。**删规则界面不等于关引擎**——Firefly 后端在新建交易时照样跑规则，界面删了就没地方看见它们。逐条决定禁用还是留，结论写进文档。
3. Firefly 侧补两个端点，读写 `oauth_access_tokens`：
   - `GET /api/v1/tokens` — 列出当前用户的令牌（名称、创建时间、最后使用时间、是否已撤销）
   - `DELETE /api/v1/tokens/{id}` — 撤销

**做完的效果**：三个问题各有一句写死的结论；`curl` 能列出和撤销令牌。阶段 5、6 可以放心开工。

**风险**：如果 `active=false` 不能 trigger，订阅方案要改成「保持 active + 停掉 cron」，这会牵动部署方式（cron 容器要停），必须提前知道，不能等做到一半。

---

## 阶段 1 · 改名 Abaku

纯机械，零行为变化，单独一个 commit 便于回滚。

**要做的**

- `granary-web` → `abaku-web`（`git mv`）
- `package.json` 的 `name`、`index.html` 的 `<title>`
- `public/favicon.svg` 换成 `docs/design/brand/abaku-mark-16.svg`（现在还是 Vite 默认的紫色闪电）
- 侧栏字标：现在是 indigo 方块里写「谷」，换成 `abaku-mark.svg` + 「Abaku / 算珠」字标
- `compose.yml` 服务名、`Makefile` 的 `WEB_DIR`、nginx 配置、Dockerfile
- 存储键 `granary.*` **保持不动**，在代码里留一行注释说明是故意的，免得后人当成漏改

**单独一步，要先确认**：顶层仓库 `firefly-ai-accounting` → `abaku`。它会连带影响 GitHub remote、本地路径，以及 Claude Code 按路径生成的项目目录——`~/.claude/projects/-Users-youla-proj-firefly-ai-accounting/` 下的记忆和会话历史改名后对不上，要一起搬。建议放在整批工作的最后做。

**做完的效果**：全仓库不再出现「谷仓 / granary」的可见字样（存储键除外），侧栏和浏览器标签页都是新标志。

---

## 阶段 2 · 视觉地基

这批里最大的一块机械工作，也是收益最直观的一块。

**要做的**

1. **重写 `src/index.css` 的 token 层**（现在只有 86 行，等于没有）。三组变量，深浅各一套：
   - 中性分层：Carbon 式「抬升 = 表面变浅」，深色下不要用阴影表达层级
   - 语义色：收入 / 支出 / 转账 / 需要注意 / 危险 / 已完成（色值见 `redesign-decisions.md` 的语义色板）
   - 品牌色：炭墨无彩色，浅 `#2B2A24` / 深 `#EDEBE1`
2. **`MoneyText` 改签名**：只接受语义（`income` / `expense` / `transfer` / `neutral`），组件内部强制 `+`/`-` 前缀、`tabular-nums`、负号排在货币符号前（`-¥32.00`）。隐私模式（`Ctrl+P` 换成 `••••`）只在这一个组件里实现。
3. **主题**：跟随系统，设置里可手动锁定，存进 Firefly preferences。
4. **替换 1030 处硬编码颜色类**，58 个文件。组件一律通过 token，禁止 `'rgb(220 38 38 / 1)'` 这类字面量（`TransactionsPage.tsx` 现在就有）。
5. **密度 token**：行高 40px 默认，48px 可切。

**做完的效果**：界面一次性换掉 Tailwind 默认的 indigo 观感。收入变红、支出用正文色不上色、警示变琥珀、主色变炭墨，深浅两套主题都成立。功能一行没动，但看上去已经不是半成品。

**验收**：`grep` 硬编码颜色类归零；深浅主题各截一轮图；正文与金额对比度过 WCAG AA。

**为什么排这么靠前**：58 个文件的颜色改动如果拖到页面重写之后，等于改两遍。

---

## 阶段 3 · 骨架与首屏

**要做的**

- 一级导航 8 → 6：`今天 / 交易 / 账户 / 预算 / 分析 / 设置`
  - 删掉「总览」「账单收件箱」「按天对账」三个一级入口
  - `/bill-inbox` 和 `/reconciliation` **路由保留**，只是不占侧栏——从「今天」的待办区进，Cmd+K 也能直达
  - 「今天」上挂待办数徽标（`useNavBadges.ts` 已有底子）
- 「今天」页首屏跟着状态走：
  - 有待办 → 显示待办（待审账单 N 笔 / 等解压密码 M 个 / 未对账 K 天 / 本月待付订阅 J 笔）
  - 待办清空 → 换成「本月还能花多少」，大数字 + 进度条 + 剩余天数
  - 两态之间要有过渡，不能突兀地跳
  - 没配预算时显示「去设个预算」的引导，不是显示 0
- 「报表」改叫「分析」，吸收原总览的净资产曲线和余额趋势；「预算与订阅」改叫「预算」
- 日期范围 store 拆页：每页有自己的默认粒度，全局只存上次偏好

**做完的效果**：打开界面就知道今天该干什么；活干完了它告诉你还能花多少。侧栏从八项收到六项，不再有「总览和今天到底看哪个」的问题。

---

## 阶段 4 · 交易工作台

现在交易页只有四个类型 tab，其余全缺。

**要做的**

1. **自建 `DataTable`**：列定义 + 密度 + 粘性表头 + 行选择 + 键盘。不引 TanStack Table——我们的表都是服务端分页，它的客户端排序过滤用不上。
2. **`useListKeyboard`**：`↑↓` 移动、`Enter` 展开、`C` 改分类、`E` 编辑、`X` 选中。交易页和收件箱共用。
3. **`buildFireflyQuery()`**：筛选条件编译成 Firefly 查询语言（`amount:>100 category:餐饮`），走 `/search/transactions`，不需要新接口。
4. **筛选栏**：账户、分类、标签、金额区间、关键词。筛选状态进 URL，可分享可回退。
5. **批量选择 + 批量改**：`POST /data/bulk/transactions` 已经在，能批量改分类 / 预算 / 标签。
6. **粘性日期头**：分组头 sticky 在顶栏下方。
7. `TransactionRow` 从 32px 自绘 div 换成 DataTable 行（32px 放不下复选框，也不满足 WCAG 2.2 的 24×24 触控下限）。

**做完的效果**：交易页从一个只能翻的列表，变成能查、能批量改、能全键盘操作的工作台。这是使用频率最高的页面，单阶段收益最大。

---

## 阶段 5 · 订阅闭环

**要做的**

- 「预算」页加「订阅」tab：列出所有 recurrence、下次到期日、金额
- 每行一个「记这一笔」按钮 → `POST /recurrences/{id}/trigger`，成功后跳到新建的交易
- 「今天」页待办区加「本月待付 N 笔」，点进订阅列表
- 把设置页 `AutomationPanel` 里**已经写好**的 `useTriggerRecurrence` 挪过来，那个面板整块删掉
- 删 `features/budgets/BillRow.tsx`——Bills 不做

**为什么底层用 Recurrence 不用 Bill**：Bill 没有账户和分类模板，也不能生成交易，「点一下记这一笔」无从谈起。Recurrence 天生就是模板加触发。所以界面上只有「订阅」一个概念，`bills` 和 `subscriptions` 两组共 16 个接口整块不接。

**做完的效果**：订阅提醒 → 点一下 → 自动生成一笔交易，闭环跑通。

**依赖**：阶段 0 的三个结论。

---

## 阶段 6 · 账户与设置收口

**要做的**

- **账户「归档」改成真归档**。现在按钮写着「归档」，实际调的是 `DELETE`，Firefly 会连带处理该账户下的交易——这是当前界面上最危险的一个按钮。
  - 归档 = `PUT /accounts/{id}` 设 `active=false`，账户从默认列表隐去，数据全在
  - 列表加「显示已归档」开关
  - 真删除移到账户详情页底部的危险区，要求输入账户名确认
- **设置页**：
  - 令牌列表 + 撤销（用阶段 0 补的两个接口）
  - 主题锁定开关、行高密度开关
  - 删掉币种 Card（`SettingsPage.tsx:76`）——只记人民币
  - 删掉 `AutomationPanel` 的规则部分

改密码和 2FA 继续走 artisan 命令，不做界面。

**做完的效果**：不会再有人点「归档」把交易一起弄没；令牌能自己撤，不用登服务器。

---

## 阶段 7 · 清库存与收尾

**要做的**

- 删 `api/firefly.ts` 里约 110 个不接的适配函数，以及 `queries.ts` 里对应的 hooks：

  | 功能 | 接口数 |
  |---|---|
  | 币种 + 汇率 | 27 |
  | 规则 + 规则组 | 16 |
  | Bills + subscriptions 别名 | 16 |
  | Webhooks | 13 |
  | 储蓄罐 + 对象组 | 14 |
  | 交易链接 + 链接类型 | 11 |
  | 用户 + 用户组 | 8 |
  | 管理员配置 | 3 |
  | 数据销毁 / 清空回收站 | 2 |

- 删 `features/budgets/PiggyRow.tsx`
- 卸 `matter.js`（`src/motion/grainBurst.ts`，谷粒彩蛋——名字都跟着旧名走了）和 `lenis`（`src/motion/useLenis.ts` + `ReportsPage` 的引用）。各自一个依赖只服务一个场景。GSAP 和 Lottie 留。
- 图表补主题适配：切主题时重读 CSS 变量、深色下网格线降到白 6–10%、只保留水平网格、零线加粗、tooltip 显示完整金额（不缩写）
- 回归：vitest 全绿，Playwright 主流程重录

**做完的效果**：前端需要覆盖的接口面从 201 条路径缩到 90 条左右，`firefly.ts` 明显瘦身，依赖少两个。

---

## 不在这批里

- 改密码 / 2FA 界面（走 artisan 命令）
- 主题编辑器
- 引组件库成品皮肤（tailwind-plus 继续只当组件行为参考）
- 换状态管理（zustand + React Query 现在的分工是对的）
- 自托管 Inter 字体（先用系统等宽，视觉定稿后再评估）
- AI 记账、CLI 这条主线（另一条线，不和这批交叉）

---

## 附录：动工前量到的现状

| 项 | 数字 |
|---|---|
| 源码（非测试） | 98 文件 / 13,009 行 |
| 硬编码 Tailwind 调色板类 | 1030 处 / 58 文件（gray 805、indigo 123、red 80、emerald 12、amber 10） |
| `src/index.css` | 86 行 |
| `api/firefly.ts` | 1196 行 |
| `api/queries.ts` | 981 行 |
| 侧栏一级导航 | 8 项 |
| 颜色字面量（`rgb()` / `#rrggbb`） | 7 处 / 5 文件 |

---

## 阶段 0 验证结论（2026-08-05，代码级定案）

1. **`active=false` 的 recurrence 不能手动 trigger。** `TriggerController::trigger()` 调
   `CreateRecurringTransactions` 且 `setForce(false)`，而 `validRecurrence()` 对 `active=false`
   无条件跳过（force 只绕过重复期次检查，不绕过 active）。**结论：订阅必须保持 `active=true`，
   靠“不跑自动生成”来防止重复入账。**
2. **自动生成的开关 = cron。已修。** 本地 `compose.yml` 没有 cron 服务（entrypoint 只跑
   apache + migrate），本地天然不会自动生成。生产部署 `deploy/firefly/docker-compose.yml`
   原先跑的是不带参数的 `php artisan firefly-iii:cron`，那会执行全部六项、包含
   `create-recurring`，订阅上线即重复入账（手动一条 + cron 一条）。

   **改法**：命令带上分项开关。`Cron.php:60` 的 `$doAll` 在任一分项开关出现时为 false，
   于是只跑指定项。现在是 `firefly-iii:cron --create-auto-budgets`——只留预算按月续期。
   其余五项对本项目都无意义：`download-cer`（只记人民币，汇率已删）、`check-version`
   （自托管不需要外发版本检查）、`create-recurring`（要防的就是它）、
   `send-subscription-warnings`（Bills 未接入）、`send-webhook-messages`（Webhooks 已删）。
3. **`trigger` 的 `date` 参数 = 按该日期生成一笔。** `handleOccurrence()` 只接受与 job date
   相等的期次；同一天已有交易时（`force=false`）跳过，不会重复。传过去的日期就是交易日期，
   不是“生成截至该日的所有期次”。
4. **存量规则审计：本地库已查，无存量规则，不需要处置。**（2026-08-05 对本地 dev 库）

   ```sql
   SELECT r.id, r.title, r.active, r.stop_processing, rg.title AS grp
   FROM rules r LEFT JOIN rule_groups rg ON rg.id = r.rule_group_id ORDER BY r.id;
   ```

   结果 0 行。`rule_groups` 有两条（「默认规则」「订阅规则组」），但都不含任何规则，是
   Firefly 建用户时自动生成的空壳。顺带查了其它会被界面遗弃的表：`bills` 0、
   `piggy_banks` 0、`object_groups` 0、`webhooks` 0、`journal_links` 0、`recurrences` 0；
   `link_types` 4 条是 Firefly 内置的种子参考数据，无副作用。

   **注意这是 dev 库的结论。** 生产库上线前要用同一条 SQL 再跑一遍——界面删掉之后规则引擎
   仍会在新建交易时执行，生产上真有规则的话既看不见也关不掉。命令：
   `docker compose exec -T db psql -U firefly -d firefly -c "<上面那条 SQL>"`
5. **后端接口已补**：`GET /api/v1/tokens`、`DELETE /api/v1/tokens/{id}` 已实现（
   `TokenController.php` + `routes/api.php`），并有集成测试
   `tests/integration/Api/User/TokenControllerTest.php`（12 例 40 断言）。

   **怎么筛出「个人访问令牌」这件事踩了两次坑，记下来免得再踩：**

   - ❌ `whereNull('client_id')` —— 错。Passport 的 PAT 也挂在一个 client 上，`client_id`
     非空，这么写会把 PAT 全滤掉。
   - ❌ `whereHas('client', fn($q) => $q->where('personal_access_client', true))` —— 也错。
     迁移 `2026_04_13_185808_migrations_04_2026.php` 为 Passport 13 重建了 `oauth_clients`，
     幸存的列是 `id, owner_type, owner_id, name, secret, provider, redirect_uris,
     grant_types, revoked, created_at, updated_at`，**没有 `personal_access_client`**。
     危险的是它在 SQLite 上不报错：未知的双引号标识符被当成字符串字面量，
     谓词变成 `'personal_access_client' = 1`，恒假，于是 `GET /api/v1/tokens` 对所有人
     都静默返回 `{"data":[]}`。换到 Postgres/MySQL 才会炸成 500。
   - ✅ `whereHas('client', fn($q) => $q->whereJsonContains('grant_types', 'personal_access'))`
     —— 对。这与 Passport 13 的 `ClientRepository::personalAccessClient()` 判定方式一致
     （`hasGrantType('personal_access')`）。`grant_types` 是 TEXT 列，内容形如
     `["personal_access"]`；Postgres 上 Laravel 生成 `(grant_types)::jsonb @> ...`，
     已对本地 Postgres 17 实测通过（不只是 SQLite 测试环境）。

   另有一个同批修掉的 bug：控制器漏了 `use Laravel\Passport\Token;`，`Token` 解析成不存在的
   `FireflyIII\Api\V1\Controllers\User\Token`，导致 `index()` 和 `destroy()` 一律 500。
