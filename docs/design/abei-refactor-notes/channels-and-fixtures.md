# 渠道与金样本清单（阶段 0 · 盘点）

2026-08-09 · 为 §八-2「剥 bill-inbox：按渠道 PHP→Rust」备档

范围：`firefly-iii/app/Services/BillIngestion/`（38 个 PHP 文件 / 8130 行）+ 相关模型、控制器、迁移、测试。

---

## 一、总体结构

**注册表**：`app/Providers/FireflyServiceProvider.php:133-141` 单例装配，**顺序即匹配优先级**：

```php
new BillSourceChannelRegistry([
    app(AlipayBillSourceChannel::class),
    app(WechatPayBillSourceChannel::class),
    app(CmbTransactionBillSourceChannel::class),
    app(CmbCreditDailyBillSourceChannel::class),
    app(BocTransactionBillSourceChannel::class),
])
```

`BillSourceChannelRegistry::matchMail()` **首个 `matches()` 为真者胜**（`BillSourceChannelRegistry.php:57-68`）。
⚠ 两个招行渠道 `source()` 都返回 `'cmb'`，靠 `profileIds()` 区分（`cmb-transaction-statement` / `cmb-credit-card-daily`）；
`find(string $source, ?string $profileId)` 在 `$profileId === null` 时返回**第一个** source 匹配者，即交易流水渠道。移植时这条隐式规则要保留。

**接口**（`BillSourceChannel.php`，14 个方法）：
`source / displayName / settingsDescription / profileIds / mailboxSearchCriteria / matches / ingest /
prepare / needsSecret / secretPrompt / process / shouldProcessAfterSecret / processingRule`

**管线**：
```
BillMailboxSyncService（IMAP 拉取 → registry.matchMail → channel.ingest → BillTask）
        ↓
BillTaskProcessor（channel.prepare → needsSecret → 开密码挑战 / channel.process）
        ↓
各 ImportService → BillStatementImport + BillStatementRow（经 BillStatementRowIdentityService.upsertRow）
        ↓
BillStatementRowSummaryService（复核载荷）→ BillStatementRowImportService（写进 Firefly）
```

**后台循环**（`compose.yml:89-98`，将来变 abei-api 内 tokio 任务）：
```sh
while true; do
  php artisan firefly-iii:sync-bill-mailbox --limit=100 || true
  php artisan firefly-iii:process-bill-tasks --limit=100 || true
  sleep ${BILL_WORKER_INTERVAL:-300}
done
```

**artisan 命令**（worker 循环调用的三个入口）：
`app/Console/Commands/Tools/SyncsBillMailbox.php`（`firefly-iii:sync-bill-mailbox`）、
`app/Console/Commands/Tools/ProcessesBillTasks.php`（`firefly-iii:process-bill-tasks`）、
`app/Console/Commands/BillIngestion/CleansBillStatementRows.php`（清理，走 `BillStatementRowDismissalService`）。

**表**（7 张，全在 `firefly-iii/database/migrations/`）：
`bill_mail_messages` / `bill_tasks` / `bill_artifacts` / `bill_task_events` / `bill_secret_challenges`
（`2026_06_10_000000_create_bill_ingestion_tables.php`）、
`bill_statement_imports` / `bill_statement_rows`（`2026_06_15_000000_create_bill_statement_import_tables.php`），
后续三次加列：`2026_06_17_…add_identity_columns`、`2026_08_05_…add_suggestion_columns`、`2026_08_07_010000_add_dismissed_columns`。

---

## 二、逐渠道清单

### 1. 支付宝 Alipay

