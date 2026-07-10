import type { AccountChartSeries } from '../api/schemas'

export interface BalancePoint {
  /** YYYY-MM-DD（本地日） */
  date: string
  value: number
}

export interface BalanceSeries {
  /** 稳定 key：用 label（API 不返回 account id） */
  key: string
  name: string
  currencySymbol: string
  points: BalancePoint[]
}

/** Atom / ISO 时间戳 → YYYY-MM-DD（取日期部分，避免时区二次解析） */
export function chartEntryDateKey(atomOrIso: string): string {
  return atomOrIso.slice(0, 10)
}

/**
 * 把 chart/account/overview 单条 series 转成有序点列。
 * 优先 entries；若 convertToPrimary 时只有 pc_entries 再回退。
 */
export function seriesToPoints(series: AccountChartSeries): BalancePoint[] {
  const raw =
    series.entries && Object.keys(series.entries).length > 0
      ? series.entries
      : (series.pc_entries ?? {})
  return Object.entries(raw)
    .map(([k, v]) => ({ date: chartEntryDateKey(k), value: Number(v) }))
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/** 单条 chart series → 图表组件数据（账户详情单序列用，保留全 0） */
export function toBalanceSeries(series: AccountChartSeries): BalanceSeries {
  return {
    key: series.label,
    name: series.label,
    currencySymbol: series.currency_symbol ?? '¥',
    points: seriesToPoints(series),
  }
}

/**
 * 总览：最多 max 条，按期末 |余额| 降序；剔除全程为 0 的空序列。
 * 规范 §4：账户余额面积线最多 4 条。
 */
export function pickTopBalanceSeries(
  raw: AccountChartSeries[],
  max = 4,
): BalanceSeries[] {
  return raw
    .map(toBalanceSeries)
    .filter((s) => s.points.some((p) => p.value !== 0))
    .sort((a, b) => {
      const lastA = Math.abs(a.points.at(-1)?.value ?? 0)
      const lastB = Math.abs(b.points.at(-1)?.value ?? 0)
      return lastB - lastA
    })
    .slice(0, max)
}
