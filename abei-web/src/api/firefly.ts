import {
  AbeiApiError,
  apiDelete,
  apiDownload,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  apiUpload,
  viaFirefly,
  type QueryParams,
} from './client'
import { gateParams, type WriteGate } from './gate'
// 生成物：由 abei/openapi.json 出，`npm run gen:api` 重新生成，别手改。
import { zRowsSplitBody, zRowsUpdateBody } from './generated/zod.gen'
import {
  accountsResponseSchema,
  accountDetailResponseSchema,
  accountItemResponseSchema,
  aboutResponseSchema,
  autocompleteAccountsSchema,
  autocompleteCategoriesSchema,
  autocompleteTagsSchema,
  autocompleteTransactionsSchema,
  attachmentItemResponseSchema,
  attachmentsResponseSchema,
  billImportResponseSchema,
  billInboxSummarySchema,
  billInboxSettingsSchema,
  googleOAuthStartSchema,
  billInboxProcessResultSchema,
  billInboxCleanupResultSchema,
  billInboxSyncResultSchema,
  billStatementRowItemResponseSchema,
  billStatementRowsResponseSchema,
  billTaskItemResponseSchema,
  billRowSplitResponseSchema,
  billRowsResponseSchema,
  billRowsBulkResultSchema,
  billArtifactsResponseSchema,
  billTaskEventsResponseSchema,
  billTaskReviewSchema,
  budgetItemResponseSchema,
  budgetLimitItemResponseSchema,
  budgetLimitsResponseSchema,
  budgetWithLimitResponseSchema,
  budgetsResponseSchema,
  categoriesResponseSchema,
  categoryItemResponseSchema,
  categoryStatsResponseSchema,
  budgetGroupsResponseSchema,
  currenciesResponseSchema,
  recurrencesResponseSchema,
  tagsResponseSchema,
  transactionCreateResponseSchema,
  transactionDetailResponseSchema,
  type AccountsResponse,
  type AccountDetailResponse,
  type AboutResponse,
  type AutocompleteAccount,
  type AutocompleteCategory,
  type AutocompleteTag,
  type AutocompleteTransaction,
  type AttachmentItemResponse,
  type AttachmentsResponse,
  type BillImportResponse,
  type BillInboxSummary,
  type BillInboxSettings,
  type GoogleOAuthStart,
  type BillInboxProcessResult,
  type BillInboxCleanupResult,
  type BillInboxSyncResult,
  type BillStatementRowItemResponse,
  type BillStatementRowsResponse,
  type BillTaskItemResponse,
  type BillRowSplitResponse,
  type BillRowGroup,
  type BillRowsResponse,
  type BillRowsBulkResult,
  billTasksResponseSchema,
  type BillArtifactsResponse,
  type BillTaskEventsResponse,
  type BillTaskReview,
  type BillTasksResponse,
  type BudgetItemResponse,
  type BudgetLimitItemResponse,
  type BudgetLimitsResponse,
  type BudgetWithLimitResponse,
  type BudgetsResponse,
  type CategoriesResponse,
  type Category,
  type CategoryDomain,
  type CategoryStats,
  type BudgetGroup,
  type CurrenciesResponse,
  type RecurrencesResponse,
  type TagsResponse,
  type TransactionCreateResponse,
  type TransactionDetailResponse,
  accountChartOverviewSchema,
  apiTokensResponseSchema,
  financialReportResponseSchema,
  insightCategoryResponseSchema,
  summaryResponseSchema,
  transactionsResponseSchema,
  transactionSearchCountSchema,
  type AccountChartOverview,
  type ApiToken,
  type FinancialReportResponse,
  type InsightCategoryEntry,
  type SummaryResponse,
  type TransactionsResponse,
  type TransactionSearchCount,
} from './schemas'

/* ------------------------------------------------------------------ *
 * 逃生舱
 *
 * 阶段 3B：所有请求都打 abei-api。已经建模成资源的域（transactions / accounts /
 * bills / rows）直接打 `/v1/<资源>`；其余还没建模的接口原样加 `/v1/firefly` 前缀
 * 转给 Firefly，路径不变。
 *
 * 建模一个域之后，把对应调用从 proxy* 换成 api*，这里就少一条——`proxy*` 的调用点
 * 数量就是「还欠多少建模」的进度条。
 * ------------------------------------------------------------------ */

const proxyGet = <T = unknown>(path: string, params?: QueryParams): Promise<T> =>
  apiGet<T>(viaFirefly(path), params)
const proxyPost = <T = unknown>(path: string, body: unknown): Promise<T> =>
  apiPost<T>(viaFirefly(path), body)
const proxyPut = <T = unknown>(path: string, body: unknown): Promise<T> =>
  apiPut<T>(viaFirefly(path), body)
const proxyPatch = <T = unknown>(path: string, body: unknown): Promise<T> =>
  apiPatch<T>(viaFirefly(path), body)
const proxyDelete = (path: string): Promise<void> => apiDelete(viaFirefly(path))
const proxyDownload = (path: string): Promise<{ blob: Blob; filename: string | null }> =>
  apiDownload(viaFirefly(path))
const proxyUpload = (path: string, body: Blob): Promise<void> => apiUpload(viaFirefly(path), body)

/** abei-api 的 limit 上限是 100（check_limit），超了是 400 InvalidParams。 */
const MAX_PAGE_SIZE = 100

export interface DateRange {
  start: string // YYYY-MM-DD
  end: string // YYYY-MM-DD
}

type FireflyQueryParams = Record<string, string | number | readonly (string | number)[] | undefined>
type PaginatedCollection = {
  data: unknown[]
  meta?: {
    pagination?: {
      total_pages?: number
      total?: number
      per_page?: number
    }
  }
}

async function getAllPages<T extends PaginatedCollection>(
  path: string,
  params: FireflyQueryParams,
  schema: { parse(raw: unknown): T },
  limit = 100,
): Promise<T> {
  const fetchPage = async (page: number): Promise<T> => {
    const raw = await proxyGet(path, { ...params, limit, page })
    return schema.parse(raw)
  }

  const first = await fetchPage(1)
  const pagination = first.meta?.pagination
  const totalPages = pagination?.total_pages
    ?? (pagination?.total !== undefined && pagination.per_page
      ? Math.ceil(pagination.total / pagination.per_page)
      : 1)
  if (totalPages <= 1) return first

  const remaining = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) => fetchPage(index + 2)),
  )
  return {
    ...first,
    data: [first, ...remaining].flatMap((response) => response.data),
  } as T
}

/**
 * Firefly 分页游标：列表端点返回 meta.pagination（page 语义），
 * 前端无限滚动用 next_before_id 当下页页码（String 形式）。
 */
function parseTransactionPage(raw: unknown): TransactionsResponse {
  const parsed = transactionsResponseSchema.parse(raw)
  const pagination = parsed.meta?.pagination
  const current = pagination?.current_page ?? 1
  const totalPages = pagination?.total_pages ?? 1
  return { ...parsed, next_before_id: current < totalPages ? String(current + 1) : null }
}

