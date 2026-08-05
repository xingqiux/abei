export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
      <div className="text-lg font-semibold text-[var(--text-primary)] ">{title}</div>
      <div
        className="rounded bg-[var(--surface-hover)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]  "
      >
        开发中
      </div>
      <div className="mt-2 max-w-[420px] text-[13px] text-[var(--text-secondary)] ">
        {description}
      </div>
    </div>
  )
}
