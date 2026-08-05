export function CategoryChip({ label }: { label: string }) {
  return (
    <span
      className="inline-flex h-[18px] items-center rounded-md bg-gray-100 px-2 text-[11px] text-gray-500 dark:bg-gray-800 dark:text-gray-400"
    >
      {label}
    </span>
  )
}