export type TransactionTypeFilter = 'all' | 'withdrawal' | 'deposit' | 'transfer'

/**
 * 逃生舱。abei-api 的 `transactions.summary`（/v1/transactions/summary）不是这个的替身：
 * 它是阿贝自己按流水算出来的一份分类报表，形状和 Firefly 的 summary/basic 完全不同。
 * 概览页要的是后者，所以这里继续原样转发。
 */
export async function getSummaryBasic(range: DateRange): Promise<SummaryResponse> {
  const raw = await proxyGet('/api/v1/summary/basic', { start: range.start, end: range.end })
  return summaryResponseSchema.parse(raw)
}

export async function getTransactions(
  range: DateRange,
  opts: { limit?: number; page?: number; beforeId?: string; type?: TransactionTypeFilter } = {},
): Promise<TransactionsResponse> {
  const raw = await apiGet('/v1/transactions', {
    start: range.start,
    end: range.end,
    limit: Math.min(opts.limit ?? 80, MAX_PAGE_SIZE),
    page: opts.beforeId ? Number(opts.beforeId) : (opts.page ?? 1),
    type: opts.type ?? 'all',
  })
  return parseTransactionPage(raw)
}

export async function getAllTransactions(
  range: DateRange,
  opts: { limit?: number; type?: TransactionTypeFilter } = {},
): Promise<TransactionsResponse> {
  // 上限 100：abei-api 的 check_limit 卡在这里，原来的 200 会被判 InvalidParams。
  const limit = Math.min(opts.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE)
  const data: TransactionsResponse['data'] = []
  let beforeId: string | undefined
  do {
    const page = await getTransactions(range, { limit, type: opts.type, beforeId })
    data.push(...page.data)
    beforeId = page.next_before_id ?? undefined
  } while (beforeId)
  return transactionsResponseSchema.parse({ data, next_before_id: null })
}

/**
 * 命令面板「搜索交易」区：GET /api/v1/search/transactions?query=&limit=&page=。
 * 响应结构与 GET /api/v1/transactions 一致（transaction group 数组 + pagination）。
 */
export async function searchTransactions(query: string, limit = 10, page = 1): Promise<TransactionsResponse> {
  const raw = await proxyGet('/api/v1/search/transactions', { query: query.trim(), limit, page })
  return parseTransactionPage(raw)
}

export async function countTransactions(query: string): Promise<TransactionSearchCount> {
  let page = 1
  let count = 0
  do {
    const raw = await proxyGet('/api/v1/search/transactions', { query: query.trim(), limit: 200, page })
    const response = parseTransactionPage(raw)
    count += response.data.length
    const pagination = response.meta?.pagination
    const current = pagination?.current_page ?? 1
    const totalPages = pagination?.total_pages ?? 1
    if (current >= totalPages) break
    page += 1
  } while (page < 1000)
  return transactionSearchCountSchema.parse({ count })
}

export async function searchAccounts(query: string): Promise<AccountsResponse> {
  const raw = await proxyGet('/api/v1/search/accounts', { query: query.trim(), field: 'all' })
  return accountsResponseSchema.parse(raw)
}

export async function getExpenseByCategory(range: DateRange): Promise<InsightCategoryEntry[]> {
  const raw = await proxyGet('/api/v1/insight/expense/category', { start: range.start, end: range.end })
  return insightCategoryResponseSchema.parse(raw)
}

/** GET /api/v1/insight/income/revenue（报表页「收入来源排行」）：结构与 expense/category 一致 */
export async function getIncomeByRevenue(range: DateRange): Promise<InsightCategoryEntry[]> {
  const raw = await proxyGet('/api/v1/insight/income/revenue', {
    start: range.start,
    end: range.end,
  })
  return insightCategoryResponseSchema.parse(raw)
}

/** GET /api/v1/insight/expense/asset（报表页「账户流出排行」）：结构与 expense/category 一致 */
export async function getExpenseByAsset(range: DateRange): Promise<InsightCategoryEntry[]> {
  const raw = await proxyGet('/api/v1/insight/expense/asset', {
    start: range.start,
    end: range.end,
  })
  return insightCategoryResponseSchema.parse(raw)
}

async function getInsightRanking(path: string, range: DateRange): Promise<InsightCategoryEntry[]> {
  const raw = await proxyGet(path, { start: range.start, end: range.end })
  return insightCategoryResponseSchema.parse(raw)
}

export function getExpenseByTag(range: DateRange): Promise<InsightCategoryEntry[]> {
  return getInsightRanking('/api/v1/insight/expense/tag', range)
}

export function getExpenseByBudget(range: DateRange): Promise<InsightCategoryEntry[]> {
  return getInsightRanking('/api/v1/insight/expense/budget', range)
}

export async function getExpenseWithoutCategory(range: DateRange): Promise<InsightCategoryEntry[]> {
  return (await getInsightRanking('/api/v1/insight/expense/no-category', range)).map((row) => ({ ...row, name: '未分类支出' }))
}

export async function getExpenseWithoutBudget(range: DateRange): Promise<InsightCategoryEntry[]> {
  return (await getInsightRanking('/api/v1/insight/expense/no-budget', range)).map((row) => ({ ...row, name: '未编入预算' }))
}

export async function getFinancialReport(range: DateRange): Promise<FinancialReportResponse> {
  const raw = await proxyGet('/api/v1/insight/report/overview', { start: range.start, end: range.end })
  return financialReportResponseSchema.parse(raw)
}

/** chart/account/overview 的 period 枚举（config/firefly.php valid_view_ranges） */
export type ChartPeriod = '1D' | '1W' | '1M' | '3M' | '6M' | '1Y'

/**
 * preselected 缺省为 empty，会走 frontpageAccounts 偏好；
 * 本地实测偏好里的 id 可能已失效导致空数组，总览默认用 assets。
 * accounts 显式传入时覆盖 preselected（账户详情单序列用）。
 */
export type AccountChartPreselected = 'all' | 'assets' | 'liabilities'

export interface AccountOverviewChartOpts {
  period?: ChartPeriod
  preselected?: AccountChartPreselected
  /** 账户 id 列表；与 preselected 同时传时仍会返回这些账户（preselected=empty 路径） */
  accounts?: readonly (string | number)[]
}

/**
 * 按日期跨度选 period：短窗用日粒度才有面积线密度；长窗降采样避免点过密。
 * 任务 4 / 任务 7 共用。
 */
export function pickChartPeriod(range: DateRange): ChartPeriod {
  const startMs = Date.parse(`${range.start}T00:00:00`)
  const endMs = Date.parse(`${range.end}T00:00:00`)
  const days = Math.max(1, Math.round((endMs - startMs) / 86_400_000) + 1)
  if (days <= 62) return '1D'
  if (days <= 180) return '1W'
  return '1M'
}

