import { describe, expect, it } from 'vitest'
import { nextOccurrence } from './recurrence'
import type { Recurrence } from '../api/schemas'

function recurrence(partial: {
  title?: string
  active?: boolean
  first_date?: string
  latest_date?: string | null
  repeat_until?: string | null
  repetitions?: Array<{ type?: string; moment?: string; skip?: number; occurrences?: string[] }>
}): Recurrence {
  const { repetitions, ...rest } = partial
  return {
    id: '1',
    attributes: {
      title: '测试',
      active: true,
      first_date: '2026-01-01',
      recurrence_transactions: [],
      ...rest,
      repetitions: (repetitions ?? []).map((r) => ({ ...r, occurrences: r.occurrences ?? [] })),
    },
  }
}

describe('nextOccurrence', () => {
  it('月度：1 月 31 日之后的下一次落在 2 月末（钳制）', () => {
    const r = recurrence({ first_date: '2026-01-31', repetitions: [{ type: 'monthly', moment: '31', skip: 0 }] })
    expect(nextOccurrence(r, new Date(2026, 1, 1))?.toISOString().slice(0, 10)).toBe('2026-02-28')
  })

  it('闰年：2 月 29 日的月度继续按 29 日走', () => {
    const r = recurrence({ first_date: '2028-02-29', repetitions: [{ type: 'monthly', moment: '29', skip: 0 }] })
    expect(nextOccurrence(r, new Date(2028, 2, 1))?.toISOString().slice(0, 10)).toBe('2028-03-29')
  })

  it('闰年：2 月 29 日的年度在平年回落到 2 月 28 日', () => {
    const yearly = recurrence({ first_date: '2028-02-29', repetitions: [{ type: 'yearly', moment: '02-29', skip: 0 }] })
    expect(nextOccurrence(yearly, new Date(2029, 0, 1))?.toISOString().slice(0, 10)).toBe('2029-02-28')
  })

  it('skip：weekly skip=1 时跳过一期', () => {
    const r = recurrence({
      first_date: '2026-01-05', // 周一
      repetitions: [{ type: 'weekly', moment: '1', skip: 1 }],
    })
    const next = nextOccurrence(r, new Date(2026, 0, 6))
    expect(next?.toISOString().slice(0, 10)).toBe('2026-01-19')
  })

  it('repeat_until 已过返回 null', () => {
    const r = recurrence({
      first_date: '2026-01-01',
      repeat_until: '2026-03-01',
      repetitions: [{ type: 'monthly', moment: '1', skip: 0 }],
    })
    expect(nextOccurrence(r, new Date(2026, 3, 1))).toBeNull()
  })

  it('ndom：每月第二个星期五', () => {
    const r = recurrence({ first_date: '2026-01-09', repetitions: [{ type: 'ndom', moment: '2,5', skip: 0 }] })
    const next = nextOccurrence(r, new Date(2026, 0, 10))
    expect(next?.toISOString().slice(0, 10)).toBe('2026-02-13')
  })
})
