export type ChipKind = 'ok' | 'warn' | 'danger' | 'muted' | 'accent'

const KIND_COLOR: Record<ChipKind, string> = {
  ok: 'var(--g-income)',
  warn: 'var(--g-warn)',
  danger: 'var(--g-danger)',
  muted: 'var(--g-ink-2)',
  accent: 'var(--g-accent)',
}

/** 状态语义 chip：18px 高、4px 圆角，底色统一用 surface-2，颜色只上文字（规范 §2.1/§5） */
export function StatusChip({ label, kind = 'muted' }: { label: string; kind?: ChipKind }) {
  return (
    <span
      className="inline-flex h-[18px] shrink-0 items-center rounded-[4px] px-1.5 text-[11px]"
      style={{ background: 'var(--g-surface-2)', color: KIND_COLOR[kind], fontWeight: 'var(--g-weight-demibold)' }}
    >
      {label}
    </span>
  )
}
