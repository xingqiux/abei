import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  expect,
  test as base,
  type APIRequestContext,
  type Page,
  type TestInfo,
} from '@playwright/test'
import { normalizeDecimalString } from '../src/lib/decimal'

const primaryTokenPath = process.env.E2E_TOKEN_PATH ?? '/run/e2e/token'
const secondaryTokenPath = process.env.E2E_SECONDARY_TOKEN_PATH ?? '/run/e2e/token-secondary'

type AccountType = 'asset' | 'expense'

interface TransactionInput {
  type: 'withdrawal' | 'deposit' | 'transfer'
  date: string
  amount: string
  description: string
  source_id?: string
  destination_id?: string
  category_name?: string
  budget_id?: string
  tags?: string[]
  notes?: string
}

interface AccountResponse {
  data: {
    id: string
    attributes: { name: string; notes?: string | null }
  }
}

interface TransactionResponse {
  data: {
    id: string
    attributes: {
      transactions: Array<{
        transaction_journal_id?: string | number
        description: string
        amount: string
        reconciled?: boolean
      }>
    }
  }
}

interface TransactionListResponse {
  data: TransactionResponse['data'][]
}

interface BudgetListResponse {
  data: Array<{ id: string; attributes: { name: string } }>
}

interface BudgetLimitsResponse {
  data: Array<{ id: string; attributes: { amount: string } }>
}

function readToken(path: string): string {
  return readFileSync(path, 'utf8').trim()
}

function primaryToken(): string {
  return readToken(primaryTokenPath)
}

function secondaryToken(): string {
  return readToken(secondaryTokenPath)
}

function uniqueName(testInfo: TestInfo, label: string): string {
  return `E2E ${label} ${testInfo.project.name} ${randomUUID().slice(0, 8)}`
}

function shanghaiToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

