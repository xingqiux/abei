import { describe, expect, it } from 'vitest'
import { buildFireflyQuery, quote } from './fireflyQuery'

describe('buildFireflyQuery', () => {
  it('组合日期、分类、金额与类型', () => {
    expect(buildFireflyQuery({
      start: '2026-08-01',
      end: '2026-08-31',
      categories: ['餐饮'],
      amountMin: 10,
      types: ['withdrawal'],
    })).toBe('date_after:2026-08-01 date_before:2026-08-31 category_is:餐饮 amount_more:10 type:withdrawal')
  })

  it('含空格的值加引号', () => {
    expect(quote('招商银行 工资')).toBe('"招商银行 工资"')
    expect(quote('餐饮')).toBe('餐饮')
  })
})
