export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex min-h-16 items-center justify-center gap-3 px-3 py-4 text-[13px] text-[var(--danger)] ">
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="rounded-md bg-[var(--surface-hover)] px-2 py-1 text-[var(--brand)] hover:bg-[var(--surface-selected)]   ">
          重试
        </button>
      )}
    </div>
  )
}
