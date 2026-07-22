export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex min-h-16 items-center justify-center gap-3 px-3 py-4 text-[12.5px]" style={{ color: 'var(--g-danger)' }}>
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="rounded-[5px] px-2 py-1" style={{ background: 'var(--g-surface-2)', color: 'var(--g-accent)' }}>
          重试
        </button>
      )}
    </div>
  )
}
