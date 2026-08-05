/**
 * 通用进度条：track/fill 样式与 CategoryBarChart 保持一致（h-2、3px 圆角、surface-2 底）。
 * 预算与订阅页用它画「已花费/限额」「当前/目标」两类进度；宽度变化时走 CSS transition，
 * 无需 GSAP（规范 §6 图表生长动效只用于真正的图表条形，这里是简单状态条）。
 */
export function ProgressBar({ pct, colorVar = 'var(--brand)' }: { pct: number; colorVar?: string }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-hover)] ">
      <div
        className="h-full rounded-full transition-[width] duration-240"
        style={{ width: `${clamped}%`, background: colorVar }}
      />
    </div>
  )
}
