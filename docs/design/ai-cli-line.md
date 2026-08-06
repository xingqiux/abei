# AI/CLI 主线设计

起草 2026-08-05。上游：`../implementation-plan.md`（前一批重构的记录）。
iCloud 笔记里的《账单收件箱子系统》和《Firefly API 清单》是这条线的事实基础，本文不重复它们。

这条线的一句话目标：**账单邮件进来之后，不用一条条看**。

---

## 一、先说清楚 AI 到底做什么

容易搞错的地方是把 AI 当成整条流水线。实际上流水线已经建好了，而且建得不差：

拉邮件 → 解析 → 三层查重 → **审阅分桶** → 入账。

`GET /api/v1/bill-tasks/{id}/review` 这个端点已经把每一行分好了桶，每桶带一句中文理由：

| 桶 | 含义 | 谁来处理 |
|---|---|---|
| `new` | 干净的新流水 | 缺分类和描述 → **AI 补** |
| `duplicate` / `conflict` | 机器判定的重复 | 已经确定，跳过，不用管 |
| `crossSource`（high 置信度） | 和已有 Firefly 交易高度重合 | 已经确定，建议跳过 |
| `crossSource`（medium 置信度） | 模糊命中，现在必须人看 | → **AI 先给判断** |
| `transfer` | 疑似自己账户间转账 | → **AI 判断转到哪个账户** |
| `needsUserNote` | 用途不明（比如「转账」两个字） | → **AI 试着补，补不出就留给人** |

所以 AI 的活是四件事，不是一整条线：

1. 给 `new` 行填 `category_name` 和 `firefly_description`
2. 给 medium 置信度的跨来源命中一个「重不重复」的判断
3. 给 `transfer` 行认出对手账户
4. 给 `needsUserNote` 行补一句说得清的备注

**剩下的一切都不要碰。** 机器已经判定的重复不需要 AI 复核——那是三层指纹算出来的，
比语言模型可靠。

## 二、AI 的输入够不够

够。两个之前担心的点都查过了：

- **脱敏不挡事**。`review` 输出走 `redactText()`，但它只把 7 位以上的连续数字打码
  （卡号、订单号），商户名、商品说明、金额、时间全都是原文。分类需要的信息都在。
- **历史是现成的**。要「上次这个商户记的什么分类」，`/api/v1/search/transactions`
  支持查询语言（`description:星巴克`），能直接查。

不够的地方有一个，见第五节。

## 三、MCP 工具面

`ffc bill-inbox` 有 20 个子命令，但**不要 1:1 映射成 20 个 MCP 工具**。
那 20 个里有一半是运维命令（`artifacts`、`artifact download`、`events`、`cleanup-stale`、
`archive`、`retry`、`settings set`），agent 用不上，摆在工具面里只会让它选错。

按 agent 真正要做的事收成 8 个：

| 工具 | 底层 | 干什么 |
|---|---|---|
| `list_bill_tasks` | `GET /bill-tasks` | 有哪些任务在等，各自什么状态 |
| `review_bill_task` | `GET /bill-tasks/{id}/review` | 拿分好桶的行。**这是主入口** |
| `update_bill_row` | `PATCH /bill-statement-rows/{id}` | 写回分类、描述、备注、标签 |
| `split_bill_row` | `POST /bill-statement-rows/{id}/split` | 组合支付拆成多笔 |
| `import_bill_task` | `POST /bill-tasks/{id}/import` | 先干跑，人确认后再带 `confirm` |
| `submit_bill_secret` | `POST /bill-tasks/{id}/secret` | 交解压密码/验证码 |
| `search_transactions` | `GET /search/transactions` | 查历史，用于「上次记的什么分类」 |
| `spending_summary` | `ffc transactions summary` 那套 | 回答「这个月花了多少」这类问题 |

工具面放在 `firefly-cli` 里作为一个 `ffc mcp` 子命令，不另开包：它要复用
`http-client.ts`、`config-store.ts`（profile 和令牌）、`bill-task-service.ts`，
另开包等于把这三样再抄一遍。

## 四、不能让 AI 直接落库

