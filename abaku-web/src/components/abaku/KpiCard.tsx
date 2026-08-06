import { formatAmount, semanticColorClass, type MoneySemantic } from '../../lib/format'
import type { CurrencyAmount } from '../../lib/summary'
import { Card } from '../ui/Card'

/**
 * 概览数字卡。多币种时并排列出，没有数据显示 `--`。
 *
 * 颜色走 `semanticColorClass`，不再由调用方传 CSS 变量名：原先几处各传各的，
 * 支出被涂成 `--danger`——那个 token 写明了只给删除类操作，跟「这个月花了多少」
 * 不是一回事，而且和「收入红」撞成两种红。
 */
export function KpiCard({
  label,
  amounts,
  semantic,
  sublabel,
  signed = false,
}: {
  label: string
  amounts: CurrencyAmount[]
  semantic: MoneySemantic
  sublabel: string
  signed?: boolean
}) {
  return (
    <Card>
      <div className="text-[11px] font-medium tracking-wide text-[var(--text-secondary)] uppercase">{label}</div>
      <div className={`mt-1.5 flex min-h-[30px] flex-wrap items-baseline gap-x-3 gap-y-1 font-mono tabular-nums ${semanticColorClass(semantic)}`}>
        {amounts.map((amount) => {
          const negative = amount.value.trim().startsWith('-')
          const zero = /^[-+]?0(?:\.0*)?$/.test(amount.value.trim())
          const sign = signed && !zero ? (negative ? '-' : '+') : negative ? '-' : ''
          return (
            <span key={amount.code} title={amount.code} className="text-xl font-semibold">
              {sign}{amount.symbol}{formatAmount(amount.value)}
            </span>
          )
        })}
        {amounts.length === 0 && <span className="text-xl font-semibold">--</span>}
      </div>
      <div className="mt-1 text-[11px] text-[var(--text-secondary)]">{sublabel}</div>
    </Card>
  )
}
