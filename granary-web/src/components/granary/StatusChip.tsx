export type ChipKind = 'ok' | 'warn' | 'danger' | 'muted' | 'accent'

const KIND_COLOR: Record<ChipKind, string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
  muted: 'text-gray-500 dark:text-gray-400',
  accent: 'text-indigo-600 dark:text-indigo-400',
}

/** 状态语义 chip：18px 高、4px 圆角，底色统一用 surface-2，颜色只上文字（规范 §2.1/§5） */
export function StatusChip({ label, kind = 'muted' }: { label: string; kind?: ChipKind }) {
  return (
    <span
      className={`inline-flex h-[18px] shrink-0 items-center rounded-md bg-gray-100 px-2 text-[11px] font-semibold dark:bg-gray-800 ${KIND_COLOR[kind]}`}
    >
      {label}
    </span>
  )
}
