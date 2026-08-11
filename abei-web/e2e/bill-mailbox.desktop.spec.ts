import { expect, test } from '@playwright/test'
import { seedFireflyE2EUser } from './seed'

test('最新招商邮件不会被旧渠道邮件挤掉', async ({ request }) => {
  let token = await seedFireflyE2EUser()
  const headers = () => ({ Authorization: `Bearer ${token}` })
  const before = await request.get('/v1/bills?source=cmb&limit=100', { headers: headers() })
  expect(before.ok()).toBeTruthy()
  const previousIds = new Set(((await before.json()) as { data: { id: string }[] }).data.map(({ id }) => id))

  const reset = await request.put('/v1/bills/mailbox', {
    headers: headers(),
    data: { enabled: false, provider: 'gmail' },
  })
  expect(reset.ok(), await reset.text()).toBeTruthy()

  token = await seedFireflyE2EUser(true)
  const settings = await request.put('/v1/bills/mailbox', {
    headers: headers(),
    data: {
      enabled: true,
      provider: 'imap',
      email: 'bills@localhost',
      host: 'mail',
      port: 3143,
      encryption: 'none',
      username: 'bills',
      password: 'bills-local-only',
      folder: 'INBOX',
    },
  })
  expect(settings.ok(), await settings.text()).toBeTruthy()

  const sync = await request.post('/v1/bills/sync', { headers: headers(), data: { limit: 1 } })
  expect(sync.status(), await sync.text()).toBe(202)

  await expect.poll(async () => {
    const response = await request.get('/v1/bills?source=cmb&limit=100', { headers: headers() })
    if (!response.ok()) return false
    const body = (await response.json()) as {
      data: { id: string; attributes: { profile_id?: string } }[]
    }
    return body.data.some(
      ({ id, attributes }) => !previousIds.has(id) && attributes.profile_id === 'cmb-transaction-statement',
    )
  }, { timeout: 30_000 }).toBe(true)
})
