import { expect, test, type Locator, type Page } from '@playwright/test'
import { seedFireflyE2EUser } from './seed'

/**
 * 一条主路径打穿：登录 → 今天页待办 → 交易筛选 → 键盘操作 → 批量改分类 → 订阅记一笔 → 账户归档。
 *
 * 合成一个 test 是有意的：这些步骤共享同一份服务端数据，拆开就变成跨 test 的隐式状态依赖。
 * 只跑 desktop（文件名带 .desktop）：这条路径会写服务端数据，同一轮再跑一遍 mobile
 * 会踩到上一轮改过的笔数。
 */

/** 跟 firefly-iii 的 SeedsE2EEnvironment 一一对应，改那边这里也要跟着改。 */
const FIXTURE = {
  archiveAsset: 'E2E 归档账户',
  categoryFood: 'E2E 餐饮',
  categoryRide: 'E2E 交通',
  subscription: 'Abaku E2E Daily Synthetic Subscription',
  subscriptionCharge: 'Abaku E2E Synthetic Subscription Charge',
  subscriptionAmount: '-¥12.34',
  /** 播的三笔都在今天，时间 18:00 / 12:00 / 08:00，列表按日期倒序，所以顺序是定的。 */
  transactions: [
    { description: 'E2E 打车', amount: '-¥56.00', category: 'E2E 交通' },
    { description: 'E2E 午餐', amount: '-¥34.00', category: 'E2E 餐饮' },
    { description: 'E2E 早餐', amount: '-¥12.00', category: 'E2E 餐饮' },
  ],
  /** e2e 用户的资产账户：记账账户 + 归档账户 + 订阅的扣款账户。 */
  assetAccountCount: 3,
} as const

let token = ''

test.beforeAll(() => {
  token = seedFireflyE2EUser()
})

/**
 * 数据行。DataTable 首行是一行 sr-only 表头（role=row + columnheader），它在无障碍树里
 * 是真实存在的，getByRole('row') 会数到它——按 columnheader 排掉，下标才对得上。
 */
function dataRows(page: Page): Locator {
  return page.getByRole('row').filter({ hasNot: page.getByRole('columnheader') })
}

function transactionRow(page: Page, description: string): Locator {
  return dataRows(page).filter({ hasText: description })
}

function toast(page: Page, message: string): Locator {
  return page.getByRole('status').filter({ hasText: message })
}

/** 详情弹层的「关闭」有两个（右上角图标 + 页脚按钮），取页脚那个。 */
function closeDialog(dialog: Locator): Locator {
  return dialog.getByRole('button', { name: '关闭', exact: true }).last()
}

function searchParam(page: Page, key: string): string | null {
  return new URL(page.url()).searchParams.get(key)
}

