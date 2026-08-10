export function CategoryChip({ label }: { label: string }) {
  return (
    <span
      className="inline-flex h-[18px] items-center rounded-md bg-[var(--surface-hover)] px-2 text-[11px] text-[var(--text-secondary)]  "
    >
      {label}
    </span>
  )
}
