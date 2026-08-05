export function PlaceholderPage({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
      <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</div>
      <div
        className="rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-500 dark:bg-gray-800 dark:text-gray-400"
      >
        开发中
      </div>
      <div className="mt-2 max-w-[420px] text-[13px] text-gray-500 dark:text-gray-400">
        {description}
      </div>
    </div>
  )
}