/**
 * GET /api/v1/chart/account/overview?start&end&period&preselected|accounts[]
 * 实测：不带 preselected/accounts 时可能因 frontpageAccounts 失效返回 []。
 */
export async function getAccountOverviewChart(
  range: DateRange,
  opts: AccountOverviewChartOpts = {},
): Promise<AccountChartOverview> {
  const raw = await proxyGet('/api/v1/chart/account/overview', {
    start: range.start,
    end: range.end,
    period: opts.period ?? pickChartPeriod(range),
    preselected: opts.accounts && opts.accounts.length > 0 ? 'empty' : (opts.preselected ?? 'assets'),
    accounts: opts.accounts,
  })
  return accountChartOverviewSchema.parse(raw)
}

export async function getBillInboxSummary(): Promise<BillInboxSummary> {
  const raw = await proxyGet('/api/v1/bill-inbox/summary', {})
  return billInboxSummarySchema.parse(raw)
}

export type BillInboxSettingsInput = Partial<
  Pick<
    BillInboxSettings['data']['attributes'],
    'enabled' | 'provider' | 'email' | 'host' | 'port' | 'encryption' | 'username' | 'folder'
  >
> & { password?: string }

export async function getBillInboxSettings(): Promise<BillInboxSettings> {
  const raw = await apiGet('/v1/bills/mailbox')
  return billInboxSettingsSchema.parse(raw)
}

export async function updateBillInboxSettings(
  input: BillInboxSettingsInput,
): Promise<BillInboxSettings> {
  const raw = await apiPut('/v1/bills/mailbox', input)
  return billInboxSettingsSchema.parse(raw)
}

export async function startGoogleMailboxOAuth(): Promise<GoogleOAuthStart> {
  const raw = await apiPost('/v1/bills/mailbox/google/connect', {})
  return googleOAuthStartSchema.parse(raw)
}

export async function completeGoogleMailboxOAuth(input: {
  code: string
  state: string
}): Promise<BillInboxSettings> {
  const raw = await apiPost('/v1/bills/mailbox/google/callback', input)
  return billInboxSettingsSchema.parse(raw)
}

export async function disconnectGoogleMailbox(): Promise<BillInboxSettings> {
  await apiDelete('/v1/bills/mailbox/google')
  return getBillInboxSettings()
}

export async function processBillInbox(limit = 25): Promise<BillInboxProcessResult> {
  const raw = await proxyPost('/api/v1/bill-inbox/process', { limit })
  return billInboxProcessResultSchema.parse(raw)
}

export async function cleanupBillInbox(): Promise<BillInboxCleanupResult> {
  const raw = await proxyPost('/api/v1/bill-inbox/cleanup-stale', {})
  return billInboxCleanupResultSchema.parse(raw)
}

export type BillTaskSource = 'alipay' | 'wechat' | 'cmb' | 'boc'

/**
 * GET /api/v1/bill-rows —— 跨任务的流水队列（设计稿 02 §3）。
 * 收件箱页面的主数据源；单任务的 /bill-tasks/{id}/rows 仍保留给来源凭证视图。
 */
export async function getBillRows(opts: {
  group: BillRowGroup
  source?: string
  page?: number
  limit?: number
}): Promise<BillRowsResponse> {
  const raw = await proxyGet('/api/v1/bill-rows', {
    group: opts.group,
    source: opts.source,
    page: opts.page ?? 1,
    limit: opts.limit ?? 200,
  })
  return billRowsResponseSchema.parse(raw)
}

/** 整组读完：队列要按理由分小节并支持「全部入账」，分页读一半没法给准数 */
export async function getAllBillRows(opts: {
  group: BillRowGroup
  source?: string
  limit?: number
}): Promise<BillRowsResponse> {
  const limit = opts.limit ?? 200
  const first = await getBillRows({ ...opts, limit, page: 1 })
  const totalPages = first.meta?.pagination?.total_pages ?? 1
  if (totalPages <= 1) return first

  const remaining = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) =>
      getBillRows({ ...opts, limit, page: index + 2 }),
    ),
  )
  return {
    ...first,
    data: [first, ...remaining].flatMap((page) => page.data),
  }
}

/**
 * POST /api/v1/bill-rows/dismiss —— 忽略流水。
 * 要么点名 row_ids，要么用 filter 一次清掉机器判重的存量。
 */
export async function dismissBillRows(
  body: { row_ids: string[] } | { filter: 'machine_duplicates' },
): Promise<BillRowsBulkResult> {
  const raw = await proxyPost('/api/v1/bill-rows/dismiss', body)
  return billRowsBulkResultSchema.parse(raw)
}

/** POST /api/v1/bill-rows/restore —— 已忽略的流水恢复成 pending */
export async function restoreBillRows(rowIds: string[]): Promise<BillRowsBulkResult> {
  const raw = await proxyPost('/api/v1/bill-rows/restore', { row_ids: rowIds })
  return billRowsBulkResultSchema.parse(raw)
}

/**
 * POST /api/v1/bill-rows/import —— 跨任务批量入账。
 * confirm=false 是干跑，响应结构与单任务 /bill-tasks/{id}/import 完全一致。
 */
export async function importBillRows(body: {
  row_ids: string[]
  confirm: boolean
}): Promise<BillImportResponse> {
  const raw = await proxyPost('/api/v1/bill-rows/import', body)
  return billImportResponseSchema.parse(raw)
}

/* ------------------------------------------------------------------ *
 * 账单收件箱：已建模的能力
 *
 * bills.list / show / review / sync / process / import / unlock / ignore / retry
 * 和 rows.update / split 都走 abei-api 的资源路由。写闸门在服务端，页面绕不过。
 *
 * 同一个域里没建模的接口（行列表、产物、事件、归档、跨任务批量）仍走 proxy*，
 * 见下面各函数上的注释。
 * ------------------------------------------------------------------ */

export async function getBillTasks(opts: {
  source?: string
  status?: string
  page?: number
  limit?: number
}): Promise<BillTasksResponse> {
  const raw = await apiGet('/v1/bills', {
    source: opts.source,
    status: opts.status,
    page: opts.page ?? 1,
    limit: Math.min(opts.limit ?? 30, MAX_PAGE_SIZE),
  })
  return billTasksResponseSchema.parse(raw)
}

/** GET /v1/bills/{id} —— 单份账单任务。 */
export async function getBillTask(taskId: string): Promise<BillTaskItemResponse> {
  const raw = await apiGet(`/v1/bills/${taskId}`)
  return billTaskItemResponseSchema.parse(raw)
}

export async function getAllBillTasks(opts: {
  source?: string
  status?: string
  limit?: number
}): Promise<BillTasksResponse> {
  const limit = Math.min(opts.limit ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE)
  const first = await getBillTasks({ ...opts, limit, page: 1 })
  const totalPages = first.meta?.pagination?.total_pages ?? 1
  if (totalPages <= 1) return first

  const remaining = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) =>
      getBillTasks({ ...opts, limit, page: index + 2 }),
    ),
  )
  return {
    ...first,
    data: [first, ...remaining].flatMap((page) => page.data),
  }
}

