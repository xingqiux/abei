import { FireflyApiError, fireflyDelete, fireflyDownload, fireflyFetch, fireflyPatch, fireflyPost, fireflyPut, fireflyUpload } from './client'
import {
  getActiveBookId,
  granaryDelete,
  granaryGet,
  granaryPost,
  granaryPut,
} from './granary'
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
  billInboxProcessResultSchema,
  billInboxCleanupResultSchema,
  billInboxSyncResultSchema,
  billStatementRowItemResponseSchema,
  billStatementRowsResponseSchema,
  billTaskItemResponseSchema,
  billRowSplitResponseSchema,
  billArtifactsResponseSchema,
  billTaskEventsResponseSchema,
  billTaskReviewSchema,
  billTasksResponseSchema,
  billsResponseSchema,
  budgetItemResponseSchema,
  budgetLimitItemResponseSchema,
  budgetLimitsResponseSchema,
  budgetWithLimitResponseSchema,
  budgetsResponseSchema,
  categoriesResponseSchema,
  currenciesResponseSchema,
  piggyBanksResponseSchema,
  reconciliationSummarySchema,
  reconciliationActionResultSchema,
  recurrencesResponseSchema,
  rulesResponseSchema,
  ruleGroupsResponseSchema,
  tagsResponseSchema,
  transactionCreateResponseSchema,
  transactionDetailResponseSchema,
  type Account,
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
  type BillInboxProcessResult,
  type BillInboxCleanupResult,
  type BillInboxSyncResult,
  type BillStatementRowItemResponse,
  type BillStatementRowsResponse,
  type BillTaskItemResponse,
  type BillRowSplitResponse,
  type BillArtifactsResponse,
  type BillTaskEventsResponse,
  type BillTaskReview,
  type BillTasksResponse,
  type BillsResponse,
  type BudgetItemResponse,
  type BudgetLimitItemResponse,
  type BudgetLimitsResponse,
  type BudgetWithLimitResponse,
  type BudgetsResponse,
  type CategoriesResponse,
  type CurrenciesResponse,
  type PiggyBanksResponse,
  type ReconciliationSummary,
  type RecurrencesResponse,
  type RulesResponse,
  type RuleGroupsResponse,
  type TagsResponse,
  type TransactionCreateResponse,
  type TransactionDetailResponse,
  accountChartOverviewSchema,
  financialReportResponseSchema,
  insightCategoryResponseSchema,
  preferenceResponseSchema,
  summaryResponseSchema,
  transactionsResponseSchema,
  transactionSearchCountSchema,
  type AccountChartOverview,
  type FinancialReportResponse,
  type InsightCategoryEntry,
  type PreferenceResponse,
  type ReconciliationActionResult,
  type SummaryResponse,
  type TransactionsResponse,
  type TransactionSearchCount,
} from './schemas'
import { sumDecimalStrings } from '../lib/decimal'

interface GranaryAccount {
  id: number
  name: string
  class: 'asset' | 'liability'
  role: 'bank' | 'cash' | 'card' | 'loan' | 'other'
  currency_code: string
  balance: string
  version: number
  archived_at: string | null
}

interface GranaryPosting {
  id: number
  account_id: number
  account_name: string
  account_class: 'asset' | 'liability' | 'expense' | 'income' | 'equity'
  currency_code: string
  category_id: number | null
  category_name: string | null
  budget_id: number | null
  budget_name: string | null
  amount: string
  book_amount: string
  memo: string | null
  cleared_at: string | null
}

interface GranaryTransaction {
  id: number
  status: string
  transaction_type: CreateTransactionType
  occurred_at: string
  description: string
  counterparty_id: number | null
  counterparty_name: string | null
  version: number
  postings: GranaryPosting[]
  tags: Array<{ id: number; name: string; archived: boolean }>
}

interface GranaryTransactionPage {
  data: GranaryTransaction[]
  next_before_id: number | null
}

interface GranaryCategory {
  id: number
  name: string
  kind: 'income' | 'expense'
  parent_id: number | null
  version: number
  archived_at: string | null
}

interface GranaryTag {
  id: number
  name: string
  color: string | null
  version: number
  archived_at: string | null
}

interface GranaryCounterparty {
  id: number
  name: string
  kind: string
  review_status: string
  notes: string | null
  version: number
  archived_at: string | null
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: '¥',
  USD: '$',
  HKD: 'HK$',
  EUR: '€',
  JPY: '¥',
  GBP: '£',
}

function bookPath(suffix: string): string {
  return `/api/v1/books/${getActiveBookId()}${suffix}`
}

function accountType(account: GranaryAccount): AccountType {
  if (account.class === 'liability') return 'liabilities'
  if (account.role === 'cash') return 'cash'
  return 'asset'
}

function mapAccount(account: GranaryAccount): Account {
  return {
    id: String(account.id),
    attributes: {
      name: account.name,
      type: accountType(account),
      active: account.archived_at == null,
      currency_code: account.currency_code,
      currency_symbol: CURRENCY_SYMBOLS[account.currency_code] ?? account.currency_code,
      current_balance: account.balance,
      account_role: account.role,
      include_net_worth: true,
      version: account.version,
    },
  }
}