test('从登录一路走到归档账户', async ({ page }) => {
  // 1. 登录：令牌只能从 TokenGate 粘进去，粘完前整个应用都不该渲染。
  await page.goto('/')
  const gate = page.getByRole('dialog', { name: '设置 API 令牌' })
  await expect(gate).toBeVisible()
  await gate.getByRole('textbox').fill(token)
  await gate.getByRole('button', { name: '保存并继续' }).click()
  await expect(gate).toBeHidden()

  // 2. 今天页：种子里有一条今天起算的日订阅，「本月待付订阅」必须正好是 1。
  await expect(page.getByRole('heading', { name: '今天' })).toBeVisible()
  await expect(page.getByRole('link', { name: /本月待付订阅/ })).toHaveText(/本月待付订阅\s*1\s*→/)

  // 3. 交易页：先确认三笔的顺序、金额、分类，再用筛选栏筛一次。
  await page.goto('/transactions')
  const rows = dataRows(page)
  await expect(rows).toHaveCount(FIXTURE.transactions.length)
  for (const [index, expected] of FIXTURE.transactions.entries()) {
    await expect(rows.nth(index)).toContainText(expected.description)
    await expect(rows.nth(index)).toContainText(expected.amount)
    await expect(rows.nth(index)).toContainText(expected.category)
  }

  const categoryFilter = page.getByLabel('分类', { exact: true })
  await categoryFilter.selectOption(FIXTURE.categoryRide)
  await expect.poll(() => searchParam(page, 'cat')).toContain(FIXTURE.categoryRide)
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('E2E 打车')
  await expect(rows.first()).toContainText('-¥56.00')

  await page.getByRole('button', { name: '清除筛选' }).click()
  await expect.poll(() => searchParam(page, 'cat')).not.toContain(FIXTURE.categoryRide)
  await expect(categoryFilter).toHaveValue('')
  await expect(rows).toHaveCount(FIXTURE.transactions.length)

  // 4. 键盘：↓↓↑ 把光标停在第二行，Enter 展开的就该是第二行那笔。
  //    放在批量改分类之前跑：批量 PUT 会把时间抹成当天 00:00，行序就不再由播种时间决定了。
  await expect(rows.nth(0)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(1)).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(rows.nth(2)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(rows.nth(1)).toBeFocused()

  await page.keyboard.press('Enter')
  const detail = page.getByRole('dialog', { name: '交易详情' })
  await expect(detail).toContainText('E2E 午餐')
  await expect(detail).toContainText('-¥34.00')
  await expect(detail).toContainText(FIXTURE.categoryFood)
  await expect.poll(() => searchParam(page, 'transaction')).not.toBeNull()
  await closeDialog(detail).click()
  await expect(detail).toBeHidden()

  // 5. 批量改分类：勾两笔餐饮改成交通，确认框要写清楚改几笔，改完列表当场更新。
  await transactionRow(page, 'E2E 早餐').getByRole('checkbox', { name: '选择此行' }).check()
  await transactionRow(page, 'E2E 午餐').getByRole('checkbox', { name: '选择此行' }).check()
  await expect(page.getByText('已选 2 笔')).toBeVisible()

  await page.getByRole('button', { name: '改分类', exact: true }).click()
  const batchDialog = page.getByRole('dialog', { name: '批量改分类' })
  await expect(batchDialog).toContainText('将修改 2 笔交易的改分类')
  await batchDialog.getByLabel('分类名称').fill(FIXTURE.categoryRide)
  await batchDialog.getByRole('button', { name: '将修改 2 笔交易' }).click()

  await expect(toast(page, '已更新 2 笔交易')).toBeVisible()
  await expect(batchDialog).toBeHidden()
  await expect(transactionRow(page, 'E2E 早餐')).toContainText(FIXTURE.categoryRide)
  await expect(transactionRow(page, 'E2E 午餐')).toContainText(FIXTURE.categoryRide)

  // 三笔现在都在交通名下，筛一次能筛出三笔
  await categoryFilter.selectOption(FIXTURE.categoryRide)
  await expect(rows).toHaveCount(FIXTURE.transactions.length)
  await page.getByRole('button', { name: '清除筛选' }).click()
  await expect(rows).toHaveCount(FIXTURE.transactions.length)

  // 6. 订阅：点「记这一笔」应当真生成一笔 12.34 的交易，列表也要多一笔。
  await page.goto('/accounts?view=subscriptions')
  await expect(page.getByText(FIXTURE.subscription)).toBeVisible()
  const triggered = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST'
      && /\/api\/v1\/recurrences\/\d+\/trigger/.test(new URL(response.url()).pathname),
  )
  await page.getByRole('button', { name: '记这一笔' }).click()
  const triggerResponse = await triggered
  expect(triggerResponse.status()).toBe(200)
  const createdGroupId = ((await triggerResponse.json()) as { data: { id: string }[] }).data[0].id

  await expect(toast(page, `已记一笔「${FIXTURE.subscription}」`)).toBeVisible()
  await expect(page.getByText('本期已记')).toBeVisible()

  await page.goto(`/transactions?transaction=${createdGroupId}`)
  const charge = page.getByRole('dialog', { name: '交易详情' })
  await expect(charge).toContainText(FIXTURE.subscriptionCharge)
  await expect(charge).toContainText(FIXTURE.subscriptionAmount)
  await closeDialog(charge).click()
  await expect(rows).toHaveCount(FIXTURE.transactions.length + 1)

  // 7. 账户：归档是 PUT active=false，不是删除；归档后默认列表少一行，勾「显示已归档」又回来。
  await page.goto('/accounts')
  const accountRows = page.getByTestId('account-row')
  await expect(accountRows).toHaveCount(FIXTURE.assetAccountCount)

  const archiveRequest = page.waitForRequest(
    (request) => request.method() === 'PUT' && /\/api\/v1\/accounts\/\d+$/.test(new URL(request.url()).pathname),
  )
  await page.getByRole('button', { name: `归档 ${FIXTURE.archiveAsset}` }).click()
  expect(JSON.parse((await archiveRequest).postData() ?? '{}')).toMatchObject({
    name: FIXTURE.archiveAsset,
    active: false,
  })

  await expect(toast(page, '账户已归档，数据都还在')).toBeVisible()
  await expect(accountRows).toHaveCount(FIXTURE.assetAccountCount - 1)
  await expect(page.getByText(FIXTURE.archiveAsset)).toHaveCount(0)

  await page.getByLabel('显示已归档').check()
  await expect(accountRows).toHaveCount(FIXTURE.assetAccountCount)
  await expect(accountRows.filter({ hasText: FIXTURE.archiveAsset })).toContainText('已归档')
})
