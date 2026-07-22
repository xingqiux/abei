import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const tokenPath = process.env.E2E_TOKEN_PATH ?? '/run/e2e/token'

function token(): string {
  return readFileSync(tokenPath, 'utf8').trim()
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

test('serves security headers on the SPA shell and hashed assets', async ({ page, request, baseURL }) => {
  const response = await page.goto('/index.html')
  expect(response).not.toBeNull()
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'")
  expect(response?.headers()['content-security-policy']).toContain("font-src 'self' data:")
  expect(response?.headers()['x-content-type-options']).toBe('nosniff')
  expect(response?.headers()['x-frame-options']).toBe('DENY')
  expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin')

  const scriptPath = await page.locator('script[src]').first().getAttribute('src')
  expect(scriptPath).toBeTruthy()
  const asset = await request.get(new URL(scriptPath as string, baseURL).toString())
  expect(asset.headers()['content-security-policy']).toContain("script-src 'self'")
  expect(asset.headers()['cache-control']).toContain('immutable')
})

test('creates an account and records a transaction', async ({ page }, testInfo) => {
  await authenticate(page)
  const accountName = 'E2E Checking ' + testInfo.project.name
  const description = 'E2E lunch ' + testInfo.project.name

  await page.goto('/accounts')
  await page.getByRole('button', { name: '新建账户' }).click()
  const accountDialog = page.getByRole('dialog', { name: '新建账户' })
  await accountDialog.getByLabel('名称').fill(accountName)
  await accountDialog.getByLabel('币种').selectOption('CNY')
  await accountDialog.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('status').filter({ hasText: '账户已创建' })).toBeVisible()
  await expect(page.getByText(accountName)).toBeVisible()

  await page.getByRole('button', { name: '记一笔' }).click()
  const transactionDialog = page.getByRole('dialog', { name: '记一笔' })
  await transactionDialog.getByLabel('金额').fill('12.34')
  await transactionDialog.getByLabel('描述').fill(description)
  await transactionDialog.getByLabel('来源账户').selectOption({ label: accountName })
  await transactionDialog.getByLabel('目标账户').fill('合成测试商户')
  await transactionDialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已入账' })).toBeVisible()

  await page.goto('/transactions')
  await expect(page.getByText(description, { exact: true }).filter({ visible: true })).toBeVisible()
})
