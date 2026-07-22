import { readFileSync } from 'node:fs'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const tokenPath = process.env.E2E_TOKEN_PATH ?? '/run/e2e/token'
const taskSummary = '支付宝交易流水明细'
const rawArchiveName = '支付宝交易明细(20260701-20260731).zip'
const derivedCsvName = 'alipay-202607201230-20260701_20260731.csv'

function token(): string {
  return readFileSync(tokenPath, 'utf8').trim()
}

function headers(): Record<string, string> {
  return { Authorization: 'Bearer ' + token(), Accept: 'application/json' }
}

async function authenticate(page: Page): Promise<void> {
  await page.goto('/')
  const tokenDialog = page.getByRole('dialog', { name: '设置 API 令牌' })
  const input = page.getByPlaceholder('粘贴个人访问令牌…')
  if (await input.isVisible()) {
    await input.fill(token())
    await page.getByRole('button', { name: '保存并继续' }).click()
  }
  await expect(tokenDialog).toBeHidden()
  await expect(page.getByText('本期支出', { exact: true })).toBeVisible()
}

async function ensureAccount(
  request: APIRequestContext,
  baseURL: string | undefined,
  account: Record<string, unknown> & { name: string; type: 'asset' | 'liabilities' },
): Promise<void> {
  if (!baseURL) throw new Error('Playwright baseURL is required')
  const endpoint = new URL('/api/v1/accounts', baseURL).toString()
  const existing = await request.get(endpoint, {
    headers: headers(),
    params: { type: account.type, limit: 200 },
  })
  expect(existing.ok()).toBeTruthy()
  const body = (await existing.json()) as { data: Array<{ attributes: { name: string } }> }
  if (body.data.some((item) => item.attributes.name === account.name)) return

  const created = await request.post(endpoint, { headers: headers(), data: account })
  expect(created.ok()).toBeTruthy()
}

function evidenceSection(page: Page, title: 'REVIEW' | '产物' | '事件') {
  return page.locator('section').filter({
    has: page.getByRole('heading', { name: title, exact: true }),
  })
}

async function expectArtifactDownload(page: Page, filename: string): Promise<void> {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: `下载 ${filename}`, exact: true }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(filename)
  await download.cancel()
}