| 项 | 值 |
|---|---|
| 入口 | `app/Services/BillIngestion/Channels/AlipayBillSourceChannel.php`（209 行） |
| `source` / `profileIds` | `alipay` / `['alipay-statement']` |
| IMAP 条件 | `FROM "service@mail.alipay.com"` |
| 匹配 | 发件人含 `service@mail.alipay.com` **且** 主题含 `支付宝交易流水明细` |
| 输入 | 邮件**附件** ZIP（`attachment_extensions => ['zip']`） |
| 加密 | 是。`needsSecret()` = 存在 `encrypted=true` 的 artifact；提示语「请输入支付宝服务消息中的账单解压密码」（密码来自支付宝服务号消息） |
| 解压 | `AlipayStatementArchiveExtractor.php`（121 行），`ZipArchive` + `setPassword()`；`getFromIndex` 返回 false → `InvalidBillSecretException` |
| 解析 | `AlipayStatementImportService.php`（418 行）。**CSV**。编码 `mb_detect_encoding([UTF-8, GB18030, GBK, BIG5])`，探测失败**兜底 GB18030**；`findHeader()` 找表头行；`str_getcsv`，另有 `explode('|')` 分支；元数据靠正则 `导出时间：[…]` / `起始时间：[…] 终止时间：[…]` |
| 特殊 | 「组合支付」拆分：`收/付款方式` 用 `&` 连接多渠道（如 `招商银行储蓄卡(8705)&花呗`），走 `BillStatementRowSplitService` 人工拆分 |
| 表头（12 列） | `交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注` |

### 2. 微信支付 WechatPay

| 项 | 值 |
|---|---|
| 入口 | `Channels/WechatPayBillSourceChannel.php`（354 行，最复杂） |
| `source` / `profileIds` | `wechat` / `['wechat-pay-statement']` |
| IMAP 条件 | `FROM "wechatpay@tencent.com"` |
| 匹配 | 发件人 + （主题或**正文**含 `微信支付账单流水文件`）+ （含 `账单流水文件` 或正文含 `点击下载`） |
| 输入 | **邮件里没有附件，只有下载链接。** `prepare()` 走 `RemoteBillFileDownloader`（46 行）把 ZIP 下回来，存成 `metadata.source = 'remote_download'` 的 artifact（落到 `bill-inbox/{task}/remote/`） |
| 加密 | 是。密码来自微信支付公众号 |
| 解压 | `WechatPayStatementArchiveExtractor.php`（119 行），同 `ZipArchive` + 密码 |
| 解析 | `WechatPayStatementImportService.php`（**656 行，五个渠道里最大**）。**双格式**：CSV 与 XLSX。XLSX 是**手写解析**——`ZipArchive` 取 `xl/sharedStrings.xml` + `xl/worksheets/sheet1.xml`，`simplexml_load_string` 走单元格（`readSharedStrings` / `readFirstWorksheetTable` / `cellValue`，L438-544）。无 PhpSpreadsheet 依赖 |
| 编码 | 同探测链，但**兜底 UTF-8**（与支付宝的 GB18030 兜底不同，别混） |
| 表头 | `交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注`；正文有 `微信支付账单明细` / `----微信支付账单明细列表----` 分隔行 |
| 特殊 | 商户单号常为占位值，判重要靠交易单号（见 `testWechatPlaceholderMerchantOrderDoesNotHideDistinctPlatformOrders`） |

### 3. 招行交易流水 CMB Statement

| 项 | 值 |
|---|---|
| 入口 | `Channels/CmbTransactionBillSourceChannel.php`（275 行） |
| `source` / `profileIds` | `cmb` / `['cmb-transaction-statement']` |
| IMAP 条件 | `FROM "95555@message.cmbchina.com"` |
| 匹配 | 发件人 + （主题含 `招商银行交易流水` 或正文含 `电子版交易流水`）+ （正文含 `招商银行App` / `流水打印` 或有 zip 附件） |
| 输入 | 附件 ZIP，**包内是 PDF**（不是 CSV） |
| 加密 | 是，「招商银行App"流水打印-申请记录"中的账单解压码」 |
| 解压 | `CmbStatementArchiveExtractor.php`（121 行）。`kindForFilename` 比支付宝版**多一个 `pdf`**分支；解出 `pdf` 后直接调 `CmbStatementImportService::importArtifact()` |
| 解析 | `CmbStatementImportService.php`（371 行）。**外部进程**：`new Process(['pdftotext', '-layout', $path, '-'])`（L266），再对定宽文本跑正则：<br>`/^(20\d{2}-\d{2}-\d{2})\s+CNY\s+([+-]?[0-9,]+\.\d{2})\s+([+-]?[0-9,]+\.\d{2})\s+…/`（有两个宽松度不同的分支）<br>元数据正则：`交易区间 20xx-xx-xx -- 20xx-xx-xx`、`申请时间：`、`账号：`、`验 证 码：`（字符间可能有空格） |
| 特殊 | 行携带**联机余额**（第三个金额列）→ 参与 `BalanceChainVerifier` 余额链校验。<br>`BillStatementRowIdentityService::externalKey()` 对 `'cmb'` **硬编码返回 null**（招行流水没有订单号），只能靠指纹判重 |
| 落盘时 | 新 artifact 的 `metadata.parser_status = 'waiting_for_sample_structure'` |

