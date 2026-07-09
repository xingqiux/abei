import { fireflyFetch, fireflyPost } from './client'
import {
  accountsResponseSchema,
  aboutResponseSchema,
  billImportResponseSchema,
  billInboxSummarySchema,
  billStatementRowsResponseSchema,
  billTasksResponseSchema,
  billsResponseSchema,
  budgetLimitsResponseSchema,
  budgetsResponseSchema,
  categoriesResponseSchema,
  currenciesResponseSchema,
  piggyBanksResponseSchema,
  reconciliationSummarySchema,
  recurrencesResponseSchema,
  rulesResponseSchema,
  tagsResponseSchema,
  transactionCreateResponseSchema,
  type Account,
  type AboutResponse,
  type BillImportResponse,
  type BillInboxSummary,
  type BillStatementRowsResponse,
  type BillTasksResponse,
  type BillsResponse,
  type BudgetLimitsResponse,
  type BudgetsResponse,
  type CategoriesResponse,
  type CurrenciesResponse,
  type PiggyBanksResponse,
  type ReconciliationSummary,
  type RecurrencesResponse,
  type RulesResponse,
  type TagsResponse,
  type TransactionCreateResponse,
  insightCategoryResponseSchema,
  summaryResponseSchema,
  transactionsResponseSchema,
  type InsightCategoryEntry,
  type SummaryResponse,
  type TransactionsResponse,
} from './schemas'

export interface DateRange {
  start: string // YYYY-MM-DD
  end: string // YYYY-MM-DD
}

export type TransactionTypeFilter = 'all' | 'withdrawal' | 'deposit' | 'transfer'

export async function getSummaryBasic(range: DateRange): Promise<SummaryResponse> {
  const raw = await fireflyFetch('/api/v1/summary/basic', { start: range.start, end: range.end })
  return summaryResponseSchema.parse(raw)
}

export async function getTransactions(
  range: DateRange,
  opts: { limit?: number; page?: number; type?: TransactionTypeFilter } = {},
): Promise<TransactionsResponse> {
  const raw = await fireflyFetch('/api/v1/transactions', {
    start: range.start,
    end: range.end,
    limit: opts.limit ?? 80,
    page: opts.page ?? 1,
    type: opts.type ?? 'all',
  })
  return transactionsResponseSchema.parse(raw)
}

/**
 * 命令面板「搜索交易」区：GET /api/v1/search/transactions?query=&limit=。
 * 实测响应结构与 GET /api/v1/transactions 完全一致（data 为 transaction group 数组，
 * 每个 group.attributes.transactions 是拆分数组），因此复用 transactionsResponseSchema。
 */
export async function searchTransactions(query: string, limit = 10): Promise<TransactionsResponse> {
  const raw = await fireflyFetch('/api/v1/search/transactions', { query, limit })
  return transactionsResponseSchema.parse(raw)
}

