import type { InsightCategoryEntry } from '../api/schemas'
import type { CategoryBarDatum } from '../components/abaku/CategoryBarChart'
import { absoluteDecimalString, compareDecimalStrings, sumDecimalStrings } from './decimal'

/**
 * 把 insight 系列端点（expense/category、income/revenue、expense/asset）的原始数组
 * 转成 CategoryBarChart 需要的 Top N + 「其他」聚合数据。与总览页分类支出排行同一算法
 * （规范 §4「Top 8+其他」），报表页三个排行区块共用。
 */
export function topNWithOther(rows: InsightCategoryEntry[], n = 8): CategoryBarDatum[] {
  const byCurrency = new Map<string, InsightCategoryEntry[]>()
  for (const row of rows) {
    const current = byCurrency.get(row.currency_code)
    if (current) current.push(row)
    else byCurrency.set(row.currency_code, [row])
  }

  return Array.from(byCurrency.entries()).flatMap(([currencyCode, currencyRows]) => {
    const sorted = [...currencyRows].sort((a, b) =>
      compareDecimalStrings(absoluteDecimalString(b.difference), absoluteDecimalString(a.difference)),
    )
    const top = sorted.slice(0, n).map((row) => ({
      name: row.name,
      value: absoluteDecimalString(row.difference),
      currencyCode,
    }))
    const rest = sorted.slice(n)
    if (rest.length > 0) {
      top.push({
        name: '其他',
        value: sumDecimalStrings(rest.map((row) => absoluteDecimalString(row.difference))),
        currencyCode,
      })
    }
    return top
  })
}
