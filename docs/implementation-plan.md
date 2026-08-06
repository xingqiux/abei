# Abaku 重构：做了什么

编制 2026-08-05，同日完工后改写成记录。上游文档：`docs/design/redesign-decisions.md`（决策）、
`docs/design/feature-inventory.md`（Firefly 接口对照）。

原计划分七个阶段。七个都做完了，下面按阶段记实际落地的东西，以及和计划不一样的地方。
阶段 0 那几条验证结论单独留在最后——那是查代码查出来的，重查一遍很费事。

---

## 结果

| 项 | 动工前 | 现在 |
|---|---|---|
| 源码（非测试） | 98 文件 / 13,009 行 | 111 文件 / 14,741 行 |
| 测试 | — | 37 文件 / 208 例 |
| 硬编码 Tailwind 调色板类 | 1030 处 / 58 文件 | 0 |
| 颜色字面量 | 7 处 / 5 文件 | 1 处（底部 tab 的阴影 alpha） |
| `src/index.css` | 86 行 | 244 行 |
| `api/firefly.ts` | 1196 行 | 1137 行 |
| `api/queries.ts` | 981 行 | 933 行 |
| 侧栏一级导航 | 8 项 | 6 项 |

文件数和行数是涨的：删掉了一批不接的适配函数，但加了 `components/ui/` 七个通用控件、
DataTable、今天页、订阅 tab、令牌面板和对应的测试。

---

## 阶段 0 · 验证与补接口

三个 recurrence 问题各有结论（见文末），存量规则查过，Firefly 侧补上了
`GET /api/v1/tokens` 和 `DELETE /api/v1/tokens/{id}`（`TokenController.php`，
集成测试 12 例 40 断言）。

## 阶段 1 · 改名 Abaku

`granary-web` → `abaku-web`，顶层仓库目录也跟着改成 `abaku`。favicon、侧栏字标换成
`AbakuMark`。存储键 `granary.*` 故意没动，代码里留了注释说明不是漏改。

## 阶段 2 · 视觉地基

`src/index.css` 重写成 token 层：中性分层、语义色、品牌色，浅深各一套。
`MoneyText` 改成只接受语义（`income` / `expense` / `transfer` / `neutral`），
金额颜色统一由 `lib/format.ts` 的 `semanticColorClass()` 决定。主题跟随系统、可手动锁定，
行高 40/48 两档。

和计划不一样的地方：品牌色最后不是炭墨无彩色，是靛蓝（`--brand` / `--brand-text` 两个值，
前者做实心底、后者做页面上的文字色——深色主题下拿实心底的颜色当文字用只有 2.x:1）。

新增 `npm run check:colors`（挡 Tailwind 调色板类）和 `npm run check:contrast`
（按 WCAG 算对比度，正文 4.5:1、控件边界 3.0:1，两套主题都算），都进了 CI。

## 阶段 3 · 骨架与首屏

侧栏 8 → 6。`/bill-inbox` 和 `/reconciliation` 路由保留，从今天页的待办区和 Cmd+K 进。
今天页按状态切：有待办列待办，待办清空换成「本月还能花」，没配预算时给引导而不是显示 0。
移动端是底部 5 tab +「我的」sheet。

## 阶段 4 · 交易工作台

自建 `DataTable`（列定义 + 密度 + 粘性分组头 + 行选择 + 键盘），`useListKeyboard`
（↑↓ 移动、Enter 展开、C 改分类、E 编辑、X 选中），`buildFireflyQuery()` 把筛选条件
编译成 Firefly 查询语言走 `/search/transactions`。筛选状态进 URL。批量改分类/预算/标签
走 `POST /data/bulk/transactions`。

## 阶段 5 · 订阅闭环

预算页加「订阅」tab，每行「记这一笔」调 `POST /recurrences/{id}/trigger`。
今天页待办区有「本月待付 N 笔」。设置页的 `AutomationPanel` 整块删了，
`BillRow.tsx` 也删了——Bills 不做。

## 阶段 6 · 账户与设置收口

归档改成真归档（`PUT /accounts/{id}` 设 `active=false`），列表加「显示已归档」开关；
真删除挪到账户详情页底部，要一字不差输入账户名才能点。设置页有令牌列表和撤销、
主题和行高开关，币种 Card 和规则部分都删了。

## 阶段 7 · 清库存

删掉规则、Webhooks、储蓄罐、对象组、交易链接、用户组这几组的适配函数和 hooks，
删了 `PiggyRow.tsx`，卸了 `matter.js` 和 `lenis`。币种只留一个只读的 `getCurrencies()`，
账户表单选币种要用。

---

## 计划之外补做的

原计划到阶段 7 就收工，实际又过了一遍交互和无障碍，因为界面「能看」之后才暴露出下面这些：

- **控件层收口**。抽出 `components/ui/`：Button/IconButton、Card、Field（Input/Select/
  Textarea）、Badge、Tabs、SegmentedControl、Dropdown。之前每页各写各的输入框和按钮，
  同一张表单里两种边框是常态。
- **弹层换 @headlessui/react**。Modal、下拉、标签页、单选组的焦点陷阱、Esc 关闭、
  点外面关闭、关掉之后焦点回到触发器，之前是手写的，最后一件基本都没做。
- **删掉全部 `window.confirm`**（附件删除、记账表单三处）。原生对话框不受主题控制，
  在手机浏览器上长相各异，也说不清要放弃的是什么。换成写明对象和后果的确认弹层。
- **表单校验从 toast 挪回字段本身**（账户对话框、CSV 导出）。toast 浮在右上角，
  出错的输入框在左下角，看完还得自己找回来。
- **无障碍**：补 `role="status"` / `aria-live`、命令面板的 `listbox` + `activedescendant`、
  拆分编辑器的 `fieldset` + `legend`、日历格和 Combobox 的键盘聚焦反馈、
  底部 tab 红点的 `sr-only` 文字。
- **修了几处实打实的 bug**：深色主题下底部 tab 选中态用 `--brand` 当文字色看不见；
  支出金额用了 `--danger`（那个 token 写明只给删除类操作）；分析页有个同名局部 `Card`
  把共享的遮住了；四张 KPI 的栅格写成三列；导出面板一直存在也有测试，但没有任何页面
  引到它；手机上没有更换令牌的入口。

---

## 不在这批里

- 改密码 / 2FA 界面（走 artisan 命令）
- 主题编辑器
- 引组件库成品皮肤（tailwind-plus 只当组件行为参考）
- 换状态管理（zustand + React Query 现在的分工是对的）
- 自托管 Inter 字体
- AI 记账、CLI 那条主线——那是下一批，不和这批交叉

已知还欠的：`ffc doctor local` 的三项检查已经对不上现在的部署形态
（查 SQLite、查已删掉的 Firefly Web 前端产物），见 `firefly-cli/README.md`。

---

## 阶段 0 验证结论（2026-08-05，代码级定案）

1. **`active=false` 的 recurrence 不能手动 trigger。** `TriggerController::trigger()` 调
   `CreateRecurringTransactions` 且 `setForce(false)`，而 `validRecurrence()` 对 `active=false`
   无条件跳过（force 只绕过重复期次检查，不绕过 active）。**结论：订阅必须保持 `active=true`，
   靠"不跑自动生成"来防止重复入账。**
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
   不是"生成截至该日的所有期次"。
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