### 4. 招行每日信用管家 CmbCreditDaily

| 项 | 值 |
|---|---|
| 入口 | `Channels/CmbCreditDailyBillSourceChannel.php`（190 行） |
| `source` / `profileIds` | `cmb` / `['cmb-credit-card-daily']` |
| IMAP 条件 | `FROM "ccsvc@message.cmbchina.com"`。**注释明写**：`IMAP SEARCH 只接受 US-ASCII，中文主题会被 Gmail 以 BAD 拒绝；主题过滤交给 matches()` |
| 匹配 | 发件人 + 主题 `trim()` **严格等于** `每日信用管家` + HTML 正文含 `您的消费明细如下` |
| 输入 | **无附件。数据在邮件 HTML 正文里**（`body_html_path`），落成 `kind='html'` 的 artifact |
| 加密 | **否**。`needsSecret()` 恒 false，`secretPrompt()` 返回「招商银行每日信用管家邮件无需验证码。」 |
| 解析 | `CmbCreditDailyImportService.php`（229 行）。`DOMDocument` + `DOMXPath`（`'<?xml encoding="UTF-8">'.$html` 前缀），按段落切；三个正则串联：`^(\d{2}:\d{2}:\d{2})$`、`^([A-Z]{3})\s+([0-9][0-9,]*\.\d{2})$`、`^尾号(\d{4})\s+(\S+)\s+(.+)$`；日期从 `\b(20\d{2}/\d{2}/\d{2})\b.*消费明细` 取 |
| 行字段 | `交易时间 / 货币 / 交易金额 / 卡尾号 / 交易类型 / 交易对方` |
| 特殊 | 唯一「一封邮件 = 一天」的高频渠道，其余都是「一封邮件 = 一个账期」 |

### 5. 中行 BOC

| 项 | 值 |
|---|---|
| 入口 | `Channels/BocTransactionBillSourceChannel.php`（334 行） |
| `source` / `profileIds` | `boc` / `['boc-transaction-statement']` |
| IMAP 条件 | **两条**：`X-GM-RAW "filename:pdf"`（Gmail 扩展）与 `FROM "ibank@bank-of-china.com"`。同样注明中文主题不能进 SEARCH |
| 匹配 | 主题含 `中国银行交易流水` + 正文含 `中国银行APP` 或 `交易流水打印` + **有 pdf 附件** |
| 输入 | 邮件附件 **PDF（带打开密码）** |
| 加密 | 是。`needsSecret()` = 存在 `kind='pdf' AND encrypted=true`；提示「请输入中国银行APP"交易流水打印"申请记录中的打开密码」 |
| 解密+提取 | 渠道自己做，**不经 extractor**：`extractPdfTextArtifacts()`（L199）→ `Process(['pdftotext','-layout','-upw',$secret,$path,'-'])`（L254-263），产出 `kind='txt'`、`metadata.source='boc_pdf_text_extract'` 的子 artifact，幂等（已有 txt 则跳过重解，只补 import） |
| 解析 | `BocStatementImportService.php`（425 行），`importExtractedText()`。行正则：`^\s*(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+(-?[0-9,]+\.\d{2})\s+(-?[0-9,]+\.\d{2})\s+…`；元数据 `交易区间：… 至 …`、`打印时间：`、`账号：`、`借记卡号：` |
| 特殊 | 同样带余额列 → 参与余额链校验。`parser_status` 在无行时置 `'waiting…'` 而不是 `'parsed'` |

**没有第六个渠道。** 上述五个是 registry 的全部。用户自定义规则（`processingRule()` 的 `built_in => true` 相对项）
只影响 IMAP 抓取范围，不新增解析器；且内建支付宝渠道**明确忽略用户配置的 Gmail label**
（`testBuiltInAlipayChannelIgnoresConfiguredGmailLabelAndUsesInbox`）。