export async function getExpenseByCategory(range: DateRange): Promise<InsightCategoryEntry[]> {
  const raw = await fireflyFetch('/api/v1/insight/expense/category', {
    start: range.start,
    end: range.end,
  })
  return insightCategoryResponseSchema.parse(raw)
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

export async function getBillInboxSummary(): Promise<BillInboxSummary> {
  const raw = await fireflyFetch('/api/v1/bill-inbox/summary', {})
  return billInboxSummarySchema.parse(raw)
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

export type AccountType = 'asset' | 'expense' | 'revenue' | 'liabilities'

/**
 * 账户页四个 tab 的分页列表：GET /api/v1/accounts?type=&limit=&page=。
 * 「加载更多」沿用账单收件箱/交易列表的惯例——用增大 limit 而非翻页重新整体取数。
 */
export async function getAccountsByType(
  type: AccountType,
  opts: { limit?: number; page?: number } = {},
) {
  const raw = await fireflyFetch('/api/v1/accounts', {
    type,
    limit: opts.limit ?? 40,
    page: opts.page ?? 1,
  })
  return accountsResponseSchema.parse(raw)
}

export interface AccountSummary {
  id: string
  name: string
}

/**
 * 资产账户列表（记一笔表单的来源/目标下拉），只保留启用状态的账户。
 * 实测 GET /api/v1/accounts?type=asset 返回 {data:[{id, attributes:{name, active, ...}}]}。
 */
export async function getAssetAccounts(): Promise<AccountSummary[]> {
  const raw = await fireflyFetch('/api/v1/accounts', { type: 'asset', limit: 200 })
  const parsed = accountsResponseSchema.parse(raw)
  return parsed.data
    .filter((a: Account) => a.attributes.active !== false)
    .map((a: Account) => ({ id: a.id, name: a.attributes.name }))
}

export type CreateTransactionType = 'withdrawal' | 'deposit' | 'transfer'

export interface CreateTransactionInput {
  type: CreateTransactionType
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
  tags?: string[]
  notes?: string
}

/**
 * 记一笔表单提交。
 * 实测 POST /api/v1/transactions body 形如
 * {error_if_duplicate_hash:false, transactions:[{type, date:'YYYY-MM-DDT00:00:00+08:00',
 * amount, description, source_id|source_name, destination_id|destination_name,
 * category_name?, tags?, notes?}]}（字段名对照后端 app/Api/V1/Requests/Models/Transaction/StoreRequest.php
 * 的校验规则确认）。响应是单个 Item 资源（data 为对象，不是数组），与 GET /transactions 的
 * Collection 响应结构不同。
 */
export async function createTransaction(input: CreateTransactionInput): Promise<TransactionCreateResponse> {
  const tx: Record<string, unknown> = {
    type: input.type,
    date: `${input.date}T00:00:00+08:00`,
    amount: input.amount,
    description: input.description,
  }
  if (input.source_id) tx.source_id = input.source_id
  else if (input.source_name) tx.source_name = input.source_name
  if (input.destination_id) tx.destination_id = input.destination_id
  else if (input.destination_name) tx.destination_name = input.destination_name
  if (input.category_name) tx.category_name = input.category_name
  if (input.tags && input.tags.length > 0) tx.tags = input.tags
  if (input.notes) tx.notes = input.notes

  const raw = await fireflyPost('/api/v1/transactions', {
    error_if_duplicate_hash: false,
    transactions: [tx],
  })
  return transactionCreateResponseSchema.parse(raw)
}

/**
 * GET /api/v1/budgets?start&end（预算与订阅页「预算」tab）。
 * 传入 start/end 时后端才会计算 attributes.spent（见 BudgetEnrichment），因此这里强制要求 range。
 */
export async function getBudgets(range: DateRange): Promise<BudgetsResponse> {
  const raw = await fireflyFetch('/api/v1/budgets', { start: range.start, end: range.end, limit: 100 })
  return budgetsResponseSchema.parse(raw)
}

/** GET /api/v1/budgets/{id}/limits?start&end（该预算在当前日期范围内的手动限额，通常 0~1 条） */
export async function getBudgetLimits(budgetId: string, range: DateRange): Promise<BudgetLimitsResponse> {
  const raw = await fireflyFetch(`/api/v1/budgets/${budgetId}/limits`, {
    start: range.start,
    end: range.end,
  })
  return budgetLimitsResponseSchema.parse(raw)
}

/** GET /api/v1/bills（预算与订阅页「订阅」tab，只读展示不分页——订阅数量通常较少） */
export async function getBills(): Promise<BillsResponse> {
  const raw = await fireflyFetch('/api/v1/bills', { limit: 200 })
  return billsResponseSchema.parse(raw)
}

/** GET /api/v1/piggy-banks（预算与订阅页「储蓄罐」tab） */
export async function getPiggyBanks(): Promise<PiggyBanksResponse> {
  const raw = await fireflyFetch('/api/v1/piggy-banks', { limit: 200 })
  return piggyBanksResponseSchema.parse(raw)
}

/** GET /api/v1/categories（设置页「分类与标签」组，只读展示，limit=200 覆盖测试环境全量 45 条） */
export async function getCategories(): Promise<CategoriesResponse> {
  const raw = await fireflyFetch('/api/v1/categories', { limit: 200 })
  return categoriesResponseSchema.parse(raw)
}

/** GET /api/v1/tags（设置页「分类与标签」组） */
export async function getTags(): Promise<TagsResponse> {
  const raw = await fireflyFetch('/api/v1/tags', { limit: 200 })
  return tagsResponseSchema.parse(raw)
}

/** GET /api/v1/rules（设置页「自动化」组） */
export async function getRules(): Promise<RulesResponse> {
  const raw = await fireflyFetch('/api/v1/rules', { limit: 200 })
  return rulesResponseSchema.parse(raw)
}

/** GET /api/v1/recurrences（设置页「自动化」组） */
export async function getRecurrences(): Promise<RecurrencesResponse> {
  const raw = await fireflyFetch('/api/v1/recurrences', { limit: 200 })
  return recurrencesResponseSchema.parse(raw)
}

/** GET /api/v1/currencies（设置页「币种」组） */
export async function getCurrencies(): Promise<CurrenciesResponse> {
  const raw = await fireflyFetch('/api/v1/currencies', { limit: 200 })
  return currenciesResponseSchema.parse(raw)
}

/** GET /api/v1/about（设置页「关于」卡） */
export async function getAbout(): Promise<AboutResponse> {
  const raw = await fireflyFetch('/api/v1/about', {})
  return aboutResponseSchema.parse(raw)
}