**`import` 永远要人点一下 `confirm`。** 干跑（`confirm=false`）随便 AI 调，
落库那一下必须是人。理由不是"AI 不可靠"这种笼统说法，是具体的：

- 入账走的是 Firefly 的标准 `TransactionGroupRepository::store()`，写进去就进了
  规则引擎、webhook、审计，撤销要一条条删。
- 账单子系统入账时主动关掉了 Firefly 自带的哈希查重
  （`error_if_duplicate_hash=false`），防重完全靠自己那三层。AI 绕过审阅直接入账，
  等于把最后一道人工闸门也拆了。

`update_bill_row` 可以让 AI 自己写——它改的是待入账的草稿，不是账本。

## 五、要补的一件事：分不清哪些是 AI 猜的

**这是开工前必须先解决的问题。**

现在 `PATCH /bill-statement-rows/{id}` 一律把 `user_modified_at` 设成当前时间，
而 `BillStatementRowIdentityService` 看到这个字段非空就再也不覆盖这一行
（`preservedUserEdits`）。

好处是 AI 写的东西不会被重新解析冲掉。问题是：

- 事后看不出某一行的分类是自己选的还是 AI 猜的。
- AI 一次猜错两百行，没有任何办法把它们挑出来批量回退。
- 「人已确认」和「AI 待确认」在数据上完全一样，审阅界面没法把后者标出来。

三个改法：

| 方案 | 做法 | 代价 |
|---|---|---|
| 加一列 | `bill_statement_rows` 加 `suggested_by`（null / `ai`）+ `suggested_at` | 一个迁移，最干净 |
| 塞 notes | 在 `notes` 里写个前缀标记 | 不用迁移，但 notes 是给人看的，会脏 |
| 打标签 | 入账时带一个 `ai-suggested` 标签 | 只在入账之后才有，草稿阶段还是分不清 |

**选加一列。** 这是 AGENT.md 第 7 条说的那种"往长了做"的地方：等到有几千行
AI 改过的数据之后再补这个字段，就没法回填了。

配套的行为：`update_bill_row` 带一个 `as_suggestion` 参数，AI 调的时候传 true，
写 `suggested_by='ai'`；人在界面上改则清掉这个标记，表示已确认。

## 六、验证码这件事

支付宝的解压密码在支付宝服务消息里、微信的在公众号里、招行中行的在 App 里——
**都不在邮箱里**，所以"让 AI 去邮箱捞验证码"这个想法多半不成立。

先做能做的：招行信用卡日账单那条渠道根本不需要密码（正文 HTML 直接解析）。
其余四个渠道，AI 能做的是把"现在卡在等哪个密码"说清楚，并且在人给出密码后
自动往下推——而不是自己去找密码。

顺带一个现成的坑要一起修：**密码挑战没有失败保护**，密码填错也算 consumed，
得 `retry` 整个任务重来。AI 会比人更频繁地试错，这个必须先加上尝试上限和重开挑战。

## 七、动工顺序

1. **加 `suggested_by` 列**（迁移 + `PATCH` 的 `as_suggestion` 参数 + review 输出带上它）。
   先做这个，因为它是数据结构，越晚做代价越大。
2. **密码挑战加失败保护**（尝试上限、错了不算 consumed）。
3. **`ffc mcp`**：先把上面 8 个工具接出来，能跑通「列任务 → 拿 review → 改一行 → 干跑」。
4. **归类**：给 `new` 行补分类。这一步的质量取决于历史检索做得好不好，
   可能需要在 Firefly 侧加一个"按商户名查历史分类"的端点，比反复调 search 省事。
5. **medium 置信度判断**和 **transfer 对手账户识别**。
6. **`needsUserNote` 补备注**。

3 之前的两步都是后端小改动，做完再动 CLI。

## 八、顺带要还的账

- `ffc doctor local` 三项检查对不上现在的部署形态（查 SQLite、查已删掉的 Firefly
  前端产物）。要么删要么改。
- `sync-bill-mailbox` / `process-bill-tasks` 两个 artisan 命令没挂 scheduler。
- 账单状态字符串没有常量类，前端删掉之后连一份权威清单都没有了，改动只能 grep。
