import { describe, expect, it } from 'vitest'
import { decisionSentence, evidenceSentence } from './PairingSuggestions'
import type { BillRowLink } from '../../api/schemas'

function link(evidence: Record<string, unknown>): BillRowLink {
  return { id: '1', attributes: { evidence } } as unknown as BillRowLink
}

function decided(decidedBy: 'user' | 'auto'): BillRowLink {
  return { id: '1', attributes: { decided_by: decidedBy } } as unknown as BillRowLink
}

describe('evidenceSentence', () => {
  it('说清楚凭什么认为是同一笔', () => {
    expect(
      evidenceSentence(link({ matched_on: ['provider_transaction_id'], days_apart: 0 })),
    ).toBe('金额一样、同一天、交易号对得上')
  })

  it('隔了几天就把天数说出来', () => {
    expect(evidenceSentence(link({ matched_on: [], days_apart: 2 }))).toBe('金额一样、差 2 天')
  })

  it('evidence 是空的也给得出一句话', () => {
    expect(evidenceSentence(link({}))).toBe('金额一样')
  })
})

describe('decisionSentence', () => {
  it('系统自己合的要说是自己合的，不能装成人点的', () => {
    expect(decisionSentence(decided('auto'), true))
      .toBe('订单号完全对得上，已自动合并。那一笔已经并进这一笔，不再单独入账。')
  })

  it('人点的还是那句已确认', () => {
    expect(decisionSentence(decided('user'), false)).toBe('已确认。')
  })
})