**外部二进制依赖**：`pdftotext`（poppler-utils），CMB 流水与 BOC 都用。Rust 移植时要么继续 shell out，
要么换 `pdf-extract` / `lopdf` —— 但 BOC 那条带 `-upw` 密码解密，纯 Rust 生态里带密码 PDF 支持有限，**这是移植的一个具体技术风险点**。

---

## 三、金样本：现状与缺口

### 3.1 版本库里 **零个**渠道级样本文件

`find` 全仓（排除 node_modules / vendor / .git）：**没有任何 fixture 目录**存放 eml / zip / xlsx / 加密 PDF。
`firefly-iii/tests/` 下非 PHP 文件只有两个 `.disabled` 的测试。
唯一的 `__fixtures__` 目录是 `abaku-web/src/api/__fixtures__/`（前端 API JSON，与账单解析无关）。

`firefly-iii/resources/stubs/csv.csv` 与 `demo-import.csv` 是 **Firefly III 上游自带**的通用 CSV 导入示例，与本地五渠道无关。

### 3.2 但有**内联合成样本**（PHP 字符串常量），覆盖全部五渠道

| 渠道 | 测试 | 合成方式 |
|---|---|---|
| 支付宝 | `tests/integration/Services/BillIngestion/BillTaskProcessorTest.php`（1331 行）L1119、L1139、L1014 | 12 列 CSV 字符串 → `ZipArchive::addFromString` + `setEncryptionName(EM_AES_256, pass)` 造加密 ZIP |
| 微信 CSV | 同上 L1147-1154 | 带 `微信支付账单明细` 头的 CSV |
| 微信 XLSX | 同上 L1225、L1300-1318 | **手写最小 XLSX**：`[Content_Types].xml` + `xl/workbook.xml.rels` + `xl/sharedStrings.xml` + `xl/worksheets/sheet1.xml` 四件套打进 ZIP |
| 招行流水 | 同上 L1174-1187 | 定宽文本（模拟 `pdftotext -layout` 输出）；并用**假的 `pdftotext` shell 脚本**（L229-241，写进临时 bin 目录 + `chmod 0755` + 改 PATH）绕过真 PDF |
| 中行 | 同上 L1197-1201 | 同样定宽文本 + 假 pdftotext |
| 招行每日信用管家 | `BillMailboxSyncServiceTest.php` L609-630 | HTML `<tr><td>09:33:08</td><td>CNY 9.75</td><td>尾号1234 消费 财付通-测试咖啡</td></tr>` + base64 编码的 `每日信用管家` 主题，拼成完整 eml |
| 微信下载链接邮件 | `BillMailboxSyncServiceTest.php` L544-553 | 正文含「微信用户 x\*\*\*\*\*\*ux 申请的微信支付账单流水文件(…)已生成」 |
| 支付宝（e2e） | `firefly-iii/app/Console/Commands/System/SeedsE2EEnvironment.php` L341-360 | 生产代码里的 seeder：两行合成 CSV → AES-256 加密 ZIP → 发信到 MailHog，供浏览器 e2e 用 |

**测试文件清单**（BillIngestion 相关，共 4926 行）：
```
tests/integration/Services/BillIngestion/BillTaskProcessorTest.php          1331
tests/integration/Api/Models/BillTask/BillTaskControllerTest.php            1365
tests/integration/Services/BillIngestion/BillMailboxSyncServiceTest.php      660
tests/integration/Services/BillIngestion/CrossSourceDuplicateMatcherTest.php 311
tests/integration/Services/BillIngestion/BalanceChainVerifierTest.php        236
tests/integration/Services/BillIngestion/BillTaskActionServiceTest.php       222
tests/integration/Services/BillIngestion/BillStatementRowTimezoneTest.php    220
tests/integration/Api/Models/BillTask/BillInboxSummaryControllerTest.php     165
tests/unit/Services/BillIngestion/NativeImapBillMailboxClientTest.php        133
tests/integration/Services/BillIngestion/BillMailIngestionServiceTest.php     93
tests/integration/Services/BillIngestion/FakeImapBillMailboxClient.php        95（辅助）
tests/integration/Http/BillInbox/FakeBillInboxImapClient.php                  69（辅助）
tests/integration/Services/BillIngestion/FakeImapMailMessage.php              13（辅助）
tests/integration/Http/BillInbox/FakeBillInboxImapMessage.php                 13（辅助）
```