test('loads mailbox settings, syncs evidence, splits a combined payment and imports the reviewed bill', async ({
  page,
  request,
  baseURL,
}) => {
  await ensureAccount(request, baseURL, {
    name: 'E2E Checking',
    type: 'asset',
    currency_code: 'CNY',
    account_role: 'defaultAsset',
    active: true,
    include_net_worth: true,
  })
  await ensureAccount(request, baseURL, {
    name: '招商银行',
    type: 'asset',
    currency_code: 'CNY',
    account_role: 'defaultAsset',
    active: true,
    include_net_worth: true,
  })
  await ensureAccount(request, baseURL, {
    name: '花呗',
    type: 'liabilities',
    currency_code: 'CNY',
    liability_type: 'debt',
    liability_direction: 'credit',
    interest: '0',
    interest_period: 'monthly',
    active: true,
    include_net_worth: true,
  })

  await authenticate(page)
  await page.goto('/bill-inbox')

  await page.getByRole('button', { name: '邮箱设置' }).click()
  const settings = page.getByRole('dialog', { name: '邮箱设置' })
  await expect(settings.getByLabel('启用账单邮箱')).toBeChecked()
  await expect(settings.getByLabel('提供商')).toHaveValue('imap')
  await expect(settings.getByLabel('邮箱地址')).toHaveValue('bills@localhost')
  await expect(settings.getByLabel('主机')).toHaveValue('e2e-mail')
  await expect(settings.getByLabel('端口')).toHaveValue('3143')
  await expect(settings.getByLabel('加密')).toHaveValue('none')
  await expect(settings.getByLabel('文件夹')).toHaveValue('INBOX')
  await expect(settings.getByLabel('用户名')).toHaveValue('bills')
  const password = settings.getByLabel('替换密码', { exact: true })
  await expect(password).toHaveAttribute('type', 'password')
  await expect(password).toHaveValue('')
  await expect(password).toHaveAttribute('placeholder', '留空保持不变')
  await settings.getByRole('button', { name: '取消' }).click()
  await expect(settings).toBeHidden()

  const syncResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/api/v1/bill-inbox/sync',
  )
  await page.getByRole('button', { name: '同步邮箱' }).first().click()
  const syncResponse = await syncResponsePromise
  expect(syncResponse.ok()).toBeTruthy()
  const sync = (await syncResponse.json()) as {
    data: { attributes: { scanned: number; created: number; processed: number; failed: number; process_failed: number } }
  }
  expect(sync.data.attributes).toMatchObject({ scanned: 1, created: 1, processed: 1, failed: 0, process_failed: 0 })
  await expect(page.getByRole('status').filter({ hasText: '同步完成：扫描 1，新建 1，处理 1' })).toBeVisible()

  await page.getByRole('button', { name: '需处理', exact: true }).click()
  await page.getByText(taskSummary, { exact: true }).click()

  const rawArtifact = page.getByRole('button', { name: `下载 ${rawArchiveName}`, exact: true }).locator('..')
  await expect(rawArtifact).toContainText('application/zip')
  await expect(rawArtifact).toContainText('已接收')
  await expect(rawArtifact).toContainText('已加密')
  const initialEvents = evidenceSection(page, '事件')
  await expect(initialEvents.getByText('task.created', { exact: true })).toBeVisible()
  await expect(initialEvents.getByText('challenge.created', { exact: true })).toBeVisible()
  await expectArtifactDownload(page, rawArchiveName)

  await page.getByPlaceholder('密码 / 验证码').fill('e2e-bill-only')
  await page.getByRole('button', { name: '提交', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '验证码已提交' })).toBeVisible()

  await page.getByRole('button', { name: '待审', exact: true }).click()
  await page.getByText(taskSummary, { exact: true }).click()

  const review = evidenceSection(page, 'REVIEW')
  await expect(review.locator('span').filter({ hasText: /^新增\s+1$/ })).toBeVisible()
  const parsedEvents = evidenceSection(page, '事件')
  for (const eventType of ['task.created', 'challenge.created', 'task.ready', 'challenge.consumed', 'task.parsed']) {
    await expect(parsedEvents.getByText(eventType, { exact: true })).toBeVisible()
  }

  const derivedArtifact = page.getByRole('button', { name: `下载 ${derivedCsvName}`, exact: true }).locator('..')
  await expect(derivedArtifact).toContainText('text/csv')
  await expect(derivedArtifact).toContainText('已解压')
  await expectArtifactDownload(page, derivedCsvName)

  await page.getByRole('button', { name: '拆分组合支付', exact: true }).click()
  const splitDialog = page.getByRole('dialog', { name: '拆分组合支付' })
  await splitDialog.getByLabel('拆分 1 支付方式').fill('招商银行储蓄卡(8705)')
  await splitDialog.getByLabel('拆分 1 账户').fill('招商银行')
  await splitDialog.getByLabel('拆分 1 描述').fill('合成午餐-银行卡')
  await splitDialog.getByLabel('拆分 1 金额').fill('9.72')
  await splitDialog.getByLabel('拆分 2 支付方式').fill('花呗')
  await splitDialog.getByLabel('拆分 2 账户').fill('花呗')
  await splitDialog.getByLabel('拆分 2 描述').fill('合成午餐-花呗')
  await splitDialog.getByLabel('拆分 2 金额').fill('14.07')
  await expect(splitDialog.getByText('合计 23.79 / 23.80', { exact: true })).toBeVisible()
  await expect(splitDialog.getByRole('button', { name: '确认拆分' })).toBeDisabled()

  await splitDialog.getByLabel('拆分 2 金额').fill('14.08')
  await expect(splitDialog.getByText('合计 23.8 / 23.80', { exact: true })).toBeVisible()
  await splitDialog.getByRole('button', { name: '确认拆分' }).click()
  await expect(page.getByRole('status').filter({ hasText: '组合支付已拆分' })).toBeVisible()
  await expect(splitDialog).toBeHidden()
  await expect(page.getByText('合成午餐-银行卡', { exact: true })).toBeVisible()
  await expect(page.getByText('合成午餐-花呗', { exact: true })).toBeVisible()
  await expect(review.locator('span').filter({ hasText: /^新增\s+3$/ })).toBeVisible()

  await page.getByRole('button', { name: '入账 3 笔', exact: true }).click()
  const importDialog = page.getByRole('dialog', { name: /确认入账/ })
  await expect(importDialog).toContainText('选中 3 笔')
  await expect(importDialog).toContainText('将入账 3 笔')
  await expect(importDialog).toContainText('跳过 0 笔')
  await importDialog.getByRole('button', { name: '确认入账 3 笔', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已入账 3 笔' })).toBeVisible()

  await page.getByRole('button', { name: '已入账', exact: true }).click()
  await page.getByText(taskSummary, { exact: true }).click()
  await expect(evidenceSection(page, '事件').getByText('task.imported', { exact: true })).toBeVisible()

  await page.goto('/transactions')
  for (const description of ['合成午餐', '合成午餐-银行卡', '合成午餐-花呗']) {
    await expect(page.getByText(description, { exact: true }).filter({ visible: true })).toBeVisible()
  }
})
