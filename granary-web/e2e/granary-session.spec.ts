import { expect, test, type Page } from '@playwright/test'

const EMAIL = 'owner@granary.test'
const PASSWORD = 'granary-e2e-password-2026'

async function authenticate(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByText(/初始化私有实例|登录账本|本期支出/).first()).toBeVisible()

  if (await page.getByText('初始化私有实例', { exact: true }).isVisible()) {
    await page.getByLabel('显示名称').fill('Granary E2E Owner')
    await page.getByLabel('邮箱').fill(EMAIL)
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
    await page.getByLabel('确认密码').fill(PASSWORD)
    await page.getByRole('button', { name: '创建并登录' }).click()
  } else if (await page.getByText('登录账本', { exact: true }).isVisible()) {
    await page.getByLabel('邮箱').fill(EMAIL)
    await page.getByLabel('密码', { exact: true }).fill(PASSWORD)
    await page.getByRole('button', { name: '登录', exact: true }).click()
  }

  await expect(page.getByText('本期支出', { exact: true })).toBeVisible()
}

async function createReferenceData(page: Page, category: string, counterparty: string): Promise<void> {
  await page.goto('/settings')
  await page.getByRole('button', { name: '分类', exact: true }).click()
  await page.getByRole('button', { name: '新建', exact: true }).click()
  let dialog = page.getByRole('dialog', { name: '新建基础资料' })
  await dialog.getByLabel('名称').fill(category)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已创建' }).last()).toBeVisible()
  await expect(page.getByText(category, { exact: true })).toBeVisible()

  await page.getByRole('button', { name: '交易方', exact: true }).click()
  await page.getByRole('button', { name: '新建', exact: true }).click()
  dialog = page.getByRole('dialog', { name: '新建基础资料' })
  await dialog.getByLabel('名称').fill(counterparty)
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已创建' }).last()).toBeVisible()
  await expect(page.getByText(counterparty, { exact: true })).toBeVisible()
}

async function createAccount(page: Page, accountName: string): Promise<void> {
  await page.goto('/accounts')
  await page.getByRole('button', { name: '新建账户' }).click()
  const dialog = page.getByRole('dialog', { name: '新建账户' })
  await dialog.getByLabel('名称').fill(accountName)
  await expect(dialog.getByLabel('币种')).toHaveValue('CNY')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '账户已创建' })).toBeVisible()
  await expect(page.getByText(accountName, { exact: true })).toBeVisible()
}

async function createTransaction(
  page: Page,
  accountName: string,
  category: string,
  counterparty: string,
  description: string,
): Promise<void> {
  await page.getByRole('button', { name: '记一笔', exact: true }).filter({ visible: true }).click()
  const dialog = page.getByRole('dialog', { name: '记一笔' })
  await dialog.getByLabel('金额').fill('12.34')
  await dialog.getByLabel('描述').fill(description)
  await dialog.getByLabel('来源账户').selectOption({ label: accountName })
  await dialog.getByLabel('目标账户').fill(counterparty)
  await dialog.getByRole('button', { name: '更多选项' }).click()
  await dialog.getByLabel('分类').fill(category)

  const requestPromise = page.waitForRequest((request) =>
    request.method() === 'POST' && /\/api\/v1\/books\/\d+\/transactions$/.test(new URL(request.url()).pathname),
  )
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' && /\/api\/v1\/books\/\d+\/transactions$/.test(new URL(response.url()).pathname),
  )
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  const [request, response] = await Promise.all([requestPromise, responsePromise])
  expect(await request.headerValue('x-csrf-token')).toBeTruthy()
  expect(response.ok()).toBeTruthy()
  await expect(page.getByRole('status').filter({ hasText: '已入账' })).toBeVisible()
}

async function ensureSecondBook(page: Page, name: string): Promise<void> {
  await page.evaluate(async (bookName) => {
    const booksResponse = await fetch('/api/v1/books', { credentials: 'same-origin' })
    if (!booksResponse.ok) throw new Error(`list books failed: ${booksResponse.status}`)
    const books = await booksResponse.json() as Array<{ id: number; organization_id: number; name: string }>
    if (books.some((book) => book.name === bookName)) return
    const csrf = sessionStorage.getItem('granary.csrf')
    const response = await fetch(`/api/v1/organizations/${books[0].organization_id}/books`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrf ?? '',
      },
      body: JSON.stringify({ name: bookName, base_currency_code: 'CNY', timezone: 'Asia/Shanghai' }),
    })
    if (!response.ok) throw new Error(`create book failed: ${response.status} ${await response.text()}`)
  }, name)
  await page.reload()
  await expect(page.getByText('本期支出', { exact: true })).toBeVisible()
}

async function selectBook(page: Page, name: string): Promise<void> {
  await page.goto('/settings')
  const select = page.getByLabel('当前账本').filter({ visible: true })
  await expect(select).toBeVisible()
  await select.selectOption({ label: name })
  await expect(select.locator('option:checked')).toHaveText(name)
}

test('runs the Granary Session and bookkeeping journey against an empty database', async ({ page, context }, testInfo) => {
  const suffix = testInfo.project.name
  const accountName = `E2E 账户 ${suffix}`
  const categoryName = `E2E 餐饮 ${suffix}`
  const counterpartyName = `E2E 商户 ${suffix}`
  const description = `E2E 午餐 ${suffix}`
  const secondBook = `E2E 隔离账本 ${suffix}`

  const shell = await page.goto('/index.html')
  expect(shell?.headers()['content-security-policy']).toContain("default-src 'self'")
  expect(shell?.headers()['x-content-type-options']).toBe('nosniff')
  expect(shell?.headers()['x-frame-options']).toBe('DENY')

  await authenticate(page)
  const cookies = await context.cookies()
  expect(cookies.find((cookie) => cookie.name === 'granary_session')).toMatchObject({
    httpOnly: true,
    sameSite: 'Lax',
  })
  const firstCsrf = await page.evaluate(() => sessionStorage.getItem('granary.csrf'))
  expect(firstCsrf).toBeTruthy()

  await page.reload()
  await expect(page.getByText('本期支出', { exact: true })).toBeVisible()
  const restoredCsrf = await page.evaluate(() => sessionStorage.getItem('granary.csrf'))
  expect(restoredCsrf).toBeTruthy()
  expect(restoredCsrf).not.toBe(firstCsrf)

  await createReferenceData(page, categoryName, counterpartyName)
  await createAccount(page, accountName)
  await createTransaction(page, accountName, categoryName, counterpartyName, description)

  await page.goto('/transactions')
  await expect(page.getByText(description, { exact: true }).filter({ visible: true })).toBeVisible()
  await page.goto('/')
  await expect(page.getByText(description, { exact: true }).filter({ visible: true })).toBeVisible()

  await ensureSecondBook(page, secondBook)
  await selectBook(page, secondBook)
  await page.goto('/accounts')
  await expect(page.getByText(accountName, { exact: true })).toHaveCount(0)

  await selectBook(page, '默认账本')
  await page.goto('/accounts')
  await expect(page.getByText(accountName, { exact: true })).toBeVisible()

  await page.goto('/settings')
  await page.getByRole('button', { name: '退出登录' }).filter({ visible: true }).click()
  await expect(page.getByText('登录账本', { exact: true })).toBeVisible()
  expect((await context.cookies()).some((cookie) => cookie.name === 'granary_session')).toBe(false)
})