/**
 * 行列表接口的 page/limit 参数目前对后端无效（实测总是整表返回），
 * 这里仍然透传参数以贴合接口文档，真正的"加载更多"体验在前端对已取回的
 * 全量行数组做切片展示（见 TaskDetailPanel）。
 *
 * 还没建模，走逃生舱。
 */
export async function getBillTaskRows(
  taskId: string,
  opts: { status?: string } = {},
): Promise<BillStatementRowsResponse> {
  const raw = await proxyGet(`/api/v1/bill-tasks/${taskId}/rows`, {
    status: opts.status,
  })
  return billStatementRowsResponseSchema.parse(raw)
}

export async function getBillTaskArtifacts(taskId: string): Promise<BillArtifactsResponse> {
  const raw = await proxyGet(`/api/v1/bill-tasks/${taskId}/artifacts`)
  return billArtifactsResponseSchema.parse(raw)
}

export async function getBillTaskEvents(taskId: string): Promise<BillTaskEventsResponse> {
  const raw = await proxyGet(`/api/v1/bill-tasks/${taskId}/events`)
  return billTaskEventsResponseSchema.parse(raw)
}

export async function getBillTaskReview(taskId: string): Promise<BillTaskReview> {
  const raw = await apiGet(`/v1/bills/${taskId}/review`)
  return billTaskReviewSchema.parse(raw)
}

export async function downloadBillArtifact(
  artifactId: string,
): Promise<{ blob: Blob; filename: string | null }> {
  return proxyDownload(`/api/v1/bill-artifacts/${artifactId}/download`)
}

/**
 * PATCH /v1/rows/{id} —— 填一条流水该记成什么。
 *
 * 服务端有两条不给调用方选的规矩，页面必须照着做，别绕：
 *
 * 1. **写入一律是建议**：服务端强制 `as_suggestion: true`，落库后行上带 `suggested_by`。
 *    也就是说这里写进去的东西是「AI 填的，等人确认」，不是既成事实——页面要显示得出来
 *    （见 QueueRow 的建议标记）。人自己在页面上改过之后，后端会把 `suggested_by` 清掉。
 * 2. **银行原文不给改**：`occurred_at` / `counterparty` / `platform_order_no` / `amount`
 *    不在可写字段里，页面上它们是只读的。要记的金额写 `firefly_amount`，
 *    原始 `amount` 保持银行给的那个值。
 *
 * 字段名就是这份类型——多写一个服务端会当未知字段拒掉（ValidJson 严格校验）。
 */
export interface UpdateBillStatementRowInput {
  firefly_type?: 'withdrawal' | 'deposit' | 'transfer' | null
  firefly_date?: string | null
  firefly_amount?: string | null
  firefly_description?: string | null
  source_name?: string | null
  destination_name?: string | null
  category_name?: string | null
  notes?: string | null
  tags?: string[] | null
}

export async function updateBillStatementRow(
  rowId: string,
  input: UpdateBillStatementRowInput,
): Promise<BillStatementRowItemResponse> {
  // 生成的 Zod 来自 abei/openapi.json，与服务端同源：字段写错在这里就炸，不用等 400。
  const body = zRowsUpdateBody.parse(input)
  const raw = await apiPatch(`/v1/rows/${rowId}`, body)
  return billStatementRowItemResponseSchema.parse(raw)
}

/**
 * 改判「这不是重复」。
 *
 * `duplicate_state` 还没建模进 `rows.update`（那条能力只收记账字段），所以走逃生舱。
 * 只允许改判为 unique，见设计稿 02 §2。
 */
export async function markBillRowUnique(rowId: string): Promise<BillStatementRowItemResponse> {
  const raw = await proxyPatch(`/api/v1/bill-statement-rows/${rowId}`, { duplicate_state: 'unique' })
  return billStatementRowItemResponseSchema.parse(raw)
}

/** POST /v1/rows/{id}/split —— 组合支付拆成两笔以上草稿。服务端限 2 到 20 笔。 */
export async function splitBillStatementRow(
  rowId: string,
  splits: Array<{ payment_method?: string; source_name?: string; amount: string; description: string; category_name?: string }>,
): Promise<BillRowSplitResponse> {
  const body = zRowsSplitBody.parse({ splits })
  const raw = await apiPost(`/v1/rows/${rowId}/split`, body)
  return billRowSplitResponseSchema.parse(raw)
}

/**
 * POST /v1/bills/{id}/import —— confirm 档。
 *
 * 必须先 `DRY_RUN` 拿预览给人看，人点确认后才 `CONFIRMED`。两个都不带是 409
 * ConfirmationRequired。干跑的响应形状与真导入一致，只是多一个 `dry_run: true`。
 */
export async function importBillTaskRows(
  taskId: string,
  selection: { row_ids?: string[]; all?: boolean },
  gate: WriteGate,
): Promise<BillImportResponse> {
  // all 与 row_ids 二选一，服务端两个都给或都不给都会拒。
  const body = selection.all
    ? { all: true }
    : { row_ids: (selection.row_ids ?? []).map(Number) }
  const raw = await apiPost(`/v1/bills/${taskId}/import`, body, gateParams(gate))
  return billImportResponseSchema.parse(raw)
}

/**
 * POST /v1/bills/{id}/ignore —— confirm 档。
 *
 * 干跑不回上游内容，只回一句「将要忽略这份账单」，页面据此弹确认。
 */
export async function ignoreBillTask(taskId: string, gate: WriteGate): Promise<unknown> {
  return apiPost(`/v1/bills/${taskId}/ignore`, {}, gateParams(gate))
}

/** 还没建模，走逃生舱。 */
export async function archiveBillTask(taskId: string): Promise<BillTaskItemResponse> {
  const raw = await proxyPost(`/api/v1/bill-tasks/${taskId}/archive`, {})
  return billTaskItemResponseSchema.parse(raw)
}

export async function deleteBillTask(taskId: string): Promise<void> {
  return proxyDelete(`/api/v1/bill-tasks/${taskId}`)
}

/** POST /v1/bills/sync：投递邮箱同步任务，进度从 bill-inbox summary 读取。 */
export async function syncBillInbox(opts: { limit?: number } = {}): Promise<BillInboxSyncResult> {
  const body = opts.limit !== undefined ? { limit: opts.limit } : {}
  const raw = await apiPost('/v1/bills/sync', body)
  return billInboxSyncResultSchema.parse(raw)
}

/**
 * POST /v1/bills/{id}/unlock —— 提交解压密码/验证码（needs_secret 状态）。confirm 档。
 *
 * **干跑不会把密码递给上游**——服务端在 dry_run 分支里直接返回，密码根本不出阿贝。
 * 所以页面上密码必须是人当场敲的：先干跑确认「会把密码提交给这份账单」，
 * 人点确认后再带着真密码执行一次。别把密码缓存起来跨步骤复用。
 */
