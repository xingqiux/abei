import { describe, expect, it } from 'vitest'
import { blockingStep } from './InboxOnboardingCard'

describe('blockingStep', () => {
  it('邮箱没连就卡在第一步', () => {
    expect(blockingStep({ mailboxReady: false, hasRows: false, hasImported: false })).toBe('connect')
  })

  it('连了但还没解析出流水就是在等同步', () => {
    expect(blockingStep({ mailboxReady: true, hasRows: false, hasImported: false })).toBe('sync')
  })

  it('有流水没入过账就该去确认入账', () => {
    expect(blockingStep({ mailboxReady: true, hasRows: true, hasImported: false })).toBe('import')
  })
})