### 3.3 本机上有**真实样本**，但**没进版本库**

`firefly-iii/storage/app/bill-inbox/`（12 MB，`firefly-iii/storage/app/.gitignore` 第一行是 `*`，
`git ls-files` 返回 **0**）：

| 内容 | 数量 |
|---|---|
| `.eml` 原始邮件 | **58** |
| 邮件 HTML 正文 `body.html` | 55 |
| 附件 ZIP | 12 |
| 附件 PDF | 19 |
| 已派生 CSV / XLSX / PDF / TXT | 3 / 3 / 1 / 1 |

按发件人分布（58 封）：

| 发件人 | 封数 | 渠道 |
|---|---:|---|
| `ccsvc@message.cmbchina.com` | **21** | 招行每日信用管家 |
| `service@mail.alipay.com` | 6 | 支付宝（另有 9 个 `支付宝交易明细*.zip`） |
| `95555@message.cmbchina.com` | 3 | 招行交易流水（3 个 `招商银行交易流水*.zip`） |
| `ibank@bank-of-china.com` | **1** | 中行 |
| 其余（evoxt / bandwagonhost / apple 等） | 14 | 非账单噪声邮件，**是有价值的负样本** |

微信支付走链接下载，本机有 10 个 `微信支付账单流水文件(…).zip` / `wechat-pay-statement.zip`（在 `bill-inbox/{10..31}/remote/`）。

已解出的派生物（可直接做解析器对拍的输入）：
```
bill-inbox/9/derived/alipay-202606151853-20260515_20260615.csv
bill-inbox/16/derived/alipay-202606171519-20260517_20260617.csv
bill-inbox/19/derived/alipay-202606221207-20260522_20260622.csv
bill-inbox/13|17|20/derived/wechat-pay-*.xlsx
bill-inbox/15/derived/cmb-transaction-202606161744-20260601_20260614.pdf
bill-inbox/18/derived/boc-transaction-202606171644-20260601_20260617.txt
```

### 3.4 缺口判定（按渠道）

| 渠道 | 版本库金样本 | 内联合成 | 本机真实样本 | 判定 |
|---|---|---|---|---|
| 支付宝 | ❌ 无 | ✅ CSV（12 列全字段） | ✅ 9 个加密 ZIP + 3 个已解 CSV | **可移植**（先脱敏入库） |
| 微信 CSV | ❌ 无 | ✅ | ⚠ 未见已解 CSV，只有 XLSX | **CSV 分支缺真实样本** |
| 微信 XLSX | ❌ 无 | ✅ 手写最小 XLSX | ✅ 3 个真实 XLSX + 10 个 ZIP | **可移植**（但合成 XLSX 太简化，不能代表真实 sharedStrings/样式） |
| 招行交易流水 | ❌ 无 | ✅ 定宽文本 + 假 pdftotext | ✅ 3 个加密 ZIP + 1 个已解 PDF | **可移植** |
| 招行每日信用管家 | ❌ 无 | ✅ 4 行 HTML 表格 | ✅ 21 封本机 + 记忆中约 180 封归档邮件待 gws 回灌 | **样本最充足**，但需要回灌 |
| 中行 BOC | ❌ 无 | ✅ 定宽文本 + 假 pdftotext | ⚠ **只有 1 封邮件 / 1 个已解 txt**，且真实加密 PDF 的 `-upw` 路径**从未被真数据验证过**（测试用假 pdftotext 绕过） | **⚠ 最大缺口** |

**结论**：五个渠道都**没有**版本库里的金样本；内联合成样本只覆盖 happy path 的字段形状，
不覆盖真实文件的编码怪癖、单元格样式、PDF 布局漂移。
移植前必须先做一件事：**把本机 `storage/app/bill-inbox/` 的真实样本脱敏后建成金样本集**（含加密 ZIP/PDF 与密码），
否则 Rust 侧的正则/编码探测无从对拍。中行是首要补样本对象（只有 1 份）；微信 CSV 分支次之。

---

## 四、移植必须保持的不变量