export async function submitBillTaskSecret(
  taskId: string,
  value: string,
  gate: WriteGate,
): Promise<unknown> {
  return apiPost(`/v1/bills/${taskId}/unlock`, { secret: value }, gateParams(gate))
}

/**
 * POST /v1/bills/{id}/retry —— 失败任务重试，无 body。draft 档，服务端直接放行。
 */
export async function retryBillTask(taskId: string): Promise<BillTaskItemResponse> {
  const raw = await apiPost(`/v1/bills/${taskId}/retry`, {})
  return billTaskItemResponseSchema.parse(raw)
}

export type AccountType = 'asset' | 'cash' | 'expense' | 'revenue' | 'liabilities'

/**
 * 页面的账户档 → abei-api 认的 type 值。
 *
 * `liabilities` 和 `liability` 在 Firefly 里指的是同一组账户类型
 * （Loan / Debt / Mortgage / CreditCard，见 AccountFilter），换个写法不改结果。
 * `cash` 那一档 abei-api 还没建模，映射里没有它，调用方据此回退到逃生舱。
 */
const MODELED_ACCOUNT_TYPES: Partial<Record<AccountType, string>> = {
  asset: 'asset',
  expense: 'expense',
  revenue: 'revenue',
  liabilities: 'liability',
}

/**
 * 账户页四个 tab 的分页列表：GET /api/v1/accounts?type=&limit=&page=。
 */
export async function getAccountsByType(
  type: AccountType,
  opts: { limit?: number; page?: number } = {},
) {
  const limit = Math.min(opts.limit ?? 40, MAX_PAGE_SIZE)
  const page = opts.page ?? 1
  const modeled = MODELED_ACCOUNT_TYPES[type]

  // cash 没建模：abei-api 的 accounts.list 只认 asset/expense/revenue/liability/all，
  // 而 Firefly 还有一个 cash 档（AccountFilter 里的 'Cash account'）。这一档走逃生舱，
  // 等目录把它加进去再收回来。
  const raw = modeled
    ? await apiGet('/v1/accounts', { type: modeled, limit, page })
    : await proxyGet('/api/v1/accounts', { type, limit, page })
  return accountsResponseSchema.parse(raw)
}

/** GET /api/v1/accounts/{id} */
export async function getAccount(accountId: string): Promise<AccountDetailResponse> {
  const raw = await proxyGet(`/api/v1/accounts/${accountId}`)
  return accountDetailResponseSchema.parse(raw)
}

export interface AccountInput {
  name: string
  type?: AccountType
  currency_code?: string
  active?: boolean
  include_net_worth?: boolean
  account_role?: string
  liability_type?: 'loan' | 'debt' | 'mortgage'
  liability_direction?: 'credit' | 'debit'
  interest?: string
  interest_period?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'half-year' | 'yearly'
  credit_card_type?: 'monthlyFull'
  monthly_payment_date?: string
  opening_balance?: string
  opening_balance_date?: string
  account_number?: string
  notes?: string
  version?: number
}

export async function createAccount(input: AccountInput): Promise<AccountDetailResponse> {
  const raw = await proxyPost('/api/v1/accounts', accountWritePayload(input))
  return accountItemResponseSchema.parse(raw)
}

export async function updateAccount(accountId: string, input: AccountInput): Promise<AccountDetailResponse> {
  const current = (await proxyGet<AccountDetailResponse>(`/api/v1/accounts/${accountId}`)).data.attributes
  const merged: AccountInput = { ...input }
  if (merged.account_role === undefined) merged.account_role = current.account_role ?? undefined
  if (merged.liability_type === undefined && current.liability_type) {
    merged.liability_type = current.liability_type as AccountInput['liability_type']
  }
  if (merged.liability_direction === undefined) merged.liability_direction = current.liability_direction ?? undefined
  const raw = await proxyPut(`/api/v1/accounts/${accountId}`, accountWritePayload(merged))
  return accountItemResponseSchema.parse(raw)
}

export async function deleteAccount(accountId: string): Promise<void> {
  return proxyDelete(`/api/v1/accounts/${accountId}`)
}

const FIREFLY_ACCOUNT_ROLES = ['defaultAsset', 'sharedAsset', 'savingAsset', 'ccAsset', 'cashWalletAsset'] as const

function accountWritePayload(input: AccountInput) {
  const type = input.type ?? 'asset'
  const body: Record<string, unknown> = { name: input.name, type }
  const passthrough: Array<keyof AccountInput> = [
    'currency_code', 'active', 'include_net_worth', 'interest', 'interest_period',
    'credit_card_type', 'monthly_payment_date', 'opening_balance', 'opening_balance_date',
    'account_number', 'notes',
  ]
  for (const field of passthrough) {
    if (input[field] !== undefined) body[field] = input[field]
  }
  if (type === 'liabilities') {
    body.liability_type = input.liability_type ?? (input.account_role === 'loan' ? 'loan' : 'debt')
    body.liability_direction = input.liability_direction ?? 'debit'
  } else {
    const role = input.account_role
    if (role != null && (FIREFLY_ACCOUNT_ROLES as readonly string[]).includes(role)) body.account_role = role
    else if (role === 'cash') body.account_role = 'cashWalletAsset'
    else if (role === 'card') body.account_role = 'ccAsset'
    else body.account_role = 'defaultAsset'
  }
  return body
}

/**
 * GET /api/v1/accounts/{id}/transactions?start&end&limit&page
 * 响应结构与 GET /transactions 一致（transaction groups + pagination meta）。
 */
export async function getAccountTransactions(
  accountId: string,
  range: DateRange,
  opts: { limit?: number; page?: number; beforeId?: string; type?: TransactionTypeFilter } = {},
): Promise<TransactionsResponse> {
  const raw = await proxyGet(`/api/v1/accounts/${accountId}/transactions`, {
    start: range.start,
    end: range.end,
    limit: opts.limit,
    page: opts.beforeId ? Number(opts.beforeId) : (opts.page ?? 1),
    type: opts.type ?? 'all',
  })
  return parseTransactionPage(raw)
}

export interface AccountSummary {
  id: string
  name: string
  currencyCode: string
  currencySymbol: string
}

/**
 * 记一笔/编辑表单的来源与转账账户下拉。
 * 默认合并 type=asset 与 type=liabilities（花呗等 Debt 可作支出来源）。
 * includeLiabilities:false 时仅资产（对账调整用，避免负债混入）。
 */
export async function getAssetAccounts(
  opts: { includeLiabilities?: boolean } = {},
): Promise<AccountSummary[]> {
  const includeLiabilities = opts.includeLiabilities ?? true
  const [assets, liabilities] = await Promise.all([
    getAllPages('/api/v1/accounts', { type: 'asset' }, accountsResponseSchema),
    includeLiabilities ? getAllPages('/api/v1/accounts', { type: 'liabilities' }, accountsResponseSchema) : Promise.resolve(null),
  ])
  const accounts = [...assets.data, ...(liabilities?.data ?? [])]
  return accounts.map((account) => ({
    id: account.id,
    name: account.attributes.name,
    currencyCode: account.attributes.currency_code ?? 'CNY',
    currencySymbol: account.attributes.currency_symbol ?? account.attributes.currency_code ?? 'CNY',
  }))
}