function absoluteAmount(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value
}

function mapTransaction(transaction: GranaryTransaction) {
  const visible = transaction.postings.filter((posting) => posting.account_class === 'asset' || posting.account_class === 'liability')
  const categories = transaction.postings.filter((posting) => posting.category_id != null)
  const source = transaction.transaction_type === 'deposit'
    ? null
    : visible.find((posting) => posting.amount.trim().startsWith('-')) ?? visible[0] ?? null
  const destination = transaction.transaction_type === 'withdrawal'
    ? null
    : visible.find((posting) => !posting.amount.trim().startsWith('-') && posting.amount !== '0') ?? visible.at(-1) ?? null
  const rows = transaction.transaction_type === 'transfer'
    ? [source ?? destination].filter((posting): posting is GranaryPosting => posting != null)
    : categories
  const transactions = rows.map((posting) => {
    const currencyCode = transaction.transaction_type === 'transfer'
      ? posting.currency_code
      : posting.currency_code
    return {
      description: transaction.description,
      amount: absoluteAmount(transaction.transaction_type === 'transfer' ? posting.amount : posting.book_amount),
      currency_code: currencyCode,
      currency_symbol: CURRENCY_SYMBOLS[currencyCode] ?? currencyCode,
      type: transaction.transaction_type,
      date: transaction.occurred_at,
      source_name: source?.account_name ?? transaction.counterparty_name,
      destination_name: destination?.account_name ?? transaction.counterparty_name,
      category_name: posting.category_name,
      transaction_journal_id: String(transaction.id),
      source_id: source == null ? null : String(source.account_id),
      destination_id: destination == null ? null : String(destination.account_id),
      category_id: posting.category_id == null ? null : String(posting.category_id),
      budget_id: posting.budget_id == null ? null : String(posting.budget_id),
      budget_name: posting.budget_name,
      tags: transaction.tags.filter((tag) => !tag.archived).map((tag) => tag.name),
      notes: posting.memo,
      reconciled: visible.length > 0 && visible.every((item) => item.cleared_at != null),
      granary_version: transaction.version,
      counterparty_id: transaction.counterparty_id,
    }
  })
  return {
    id: String(transaction.id),
    attributes: {
      group_title: transaction.description,
      transactions,
    },
  }
}

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
    const raw = await fireflyFetch(path, { ...params, limit, page })
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

export type TransactionTypeFilter = 'all' | 'withdrawal' | 'deposit' | 'transfer'

export async function getSummaryBasic(range: DateRange): Promise<SummaryResponse> {
  const summary = await granaryGet<{
    currency_code: string
    expense: string
    income: string
    net_cashflow: string
    net_worth: string
  }>(bookPath('/reports/summary'), { start: range.start, end: range.end })
  const symbol = CURRENCY_SYMBOLS[summary.currency_code] ?? summary.currency_code
  return summaryResponseSchema.parse({
    [`spent-in-${summary.currency_code}`]: {
      key: `spent-in-${summary.currency_code}`,
      monetary_value: `-${absoluteAmount(summary.expense)}`,
      value_parsed: summary.expense,
      currency_code: summary.currency_code,
      currency_symbol: symbol,
    },
    [`earned-in-${summary.currency_code}`]: {
      key: `earned-in-${summary.currency_code}`,
      monetary_value: absoluteAmount(summary.income),
      value_parsed: summary.income,
      currency_code: summary.currency_code,
      currency_symbol: symbol,
    },
    [`net-worth-in-${summary.currency_code}`]: {
      key: `net-worth-in-${summary.currency_code}`,
      monetary_value: summary.net_worth,
      value_parsed: summary.net_worth,
      currency_code: summary.currency_code,
      currency_symbol: symbol,
    },
  })
}

export async function getTransactions(
  range: DateRange,
  opts: { limit?: number; page?: number; beforeId?: string; type?: TransactionTypeFilter; accountId?: string; query?: string } = {},
): Promise<TransactionsResponse> {
  const raw = await granaryGet<GranaryTransactionPage>(bookPath('/transactions'), {
    start: range.start,
    end: range.end,
    limit: opts.limit ?? 80,
    before_id: opts.beforeId,
    type: opts.type ?? 'all',
    account_id: opts.accountId,
    query: opts.query,
  })
  return transactionsResponseSchema.parse({
    data: raw.data.map(mapTransaction),
    next_before_id: raw.next_before_id == null ? null : String(raw.next_before_id),
  })
}

