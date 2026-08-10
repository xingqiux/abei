import { CategoryIcon } from './CategoryIcon'
import { formatAmount } from '../../lib/format'

/** 色板号解析和 CategoryIcon 同规则：只认 "1"~"12"，其余落 12 号灰 */
function paletteSlot(color: string | null | undefined): number {
  const n = Number(color)
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 12
}

/**
 * 分类占比小卡：图标 + 名称 + 占总支出百分比 + 金额 + 同色进度条。
 * percent 的口径是「占本期总支出」，不是排行图那种「相对最大项」——
 * 两个数长得像但含义完全不同，别混着喂。
 */
export function CategoryShareCard({
  name,
  icon,
  color,
  amount,
  symbol,
  percent,
}: {
  name: string
  icon?: string | null
  color?: string | null
  amount: string
  symbol: string
  percent: number
}) {
  const slot = paletteSlot(color)
  const width = percent > 0 ? Math.max(percent, 2) : 0 // 1% 以下也画一点，看得出「有」

  // 不用 Card：这些小块躺在卡片里面，浅色下白叠白只能靠描边分层
  return (
    <div className="flex flex-col gap-2.5 rounded-lg p-3.5 ring-1 ring-[var(--border-subtle)]">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <CategoryIcon icon={icon} color={color} size={20} />
          <span className="truncate text-[13px] font-medium text-[var(--text-primary)]">{name}</span>
        </div>
        <span className="num shrink-0 text-[12px] font-semibold text-[var(--text-secondary)]">{percent}%</span>
      </div>
      <div className="num text-[15px] leading-none font-semibold text-[var(--text-primary)]">
        {symbol}
        {formatAmount(amount)}
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-[var(--surface-hover)]" aria-hidden>
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{ width: `${width}%`, background: `var(--cat-${slot})` }}
        />
      </div>
    </div>
  )
}