/**
 * 今天页「资产 / 负债 / 净资产」三数并排用的原始账户。
 * getAssetAccounts 只留了下拉需要的四个字段，余额和最近活动都被丢掉了，
 * 这里另开一条，保留 attributes 原样。
 */
export async function getNetWorthAccounts(): Promise<AccountsResponse['data']> {
  const [assets, liabilities] = await Promise.all([
    getAllPages('/api/v1/accounts', { type: 'asset' }, accountsResponseSchema),
    getAllPages('/api/v1/accounts', { type: 'liabilities' }, accountsResponseSchema),
  ])
  return [...assets.data, ...liabilities.data]
}

export type CreateTransactionType = 'withdrawal' | 'deposit' | 'transfer'

export interface CreateTransactionInput {
  type: CreateTransactionType
  /** 交易组内的稳定展示顺序，从 0 开始。 */
  order?: number
  /** YYYY-MM-DD，本地日期 */
  date: string
  /** 如 "23.60" */
  amount: string
  description: string
  source_id?: string
  source_name?: string
  destination_id?: string
  destination_name?: string
  category_name?: string
  category_id?: string | null
  budget_id?: string | null
  budget_name?: string
  bill_id?: string | null
  bill_name?: string
  currency_id?: string | null
  currency_code?: string
  foreign_currency_id?: string | null
  foreign_currency_code?: string
  foreign_amount?: string | null
  tags?: string[]
  notes?: string
}

/**
 * 记一笔表单提交。
 * 实测 POST /api/v1/transactions body 形如
 * {error_if_duplicate_hash:false, transactions:[{type, date:'YYYY-MM-DD',
 * amount, description, source_id|source_name, destination_id|destination_name,
 * category_name?, tags?, notes?}]}（字段名对照后端 app/Api/V1/Requests/Models/Transaction/StoreRequest.php
 * 的校验规则确认）。响应是单个 Item 资源（data 为对象，不是数组），与 GET /transactions 的
 * Collection 响应结构不同。
 */
export async function createTransactionSplits(
  inputs: CreateTransactionInput[],
  groupTitle?: string,
): Promise<TransactionCreateResponse> {
  const first = inputs[0]
  if (!first) throw new AbeiApiError(422, '交易至少需要一个拆分')
  if (first.type === 'transfer' && inputs.length !== 1) {
    throw new AbeiApiError(422, '转账不能使用分类拆分')
  }
  const sameHeader = inputs.every((input) =>
    input.type === first.type
    && input.date === first.date
    && input.source_id === first.source_id
    && input.destination_id === first.destination_id,
  )
  if (!sameHeader) {
    throw new AbeiApiError(422, '同一笔分类拆分必须使用相同日期、类型和资金账户')
  }

  // Firefly 原生：分类/标签/支出收入账户按名称自动创建，无需前端预校验。
  const raw = await proxyPost('/api/v1/transactions', {
    error_if_duplicate_hash: false,
    group_title: inputs.length > 1 ? (groupTitle?.trim() || first.description.trim()) : undefined,
    transactions: inputs.map(transactionWritePayload),
  })
  return transactionCreateResponseSchema.parse(raw)
}

export async function createTransaction(input: CreateTransactionInput): Promise<TransactionCreateResponse> {
  return createTransactionSplits([input])
}

/**
 * GET /api/v1/transactions/{groupId}
 * 实测响应与 POST 创建相同：{data: transactionGroup}，data 是对象不是数组。
 * group.attributes.transactions[] 每项含 transaction_journal_id（PUT 必带）。
 */
export async function getTransaction(groupId: string): Promise<TransactionDetailResponse> {
  const raw = await apiGet(`/v1/transactions/${groupId}`)
  return transactionDetailResponseSchema.parse(raw)
}

export async function getTransactionAttachments(groupId: string): Promise<AttachmentsResponse> {
  return getAllPages(
    `/api/v1/transactions/${groupId}/attachments`,
    {},
    attachmentsResponseSchema,
  )
}

export async function createTransactionAttachment(input: {
  journalId: string
  file: File
  title?: string
  notes?: string
}): Promise<AttachmentItemResponse> {
  const createdRaw = await proxyPost('/api/v1/attachments', {
    filename: input.file.name,
    title: input.title || input.file.name,
    notes: input.notes || undefined,
    attachable_type: 'TransactionJournal',
    attachable_id: input.journalId,
  })
  const created = attachmentItemResponseSchema.parse(createdRaw)
  try {
    await proxyUpload(`/api/v1/attachments/${created.data.id}/upload`, input.file)
  } catch (error) {
    await proxyDelete(`/api/v1/attachments/${created.data.id}`).catch(() => undefined)
    throw error
  }
  return created
}

export async function updateAttachment(
  attachmentId: string,
  input: { filename?: string; title?: string; notes?: string },
): Promise<AttachmentItemResponse> {
  const raw = await proxyPut(`/api/v1/attachments/${attachmentId}`, input)
  return attachmentItemResponseSchema.parse(raw)
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
  return proxyDelete(`/api/v1/attachments/${attachmentId}`)
}

export async function downloadAttachment(attachmentId: string) {
  return proxyDownload(`/api/v1/attachments/${attachmentId}/download`)
}

export interface UpdateTransactionInput {
  /** 拆分 journal id（string/number 均可，后端 numeric） */
  transaction_journal_id?: string
  /** 交易组内的稳定展示顺序，从 0 开始。 */
  order?: number
  type?: CreateTransactionType | string
  date?: string
  amount?: string
  description?: string
  source_id?: string
  source_name?: string
  destination_id?: string
  destination_name?: string
  category_name?: string
  category_id?: string | null
  budget_id?: string | null
  budget_name?: string
  bill_id?: string | null
  bill_name?: string
  currency_id?: string | null
  currency_code?: string
  foreign_currency_id?: string | null
  foreign_currency_code?: string
  foreign_amount?: string | null
  tags?: string[]
  notes?: string
  /** 对账方案 b：PUT 置位 transactions.reconciled（2026-07-10 实测生效） */
  reconciled?: boolean
}

