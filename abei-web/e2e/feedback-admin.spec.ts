import { expect, test, type Page, type Route } from '@playwright/test'

const item = {
  feedback_id: 42,
  title: '账单导入没有结果',
  kind: 'bug',
  target: 'cli',
  status: 'reviewing',
  severity: 'high',
  public_summary: '正在定位导入队列。',
  close_reason: null,
  merged_into_id: null,
  affected_users: 3,
  occurrences: 5,
  first_seen: '2026-08-09T08:00:00-07:00',
  last_seen: '2026-08-11T08:00:00-07:00',
  archived_at: null,
  archived_by: null,
  created_at: '2026-08-09T08:00:00-07:00',
  updated_at: '2026-08-11T08:00:00-07:00',
  completed_at: null,
}

const candidate = {
  feedback_id: 42,
  title: item.title,
  kind: item.kind,
  target: item.target,
  status: item.status,
  affected_users: item.affected_users,
  occurrences: item.occurrences,
  match: { reason: 'same_capability_and_error', confidence: 'high', score: 1, algorithm_version: 1 },
}

const submission = {
  submission_id: 91,
  feedback_id: null,
  user_id: 7,
  kind: 'bug',
  target: 'cli',
  submitted_via: 'cli',
  message: '导入账单后一直没有结果',
  expected: '看到导入结果',
  actual: '命令等待后超时',
  state: 'pending_confirmation',
  context: {
    cli_version: '0.1.0',
    os: 'macos',
    arch: 'aarch64',
    recent: {
      capability_id: 'bills.import',
      request_id: 'req-feedback-91',
      result: 'error',
      error_reason: 'UpstreamUnavailable',
    },
  },
  fingerprint_version: 1,
  has_fingerprint: true,
  match_algorithm_version: 1,
  candidates: [candidate],
  item_title: null,
  item_status: null,
  message_count: 2,
  created_at: '2026-08-11T08:00:00-07:00',
  linked_at: null,
  last_seen_at: '2026-08-11T09:00:00-07:00',
}

const messages = [
  {
    id: 8,
    submission_id: 91,
    author_kind: 'admin',
    body: '请补充导出的文件格式和 abei 版本。',
    created_at: '2026-08-11T08:30:00-07:00',
  },
  {
    id: 9,
    submission_id: 91,
    author_kind: 'user',
    body: '招商银行 CSV，abei 0.1.0。',
    created_at: '2026-08-11T09:00:00-07:00',
  },
]

const audit = [
  {
    id: 1,
    item_id: null,
    submission_id: 91,
    event_type: 'submission_created',
    actor_kind: 'user',
    actor_user_id: 7,
    metadata: { candidate_count: 1, kind: 'bug', target: 'cli' },
    created_at: '2026-08-11T08:00:00-07:00',
  },
  {
    id: 2,
    item_id: null,
    submission_id: 91,
    event_type: 'information_requested',
    actor_kind: 'admin',
    actor_user_id: 1,
    metadata: { message_id: 8 },
    created_at: '2026-08-11T08:30:00-07:00',
  },
]

const itemDetail = {
  data: item,
  updates: [
    {
      id: 3,
      item_id: 42,
      body: '已经复现，正在修复导入队列的超时处理。',
      status: 'reviewing',
      created_at: '2026-08-11T10:00:00-07:00',
    },
  ],
  submissions: [
    {
      submission_id: 90,
      kind: 'bug',
      target: 'cli',
      submitted_via: 'cli',
      message: '导入 CSV 后命令超时',
      expected: null,
      actual: null,
      state: 'linked',
      context: { cli_version: '0.1.0', recent: { capability_id: 'bills.import' } },
      match_candidates: [],
      created_at: '2026-08-10T08:00:00-07:00',
      linked_at: '2026-08-10T08:01:00-07:00',
      last_seen_at: '2026-08-10T08:00:00-07:00',
    },
  ],
  messages: [],
  audit: [
    {
      id: 3,
      item_id: 42,
      submission_id: null,
      event_type: 'item_updated',
      actor_kind: 'admin',
      actor_user_id: 1,
      metadata: { changed_fields: ['status'], from_status: 'open', to_status: 'reviewing' },
      created_at: '2026-08-11T10:00:00-07:00',
    },
  ],
  permissions: { manage: true },
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockApi(page: Page) {
  await page.addInitScript(() => sessionStorage.setItem('granary.token', 'feedback-e2e-token'))
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/v1/session') {
      await json(route, { data: { user_id: 1, actor: 'owner@example.test', role: 'owner', is_owner: true } })
      return
    }
    if (url.pathname === '/v1/feedback') {
      await json(route, {
        data: [],
        pending: [],
        pagination: { limit: 100, offset: 0, count: 0 },
      })
      return
    }
    if (url.pathname === '/v1/admin/feedback/submissions') {
      await json(route, { data: [submission], pagination: { limit: 100, offset: 0, count: 1 } })
      return
    }
    if (url.pathname === '/v1/admin/feedback/submissions/91') {
      await json(route, { data: submission, messages, audit })
      return
    }
    if (url.pathname === '/v1/admin/feedback/items') {
      const archived = url.searchParams.get('archived') === 'true'
      await json(route, { data: archived ? [] : [item], pagination: { limit: 100, offset: 0, count: archived ? 0 : 1 } })
      return
    }
    if (url.pathname === '/v1/admin/feedback/items/42') {
      await json(route, itemDetail)
      return
    }
    await json(route, { data: [], pagination: { limit: 100, offset: 0, count: 0 } })
  })
}

test('owner feedback workbench remains usable without horizontal overflow', async ({ page }, testInfo) => {
  await mockApi(page)
  await page.goto('/feedback')

  const adminEntry = page.getByRole('link', { name: '管理反馈' })
  await expect(adminEntry).toBeVisible()
  await adminEntry.click()

  await expect(page.getByRole('heading', { name: '反馈管理' })).toBeVisible()
  await expect(page.getByText('导入账单后一直没有结果').first()).toBeVisible()
  await page.getByText('运行上下文与匹配信息').click()
  await expect(page.getByText(/bills\.import/)).toBeVisible()
  await expect(page.getByText('审计记录（2）')).toBeVisible()
  expect(await hasHorizontalOverflow(page)).toBe(false)
  await page.locator('main').evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: testInfo.outputPath('feedback-inbox.png'), fullPage: true })

  await page.getByRole('tab', { name: /反馈事项/ }).click()
  await expect(page.getByLabel('标题')).toHaveValue('账单导入没有结果')
  await expect(page.getByText('已经复现，正在修复导入队列的超时处理。')).toBeVisible()
  expect(await hasHorizontalOverflow(page)).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('feedback-items.png'), fullPage: true })
})

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
}
