export type ChipKind = 'ok' | 'warn' | 'danger' | 'muted' | 'accent'

const KIND_COLOR: Record<ChipKind, string> = {
  ok: 'text-[var(--done)] ',
  warn: 'text-[var(--attention)] ',
  danger: 'text-[var(--danger)] ',
  muted: 'text-[var(--text-secondary)] ',
  accent: 'text-[var(--brand-text)] ',
}

/** 状态语义 chip：18px 高、4px 圆角，底色统一用 surface-2，颜色只上文字（规范 §2.1/§5） */
export function StatusChip({ label, kind = 'muted' }: { label: string; kind?: ChipKind }) {
  return (
    <span
      className={`inline-flex h-[18px] shrink-0 items-center rounded-md bg-[var(--surface-hover)] px-2 text-[11px] font-semibold  ${KIND_COLOR[kind]}`}
    >
      {label}
    </span>
  )
}