function transactionWritePayload(input: CreateTransactionInput | UpdateTransactionInput): Record<string, unknown> {
  const tx: Record<string, unknown> = {}
  if ('transaction_journal_id' in input && input.transaction_journal_id) tx.transaction_journal_id = input.transaction_journal_id
  if (input.order !== undefined) tx.order = input.order
  if (input.type) tx.type = input.type
  if (input.date) tx.date = input.date
  if (input.amount) tx.amount = input.amount
  if (input.description !== undefined) tx.description = input.description
  if (input.source_id) tx.source_id = input.source_id
  else if (input.source_name) tx.source_name = input.source_name
  if (input.destination_id) tx.destination_id = input.destination_id
  else if (input.destination_name) tx.destination_name = input.destination_name
  if (input.category_name !== undefined) tx.category_name = input.category_name
  if (input.category_id !== undefined) tx.category_id = input.category_id
  if (input.budget_id !== undefined) tx.budget_id = input.budget_id
  else if (input.budget_name !== undefined) tx.budget_name = input.budget_name
  if (input.bill_id !== undefined) tx.bill_id = input.bill_id
  else if (input.bill_name !== undefined) tx.bill_name = input.bill_name
  if (input.currency_id !== undefined) tx.currency_id = input.currency_id
  else if (input.currency_code !== undefined) tx.currency_code = input.currency_code
  if (input.foreign_currency_id !== undefined) tx.foreign_currency_id = input.foreign_currency_id
  else if (input.foreign_currency_code !== undefined) tx.foreign_currency_code = input.foreign_currency_code
  if (input.foreign_amount !== undefined) tx.foreign_amount = input.foreign_amount
  if (input.tags) tx.tags = input.tags
  if (input.notes !== undefined) tx.notes = input.notes
  if ('reconciled' in input && input.reconciled !== undefined) tx.reconciled = input.reconciled
  return tx
}

export async function updateTransactionSplits(
  groupId: string,
  inputs: UpdateTransactionInput[],
  groupTitle?: string,
): Promise<TransactionDetailResponse> {
  const raw = await proxyPut(`/api/v1/transactions/${groupId}`, {
    group_title: inputs.length > 1 ? groupTitle?.trim() || inputs[0]?.description : undefined,
    transactions: inputs.map(transactionWritePayload),
  })
  return transactionDetailResponseSchema.parse(raw)
}

export async function updateTransaction(
  groupId: string,
  input: UpdateTransactionInput,
): Promise<TransactionDetailResponse> {
  return updateTransactionSplits(groupId, [input])
}

/**
 * DELETE /api/v1/transactions/{groupId}
 * 实测 204 空体；路径 id 是 group id（非 journal id）。
 */
export async function deleteTransaction(groupId: string): Promise<void> {
  return proxyDelete(`/api/v1/transactions/${groupId}`)
}

/**
 * GET /api/v1/budgets?start&end（预算与订阅页「预算」tab）。
 * 传入 start/end 时后端才会计算 attributes.spent（见 BudgetEnrichment），因此这里强制要求 range。
 */
export async function getBudgets(range: DateRange): Promise<BudgetsResponse> {
  return getAllPages(
    '/api/v1/budgets',
    { start: range.start, end: range.end },
    budgetsResponseSchema,
  )
}

/** GET /api/v1/budgets/{id}/limits?start&end（该预算在当前日期范围内的手动限额） */
export async function getBudgetLimits(budgetId: string, range: DateRange): Promise<BudgetLimitsResponse> {
  return getAllPages(
    `/api/v1/budgets/${budgetId}/limits`,
    { start: range.start, end: range.end },
    budgetLimitsResponseSchema,
  )
}

/** POST /api/v1/budgets —— 创建预算（name 必填） */
export async function createBudget(input: { name: string; active?: boolean }): Promise<BudgetItemResponse> {
  const raw = await proxyPost('/api/v1/budgets', {
    name: input.name.trim(),
    active: input.active ?? true,
  })
  return budgetItemResponseSchema.parse(raw)
}

export async function createBudgetWithLimit(input: {
  name: string
  active?: boolean
  limit: { start: string; end: string; amount: string; currency_code?: string }
}): Promise<BudgetWithLimitResponse> {
  const raw = await proxyPost('/api/v1/budgets/with-limit', input)
  return budgetWithLimitResponseSchema.parse(raw)
}

/** PUT /api/v1/budgets/{id} */
export async function updateBudget(
  budgetId: string,
  input: { name?: string; active?: boolean },
): Promise<BudgetItemResponse> {
  const body: Record<string, unknown> = {}
  if (input.name !== undefined) body.name = input.name.trim()
  if (input.active !== undefined) body.active = input.active
  const raw = await proxyPut(`/api/v1/budgets/${budgetId}`, body)
  return budgetItemResponseSchema.parse(raw)
}

export async function deleteBudget(budgetId: string): Promise<void> {
  return proxyDelete(`/api/v1/budgets/${budgetId}`)
}

/** POST /api/v1/budgets/{id}/limits —— 为日期范围设限额 */
export async function createBudgetLimit(
  budgetId: string,
  input: { start: string; end: string; amount: string; currency_code?: string },
): Promise<BudgetLimitItemResponse> {
  const raw = await proxyPost(`/api/v1/budgets/${budgetId}/limits`, {
    start: input.start,
    end: input.end,
    amount: input.amount,
    currency_code: input.currency_code,
  })
  return budgetLimitItemResponseSchema.parse(raw)
}

/** PUT /api/v1/budgets/{id}/limits/{limitId} —— 调整限额金额 */
export async function updateBudgetLimit(
  budgetId: string,
  limitId: string,
  input: { amount: string; start?: string; end?: string },
): Promise<BudgetLimitItemResponse> {
  const body: Record<string, unknown> = { amount: input.amount }
  if (input.start) body.start = input.start
  if (input.end) body.end = input.end
  const raw = await proxyPut(`/api/v1/budgets/${budgetId}/limits/${limitId}`, body)
  return budgetLimitItemResponseSchema.parse(raw)
}

/**
 * GET /api/v1/categories —— 分类管理页与各处分类选择器共用。
 * 不传参数就是「选择器口径」：全部域、只要没禁用的。
 * 管理页要看到禁用项，传 includeDisabled: true。
 */
export async function getCategories(
  params: { domain?: string; includeDisabled?: boolean } = {},
): Promise<CategoriesResponse> {
  const query: FireflyQueryParams = {}
  if (params.domain) query.domain = params.domain
  if (params.includeDisabled) query.include_disabled = 1
  return getAllPages('/api/v1/categories', query, categoriesResponseSchema)
}

/**
 * 分类写入字段。域和父级在创建后基本不变，但「换组」要改 parent_id，
 * 所以更新也收下同一组字段。
 * disabled 是布尔开关，后端负责翻译成 disabled_at 时间戳——前端不碰时间戳。
 */
export interface CategoryWriteInput {
  name?: string
  domain?: CategoryDomain
  parent_id?: string | null
  icon?: string | null
  color?: string | null
  disabled?: boolean
}

function categoryWritePayload(input: CategoryWriteInput): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (input.name !== undefined) body.name = input.name
  if (input.domain !== undefined) body.domain = input.domain
  if (input.parent_id !== undefined) body.parent_id = input.parent_id
  if (input.icon !== undefined) body.icon = input.icon
  if (input.color !== undefined) body.color = input.color
  if (input.disabled !== undefined) body.disabled = input.disabled
  return body
}

