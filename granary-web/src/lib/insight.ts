import type { InsightCategoryEntry } from '../api/schemas'
import type { CategoryBarDatum } from '../components/granary/CategoryBarChart'

/**
 * 把 insight 系列端点（expense/category、income/revenue、expense/asset）的原始数组
 * 转成 CategoryBarChart 需要的 Top N + 「其他」聚合数据。与总览页分类支出排行同一算法
 * （规范 §4「Top 8+其他」），报表页三个排行区块共用。
 */
export function topNWithOther(rows: InsightCategoryEntry[], n = 8): CategoryBarDatum[] {
  const sorted = [...rows].sort((a, b) => Math.abs(b.difference_float) - Math.abs(a.difference_float))
  const top = sorted.slice(0, n).map((r) => ({ name: r.name, value: Math.abs(r.difference_float) }))
  const restSum = sorted.slice(n).reduce((acc, r) => acc + Math.abs(r.difference_float), 0)
  if (restSum > 0) top.push({ name: '其他', value: restSum })
  return top
}
