export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex min-h-16 items-center justify-center gap-3 px-3 py-4 text-[13px] text-red-600 dark:text-red-400">
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="rounded-md bg-gray-100 px-2 py-1 text-indigo-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-indigo-400 dark:hover:bg-gray-700">
          重试
        </button>
      )}
    </div>
  )
}
