import type { Category, CategoryDomain, CategoryStats } from '../../api/schemas'

/**
 * 分类树的取数与排序。页面组件只管画，判断谁是组、谁能删、谁在哪个域全在这里。
 */

export const DOMAIN_ORDER: readonly CategoryDomain[] = ['income', 'expense', 'transfer']

export const DOMAIN_LABELS: Record<CategoryDomain, string> = {
  income: '收入',
  expense: '支出',
  transfer: '资金往来',
}

/** 每段标题下的一行小字：说清这个域算进哪本账 */
export const DOMAIN_HINTS: Record<CategoryDomain, string> = {
  income: '钱从哪来，进收入统计。',
  expense: '钱花在什么上，进支出统计和预算。',
  transfer: '自己账户之间搬钱、对账，不进收支统计。',
}

export function domainOf(category: Category): CategoryDomain {
  return category.attributes.domain
}

/** parent_id 后端可能给数字，统一成字符串，免得 '12' !== 12 把子分类挂丢 */
export function parentIdOf(category: Category): string | null {
  const raw = category.attributes.parent_id
  if (raw === null || raw === undefined || raw === '') return null
  return String(raw)
}

export function isDisabled(category: Category): boolean {
  return category.attributes.disabled_at != null
}

/** 出厂词表带的分类：不可删、不可改名，但可禁用、可换图标颜色 */
export function isSystem(category: Category): boolean {
  return category.attributes.system === true
}

export interface CategoryNode {
  category: Category
  children: Category[]
}

const collator = new Intl.Collator('zh-Hans-CN')

function byName(a: Category, b: Category): number {
  return collator.compare(a.attributes.name, b.attributes.name)
}

/**
 * 把一个域内的分类拼成两级树。
 * 父级不在本域（或压根没返回）的孤儿子分类提升为一级显示——宁可位置不对，
 * 也好过它在界面上凭空消失、用户以为分类被吞了。
 */
export function buildDomainTree(categories: Category[], domain: CategoryDomain): CategoryNode[] {
  const inDomain = categories.filter((c) => domainOf(c) === domain)
  const ids = new Set(inDomain.map((c) => c.id))
  const roots: Category[] = []
  const childrenOf = new Map<string, Category[]>()

  for (const category of inDomain) {
    const parentId = parentIdOf(category)
    if (parentId && ids.has(parentId)) {
      const bucket = childrenOf.get(parentId)
      if (bucket) bucket.push(category)
      else childrenOf.set(parentId, [category])
    } else {
      roots.push(category)
    }
  }

  return roots.sort(byName).map((category) => ({
    category,
    children: (childrenOf.get(category.id) ?? []).sort(byName),
  }))
}

/** 支出域里能当「组」的一级分类，供「换组」菜单和新建时选父级 */
export function groupOptions(categories: Category[], domain: CategoryDomain): Category[] {
  return categories
    .filter((c) => domainOf(c) === domain && parentIdOf(c) === null)
    .sort(byName)
}

export interface CategoryUsage {
  count: number
  lastUsedAt: string | null
}

const EMPTY_USAGE: CategoryUsage = { count: 0, lastUsedAt: null }

export function usageIndex(stats: CategoryStats | undefined): Map<string, CategoryUsage> {
  const index = new Map<string, CategoryUsage>()
  for (const entry of stats?.categories ?? []) {
    index.set(entry.id, { count: entry.txn_count_365d, lastUsedAt: entry.last_used_at })
  }
  return index
}

export function usageOf(index: Map<string, CategoryUsage>, id: string): CategoryUsage {
  return index.get(id) ?? EMPTY_USAGE
}

/** 组的笔数是自己加全部子分类——只显示组自己的通常是 0，看着像没人用 */
export function subtreeUsage(index: Map<string, CategoryUsage>, node: CategoryNode): CategoryUsage {
  let count = 0
  let lastUsedAt: string | null = null
  for (const id of [node.category.id, ...node.children.map((c) => c.id)]) {
    const usage = usageOf(index, id)
    count += usage.count
    if (usage.lastUsedAt && (!lastUsedAt || usage.lastUsedAt > lastUsedAt)) lastUsedAt = usage.lastUsedAt
  }
  return { count, lastUsedAt }
}

/** "2026-08-05"；没用过就明说，不留空格让人猜 */
export function formatLastUsed(lastUsedAt: string | null): string {
  if (!lastUsedAt) return '还没用过'
  return lastUsedAt.slice(0, 10)
}

/** 分类全路径，如「餐饮 / 外卖」。规则列表和迁移选择器都要显示到叶子 */
export function fullPath(categories: Category[], category: Category): string {
  const parentId = parentIdOf(category)
  if (!parentId) return category.attributes.name
  const parent = categories.find((c) => c.id === parentId)
  return parent ? `${parent.attributes.name} / ${category.attributes.name}` : category.attributes.name
}
