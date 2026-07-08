# 账单时区约定（单次转换）

本文件定义账单摄取链路（支付宝 / 微信 / 招商 / 中行 / 手动 OCR 补录）从原始时间到
Firefly 交易之间的**唯一**时区约定。目标：一个真实时刻在整条链路里只被转换一次，
无论后台进程、队列 worker 还是测试运行在哪个 `app.timezone` 下，都解析出同一个绝对时刻。

对应 issue #14 中「时区偏移规律异常（手动 +8h、支付宝 +16h）」的部分。

## 约定

1. **原始时间是来源本地时间。** 各来源账单里的裸时间字符串（无 offset）一律按来源配置的
   时区解释，默认 `Asia/Shanghai`。这一步在各 `*StatementImportService::parseDateTime()`
   里通过 `Carbon::parse($value, 'Asia/Shanghai')` 完成，是**唯一**一次「本地→绝对时刻」转换。

2. **存储保持时刻不变。** `BillStatementRow` 的 `occurred_at` / `firefly_date` /
   `user_modified_at` 三列使用 `BillStatementLocalDateTimeCast`（固定 `Asia/Shanghai`），
   而不是 Laravel 默认的 `datetime` cast。

   - 默认 `datetime` cast 写入时保留 Carbon 自带时区的墙钟数字、读取时按**当前** `app.timezone`
     重新解释。只要写入进程和读取进程的 `app.timezone` 不一致（例如队列 worker、或
     `TZ` 未设为 `Asia/Shanghai` 的测试环境默认 `Europe/Amsterdam`），同一行 DB 记录会解析出
     **不同的绝对时刻**，且无任何报错。这就是「裸墙钟存储地雷」。
   - `BillStatementLocalDateTimeCast` 固定按 `Asia/Shanghai` 存取，消除对 `app.timezone` 的依赖。
     已带 offset 的值按其自身 offset 归一化，仅裸时间按固定时区解释。

3. **写入 Firefly 交易不再二次转换。** `BillStatementRowImportService` 直接把
   `firefly_date`（已是正确绝对时刻的 Carbon）交给 Firefly。Firefly 的
   `transaction_journals.date` + `date_tz` 双列机制会原样保存墙钟与时区，不做额外偏移。

4. **CLI ↔ API 契约：CLI 发送带 `+08:00` offset 的时间。** `ffc transactions import --timezone
   Asia/Shanghai` 经 `convertLocalDateToFireflyDate()` 把裸本地时间补成
   `2026-06-23T13:35:00+08:00` 再发给 Firefly。已实测：在 `app.timezone=Asia/Shanghai`
   的生产环境下，POST/GET/PUT 该值均稳定回显 `13:35+08:00`，**不存在**「传 `+08:00`
   显示再 +8h」的二次转换。CLI 侧维持发送带 offset 的时间即可，无需改为发送 UTC。

## 为什么历史上出现过 +8h / +16h

- **+8h（手动/OCR）**：一条裸本地时间被当成 UTC 解释一次，再按 `Asia/Shanghai` 显示。
- **+16h（支付宝邮箱）**：裸本地时间被当成 UTC 解释后，在链路下游又被当成 UTC 二次转换。

各 `parseDateTime()` 现已统一带 `Asia/Shanghai`，解析层不再产生该偏移；本次新增的
cast 进一步消除存储层因 `app.timezone` 不一致导致的隐性二次偏移。

## 回归测试

`firefly-iii/tests/integration/Services/BillIngestion/BillStatementRowTimezoneTest.php`
在**非** `Asia/Shanghai` 的 app 时区下运行，覆盖：

- `occurred_at` / `firefly_date` 存取往返保持绝对时刻不变（证明 cast 修复了存储地雷）；
- 1点点（13:35）/ 柠季（13:01）/ 海王星辰（10:07）三笔真实场景，从账单行导入到 Firefly 交易，
  时间稳定落在正确的北京时间，无 +8h/+16h 漂移。
