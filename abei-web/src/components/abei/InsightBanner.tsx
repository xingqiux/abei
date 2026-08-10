import { Sparkle, X } from '@phosphor-icons/react'

/**
 * 页顶提醒条。品牌浅底 + 一句话，可关闭；关没关的记忆归调用方管
 * （今天页存 sessionStorage：同一条消息一个会话只打扰一次）。
 * 只放一句结论，分析过程和更多建议归右栏建议卡和助手页。
 */
export function InsightBanner({ message, onClose }: { message: string; onClose?: () => void }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-[var(--brand-soft)] py-2.5 pr-2 pl-3.5">
      <Sparkle aria-hidden weight="fill" className="size-4 shrink-0 text-[var(--brand-text)]" />
      <p className="min-w-0 flex-1 text-[13px] text-[var(--text-primary)]">{message}</p>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭提醒"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
        >
          <X aria-hidden className="size-4" />
        </button>
      )}
    </div>
  )
}
