import type { Recurrence } from '../api/schemas'

export interface RepetitionRule {
  type: string
  moment: string
  skip: number
}

const WEEKDAY_OFFSET = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 0 } as Record<string, number>

function parseRule(r: { type?: string; moment?: string; skip?: number }): RepetitionRule {
  return { type: r.type ?? 'monthly', moment: r.moment ?? '', skip: r.skip ?? 0 }
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m + 1, 0).getDate()
}

/** 规则在某个日期是否命中（weekly 对星期、monthly 对日、yearly 对月日）。 */
function matches(rule: RepetitionRule, d: Date): boolean {
  switch (rule.type) {
    case 'daily':
      return true
    case 'weekly':
      return WEEKDAY_OFFSET[rule.moment] === d.getDay()
    case 'monthly': {
      const day = Number(rule.moment)
      return Number.isFinite(day) && d.getDate() === Math.min(day, daysInMonth(d.getFullYear(), d.getMonth()))
    }
    case 'ndom': {
      // moment 形如 "2,5"：本月第 2 个星期 5
      const [nthStr, wdStr] = rule.moment.split(',')
      const nth = Number(nthStr)
      const wd = WEEKDAY_OFFSET[wdStr]
      return Number.isFinite(nth) && wd !== undefined && d.getDay() === wd && Math.ceil(d.getDate() / 7) === nth
    }
    case 'yearly': {
      const [monthStr, dayStr] = rule.moment.split('-')
      const day = Number(dayStr)
      return d.getMonth() + 1 === Number(monthStr) && d.getDate() === Math.min(day, daysInMonth(d.getFullYear(), d.getMonth()))
    }
    default:
      return true
  }
}

function firstAfter(rule: RepetitionRule, from: Date): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  for (let i = 0; i < 370; i += 1) {
    if (matches(rule, d)) return d
    d.setDate(d.getDate() + 1)
  }
  return d
}

/** 规则在 d 之后的第一次命中（含次日）；月末/闰年钳制在 matches 里。 */
function advance(rule: RepetitionRule, d: Date): Date {
  return firstAfter(rule, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1))
}

function parseLocal(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d)
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/**
 * 从 recurrence 的 repetitions 推下一次到期日。
 * Firefly 返回的 repetitions 是规则（type: daily/weekly/monthly/ndom/yearly + moment + skip），
 * 不是日期列表。skip 是跳过 n 期；repeat_until 已过时返回 null。
 * ponytail: nr_of_repetitions 未参与计算（需要从 first_date 数已生成期次，得不偿失），
 * 等真遇到“次数用尽仍显示待付”再加。
 */
export function nextOccurrence(r: Recurrence, from = new Date()): Date | null {
  const until = r.attributes.repeat_until ? parseLocal(r.attributes.repeat_until) : null
  if (until && until < startOfDay(from)) return null
  const base = r.attributes.latest_date ? parseLocal(r.attributes.latest_date) : parseLocal(r.attributes.first_date)
  const rules = (r.attributes.repetitions ?? []).map(parseRule)

  let best: Date | null = null
  for (const rule of rules) {
    let cursor = firstAfter(rule, base)
    let index = 0
    const start = startOfDay(from)
    // 从 base 走到 start，同步期数（skip 的“第几期”必须从起点对齐）
    while (cursor.getTime() < start.getTime() && index < 100_000) {
      cursor = advance(rule, cursor)
      index += 1
    }
    while (index % (rule.skip + 1) !== 0 && index < 100_000) {
      cursor = advance(rule, cursor)
      index += 1
    }
    if (until && cursor > until) continue
    if (best === null || cursor < best) best = cursor
  }
  return best
}
