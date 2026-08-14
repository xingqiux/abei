export type ProgressTone = 'brand' | 'attention' | 'danger'

const TONE: Record<ProgressTone, string> = {
  brand: 'bg-[var(--brand)]',
  attention: 'bg-[var(--attention-mark)]',
  danger: 'bg-[var(--danger)]',
}

/**
 * 通用进度条：track/fill 样式与 CategoryBarChart 保持一致（h-2、圆角、surface-hover 底）。
 * 预算与订阅页用它画「已花费/限额」「当前/目标」两类进度；宽度变化时走 CSS transition。
 *
 * 标了 role=progressbar：颜色变红是给看得见的人用的，读屏得靠 aria-valuenow 才知道
 * 「已经用掉 118%」。宽度必须留在内联样式里——百分比是运行时算的，没法预生成类。
 */
export function ProgressBar({
  pct,
  tone = 'brand',
  label,
}: {
  pct: number
  tone?: ProgressTone
  /** 读屏播报用，例如「本月预算已用」 */
  label?: string
}) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${Math.round(pct)}%`}
      className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-hover)]"
    >
      <div
        className={`h-full rounded-full transition-[width] duration-240 motion-reduce:transition-none ${TONE[tone]}`}
        style={{ width: `${clamped}%` }}
      />
    </div>
  )
}