export async function getAllTransactions(
  range: DateRange,
  opts: { limit?: number; type?: TransactionTypeFilter } = {},
): Promise<TransactionsResponse> {
  const limit = opts.limit ?? 200
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
 * 命令面板「搜索交易」区：GET /api/v1/search/transactions?query=&limit=。
 * 实测响应结构与 GET /api/v1/transactions 完全一致（data 为 transaction group 数组，
 * 每个 group.attributes.transactions 是拆分数组），因此复用 transactionsResponseSchema。
 */
export async function searchTransactions(query: string, limit = 10): Promise<TransactionsResponse> {
  return getTransactions(
    { start: '1900-01-01', end: '2999-12-31' },
    { query: query.trim(), limit },
  )
}

export async function countTransactions(query: string): Promise<TransactionSearchCount> {
  let beforeId: string | undefined
  let count = 0
  do {
    const response = await getTransactions(
      { start: '1900-01-01', end: '2999-12-31' },
      { query: query.trim(), limit: 200, beforeId },
    )
    count += response.data.length
    beforeId = response.next_before_id ?? undefined
  } while (beforeId)
  return transactionSearchCountSchema.parse({ count })
}

export async function searchAccounts(query: string): Promise<AccountsResponse> {
  const raw = await granaryGet<GranaryAccount[]>(bookPath('/accounts'))
  const needle = query.trim().toLocaleLowerCase()
  const data = raw.filter((account) => account.name.toLocaleLowerCase().includes(needle)).map(mapAccount)
  return accountsResponseSchema.parse({ data, meta: { pagination: { total: data.length } } })
}

export async function getExpenseByCategory(range: DateRange): Promise<InsightCategoryEntry[]> {
  const raw = await granaryGet<Array<{ id: number; name: string; currency_code: string; amount: string }>>(
    bookPath('/reports/expenses/by-category'),
    { start: range.start, end: range.end },
  )
  return insightCategoryResponseSchema.parse(raw.map((row) => ({
    id: String(row.id),
    name: row.name,
    difference: `-${absoluteAmount(row.amount)}`,
    currency_code: row.currency_code,
  })))
}

/** GET /api/v1/insight/income/revenue（报表页「收入来源排行」）：结构与 expense/category 一致 */
export async function getIncomeByRevenue(range: DateRange): Promise<InsightCategoryEntry[]> {
  const raw = await fireflyFetch('/api/v1/insight/income/revenue', {
    start: range.start,
    end: range.end,
  })
  return insightCategoryResponseSchema.parse(raw)
}

/** GET /api/v1/insight/expense/asset（报表页「账户流出排行」）：结构与 expense/category 一致 */
export async function getExpenseByAsset(range: DateRange): Promise<InsightCategoryEntry[]> {
  const raw = await fireflyFetch('/api/v1/insight/expense/asset', {
    start: range.start,
    end: range.end,
  })
  return insightCategoryResponseSchema.parse(raw)
}

async function getInsightRanking(path: string, range: DateRange): Promise<InsightCategoryEntry[]> {
  const raw = await fireflyFetch(path, { start: range.start, end: range.end })
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
  const raw = await fireflyFetch('/api/v1/insight/report/overview', { start: range.start, end: range.end })
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
  const raw = await granaryGet<GranaryAccount[]>(bookPath('/accounts'))
  const ids = new Set((opts.accounts ?? []).map(String))
  const accounts = raw.filter((account) => {
    if (ids.size > 0) return ids.has(String(account.id))
    if (opts.preselected === 'liabilities') return account.class === 'liability'
    return account.class === 'asset'
  })
  const timestamp = `${range.end}T12:00:00Z`
  return accountChartOverviewSchema.parse(accounts.map((account) => ({
    label: account.name,
    currency_code: account.currency_code,
    currency_symbol: CURRENCY_SYMBOLS[account.currency_code] ?? account.currency_code,
    type: accountType(account),
    period: opts.period ?? pickChartPeriod(range),
    entries: { [timestamp]: account.balance },
    pc_entries: {},
  })))
}

export async function getBillInboxSummary(): Promise<BillInboxSummary> {
  const raw = await fireflyFetch('/api/v1/bill-inbox/summary', {})
  return billInboxSummarySchema.parse(raw)
}

export type BillInboxSettingsInput = Partial<
  Pick<
    BillInboxSettings['data']['attributes'],
    'enabled' | 'provider' | 'email' | 'host' | 'port' | 'encryption' | 'username' | 'folder'
  >
> & { password?: string }

export async function getBillInboxSettings(): Promise<BillInboxSettings> {
  const raw = await fireflyFetch('/api/v1/bill-inbox/settings')
  return billInboxSettingsSchema.parse(raw)
}

export async function updateBillInboxSettings(
  input: BillInboxSettingsInput,
): Promise<BillInboxSettings> {
  const raw = await fireflyPut('/api/v1/bill-inbox/settings', input)
  return billInboxSettingsSchema.parse(raw)
}

export async function processBillInbox(limit = 25): Promise<BillInboxProcessResult> {
  const raw = await fireflyPost('/api/v1/bill-inbox/process', { limit })
  return billInboxProcessResultSchema.parse(raw)
}

export async function cleanupBillInbox(): Promise<BillInboxCleanupResult> {
  const raw = await fireflyPost('/api/v1/bill-inbox/cleanup-stale', {})
  return billInboxCleanupResultSchema.parse(raw)
}

export async function getReconciliationSummary(days = 30): Promise<ReconciliationSummary> {
  const raw = await fireflyFetch('/api/v1/daily-reconciliation/summary', { days })
  return reconciliationSummarySchema.parse(raw)
}

export type BillTaskSource = 'alipay' | 'wechat' | 'cmb' | 'boc'

export async function getBillTasks(opts: {
  source?: string
  status?: string
  page?: number
  limit?: number
}): Promise<BillTasksResponse> {
  const raw = await fireflyFetch('/api/v1/bill-tasks', {
    source: opts.source,
    status: opts.status,
    page: opts.page ?? 1,
    limit: opts.limit ?? 30,
  })
  return billTasksResponseSchema.parse(raw)
}

export async function getAllBillTasks(opts: {
  source?: string
  status?: string
  limit?: number
}): Promise<BillTasksResponse> {
  const limit = opts.limit ?? 100
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
 */
export async function getBillTaskRows(
  taskId: string,
  opts: { status?: string } = {},
): Promise<BillStatementRowsResponse> {
  const raw = await fireflyFetch(`/api/v1/bill-tasks/${taskId}/rows`, {
    status: opts.status,
  })
  return billStatementRowsResponseSchema.parse(raw)
}

export async function getBillTaskArtifacts(taskId: string): Promise<BillArtifactsResponse> {
  const raw = await fireflyFetch(`/api/v1/bill-tasks/${taskId}/artifacts`)
  return billArtifactsResponseSchema.parse(raw)
}

export async function getBillTaskEvents(taskId: string): Promise<BillTaskEventsResponse> {
  const raw = await fireflyFetch(`/api/v1/bill-tasks/${taskId}/events`)
  return billTaskEventsResponseSchema.parse(raw)
}

export async function getBillTaskReview(taskId: string): Promise<BillTaskReview> {
  const raw = await fireflyFetch(`/api/v1/bill-tasks/${taskId}/review`)
  return billTaskReviewSchema.parse(raw)
}

export async function downloadBillArtifact(
  artifactId: string,
): Promise<{ blob: Blob; filename: string | null }> {
  return fireflyDownload(`/api/v1/bill-artifacts/${artifactId}/download`)
}

/**
 * PATCH /api/v1/bill-statement-rows/{id}
 * 收件箱行内编辑：金额/分类/描述等（ActionController@updateRow 校验字段）。
 * 同时写 amount 与 firefly_amount、firefly_description，保证入账预览与展示一致。
 */
export interface UpdateBillStatementRowInput {
  firefly_type?: 'withdrawal' | 'deposit' | 'transfer' | null
  firefly_date?: string | null
  firefly_description?: string
  source_name?: string | null
  destination_name?: string | null
  category_name?: string | null
  amount?: string
  firefly_amount?: string
  description?: string
  notes?: string | null
}

export async function updateBillStatementRow(
  rowId: string,
  input: UpdateBillStatementRowInput,
): Promise<BillStatementRowItemResponse> {
  const raw = await fireflyPatch(`/api/v1/bill-statement-rows/${rowId}`, input)
  return billStatementRowItemResponseSchema.parse(raw)
}

export async function splitBillStatementRow(
  rowId: string,
  splits: Array<{ payment_method?: string; source_name?: string; amount: string; description: string; category_name?: string }>,
): Promise<BillRowSplitResponse> {
  const raw = await fireflyPost(`/api/v1/bill-statement-rows/${rowId}/split`, { splits })
  return billRowSplitResponseSchema.parse(raw)
}

export async function importBillTaskRows(
  taskId: string,
  body: { row_ids?: string[]; all?: boolean; confirm: boolean },
): Promise<BillImportResponse> {
  const raw = await fireflyPost(`/api/v1/bill-tasks/${taskId}/import`, body)
  return billImportResponseSchema.parse(raw)
}

export async function ignoreBillTask(taskId: string): Promise<unknown> {
  return fireflyPost(`/api/v1/bill-tasks/${taskId}/ignore`, {})
}

/**
 * POST /api/v1/bill-inbox/sync —— 触发真实邮箱同步（红线：验证时点一次即可，勿轮点）。
 * body 可选 {limit?:1-100}，默认后端 25。响应 attributes 含 scanned/created/processed 等。
 */
export async function syncBillInbox(opts: { limit?: number } = {}): Promise<BillInboxSyncResult> {
  const body = opts.limit !== undefined ? { limit: opts.limit } : {}
  const raw = await fireflyPost('/api/v1/bill-inbox/sync', body)
  return billInboxSyncResultSchema.parse(raw)
}

/**
 * POST /api/v1/bill-tasks/{id}/secret —— 提交解压密码/验证码（needs_secret 状态）。
 * 实测 body 字段名是 value（非 password/secret），对照 ActionController@secret。
 */
export async function submitBillTaskSecret(taskId: string, value: string): Promise<BillTaskItemResponse> {
  const raw = await fireflyPost(`/api/v1/bill-tasks/${taskId}/secret`, { value })
  return billTaskItemResponseSchema.parse(raw)
}

/**
 * POST /api/v1/bill-tasks/{id}/retry —— 失败任务重试，无 body。
 * 响应为更新后的 bill-task Item。
 */
export async function retryBillTask(taskId: string): Promise<BillTaskItemResponse> {
  const raw = await fireflyPost(`/api/v1/bill-tasks/${taskId}/retry`, {})
  return billTaskItemResponseSchema.parse(raw)
}

export type AccountType = 'asset' | 'cash' | 'expense' | 'revenue' | 'liabilities'

/**
 * 账户页四个 tab 的分页列表：GET /api/v1/accounts?type=&limit=&page=。
 */
export async function getAccountsByType(
  type: AccountType,
  opts: { limit?: number; page?: number } = {},
) {
  const raw = await granaryGet<GranaryAccount[]>(bookPath('/accounts'))
  const filtered = raw.filter((account) => accountType(account) === type)
  const limit = opts.limit ?? 40
  const start = ((opts.page ?? 1) - 1) * limit
  return accountsResponseSchema.parse({
    data: filtered.slice(start, start + limit).map(mapAccount),
    meta: {
      pagination: {
        total: filtered.length,
        count: Math.min(limit, Math.max(0, filtered.length - start)),
        per_page: limit,
        current_page: opts.page ?? 1,
        total_pages: Math.max(1, Math.ceil(filtered.length / limit)),
      },
    },
  })
}

/** GET /api/v1/accounts/{id} */
export async function getAccount(accountId: string): Promise<AccountDetailResponse> {
  const raw = await granaryGet<GranaryAccount>(bookPath(`/accounts/${accountId}`))
  return accountDetailResponseSchema.parse({ data: mapAccount(raw) })
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
  const raw = await granaryPost<GranaryAccount>(bookPath('/accounts'), accountWritePayload(input))
  return accountItemResponseSchema.parse({ data: mapAccount(raw) })
}

export async function updateAccount(accountId: string, input: AccountInput): Promise<AccountDetailResponse> {
  const current = input.version == null
    ? await granaryGet<GranaryAccount>(bookPath(`/accounts/${accountId}`))
    : null
  const raw = await granaryPut<GranaryAccount>(bookPath(`/accounts/${accountId}`), {
    ...accountWritePayload(input),
    version: input.version ?? current?.version,
  })
  return accountItemResponseSchema.parse({ data: mapAccount(raw) })
}

export async function deleteAccount(accountId: string): Promise<void> {
  const current = await granaryGet<GranaryAccount>(bookPath(`/accounts/${accountId}`))
  return granaryDelete(bookPath(`/accounts/${accountId}`), { version: current.version })
}

function accountWritePayload(input: AccountInput) {
  const type = input.type ?? 'asset'
  const className = type === 'liabilities' ? 'liability' : 'asset'
  let role = input.account_role ?? (type === 'cash' ? 'cash' : className === 'liability' ? 'other' : 'bank')
  if (role === 'cashWalletAsset') role = 'cash'
  else if (role === 'ccAsset') role = 'card'
  else if (!['bank', 'cash', 'card', 'loan', 'other'].includes(role)) role = className === 'liability' ? 'other' : 'bank'
  return {
    name: input.name,
    class: className,
    role,
    currency_code: input.currency_code ?? 'CNY',
  }
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
  return getTransactions(range, {
    limit: opts.limit,
    beforeId: opts.beforeId,
    type: opts.type,
    accountId,
  })
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
  const accounts = await granaryGet<GranaryAccount[]>(bookPath('/accounts'))
  return accounts
    .filter((account) => includeLiabilities || account.class === 'asset')
    .map((account) => ({
      id: String(account.id),
      name: account.name,
      currencyCode: account.currency_code,
      currencySymbol: CURRENCY_SYMBOLS[account.currency_code] ?? account.currency_code,
    }))
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
  if (!first) throw new FireflyApiError(422, '交易至少需要一个拆分')
  if (first.type === 'transfer' && inputs.length !== 1) {
    throw new FireflyApiError(422, '转账不能使用分类拆分')
  }
  const sameHeader = inputs.every((input) =>
    input.type === first.type
    && input.date === first.date
    && input.source_id === first.source_id
    && input.destination_id === first.destination_id,
  )
  if (!sameHeader) {
    throw new FireflyApiError(422, '同一笔分类拆分必须使用相同日期、类型和资金账户')
  }

  const [categories, tags, counterparties, accounts, books] = await Promise.all([
    granaryGet<GranaryCategory[]>(bookPath('/categories')),
    granaryGet<GranaryTag[]>(bookPath('/tags')),
    granaryGet<GranaryCounterparty[]>(bookPath('/counterparties')),
    granaryGet<GranaryAccount[]>(bookPath('/accounts')),
    granaryGet<Array<{ id: number; base_currency_code: string }>>('/api/v1/books'),
  ])
  const book = books.find((candidate) => candidate.id === getActiveBookId())
  if (!book) throw new FireflyApiError(404, '当前账本不存在')
  const accountId = first.type === 'deposit' ? first.destination_id : first.source_id
  const account = accounts.find((candidate) => String(candidate.id) === accountId)
  if (!account) throw new FireflyApiError(422, '请选择有效的资金账户')
  if (account.currency_code !== book.base_currency_code) {
    throw new FireflyApiError(422, '外币交易需要同时填写本位币金额')
  }

  const tagNames = [...new Set(inputs.flatMap((input) => input.tags ?? []))]
  const tagIds = tagNames.map((name) => {
    const tag = tags.find((candidate) => candidate.name === name && candidate.archived_at == null)
    if (!tag) throw new FireflyApiError(422, `标签“${name}”不存在，请先在管理页面创建`)
    return tag.id
  })
  const counterpartyName = first.type === 'deposit' ? first.source_name : first.destination_name
  const counterparty = counterpartyName?.trim()
    ? counterparties.find((candidate) => candidate.name === counterpartyName.trim() && candidate.archived_at == null)
    : null
  if (counterpartyName?.trim() && !counterparty) {
    throw new FireflyApiError(422, `交易方“${counterpartyName.trim()}”不存在，请先在管理页面创建`)
  }

  let body: Record<string, unknown>
  if (first.type === 'transfer') {
    const destination = accounts.find((candidate) => String(candidate.id) === first.destination_id)
    if (!destination) throw new FireflyApiError(422, '请选择有效的目标账户')
    if (destination.currency_code !== account.currency_code) {
      throw new FireflyApiError(422, '跨币种转账需要分别填写两端金额')
    }
    body = {
      type: 'transfer',
      occurred_at: `${first.date}T12:00:00Z`,
      description: first.description.trim(),
      counterparty_id: counterparty?.id ?? null,
      source_account_id: Number(first.source_id),
      source_amount: first.amount,
      source_book_amount: first.amount,
      destination_account_id: Number(first.destination_id),
      destination_amount: first.amount,
      destination_book_amount: first.amount,
      tag_ids: tagIds,
    }
  } else {
    const kind = first.type === 'withdrawal' ? 'expense' : 'income'
    const splits = inputs.map((input) => {
      const category = categories.find((candidate) =>
        candidate.archived_at == null
        && candidate.kind === kind
        && (String(candidate.id) === input.category_id || candidate.name === input.category_name?.trim()),
      )
      if (!category) {
        throw new FireflyApiError(422, `${kind === 'expense' ? '支出' : '收入'}分类“${input.category_name ?? ''}”不存在，请先在管理页面创建`)
      }
      return {
        category_id: category.id,
        budget_id: input.budget_id ? Number(input.budget_id) : null,
        amount: input.amount,
        book_amount: input.amount,
        memo: input.notes?.trim() || null,
      }
    })
    const amount = sumDecimalStrings(inputs.map((input) => input.amount))
    body = {
      type: first.type,
      occurred_at: `${first.date}T12:00:00Z`,
      description: groupTitle?.trim() || first.description.trim(),
      counterparty_id: counterparty?.id ?? null,
      account_id: Number(accountId),
      amount,
      book_amount: amount,
      splits,
      tag_ids: tagIds,
    }
  }
  const raw = await granaryPost<GranaryTransaction>(bookPath('/transactions'), body)
  return transactionCreateResponseSchema.parse({ data: mapTransaction(raw) })
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
  const raw = await granaryGet<GranaryTransaction>(bookPath(`/transactions/${groupId}`))
  return transactionDetailResponseSchema.parse({ data: mapTransaction(raw) })
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
  const createdRaw = await fireflyPost('/api/v1/attachments', {
    filename: input.file.name,
    title: input.title || input.file.name,
    notes: input.notes || undefined,
    attachable_type: 'TransactionJournal',
    attachable_id: input.journalId,
  })
  const created = attachmentItemResponseSchema.parse(createdRaw)
  try {
    await fireflyUpload(`/api/v1/attachments/${created.data.id}/upload`, input.file)
  } catch (error) {
    await fireflyDelete(`/api/v1/attachments/${created.data.id}`).catch(() => undefined)
    throw error
  }
  return created
}

export async function updateAttachment(
  attachmentId: string,
  input: { filename?: string; title?: string; notes?: string },
): Promise<AttachmentItemResponse> {
  const raw = await fireflyPut(`/api/v1/attachments/${attachmentId}`, input)
  return attachmentItemResponseSchema.parse(raw)
}

export async function deleteAttachment(attachmentId: string): Promise<void> {
  return fireflyDelete(`/api/v1/attachments/${attachmentId}`)
}

export async function downloadAttachment(attachmentId: string) {
  return fireflyDownload(`/api/v1/attachments/${attachmentId}/download`)
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
  const raw = await fireflyPut(`/api/v1/transactions/${groupId}`, {
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

export async function markDayTransactionsReconciled(
  date: string,
): Promise<ReconciliationActionResult> {
  const raw = await fireflyPost(`/api/v1/daily-reconciliation/${date}/reconcile`, {})
  return reconciliationActionResultSchema.parse(raw)
}

/** 按名称查找资产对应的 Reconciliation 账户（与资产同名）。 */
async function findReconciliationAccountId(assetName: string): Promise<string | null> {
  const list = (await getAllPages(
    '/api/v1/accounts',
    { type: 'reconciliation' },
    accountsResponseSchema,
  )).data
  const hit = list.find((a) => a.attributes.name === assetName && a.attributes.active !== false)
  return hit?.id ?? null
}

/**
 * 生成对账调整交易（type=reconciliation）。
 * - decrease：source=destination=资产 id（实测后端把 dest 改写成对账账户，余额减少）
 * - increase：source=对账账户、destination=资产（需已存在同名 reconciliation 账户）
 */
export async function createReconciliationAdjustment(input: {
  date: string
  amount: string
  account_id: string
  direction: 'decrease' | 'increase'
  description?: string
}): Promise<TransactionDetailResponse> {
  const asset = await getAccount(input.account_id)
  const assetName = asset.data.attributes.name
  let source_id = input.account_id
  let destination_id = input.account_id

  if (input.direction === 'increase') {
    const reconId = await findReconciliationAccountId(assetName)
    if (!reconId) {
      throw new FireflyApiError(
        422,
        `未找到「${assetName}」的对账账户。请先做一笔「减少余额」调整以初始化，或在旧版 Firefly 对该账户完成过对账。`,
      )
    }
    source_id = reconId
    destination_id = input.account_id
  }

  const raw = await fireflyPost('/api/v1/transactions', {
    error_if_duplicate_hash: false,
    transactions: [
      {
        type: 'reconciliation',
        date: input.date,
        amount: input.amount,
        description:
          input.description ??
          `对账调整 ${input.date}（${input.direction === 'decrease' ? '减少' : '增加'}）`,
        source_id,
        destination_id,
        reconciled: true,
      },
    ],
  })
  return transactionCreateResponseSchema.parse(raw)
}

/**
 * DELETE /api/v1/transactions/{groupId}
 * 实测 204 空体；路径 id 是 group id（非 journal id）。
 */
export async function deleteTransaction(groupId: string): Promise<void> {
  await granaryPost(bookPath(`/transactions/${groupId}/trash`), {
    reason: '用户从 Granary Web 移入回收站',
  })
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
  const raw = await fireflyPost('/api/v1/budgets', {
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
  const raw = await fireflyPost('/api/v1/budgets/with-limit', input)
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
  const raw = await fireflyPut(`/api/v1/budgets/${budgetId}`, body)
  return budgetItemResponseSchema.parse(raw)
}

export async function deleteBudget(budgetId: string): Promise<void> {
  return fireflyDelete(`/api/v1/budgets/${budgetId}`)
}

/** POST /api/v1/budgets/{id}/limits —— 为日期范围设限额 */
export async function createBudgetLimit(
  budgetId: string,
  input: { start: string; end: string; amount: string; currency_code?: string },
): Promise<BudgetLimitItemResponse> {
  const raw = await fireflyPost(`/api/v1/budgets/${budgetId}/limits`, {
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
  const raw = await fireflyPut(`/api/v1/budgets/${budgetId}/limits/${limitId}`, body)
  return budgetLimitItemResponseSchema.parse(raw)
}

/** GET /api/v1/bills（预算与订阅页「订阅」tab） */
export async function getBills(): Promise<BillsResponse> {
  return getAllPages('/api/v1/bills', {}, billsResponseSchema)
}

/** GET /api/v1/piggy-banks（预算与订阅页「储蓄罐」tab） */
export async function getPiggyBanks(): Promise<PiggyBanksResponse> {
  return getAllPages('/api/v1/piggy-banks', {}, piggyBanksResponseSchema)
}

/** GET /api/v1/categories（设置页「分类与标签」组） */
export async function getCategories(): Promise<CategoriesResponse> {
  const raw = await granaryGet<GranaryCategory[]>(bookPath('/categories'))
  return categoriesResponseSchema.parse({
    data: raw.map((category) => ({
      id: String(category.id),
      attributes: {
        name: category.name,
        kind: category.kind,
        parent_id: category.parent_id,
        version: category.version,
      },
    })),
    meta: { pagination: { total: raw.length } },
  })
}

/** GET /api/v1/tags（设置页「分类与标签」组） */
export async function getTags(): Promise<TagsResponse> {
  const raw = await granaryGet<GranaryTag[]>(bookPath('/tags'))
  return tagsResponseSchema.parse({
    data: raw.map((tag) => ({
      id: String(tag.id),
      attributes: { tag: tag.name, color: tag.color, version: tag.version },
    })),
    meta: { pagination: { total: raw.length } },
  })
}

/** GET /api/v1/rules（设置页「自动化」组） */
export async function getRules(): Promise<RulesResponse> {
  return getAllPages('/api/v1/rules', {}, rulesResponseSchema)
}

export async function getRuleGroups(): Promise<RuleGroupsResponse> {
  return getAllPages('/api/v1/rule-groups', {}, ruleGroupsResponseSchema)
}

export async function testRule(ruleId: string, range: DateRange): Promise<TransactionsResponse> {
  const raw = await fireflyFetch(`/api/v1/rules/${ruleId}/test`, { start: range.start, end: range.end })
  return transactionsResponseSchema.parse(raw)
}

export async function triggerRule(ruleId: string, range: DateRange): Promise<void> {
  const params = new URLSearchParams({ start: range.start, end: range.end })
  await fireflyPost(`/api/v1/rules/${ruleId}/trigger?${params}`, {})
}

export async function testRuleGroup(groupId: string, range: DateRange): Promise<TransactionsResponse> {
  const raw = await fireflyFetch(`/api/v1/rule-groups/${groupId}/test`, { start: range.start, end: range.end })
  return transactionsResponseSchema.parse(raw)
}

export async function triggerRuleGroup(groupId: string, range: DateRange): Promise<void> {
  const params = new URLSearchParams({ start: range.start, end: range.end })
  await fireflyPost(`/api/v1/rule-groups/${groupId}/trigger?${params}`, {})
}

export async function triggerRecurrence(recurrenceId: string, date: string): Promise<TransactionsResponse> {
  const raw = await fireflyPost(`/api/v1/recurrences/${recurrenceId}/trigger?date=${encodeURIComponent(date)}`, {})
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
  return fireflyDownload(`/api/v1/data/export/${type}?${params}`)
}

/** GET /api/v1/recurrences（设置页「自动化」组） */
export async function getRecurrences(): Promise<RecurrencesResponse> {
  return getAllPages('/api/v1/recurrences', {}, recurrencesResponseSchema)
}

/** GET /api/v1/currencies（设置页「币种」组） */
export async function getCurrencies(): Promise<CurrenciesResponse> {
  const [currencies, books] = await Promise.all([
    granaryGet<Array<{ code: string; name: string; symbol: string; minor_units: number; enabled_by_default: boolean }>>('/api/v1/currencies'),
    granaryGet<Array<{ id: number; base_currency_code: string }>>('/api/v1/books'),
  ])
  const base = books.find((book) => book.id === getActiveBookId())?.base_currency_code
  return currenciesResponseSchema.parse({
    data: currencies.map((currency) => ({
      id: currency.code,
      attributes: {
        name: currency.name,
        code: currency.code,
        symbol: currency.symbol,
        enabled: currency.enabled_by_default || currency.code === base,
        default: currency.code === base,
        decimal_places: currency.minor_units,
      },
    })),
    meta: { pagination: { total: currencies.length } },
  })
}

/** GET /api/v1/about（设置页「关于」卡） */
export async function getAbout(): Promise<AboutResponse> {
  const raw = await granaryGet<{ service_version: string }>('/api/v1/instance')
  return aboutResponseSchema.parse({ data: { version: raw.service_version, api_version: 'v1', driver: 'PostgreSQL' } })
}

/**
 * GET /api/v1/preferences/{name} —— 按名取单条偏好。
 * 不存在时 Firefly 返回 404，这里映射为 null（新建偏好前的正常状态）。
 */
export async function getPreferenceByName(name: string): Promise<PreferenceResponse | null> {
  try {
    const raw = await fireflyFetch(`/api/v1/preferences/${encodeURIComponent(name)}`)
    return preferenceResponseSchema.parse(raw)
  } catch (err) {
    if (err instanceof FireflyApiError && err.status === 404) return null
    throw err
  }
}

/**
 * POST /api/v1/preferences —— Preferences::set 语义，同名则更新（实测 upsert，id 不变）。
 * body: { name, data }；data 可为对象（如 granary.date_range）。
 */
export async function setPreference(name: string, data: unknown): Promise<PreferenceResponse> {
  const raw = await fireflyPost('/api/v1/preferences', { name, data })
  return preferenceResponseSchema.parse(raw)
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
  const needle = query.trim().toLocaleLowerCase()
  if (opts.types?.includes('Expense') || opts.types?.includes('Revenue')) {
    const counterparties = await granaryGet<GranaryCounterparty[]>(bookPath('/counterparties'))
    return autocompleteAccountsSchema.parse(counterparties
      .filter((counterparty) => counterparty.name.toLocaleLowerCase().includes(needle))
      .slice(0, opts.limit ?? 10)
      .map((counterparty) => ({ id: String(counterparty.id), name: counterparty.name, type: 'counterparty', active: true })))
  }
  const accounts = await granaryGet<GranaryAccount[]>(bookPath('/accounts'))
  return autocompleteAccountsSchema.parse(accounts
    .filter((account) => account.name.toLocaleLowerCase().includes(needle))
    .slice(0, opts.limit ?? 10)
    .map((account) => ({ id: String(account.id), name: account.name, type: accountType(account), active: true })))
}

/**
 * GET /api/v1/autocomplete/categories?query=&limit=
 * 实测：纯数组 [{id, name}]。
 */
export async function autocompleteCategories(
  query: string,
  opts: { limit?: number } = {},
): Promise<AutocompleteCategory[]> {
  const needle = query.trim().toLocaleLowerCase()
  const categories = await granaryGet<GranaryCategory[]>(bookPath('/categories'))
  const parentIds = new Set(categories
    .filter((category) => category.archived_at == null && category.parent_id != null)
    .map((category) => category.parent_id))
  return autocompleteCategoriesSchema.parse(categories
    .filter((category) => category.archived_at == null
      && !parentIds.has(category.id)
      && category.name.toLocaleLowerCase().includes(needle))
    .slice(0, opts.limit ?? 10)
    .map((category) => ({ id: String(category.id), name: category.name, kind: category.kind })))
}

/**
 * GET /api/v1/autocomplete/tags?query=&limit=
 * 实测：纯数组 [{id, name, tag}]（name 与 tag 通常同值）。
 */
export async function autocompleteTags(
  query: string,
  opts: { limit?: number } = {},
): Promise<AutocompleteTag[]> {
  const needle = query.trim().toLocaleLowerCase()
  const tags = await granaryGet<GranaryTag[]>(bookPath('/tags'))
  return autocompleteTagsSchema.parse(tags
    .filter((tag) => tag.name.toLocaleLowerCase().includes(needle))
    .slice(0, opts.limit ?? 10)
    .map((tag) => ({ id: String(tag.id), name: tag.name, tag: tag.name })))
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
