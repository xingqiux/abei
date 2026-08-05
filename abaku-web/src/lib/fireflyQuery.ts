export interface TxFilters {
  q?: string
  accountIds?: string[]
  categories?: string[]
  tags?: string[]
  amountMin?: number
  amountMax?: number
  types?: ('withdrawal' | 'deposit' | 'transfer')[]
  start?: string
  end?: string
}

/** 筛选条件编译成 Firefly 查询语言，走 /search/transactions。 */
export function buildFireflyQuery(f: TxFilters): string {
  const parts: string[] = []
  if (f.start) parts.push(`date_after:${f.start}`)
  if (f.end) parts.push(`date_before:${f.end}`)
  for (const id of f.accountIds ?? []) parts.push(`account_id:${id}`)
  for (const c of f.categories ?? []) parts.push(`category_is:${quote(c)}`)
  for (const t of f.tags ?? []) parts.push(`tag_is:${quote(t)}`)
  if (f.amountMin != null) parts.push(`amount_more:${f.amountMin}`)
  if (f.amountMax != null) parts.push(`amount_less:${f.amountMax}`)
  if (f.types?.length === 1) parts.push(`type:${f.types[0]}`)
  if (f.q) parts.push(f.q)
  return parts.join(' ')
}

/** 含空格或冒号的值要加引号，中文分类名很容易踩到 */
export function quote(v: string): string {
  return /[\s:"]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v
}
