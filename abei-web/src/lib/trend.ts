import type { KpiTrend } from '../components/abei/KpiCard'
import type { CurrencyAmount } from './summary'

export interface DateRangeLike {
  start: string
  end: string
}

function parseLocal(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function toIso(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/**
 * 上一个对比期：紧贴当前期之前、等长的一段。
 * 不做「上个自然月」对齐——当前期常常是月中截断的（本月 1 号到今天），
 * 拿半个月跟整个上月比只会得出「支出暴跌」的假环比；等长窗口没有这个问题。
 */
export function previousRange(range: DateRangeLike): DateRangeLike {
  const start = parseLocal(range.start)
  const end = parseLocal(range.end)
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1
  const prevEnd = new Date(start)
  prevEnd.setDate(prevEnd.getDate() - 1)
  const prevStart = new Date(prevEnd)
  prevStart.setDate(prevStart.getDate() - (days - 1))
  return { start: toIso(prevStart), end: toIso(prevEnd) }
}

/** 主币种取当前期的第一项（summaryAmounts 已按币种代码排序），上期按同币种对齐。 */
function primaryPair(current: CurrencyAmount[], previous: CurrencyAmount[]): { cur: number; prev: number } | null {
  const primary = current[0]
  if (!primary) return null
  const cur = Math.abs(Number(primary.value))
  const prevEntry = previous.find((amount) => amount.code === primary.code)
  if (!prevEntry) return null
  const prev = Math.abs(Number(prevEntry.value))
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return null
  return { cur, prev }
}

/**
 * 环比变化率（%，保留一位）。上期为 0 或缺数据时返回 null——
 * 「较上期 +∞%」不是信息，是笑话。
 */
export function trendPercent(current: CurrencyAmount[], previous: CurrencyAmount[]): number | null {
  const pair = primaryPair(current, previous)
  if (!pair || pair.prev === 0) return null
  return Math.round(((pair.cur - pair.prev) / pair.prev) * 1000) / 10
}

/**
 * 环比 chip。goodWhen 说的是哪个方向对钱包好：支出 'down'、收入 'up'。
 * 变化不足 0.1% 按持平处理，箭头和颜色都不给。
 */
export function periodTrend(
  current: CurrencyAmount[],
  previous: CurrencyAmount[],
  goodWhen: 'up' | 'down',
): KpiTrend | undefined {
  const pct = trendPercent(current, previous)
  if (pct === null) return undefined
  if (Math.abs(pct) < 0.1) return { label: '较上期持平', tone: 'neutral' }
  const rising = pct > 0
  const tone: KpiTrend['tone'] = rising === (goodWhen === 'up') ? 'good' : 'bad'
  return { label: `较上期 ${rising ? '↑' : '↓'}${Math.abs(pct)}%`, tone }
}