### `BillStatementRowIdentityService`（450 行）
`upsertRow()` 是**所有渠道写行的唯一入口**：先算 `external_key`（订单号优先 `{source}:order:{platform_order_no}`，
退到 `{source}:merchant:{merchant_order_no}`，**招行硬编码 null**），再算强指纹
`sha256(source|时间|金额|收支|对方|摘要|平台分类|支付方式)` 与弱指纹（去掉金额与收支）；
无 external_key 时才用弱指纹在**同 source、同日**范围内找候选。
匹配到旧行则只刷新 `SYSTEM_REFRESH_FIELDS`（23 个字段白名单）——**用户手改过的字段不被覆盖**，
这是「重叠账期重导不丢编辑」的保证（`testAlipayOverlappingStatementsReuseExistingRowsAndPreserveUserEdits`）。

### `CrossSourceDuplicateMatcher`（351 行）
跨源模糊判重，补 `BillStatementRowSummaryService::existingReferences()` 只能抓订单号相同者的洞（issue #14）：
金额绝对值相等 + 账户名匹配 + **±24 小时**窗口（`WINDOW_HOURS = 24`）+ 商户/描述词重叠（`MIN_TERM_LENGTH = 2`）。
**类头注释明写「The result is ADVISORY only … It never auto-skips or auto-imports anything.」**——
移植时这条「只提示不自动动手」的边界必须原样保留。

### `BalanceChainVerifier`（267 行）
只对带联机余额的渠道（CMB / BOC）生效：`当前 Firefly 余额 + 选中行净额 = 账单期末余额`，
容差 `TOLERANCE = 0.01`。按账户名分组，返回 `closes: bool` 与 `difference`。导入前的闸门。

### `BillStatementRowDismissalService`（204 行）
类头注释说清了理由：划掉有四个来源（0 元自动、机器判重、归档级联、人工），每处都得同时写
`status` + `dismissed_reason` + `dismissed_at`，散着写迟早漏。**唯一入口**，移植时别再散开。

### `BillStatementRowQueueService`（146 行）
「还有多少笔要处理」的**唯一口径**——跨任务跨渠道拉平计数。类头注释记录了曾经侧栏与页头各算各的、数对不上的教训。

### `BillStatementRowImportService`（331 行）
真正写进 Firefly 的一步：走 `TransactionGroupRepositoryInterface::store()`，整体包在 `DB::transaction` 里；
另有 `completeTaskWhenNoActionableRowsRemain()` / `reopenTaskWhenRowsReturn()` 两个任务状态回环。
剥离后这一步要么继续调 Firefly REST，要么随远期账本切换改写。

### 日对账（不属于 BillIngestion，但同属剥离面）
- `app/Services/DailyReconciliation/DailyReconciliationService.php`：把某天的
  withdrawal/deposit/transfer 日记账批量置 `reconciled`，`lockForUpdate()` + `DB::transaction`，
  返回 `{date,total,updated,already_reconciled,transactions_updated}`；注意 `FireflyConfig::get('utc')` 决定时区口径。
- `app/Services/DailyReconciliation/DailyReconciliationSummaryService.php`：
  **不单独存状态**，从 Firefly 原生两个信号推导每日状态——`transactions.reconciled` 布尔位，
  以及对账差额产生的 `type=Reconciliation` 调整交易。状态机四态：`none / diff / reconciled / pending`。
  Web 控制器与 `GET /api/v1/daily-reconciliation/summary` 共用。**移植时若自建状态表就是造第二份真相**（违反 §八 纪律）。

### 其他要一起搬的
- `BillStatementCurrencyResolver`（34 行）：靠 `AccountRepositoryInterface` 定币种。
- `BillStatementRowSplitService`（177 行）：组合支付拆分。
- `BillTaskActionService`（263 行）：ignore / archive / deleteFailed / archiveMany / retry / cleanupStale / submitSecret。
- `NativeImapBillMailboxClient`（356 行）：自写 IMAP 客户端（`connect/search/selectFolder/fetchRawMessage/markSeen`）。
  注意 SEARCH 只吃 US-ASCII 这条坑已在两处渠道注释里记着。
- `BillMailboxSyncService`（495 行）：单个搜索条件失败要继续（`testSyncContinuesWhenMailboxDoesNotSupportOneSearchCriterion`）、
  重复消息跳过、`X-GM-RAW` 搜不到 UID 时的兜底路径（`testSyncFindsBocPdfMailWhenSenderSearchDoesNotReturnUid`）。
