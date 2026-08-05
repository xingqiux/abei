/**
 * 交易页 URL 搜索参数的解析与构造。
 *
 * 单独一个模块，不放在 router.tsx 里——router.tsx 在模块顶层就 createRoute /
 * lazyRouteComponent，任何组件只为取 txSearch 而 import 它，都会把整棵路由树拖进
 * 自己的模块图（组件单测因此得连整个路由一起加载）。这里是纯函数，零依赖。
 */

/** 交易页支持的三种类型筛选，与 Firefly 的 transaction type 对齐。 */
const TX_TYPES = ['withdrawal', 'deposit', 'transfer'] as const

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 数组或逗号分隔字符串都收，空串丢弃——URL 里两种写法都可能出现。 */
const strArray = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x !== '')
    : typeof v === 'string' && v !== ''
      ? v.split(',').map((s) => s.trim()).filter(Boolean)
      : []

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | undefined =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : undefined

/** 把 URL 上的原始搜索参数归一成交易页要的形状。非法值一律回落到缺省，不抛错。 */
export function validateTransactionSearch(search: Record<string, unknown>) {
  const rawId = search.transaction
  const transaction = typeof rawId === 'number'
    ? rawId
    : typeof rawId === 'string' && /^\d+$/.test(rawId)
      ? Number(rawId)
      : Number.NaN

  return {
    transaction: Number.isSafeInteger(transaction) && transaction > 0 ? transaction : undefined,
    q: str(search.q),
    acc: strArray(search.acc),
    cat: strArray(search.cat),
    tag: strArray(search.tag),
    min: num(search.min),
    max: num(search.max),
    type: oneOf(search.type, TX_TYPES),
    page: Math.max(1, num(search.page) ?? 1),
  }
}

export type TransactionSearch = ReturnType<typeof validateTransactionSearch>

/**
 * 构造一份完整的交易页搜索参数。
 *
 * `<Link to="/transactions" search={...}>` 要求的是完整对象（TanStack Router 拿
 * validateSearch 的返回类型当 Link 的入参类型），只写 `{ transaction: 123 }` 过不了类型检查。
 * 与其在每个调用点手抄九个字段，不如从这里取默认值再覆盖。
 */
export function txSearch(overrides: Partial<TransactionSearch> = {}): TransactionSearch {
  return {
    transaction: undefined,
    q: undefined,
    acc: [],
    cat: [],
    tag: [],
    min: undefined,
    max: undefined,
    type: undefined,
    page: 1,
    ...overrides,
  }
}
