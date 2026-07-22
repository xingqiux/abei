import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { normalizeDecimalString } from '../src/lib/decimal'

const tokenPath = process.env.E2E_TOKEN_PATH ?? '/run/e2e/token'
const ruleGroupTitle = 'Granary E2E Synthetic Rules'
const ruleTitle = 'Granary E2E Tag Synthetic Lunch'
const ruleTag = 'granary-e2e-reviewed'
const recurrenceTitle = 'Granary E2E Daily Synthetic Subscription'
const recurrenceDescription = 'Granary E2E Synthetic Subscription Charge'

interface TransactionSplit {
  description: string
  amount: string
  tags?: string[] | null
}

interface TransactionGroup {
  id: string
  attributes: { transactions: TransactionSplit[] }
}

interface TransactionItemResponse {
  data: TransactionGroup
}

interface TransactionsResponse {
  data: TransactionGroup[]
  meta?: { pagination?: { total?: number } }
}

function token(): string {
  return readFileSync(tokenPath, 'utf8').trim()
}

function headers(): Record<string, string> {
  return { Authorization: 'Bearer ' + token(), Accept: 'application/json' }
}

function url(baseURL: string | undefined, path: string): string {
  if (!baseURL) throw new Error('Playwright baseURL is required')
  return new URL(path, baseURL).toString()
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

async function findAccountId(
  request: APIRequestContext,
  baseURL: string | undefined,
  type: 'asset' | 'expense',
  name: string,
): Promise<string> {
  const response = await request.get(url(baseURL, '/api/v1/accounts'), {
    headers: headers(),
    params: { type, limit: 200 },
  })
  expect(response.ok()).toBeTruthy()
  const body = (await response.json()) as {
    data: Array<{ id: string; attributes: { name: string } }>
  }
  const account = body.data.find((item) => item.attributes.name === name)
  expect(account, `Seeded account ${name} should exist`).toBeDefined()
  return account!.id
}

async function createMatchingTransaction(
  request: APIRequestContext,
  baseURL: string | undefined,
  description: string,
): Promise<TransactionGroup> {
  const [sourceId, destinationId] = await Promise.all([
    findAccountId(request, baseURL, 'asset', 'Granary E2E Recurrence Source'),
    findAccountId(request, baseURL, 'expense', 'Granary E2E Recurrence Merchant'),
  ])
  const response = await request.post(url(baseURL, '/api/v1/transactions'), {
    headers: headers(),
    data: {
      error_if_duplicate_hash: false,
      transactions: [{
        type: 'withdrawal',
        date: shanghaiToday(),
        amount: '8.76',
        description,
        source_id: sourceId,
        destination_id: destinationId,
      }],
    },
  })
  expect(response.ok()).toBeTruthy()
  return ((await response.json()) as TransactionItemResponse).data
}

async function getTransaction(
  request: APIRequestContext,
  baseURL: string | undefined,
  groupId: string,
): Promise<TransactionGroup> {
  const response = await request.get(url(baseURL, `/api/v1/transactions/${groupId}`), { headers: headers() })
  expect(response.ok()).toBeTruthy()
  return ((await response.json()) as TransactionItemResponse).data
}

async function authenticate(page: Page): Promise<void> {
  await page.goto('/')
  const tokenDialog = page.getByRole('dialog', { name: '设置 API 令牌' })
  const input = tokenDialog.getByPlaceholder('粘贴个人访问令牌…')
  if (await input.isVisible()) {
    await input.fill(token())
    await tokenDialog.getByRole('button', { name: '保存并继续' }).click()
  }
  await expect(tokenDialog).toBeHidden()
  await expect(page.getByText('本期支出', { exact: true })).toBeVisible()
}

function acceptNextConfirmation(page: Page): Promise<string> {
  return new Promise((resolve, reject) => {
    page.once('dialog', (dialog) => {
      const message = dialog.message()
      void dialog.accept().then(() => resolve(message), reject)
    })
  })
}

function automationSection(page: Page, title: '规则' | '规则组' | '定期交易') {
  return page.locator('section').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  })
}

