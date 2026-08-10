import {
  formatAmount,
  formatSignedAmount,
  semanticColorClass,
  type MoneySemantic,
} from '../../lib/format'
import type { CurrencyAmount } from '../../lib/summary'
import { Card } from '../ui/Card'

/**
 * 一个数字该带什么符号，由语义决定，不由数值决定：支出永远 `-`、收入永远 `+`。
 * 「净流 / 净资产 / 净额」这类卡传的是 neutral——方向本来就是数据说了算，
 * 所以先按正负落到收/支语义上，再交给 `formatSignedAmount` 出符号，
 * 这样全站只有 `formatSignedAmount` 一处在决定正负号长什么样。
 */
function signSemanticOf(semantic: MoneySemantic, negative: boolean, zero: boolean): MoneySemantic {
  if (zero) return 'neutral'
  if (semantic === 'income' || semantic === 'expense') return semantic
  return negative ? 'expense' : 'income'
}

/**
 * 环比 chip 的三种脸色。tone 说的是「对钱包好不好」，不是数字升降：
 * 支出降是 good、收入降是 bad——升降到颜色的翻译由调用方（lib/trend.ts）做，
 * 这里只管穿衣服。绿 = --done、琥珀 = --attention，都是既有语义 token，
 * 不新造颜色，也不碰「收入红」。
 */
export interface KpiTrend {
  label: string
  tone: 'good' | 'bad' | 'neutral'
}

const TREND_TONE_CLASS: Record<KpiTrend['tone'], string> = {
  good: 'bg-[var(--done-soft)] text-[var(--done)]',
  bad: 'bg-[var(--attention-soft)] text-[var(--attention)]',
  neutral: 'bg-[var(--surface-hover)] text-[var(--text-secondary)]',
}

/**
 * 概览数字卡。多币种时并排列出，没有数据显示 `--`。
 *
 * 颜色走 `semanticColorClass`，不再由调用方传 CSS 变量名：原先几处各传各的，
 * 支出被涂成 `--danger`——那个 token 写明了只给删除类操作，跟「这个月花了多少」
 * 不是一回事，而且和「收入红」撞成两种红。
 *
 * `sublabel` 是可选的：三张卡并排、口径又完全一样时，重复三遍的副标题应该提到
 * 区域标题右侧写一次（今天页的「本期概览」就是这么做的）。
 * `muted` 给「一整期都是 0」的情况——数字还在，但不该抢注意力。
 */
export function KpiCard({
  label,
  amounts,
  semantic,
  sublabel,
  muted = false,
  signed = false,
  trend,
}: {
  label: string
  amounts: CurrencyAmount[]
  semantic: MoneySemantic
  sublabel?: string
  /** 数值全为 0 时弱化成次要色 */
  muted?: boolean
  signed?: boolean
  /** 环比 chip，没有上期数据就别传 */
  trend?: KpiTrend
}) {
  return (
    <Card raised>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium tracking-wide text-[var(--text-secondary)] uppercase">{label}</div>
        {trend && (
          <span className={`num inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TREND_TONE_CLASS[trend.tone]}`}>
            {trend.label}
          </span>
        )}
      </div>
      <div
        className={`num mt-2 flex min-h-[34px] flex-wrap items-baseline gap-x-3 gap-y-1 ${
          muted ? 'text-[var(--text-secondary)]' : semanticColorClass(semantic)
        }`}
      >
        {amounts.map((amount) => {
          const raw = amount.value.trim()
          const negative = raw.startsWith('-')
          const zero = /^[-+]?0(?:\.0*)?$/.test(raw)
          return (
            <span key={amount.code} title={amount.code} className="text-[26px] leading-none font-semibold tracking-tight">
              {signed
                ? formatSignedAmount(amount.value, signSemanticOf(semantic, negative, zero), amount.symbol)
                : `${negative ? '-' : ''}${amount.symbol}${formatAmount(amount.value)}`}
            </span>
          )
        })}
        {amounts.length === 0 && <span className="text-[26px] leading-none font-semibold">--</span>}
      </div>
      {sublabel && <div className="mt-1.5 text-[11px] text-[var(--text-secondary)]">{sublabel}</div>}
    </Card>
  )
}
