import { FireflyApiError, fireflyDelete, fireflyFetch, fireflyPatch, fireflyPost, fireflyPut } from './client'
import {
  accountsResponseSchema,
  accountDetailResponseSchema,
  aboutResponseSchema,
  autocompleteAccountsSchema,
  autocompleteCategoriesSchema,
  autocompleteTagsSchema,
  autocompleteTransactionsSchema,
  billImportResponseSchema,
  billInboxSummarySchema,
  billInboxSyncResultSchema,
  billStatementRowItemResponseSchema,
  billStatementRowsResponseSchema,
  billTaskItemResponseSchema,
  billTasksResponseSchema,
  billsResponseSchema,
  budgetItemResponseSchema,
  budgetLimitItemResponseSchema,
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
  transactionDetailResponseSchema,
  type Account,
  type AccountDetailResponse,
  type AboutResponse,
  type AutocompleteAccount,
  type AutocompleteCategory,
  type AutocompleteTag,
  type AutocompleteTransaction,
  type BillImportResponse,
  type BillInboxSummary,
  type BillInboxSyncResult,
  type BillStatementRowItemResponse,
  type BillStatementRowsResponse,
  type BillTaskItemResponse,
  type BillTasksResponse,
  type BillsResponse,
  type BudgetItemResponse,
  type BudgetLimitItemResponse,
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
  type TransactionDetailResponse,
  accountChartOverviewSchema,
  insightCategoryResponseSchema,
  preferenceResponseSchema,
  summaryResponseSchema,
  transactionsResponseSchema,
  type AccountChartOverview,
  type InsightCategoryEntry,
  type PreferenceResponse,
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
  const period = opts.period ?? pickChartPeriod(range)
  const params: Record<string, string | number | readonly (string | number)[] | undefined> = {
    start: range.start,
    end: range.end,
    period,
  }
  if (opts.accounts && opts.accounts.length > 0) {
    // 显式账户列表时 preselected 保持 empty，CollectsAccountsFromFilter 直接返回这些账户
    params.accounts = opts.accounts
  } else {
    params.preselected = opts.preselected ?? 'assets'
  }
  const raw = await fireflyFetch('/api/v1/chart/account/overview', params)
  return accountChartOverviewSchema.parse(raw)
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

/**
 * PATCH /api/v1/bill-statement-rows/{id}
 * 收件箱行内编辑：金额/分类/描述等（ActionController@updateRow 校验字段）。
 * 同时写 amount 与 firefly_amount、firefly_description，保证入账预览与展示一致。
 */
export interface UpdateBillStatementRowInput {
  firefly_description?: string
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

/** GET /api/v1/accounts/{id} */
export async function getAccount(accountId: string): Promise<AccountDetailResponse> {
  const raw = await fireflyFetch(`/api/v1/accounts/${accountId}`)
  return accountDetailResponseSchema.parse(raw)
}

/**
 * GET /api/v1/accounts/{id}/transactions?start&end&limit&page
 * 响应结构与 GET /transactions 一致（transaction groups + pagination meta）。
 */
export async function getAccountTransactions(
  accountId: string,
  range: DateRange,
  opts: { limit?: number; page?: number; type?: TransactionTypeFilter } = {},
): Promise<TransactionsResponse> {
  const raw = await fireflyFetch(`/api/v1/accounts/${accountId}/transactions`, {
    start: range.start,
    end: range.end,
    limit: opts.limit ?? 50,
    page: opts.page ?? 1,
    type: opts.type && opts.type !== 'all' ? opts.type : undefined,
  })
  return transactionsResponseSchema.parse(raw)
}

export interface AccountSummary {
  id: string
  name: string
}

/**
 * 记一笔/编辑表单的来源与转账账户下拉。
 * 合并 type=asset 与 type=liabilities（花呗等 Debt 可作支出来源），只保留启用账户。
 * 并发两请求后按 id 去重；负债账户排在资产后面。
 */
export async function getAssetAccounts(): Promise<AccountSummary[]> {
  const [assetRaw, liabRaw] = await Promise.all([
    fireflyFetch('/api/v1/accounts', { type: 'asset', limit: 200 }),
    fireflyFetch('/api/v1/accounts', { type: 'liabilities', limit: 200 }),
  ])
  const assets = accountsResponseSchema.parse(assetRaw).data
  const liabilities = accountsResponseSchema.parse(liabRaw).data
  const seen = new Set<string>()
  const out: AccountSummary[] = []
  for (const a of [...assets, ...liabilities] as Account[]) {
    if (a.attributes.active === false) continue
    if (seen.has(a.id)) continue
    seen.add(a.id)
    out.push({ id: a.id, name: a.attributes.name })
  }
  return out
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
 * GET /api/v1/transactions/{groupId}
 * 实测响应与 POST 创建相同：{data: transactionGroup}，data 是对象不是数组。
 * group.attributes.transactions[] 每项含 transaction_journal_id（PUT 必带）。
 */
export async function getTransaction(groupId: string): Promise<TransactionDetailResponse> {
  const raw = await fireflyFetch(`/api/v1/transactions/${groupId}`)
  return transactionDetailResponseSchema.parse(raw)
}

export interface UpdateTransactionInput {
  /** 拆分 journal id（string/number 均可，后端 numeric） */
  transaction_journal_id: string
  type?: CreateTransactionType | string
  date?: string
  amount?: string
  description?: string
  source_id?: string
  source_name?: string
  destination_id?: string
  destination_name?: string
  category_name?: string
  tags?: string[]
  notes?: string
  /** 对账方案 b：PUT 置位 transactions.reconciled（2026-07-10 实测生效） */
  reconciled?: boolean
}

/**
 * PUT /api/v1/transactions/{groupId}
 * body 形如 {transactions:[{transaction_journal_id, ...改动字段}]}。
 * 字段名对照 UpdateRequest.php；实测改 description/amount 生效，响应同 GET 单笔。
 * 多拆分 group（transactions.length > 1）v1 前端不支持编辑。
 */
export async function updateTransaction(
  groupId: string,
  input: UpdateTransactionInput,
): Promise<TransactionDetailResponse> {
  const tx: Record<string, unknown> = {
    transaction_journal_id: input.transaction_journal_id,
  }
  if (input.type) tx.type = input.type
  if (input.date) tx.date = input.date.includes('T') ? input.date : `${input.date}T00:00:00+08:00`
  if (input.amount) tx.amount = input.amount
  if (input.description !== undefined) tx.description = input.description
  if (input.source_id) tx.source_id = input.source_id
  else if (input.source_name) tx.source_name = input.source_name
  if (input.destination_id) tx.destination_id = input.destination_id
  else if (input.destination_name) tx.destination_name = input.destination_name
  if (input.category_name !== undefined) tx.category_name = input.category_name
  if (input.tags) tx.tags = input.tags
  if (input.notes !== undefined) tx.notes = input.notes
  if (input.reconciled !== undefined) tx.reconciled = input.reconciled

  const raw = await fireflyPut(`/api/v1/transactions/${groupId}`, {
    transactions: [tx],
  })
  return transactionDetailResponseSchema.parse(raw)
}

/**
 * 对账方案 b：GET 整组后 PUT 各 split 的 reconciled。
 * 2026-07-10 实测 ¥0.01 自建交易 PUT reconciled:true 可置位，随后 GET 仍为 true。
 */
export async function setTransactionGroupReconciled(
  groupId: string,
  reconciled: boolean,
): Promise<TransactionDetailResponse> {
  const detail = await getTransaction(groupId)
  const splits = detail.data.attributes.transactions
  const body = {
    transactions: splits.map((s) => {
      const tx: Record<string, unknown> = {
        transaction_journal_id: String(s.transaction_journal_id ?? ''),
        type: s.type,
        date: s.date,
        amount: String(Math.abs(Number(s.amount))),
        description: s.description,
        reconciled,
      }
      if (s.source_id != null && s.source_id !== '') tx.source_id = String(s.source_id)
      else if (s.source_name) tx.source_name = s.source_name
      if (s.destination_id != null && s.destination_id !== '') tx.destination_id = String(s.destination_id)
      else if (s.destination_name) tx.destination_name = s.destination_name
      return tx
    }),
  }
  const raw = await fireflyPut(`/api/v1/transactions/${groupId}`, body)
  return transactionDetailResponseSchema.parse(raw)
}

/**
 * 将某日全部普通交易标记为已对账（方案 b 批量）。
 * 跳过 reconciliation 类型；逐 group PUT。
 */
export async function markDayTransactionsReconciled(date: string): Promise<{ total: number; updated: number }> {
  const list = await getTransactions({ start: date, end: date }, { limit: 200, page: 1, type: 'all' })
  let updated = 0
  for (const g of list.data) {
    const first = g.attributes.transactions[0]
    if (!first) continue
    if (first.type === 'reconciliation' || first.type === 'opening balance') continue
    await setTransactionGroupReconciled(g.id, true)
    updated += 1
  }
  return { total: list.data.length, updated }
}

/**
 * 生成对账调整交易（type=reconciliation）。
 * 实测 source_id=资产账户时后端自动挂 Reconciliation 账户为对方。
 */
export async function createReconciliationAdjustment(input: {
  date: string
  amount: string
  source_id: string
  description?: string
}): Promise<TransactionDetailResponse> {
  const raw = await fireflyPost('/api/v1/transactions', {
    error_if_duplicate_hash: false,
    transactions: [
      {
        type: 'reconciliation',
        date: `${input.date}T12:00:00+08:00`,
        amount: input.amount,
        description: input.description ?? `对账调整 ${input.date}`,
        source_id: input.source_id,
        destination_id: input.source_id,
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
  await fireflyDelete(`/api/v1/transactions/${groupId}`)
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

/** POST /api/v1/budgets —— 创建预算（name 必填） */
export async function createBudget(input: { name: string; active?: boolean }): Promise<BudgetItemResponse> {
  const raw = await fireflyPost('/api/v1/budgets', {
    name: input.name.trim(),
    active: input.active ?? true,
  })
  return budgetItemResponseSchema.parse(raw)
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

/** POST /api/v1/budgets/{id}/limits —— 为日期范围设限额 */
export async function createBudgetLimit(
  budgetId: string,
  input: { start: string; end: string; amount: string },
): Promise<BudgetLimitItemResponse> {
  const raw = await fireflyPost(`/api/v1/budgets/${budgetId}/limits`, {
    start: input.start,
    end: input.end,
    amount: input.amount,
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
  const raw = await fireflyFetch('/api/v1/autocomplete/accounts', {
    query,
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
  const raw = await fireflyFetch('/api/v1/autocomplete/categories', {
    query,
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
  const raw = await fireflyFetch('/api/v1/autocomplete/tags', {
    query,
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
  const raw = await fireflyFetch('/api/v1/autocomplete/transactions', {
    query,
    limit: opts.limit ?? 10,
  })
  return autocompleteTransactionsSchema.parse(raw)
}