/** POST /api/v1/categories */
export async function createCategory(attrs: CategoryWriteInput): Promise<Category> {
  const raw = await proxyPost('/api/v1/categories', categoryWritePayload(attrs))
  return categoryItemResponseSchema.parse(raw).data
}

/** PUT /api/v1/categories/{id}：改名、换图标颜色、换组、禁用切换都走这里 */
export async function updateCategory(id: string, attrs: CategoryWriteInput): Promise<Category> {
  const raw = await proxyPut(`/api/v1/categories/${id}`, categoryWritePayload(attrs))
  return categoryItemResponseSchema.parse(raw).data
}

/**
 * DELETE /api/v1/categories/{id}[?migrate_to=]
 * 名下还有交易时后端回 422，调用方据此弹「迁移到…」再带 migrateTo 重来。
 */
export async function deleteCategory(id: string, migrateTo?: string): Promise<void> {
  const query = migrateTo ? `?migrate_to=${encodeURIComponent(migrateTo)}` : ''
  return proxyDelete(`/api/v1/categories/${id}${query}`)
}

/** GET /api/v1/abei/category-stats —— 管理页每行的用量，和未分类交易笔数 */
export async function getCategoryStats(): Promise<CategoryStats> {
  const raw = await proxyGet('/api/v1/abei/category-stats')
  return categoryStatsResponseSchema.parse(raw).data
}

/** GET /api/v1/abei/budget-groups?start=&end= */
export async function getBudgetGroups(start: string, end: string): Promise<BudgetGroup[]> {
  const raw = await proxyGet('/api/v1/abei/budget-groups', { start, end })
  return budgetGroupsResponseSchema.parse(raw).data
}

/** PUT /api/v1/abei/budget-groups/{categoryId}：amount 传 null 即清除预算 */
export async function setGroupBudget(categoryId: string, amount: string | null): Promise<void> {
  await proxyPut(`/api/v1/abei/budget-groups/${categoryId}`, { amount })
}

/** GET /api/v1/tags（设置页「分类与标签」组） */
export async function getTags(): Promise<TagsResponse> {
  return getAllPages('/api/v1/tags', {}, tagsResponseSchema)
}

export async function triggerRecurrence(recurrenceId: string, date: string): Promise<TransactionsResponse> {
  const raw = await proxyPost(`/api/v1/recurrences/${recurrenceId}/trigger?date=${encodeURIComponent(date)}`, {})
  return transactionsResponseSchema.parse(raw)
}

export type ExportDataType =
  | 'accounts'
  | 'bills'
  | 'subscriptions'
  | 'budgets'
  | 'categories'
  | 'piggy-banks'
  | 'recurring'
  | 'rules'
  | 'tags'
  | 'transactions'

export async function exportData(
  type: ExportDataType,
  opts: { start?: string; end?: string; accounts?: string[] } = {},
) {
  const params = new URLSearchParams({ type: 'csv' })
  if (opts.start) params.set('start', opts.start)
  if (opts.end) params.set('end', opts.end)
  if (opts.accounts && opts.accounts.length > 0) params.set('accounts', opts.accounts.join(','))
  return proxyDownload(`/api/v1/data/export/${type}?${params}`)
}

/** GET /api/v1/recurrences（设置页「自动化」组） */
export async function getRecurrences(): Promise<RecurrencesResponse> {
  return getAllPages('/api/v1/recurrences', {}, recurrencesResponseSchema)
}

/** GET /api/v1/currencies（设置页「币种」组） */
export async function getCurrencies(): Promise<CurrenciesResponse> {
  return getAllPages('/api/v1/currencies', {}, currenciesResponseSchema)
}

/** GET /api/v1/about（设置页「关于」卡） */
export async function getAbout(): Promise<AboutResponse> {
  const raw = await proxyGet('/api/v1/about')
  return aboutResponseSchema.parse(raw)
}

/**
 * GET /api/v1/autocomplete/accounts?query=&limit=&types=
 * 实测：纯数组 [{id, name, name_with_balance, type, active, currency_*...}]。
 * types 传 Firefly 账户类型文案（如 "Expense account" / "Revenue account"），可逗号多值。
 * 记一笔：支出目标用 Expense account，收入来源用 Revenue account。
 */
export async function autocompleteAccounts(
  query: string,
  opts: { types?: string; limit?: number } = {},
): Promise<AutocompleteAccount[]> {
  const raw = await proxyGet('/api/v1/autocomplete/accounts', {
    query: query.trim(),
    limit: opts.limit ?? 10,
    types: opts.types,
  })
  return autocompleteAccountsSchema.parse(raw)
}

/**
 * GET /api/v1/autocomplete/categories?query=&limit=
 * 实测：纯数组 [{id, name}]。
 */
export async function autocompleteCategories(
  query: string,
  opts: { limit?: number } = {},
): Promise<AutocompleteCategory[]> {
  const raw = await proxyGet('/api/v1/autocomplete/categories', {
    query: query.trim(),
    limit: opts.limit ?? 10,
  })
  return autocompleteCategoriesSchema.parse(raw)
}

/**
 * GET /api/v1/autocomplete/tags?query=&limit=
 * 实测：纯数组 [{id, name, tag}]（name 与 tag 通常同值）。
 */
export async function autocompleteTags(
  query: string,
  opts: { limit?: number } = {},
): Promise<AutocompleteTag[]> {
  const raw = await proxyGet('/api/v1/autocomplete/tags', {
    query: query.trim(),
    limit: opts.limit ?? 10,
  })
  return autocompleteTagsSchema.parse(raw)
}

/**
 * GET /api/v1/autocomplete/transactions?query=&limit=
 * 实测：纯数组 [{id, transaction_group_id, name, description}]。
 * 用于描述字段的历史描述建议（可选加分项）。
 */
export async function autocompleteTransactions(
  query: string,
  opts: { limit?: number } = {},
): Promise<AutocompleteTransaction[]> {
  const response = await searchTransactions(query, opts.limit ?? 10)
  return autocompleteTransactionsSchema.parse(response.data.map((group) => ({
    id: group.id,
    transaction_group_id: group.id,
    name: group.attributes.transactions[0]?.description ?? '',
    description: group.attributes.transactions[0]?.description ?? '',
  })))
}

/**
 * POST /api/v1/tokens
 * 为当前用户签发一个新的个人访问令牌（abei-web）。
 */
export async function createApiToken(name = 'abei AI'): Promise<string> {
  const raw = await proxyPost<{ data: { access_token: string } }>('/api/v1/tokens', { name })
  return raw.data.access_token
}

/** GET /api/v1/tokens —— 列出当前用户的个人访问令牌（本项目后端新增端点）。 */
export async function getApiTokens(): Promise<ApiToken[]> {
  const raw = await proxyGet('/api/v1/tokens')
  return apiTokensResponseSchema.parse(raw).data
}

/** DELETE /api/v1/tokens/{id} —— 撤销令牌（行还在表里，revoked=true）。 */
export async function revokeApiToken(id: string): Promise<void> {
  await proxyDelete(`/api/v1/tokens/${id}`)
}