test('previews and executes a rule, then triggers and opens a recurring transaction', async ({
  page,
  request,
  baseURL,
}) => {
  const matchingDescription = `合成午餐 自动化验证 ${randomUUID().slice(0, 8)}`
  const matchingTransaction = await createMatchingTransaction(request, baseURL, matchingDescription)
  let recurrenceGroupId: string | undefined

  try {
    expect(matchingTransaction.attributes.transactions[0].tags ?? []).not.toContain(ruleTag)

    await authenticate(page)
    await page.goto('/settings')
    await expect(automationSection(page, '规则组').getByText(ruleGroupTitle, { exact: true })).toBeVisible()

    const ruleRow = automationSection(page, '规则').getByText(ruleTitle, { exact: true }).locator('..')
    const testButton = ruleRow.getByRole('button', { name: `测试 ${ruleTitle}`, exact: true })
    const executeButton = ruleRow.getByRole('button', { name: `执行 ${ruleTitle}`, exact: true })
    await expect(executeButton).toBeDisabled()

    const dryRunResponsePromise = page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname
      return response.request().method() === 'GET'
        && path.startsWith('/api/v1/rules/')
        && path.endsWith('/test')
    })
    await testButton.click()
    const dryRunResponse = await dryRunResponsePromise
    expect(dryRunResponse.ok()).toBeTruthy()
    const dryRun = (await dryRunResponse.json()) as TransactionsResponse
    const matchCount = dryRun.meta?.pagination?.total ?? dryRun.data.length
    expect(matchCount).toBeGreaterThan(0)
    expect(dryRun.data.some((group) => group.id === matchingTransaction.id)).toBe(true)
    await expect(ruleRow.getByText(`匹配 ${matchCount}`, { exact: true })).toBeVisible()
    await expect(page.getByRole('status').filter({ hasText: `测试完成：匹配 ${matchCount} 个交易组` })).toBeVisible()

    const afterDryRun = await getTransaction(request, baseURL, matchingTransaction.id)
    expect(afterDryRun.attributes.transactions[0].tags ?? []).not.toContain(ruleTag)

    await expect(executeButton).toBeEnabled()
    const ruleConfirmation = acceptNextConfirmation(page)
    await executeButton.click()
    const ruleConfirmationMessage = await ruleConfirmation
    expect(ruleConfirmationMessage).toContain(`执行“${ruleTitle}”`)
    expect(ruleConfirmationMessage).toContain(`${matchCount} 个交易组`)
    await expect(page.getByRole('status').filter({ hasText: `规则已执行，处理 ${matchCount} 个匹配交易组` })).toBeVisible()
    await expect(ruleRow.getByText(new RegExp(`^已执行 ${matchCount} ·`))).toBeVisible()

    const afterExecution = await getTransaction(request, baseURL, matchingTransaction.id)
    expect(afterExecution.attributes.transactions[0].tags ?? []).toContain(ruleTag)

    const recurrenceSection = automationSection(page, '定期交易')
    const triggerButton = recurrenceSection.getByRole('button', { name: `触发 ${recurrenceTitle}`, exact: true })
    const recurrenceRow = triggerButton.locator('..').locator('..')
    const recurrenceResponsePromise = page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname
      return response.request().method() === 'POST'
        && path.startsWith('/api/v1/recurrences/')
        && path.endsWith('/trigger')
    })
    const recurrenceConfirmation = acceptNextConfirmation(page)
    await triggerButton.click()
    const recurrenceConfirmationMessage = await recurrenceConfirmation
    expect(recurrenceConfirmationMessage).toContain(`立即触发定期交易“${recurrenceTitle}”`)

    const recurrenceResponse = await recurrenceResponsePromise
    expect(recurrenceResponse.ok()).toBeTruthy()
    const recurrence = (await recurrenceResponse.json()) as TransactionsResponse
    expect(recurrence.data).toHaveLength(1)
    const generated = recurrence.data[0]
    recurrenceGroupId = generated.id
    expect(generated.attributes.transactions).toHaveLength(1)
    const generatedSplit = generated.attributes.transactions[0]
    expect(generatedSplit.description).toBe(recurrenceDescription)
    expect(normalizeDecimalString(generatedSplit.amount)).toBe('12.34')

    await expect(page.getByRole('status').filter({ hasText: '已触发，生成 1 个交易组' })).toBeVisible()
    await expect(recurrenceRow.getByText(/^本次生成 1 个 ·/)).toBeVisible()
    const deepLink = recurrenceRow.getByRole('link', { name: '查看生成交易', exact: true })
    await expect(deepLink).toHaveAttribute('href', `/transactions?transaction=${generated.id}`)
    await deepLink.click()

    await expect(page).toHaveURL(new RegExp(`/transactions\\?transaction=${generated.id}$`))
    const transactionDialog = page.getByRole('dialog', { name: '编辑交易' })
    await expect(transactionDialog.getByLabel('描述')).toHaveValue(recurrenceDescription)
    await expect(transactionDialog.getByLabel('金额')).toHaveValue('12.34')
    await transactionDialog.getByRole('button', { name: '关闭' }).click()
  } finally {
    for (const groupId of [recurrenceGroupId, matchingTransaction.id]) {
      if (groupId) {
        await request.delete(url(baseURL, `/api/v1/transactions/${groupId}`), { headers: headers() })
      }
    }
  }
})
