export function CategoryChip({ label }: { label: string }) {
  return (
    <span
      className="inline-flex h-[18px] items-center rounded-[4px] px-1.5 text-[11px]"
      style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink-2)' }}
    >
      {label}
    </span>
  )
}