function monthRange(date: string): { start: string; end: string } {
  const [year, month] = date.split('-').map(Number)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return {
    start: `${year}-${String(month).padStart(2, '0')}-01`,
    end: `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  }
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = []
  for (let offset = 0; offset < items.length; offset += batchSize) {
    const settled = await Promise.allSettled(items.slice(offset, offset + batchSize).map(worker))
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason
      results.push(result.value)
    }
  }
  return results
}

function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' }
}

class DataBuilder {
  private readonly cleanups: Array<() => Promise<unknown>> = []

  constructor(
    private readonly request: APIRequestContext,
    private readonly baseURL: string,
  ) {}

  private url(path: string): string {
    return new URL(path, this.baseURL).toString()
  }

  async json<T>(token: string, method: string, path: string, data?: unknown): Promise<T> {
    const response = await this.request.fetch(this.url(path), {
      method,
      headers: authHeaders(token),
      ...(data === undefined ? {} : { data }),
    })
    if (!response.ok()) throw new Error(`${method} ${path} failed with HTTP ${response.status()}`)
    return response.json() as Promise<T>
  }

  async status(token: string, path: string): Promise<number> {
    return (await this.request.get(this.url(path), { headers: authHeaders(token) })).status()
  }

  trackDelete(token: string, path: string): void {
    this.cleanups.push(() => this.request.delete(this.url(path), { headers: authHeaders(token) }))
  }

  private trackDeleteBatch(token: string, paths: string[], concurrency: number): void {
    this.cleanups.push(async () => {
      await mapInBatches(paths, concurrency, async (path) => {
        await this.request.delete(this.url(path), { headers: authHeaders(token) })
      })
    })
  }

  async createAccount(token: string, name: string, type: AccountType = 'asset'): Promise<string> {
    const body: Record<string, unknown> = {
      name,
      type,
      currency_code: 'CNY',
      active: true,
      include_net_worth: type === 'asset',
    }
    if (type === 'asset') body.account_role = 'defaultAsset'
    const response = await this.json<AccountResponse>(token, 'POST', '/api/v1/accounts', body)
    this.trackDelete(token, `/api/v1/accounts/${response.data.id}`)
    return response.data.id
  }

  async createTransaction(token: string, transactions: TransactionInput[]): Promise<TransactionResponse['data']> {
    const response = await this.json<TransactionResponse>(token, 'POST', '/api/v1/transactions', {
      error_if_duplicate_hash: false,
      transactions,
    })
    this.trackDelete(token, `/api/v1/transactions/${response.data.id}`)
    return response.data
  }

  async createTransactionGroups(
    token: string,
    transactions: TransactionInput[],
    concurrency: number,
  ): Promise<TransactionResponse['data'][]> {
    const created: TransactionResponse['data'][] = []
    try {
      return await mapInBatches(transactions, concurrency, async (transaction) => {
        const response = await this.json<TransactionResponse>(token, 'POST', '/api/v1/transactions', {
          error_if_duplicate_hash: false,
          transactions: [transaction],
        })
        created.push(response.data)
        return response.data
      })
    } finally {
      this.trackDeleteBatch(token, created.map((group) => `/api/v1/transactions/${group.id}`), concurrency)
    }
  }

  async cleanup(): Promise<void> {
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup()
      } catch {
        // The UI may already have deleted the resource under test.
      }
    }
  }
}

const test = base.extend<{ data: DataBuilder }>({
  data: async ({ request, baseURL }, provide) => {
    if (!baseURL) throw new Error('Playwright baseURL is required')
    const data = new DataBuilder(request, baseURL)
    try {
      await provide(data)
    } finally {
      await data.cleanup()
    }
  },
})

async function authenticate(page: Page, token = primaryToken()): Promise<void> {
  await page.goto('/')
  const tokenDialog = page.getByRole('dialog', { name: '设置 API 令牌' })
  const input = tokenDialog.getByPlaceholder('粘贴个人访问令牌…')
  if (await input.isVisible()) {
    await input.fill(token)
    await tokenDialog.getByRole('button', { name: '保存并继续' }).click()
  }
  await expect(tokenDialog).toBeHidden()
  await expect(page.getByText('本期支出', { exact: true })).toBeVisible()
}

async function replaceToken(page: Page, token: string): Promise<void> {
  await page.goto('/settings')
  await page.getByRole('button', { name: '更换 API 令牌' }).click()
  const dialog = page.getByRole('dialog', { name: '设置 API 令牌' })
  await dialog.getByPlaceholder('粘贴个人访问令牌…').fill(token)
  await dialog.getByRole('button', { name: '保存并继续' }).click()
  await expect(dialog).toBeHidden()
}

async function openSearch(page: Page, query: string) {
  await page.getByRole('button', { name: /搜索/ }).click()
  const dialog = page.getByRole('dialog', { name: '命令面板' })
  await dialog.getByLabel('命令面板搜索').fill(query)
  return dialog
}

test.describe('Granary core business flows', () => {
  test('keeps account data isolated while switching between two API tokens', async ({ page, data }, testInfo) => {
    const tokenA = primaryToken()
    const tokenB = secondaryToken()
    const accountA = uniqueName(testInfo, 'isolation A')
    const accountB = uniqueName(testInfo, 'isolation B')
    await data.createAccount(tokenA, accountA)
    await data.createAccount(tokenB, accountB)

    await authenticate(page, tokenA)
    await page.goto('/accounts')
    await expect(page.getByText(accountA, { exact: true })).toBeVisible()
    await expect(page.getByText(accountB, { exact: true })).toHaveCount(0)

    await replaceToken(page, tokenB)
    await page.goto('/accounts')
    await expect(page.getByText(accountB, { exact: true })).toBeVisible()
    await expect(page.getByText(accountA, { exact: true })).toHaveCount(0)

    await replaceToken(page, tokenA)
    await page.goto('/accounts')
    await expect(page.getByText(accountA, { exact: true })).toBeVisible()
    await expect(page.getByText(accountB, { exact: true })).toHaveCount(0)
  })

  test('edits and deletes an account', async ({ page, data }, testInfo) => {
    const token = primaryToken()
    const originalName = uniqueName(testInfo, 'account original')
    const updatedName = uniqueName(testInfo, 'account updated')
    const notes = uniqueName(testInfo, 'account notes')
    const accountId = await data.createAccount(token, originalName)

    await authenticate(page, token)
    await page.goto('/accounts')
    const edit = page.getByRole('button', { name: `编辑 ${originalName}` })
    await edit.focus()
    await edit.press('Enter')

    const editDialog = page.getByRole('dialog', { name: '编辑账户' })
    await editDialog.getByLabel('名称').fill(updatedName)
    await editDialog.getByLabel('备注').fill(notes)
    await editDialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '账户已更新' })).toBeVisible()
    await expect(page.getByText(updatedName, { exact: true })).toBeVisible()

    const updated = await data.json<AccountResponse>(token, 'GET', `/api/v1/accounts/${accountId}`)
    expect(updated.data.attributes).toMatchObject({ name: updatedName, notes })

    const remove = page.getByRole('button', { name: `删除 ${updatedName}` })
    await remove.focus()
    await remove.press('Enter')
    const deleteDialog = page.getByRole('dialog', { name: '删除账户' })
    await expect(deleteDialog).toContainText(updatedName)
    await deleteDialog.getByRole('button', { name: '删除', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '账户已删除' })).toBeVisible()
    await expect(page.getByText(updatedName, { exact: true })).toHaveCount(0)
    expect(await data.status(token, `/api/v1/accounts/${accountId}`)).toBe(404)
  })

  test('creates a multi-split transaction, edits every split and survives refresh', async ({ page, data }, testInfo) => {
    const token = primaryToken()
    const date = shanghaiToday()
    const sourceId = await data.createAccount(token, uniqueName(testInfo, 'split source'))
    const destinationName = uniqueName(testInfo, 'split expense')
    await data.createAccount(token, destinationName, 'expense')
    const firstDescription = uniqueName(testInfo, 'split one')
    const secondDescription = uniqueName(testInfo, 'split two')
    const updatedDescription = `${firstDescription} updated`

    await authenticate(page, token)
    await page.getByRole('button', { name: '记一笔', exact: true }).filter({ visible: true }).click()
    const createDialog = page.getByRole('dialog', { name: '记一笔' })
    await createDialog.getByRole('tab', { name: '多拆分' }).click()
    await createDialog.getByLabel('拆分 1 金额').fill('11.11')
    await createDialog.getByLabel('拆分 1 描述').fill(firstDescription)
    await createDialog.getByLabel('拆分 1 来源账户').selectOption(sourceId)
    await createDialog.getByLabel('拆分 1 目标').fill(destinationName)
    await createDialog.getByLabel('拆分 1 日期').fill(date)
    await createDialog.getByLabel('拆分 2 金额').fill('12.12')
    await createDialog.getByLabel('拆分 2 描述').fill(secondDescription)
    await createDialog.getByLabel('拆分 2 来源账户').selectOption(sourceId)
    await createDialog.getByLabel('拆分 2 目标').fill(destinationName)
    await createDialog.getByLabel('拆分 2 日期').fill(date)
    await createDialog.getByRole('button', { name: '创建多拆分交易' }).click()
    await expect(page.getByRole('status').filter({ hasText: '已创建 2 个拆分' })).toBeVisible()
    await expect(createDialog).toBeHidden()

    const search = await data.json<TransactionListResponse>(
      token,
      'GET',
      `/api/v1/search/transactions?query=${encodeURIComponent(firstDescription)}&limit=10`,
    )
    const transaction = search.data.find((group) => {
      const descriptions = group.attributes.transactions.map((split) => split.description)
      return descriptions.includes(firstDescription) && descriptions.includes(secondDescription)
    })
    expect(transaction, 'The multi-split transaction created through the UI should exist in the API').toBeDefined()
    data.trackDelete(token, `/api/v1/transactions/${transaction!.id}`)
    expect(transaction!.attributes.transactions.map((split) => [split.description, normalizeDecimalString(split.amount)])).toEqual([
      [firstDescription, '11.11'],
      [secondDescription, '12.12'],
    ])

    await page.goto(`/transactions?transaction=${transaction!.id}`)
    const dialog = page.getByRole('dialog', { name: '编辑交易' })
    await expect(dialog.getByLabel('拆分 1 描述')).toHaveValue(firstDescription)
    await expect(dialog.getByLabel('拆分 2 描述')).toHaveValue(secondDescription)
    await dialog.getByLabel('拆分 1 描述').fill(updatedDescription)
    await dialog.getByLabel('拆分 2 金额').fill('22.22')
    await dialog.getByRole('button', { name: '保存全部拆分' }).click()
    await expect(page.getByRole('status').filter({ hasText: '已更新 2 个拆分' })).toBeVisible()
    await expect(dialog).toBeHidden()

    const saved = await data.json<TransactionResponse>(token, 'GET', `/api/v1/transactions/${transaction!.id}`)
    expect(saved.data.attributes.transactions.map((split) => [split.description, normalizeDecimalString(split.amount)])).toEqual([
      [updatedDescription, '11.11'],
      [secondDescription, '22.22'],
    ])

    await page.reload()
    const refreshed = page.getByRole('dialog', { name: '编辑交易' })
    await expect(refreshed.getByLabel('拆分 1 描述')).toHaveValue(updatedDescription)
    await expect(refreshed.getByLabel('拆分 2 金额')).toHaveValue('22.22')
  })

  test('marks a day and its transactions as reconciled', async ({ page, data }, testInfo) => {
    const token = primaryToken()
    const date = shanghaiToday()
    const sourceId = await data.createAccount(token, uniqueName(testInfo, 'reconcile source'))
    const destinationId = await data.createAccount(token, uniqueName(testInfo, 'reconcile expense'), 'expense')
    const description = uniqueName(testInfo, 'reconcile transaction')
    const transaction = await data.createTransaction(token, [
      { type: 'withdrawal', date, amount: '31.41', description, source_id: sourceId, destination_id: destinationId },
    ])

    await authenticate(page, token)
    await page.goto('/reconciliation')
    await page.getByRole('button', { name: `${date} 未对账` }).click()
    await expect(page.getByText(description, { exact: true }).filter({ visible: true })).toBeVisible()
    await page.getByRole('button', { name: '标记本日已对账' }).click()
    await expect(page.getByRole('status').filter({ hasText: /已标记 \d+ 笔为已对账/ })).toBeVisible()
    await expect(page.getByRole('button', { name: `${date} 已对账` })).toBeVisible()

    const saved = await data.json<TransactionResponse>(token, 'GET', `/api/v1/transactions/${transaction.id}`)
    expect(saved.data.attributes.transactions.every((split) => split.reconciled === true)).toBe(true)
  })

  test('creates a budget with a limit and edits the persisted limit', async ({ page, data }, testInfo) => {
    const token = primaryToken()
    const name = uniqueName(testInfo, 'budget')

    await authenticate(page, token)
    await page.goto('/budgets')
    await page.getByRole('button', { name: '新建预算' }).click()
    const createDialog = page.getByRole('dialog', { name: '新建预算' })
    await createDialog.getByLabel('名称').fill(name)
    await createDialog.getByLabel('限额币种').selectOption('CNY')
    await createDialog.getByLabel(/当期限额/).fill('100.00')
    await createDialog.getByRole('button', { name: '创建', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '预算已创建' })).toBeVisible()
    await expect(page.getByText(name, { exact: true })).toBeVisible()

    const budgets = await data.json<BudgetListResponse>(token, 'GET', '/api/v1/budgets?limit=200')
    const budget = budgets.data.find((item) => item.attributes.name === name)
    expect(budget, 'The budget created through the UI should exist in the API').toBeDefined()
    data.trackDelete(token, `/api/v1/budgets/${budget!.id}`)

    const manage = page.getByRole('button', { name: `管理 ${name} 的限额` })
    await expect(manage).toBeEnabled()
    await manage.focus()
    await manage.press('Enter')
    const limitsDialog = page.getByRole('dialog', { name: `${name} · 限额` })
    await expect(limitsDialog.getByLabel('限额 1 金额')).toHaveValue('100.00')
    await limitsDialog.getByLabel('限额 1 金额').fill('250.50')
    await limitsDialog.getByRole('button', { name: '保存限额 1' }).click()
    await expect(page.getByRole('status').filter({ hasText: '限额已更新' })).toBeVisible()

    const limits = await data.json<BudgetLimitsResponse>(token, 'GET', `/api/v1/budgets/${budget!.id}/limits?start=1970-01-01&end=2100-01-01`)
    expect(limits.data).toHaveLength(1)
    expect(limits.data[0].attributes.amount).toBe('250.50')
  })

  test('uploads, renames, downloads and deletes a transaction attachment', async ({ page, data }, testInfo) => {
    const token = primaryToken()
    const date = shanghaiToday()
    const sourceId = await data.createAccount(token, uniqueName(testInfo, 'attachment source'))
    const destinationId = await data.createAccount(token, uniqueName(testInfo, 'attachment expense'), 'expense')
    const description = uniqueName(testInfo, 'attachment transaction')
    const transaction = await data.createTransaction(token, [
      { type: 'withdrawal', date, amount: '41.42', description, source_id: sourceId, destination_id: destinationId },
    ])
    const originalFilename = `${randomUUID()}.txt`
    const renamedFilename = `${randomUUID()}-renamed.txt`
    const renamedTitle = uniqueName(testInfo, 'attachment title')
    const content = `Granary attachment ${randomUUID()}\n`

    await authenticate(page, token)
    await page.goto(`/transactions?transaction=${transaction.id}`)
    const transactionDialog = page.getByRole('dialog', { name: '编辑交易' })
    await transactionDialog.locator('input[type="file"]').setInputFiles({
      name: originalFilename,
      mimeType: 'text/plain',
      buffer: Buffer.from(content),
    })
    await expect(page.getByRole('status').filter({ hasText: '附件已上传' })).toBeVisible()
    await expect(transactionDialog.getByText(originalFilename, { exact: true })).toBeVisible()

    await transactionDialog.getByRole('button', { name: `编辑 ${originalFilename}` }).click()
    const editDialog = page.getByRole('dialog', { name: '编辑附件信息' })
    await editDialog.getByLabel('文件名').fill(renamedFilename)
    await editDialog.getByLabel('标题').fill(renamedTitle)
    await editDialog.getByLabel('备注').fill('renamed by the core E2E flow')
    await editDialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(page.getByRole('status').filter({ hasText: '附件信息已更新' })).toBeVisible()
    await expect(transactionDialog.getByText(renamedTitle, { exact: true })).toBeVisible()

    const downloadPromise = page.waitForEvent('download')
    await transactionDialog.getByRole('button', { name: `下载 ${renamedTitle}` }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toBe(renamedFilename)
    const downloadPath = await download.path()
    expect(downloadPath).not.toBeNull()
    expect(readFileSync(downloadPath!, 'utf8')).toBe(content)

    page.once('dialog', (dialog) => void dialog.accept())
    await transactionDialog.getByRole('button', { name: `删除 ${renamedTitle}` }).click()
    await expect(page.getByRole('status').filter({ hasText: '附件已删除' })).toBeVisible()
    await expect(transactionDialog.getByText(renamedTitle, { exact: true })).toHaveCount(0)
  })

  test('searches beyond the first transaction page, deep links and navigates to an account result', async ({ page, data }, testInfo) => {
    test.slow()
    const token = primaryToken()
    const date = shanghaiToday()
    const accountName = uniqueName(testInfo, 'search account')
    const sourceId = await data.createAccount(token, accountName)
    const destinationId = await data.createAccount(token, uniqueName(testInfo, 'search expense'), 'expense')
    const description = uniqueName(testInfo, 'search transaction')
    const transaction = await data.createTransaction(token, [
      { type: 'withdrawal', date: shiftDate(date, -1), amount: '51.52', description, source_id: sourceId, destination_id: destinationId },
    ])
    const fillers = Array.from({ length: 81 }, (_, index): TransactionInput => ({
      type: 'withdrawal',
      date,
      amount: '1.01',
      description: uniqueName(testInfo, `search filler ${String(index + 1).padStart(2, '0')}`),
      source_id: sourceId,
      destination_id: destinationId,
    }))
    await data.createTransactionGroups(token, fillers, 8)

    await authenticate(page, token)
    await page.goto('/transactions')
    await expect(page.getByText(fillers.at(-1)!.description, { exact: true }).filter({ visible: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '加载更多' })).toBeVisible()
    await expect(page.getByText(description, { exact: true })).toHaveCount(0)

    const transactionSearch = await openSearch(page, description)
    const transactionResult = transactionSearch.getByRole('option').filter({ hasText: description })
    await expect(transactionResult).toBeVisible()
    await transactionResult.click()
    await expect(page).toHaveURL(new RegExp(`/transactions\\?transaction=${transaction.id}$`))
    const editDialog = page.getByRole('dialog', { name: '编辑交易' })
    await expect(editDialog.getByLabel('描述')).toHaveValue(description)
    await editDialog.getByRole('button', { name: '关闭' }).click()

    const accountSearch = await openSearch(page, accountName)
    const accountResult = accountSearch.getByRole('option').filter({ hasText: accountName })
    await expect(accountResult).toBeVisible()
    await accountResult.click()
    await expect(page).toHaveURL(new RegExp(`/accounts/${sourceId}$`))
    await expect(page.getByRole('heading', { name: accountName })).toBeVisible()
  })

  test('renders report data and downloads a filtered transaction CSV', async ({ page, data }, testInfo) => {
    const token = primaryToken()
    const date = shanghaiToday()
    const range = monthRange(date)
    const accountName = uniqueName(testInfo, 'report account')
    const category = uniqueName(testInfo, 'report category')
    const tag = uniqueName(testInfo, 'report tag')
    const description = uniqueName(testInfo, 'report top expense')
    const sourceId = await data.createAccount(token, accountName)
    const destinationId = await data.createAccount(token, uniqueName(testInfo, 'report expense'), 'expense')
    await data.createTransaction(token, [
      {
        type: 'withdrawal',
        date,
        amount: '98765.43',
        description,
        source_id: sourceId,
        destination_id: destinationId,
        category_name: category,
        tags: [tag],
      },
    ])

    await authenticate(page, token)
    await page.goto('/reports')
    await expect(page.getByText('分类支出排行', { exact: true })).toBeVisible()
    await expect(page.getByText('账户流出排行', { exact: true })).toBeVisible()
    await expect(page.getByText('标签支出排行', { exact: true })).toBeVisible()
    await expect(page.getByText(category, { exact: true })).toBeVisible()
    await expect(page.getByText(accountName, { exact: true })).toBeVisible()
    await expect(page.getByText(tag, { exact: true })).toBeVisible()
    await expect(page.getByText(description, { exact: true })).toBeVisible()
    await expect(page.getByText(/98,765\.43/).filter({ visible: true }).first()).toBeVisible()

    await page.goto('/settings')
    await page.getByLabel('开始').fill(range.start)
    await page.getByLabel('结束').fill(range.end)
    await page.getByLabel(accountName, { exact: true }).check()
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出', exact: true }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename()).toContain('transactions')
    const downloadPath = await download.path()
    expect(downloadPath).not.toBeNull()
    const csv = readFileSync(downloadPath!, 'utf8')
    expect(csv).toContain(description)
    expect(csv).toContain(accountName)
    expect(csv).toContain(category)
    await expect(page.getByRole('status').filter({ hasText: 'CSV 已生成' })).toBeVisible()
  })
})
