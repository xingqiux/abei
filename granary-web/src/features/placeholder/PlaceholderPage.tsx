export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
      <div style={{ fontSize: 18, fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>{title}</div>
      <div
        className="rounded-[4px] px-2 py-0.5 text-[11px]"
        style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink-2)' }}
      >
        开发中
      </div>
      <div className="mt-2 max-w-[420px] text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>
        {description}
      </div>
    </div>
  )
}
