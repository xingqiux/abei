import type { HTMLAttributes, ReactNode, Ref } from 'react'

/**
 * 卡片与区块标题。取自 tailwind-plus `layout/cards` + `headings/section-headings`。
 *
 * 「抬升」在两个主题下靠不同手段：浅色是投影、深色是发丝线（近黑区间里
 * 投影根本看不见）。两个属性都挂上，任一主题下永远只有一个是可见的——
 * 具体见 index.css 的 --shadow-card / --ring-card。
 */
export function Card({
  children,
  className = '',
  padded = true,
  raised = false,
  ref,
  ...rest
}: HTMLAttributes<HTMLElement> & {
  children: ReactNode
  className?: string
  /** 列表类内容自己控制内边距，传 false */
  padded?: boolean
  /** 首屏重点卡（KPI、hero 邻位）用更明显的投影；深色下两档投影都不可见，只有发丝线 */
  raised?: boolean
  ref?: Ref<HTMLElement>
}) {
  return (
    <section
      ref={ref}
      className={`rounded-xl bg-[var(--surface-1)] ${raised ? 'shadow-[var(--shadow-card-raised)]' : 'shadow-[var(--shadow-card)]'} ring-1 ring-[var(--ring-card)] ${padded ? 'p-4' : ''} ${className}`}
      {...rest}
    >
      {children}
    </section>
  )
}

/**
 * 区块标题。title 走 h2，description 是可选的一行说明，
 * action 放右侧操作（按钮或 tabs）。
 */
export function SectionHeading({
  title,
  description,
  action,
  className = '',
}: {
  title: string
  description?: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={`flex items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{description}</p>
        )}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  )
}

/**
 * 竖排列表。tailwind-plus `lists/stacked-lists` 的做法：用 divide-y 而不是给每行
 * 挂 border-b——省掉 last:border-b-0，也不会在圆角卡片底部露出一道多余的线。
 */
export function StackedList({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <ul role="list" className={`divide-y divide-[var(--border-subtle)] ${className}`}>
      {children}
    </ul>
  )
}

export function StackedListItem({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <li
      className={`flex items-center justify-between gap-x-4 px-4 py-2.5 transition-colors hover:bg-[var(--surface-hover)] ${className}`}
    >
      {children}
    </li>
  )
}
