import { describe, expect, it } from 'vitest'
import { validateTransactionSearch } from './transactionSearch'

describe('validateTransactionSearch', () => {
  it('accepts direct URL and router numeric transaction ids', () => {
    expect(validateTransactionSearch({ transaction: '42' })).toEqual({
      transaction: 42, q: undefined, acc: [], cat: [], tag: [], min: undefined, max: undefined, type: undefined, page: 1,
    })
  })

  it('rejects invalid transaction ids', () => {
    expect(validateTransactionSearch({ transaction: 'not-an-id' })).toEqual({
      transaction: undefined, q: undefined, acc: [], cat: [], tag: [], min: undefined, max: undefined, type: undefined, page: 1,
    })
  })

  it('解析筛选参数：逗号数组、数字、类型白名单', () => {
    expect(validateTransactionSearch({ q: '咖啡', acc: '1,2', cat: '餐饮', min: '10', type: 'withdrawal', page: '3' })).toEqual({
      transaction: undefined, q: '咖啡', acc: ['1', '2'], cat: ['餐饮'], tag: [], min: 10, max: undefined, type: 'withdrawal', page: 3,
    })
    expect(validateTransactionSearch({ type: 'bogus' }).type).toBeUndefined()
  })
})
