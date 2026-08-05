import { useEffect, useRef, type ReactNode } from 'react'
import { useListKeyboard } from '../../hooks/useListKeyboard'

export interface Column<T> {
  key: string
  header: string
  width?: string // 固定宽度如 '128px'；flex-1 用 'minmax(0,1fr)'
  align?: 'start' | 'end'
  cell: (row: T) => ReactNode
  hideBelow?: 'sm' | 'md' | 'lg'
}

export interface DataTableProps<T> {
  rows: T[]
  columns: Column<T>[]
  rowKey: (row: T) => string
  /** 分组头，返回 null 表示这行不起新组 */
  groupBy?: (row: T, prev: T | null) => { key: string; label: ReactNode } | null
  selection?: {
    selected: Set<string>
    onChange: (next: Set<string>) => void
  }
  onActivate?: (row: T) => void
  onAction?: (key: 'c' | 'e' | 'x', row: T) => void
  emptyState?: ReactNode
  loading?: boolean
  skeletonRows?: number
}

/**
 * 通用数据表：flex 行 + role=grid 语义 + 粘性分组头 + 行选择 + 键盘层。
 * 行高走 var(--row-h)，密度开关只改 CSS 变量，表格不用知道。
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  groupBy,
  selection,
  onActivate,
  onAction,
  emptyState,
  loading = false,
  skeletonRows = 10,
}: DataTableProps<T>) {
  const { cursor, setCursor } = useListKeyboard<T>({
    rows,
    onActivate,
    onAction,
    enabled: rows.length > 0,
  })
  const rowEls = useRef(new Map<string, HTMLElement>())
  const rowKeyRef = useRef(rowKey)
  rowKeyRef.current = rowKey

  useEffect(() => {
    if (rows.length === 0) return
    const el = rowEls.current.get(rowKeyRef.current(rows[cursor]))
    if (el) {
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [cursor, rows])

  const GROUP_CLASS = 'sticky top-0 z-10 flex h-7 items-center justify-between rounded-md bg-[var(--surface-0)] px-2 text-[11.5px] text-[var(--text-secondary)] '
  const ROW_CLASS = 'flex items-center gap-2 px-2 transition-colors hover:bg-[var(--surface-hover)]  '

  if (loading) {
    return (
      <div role="grid" aria-busy="true" className="flex flex-col">
        {Array.from({ length: skeletonRows }).map((_, i) => (
          <div key={i} role="row" className="flex items-center gap-2 px-2" style={{ height: 'var(--row-h)' }}>
            <div className="h-4 flex-1 animate-pulse rounded bg-[var(--surface-hover)] " />
            <div className="h-4 w-24 animate-pulse rounded bg-[var(--surface-hover)] " />
          </div>
        ))}
      </div>
    )
  }

  if (rows.length === 0) return <>{emptyState}</>

  let prev: T | null = null

  return (
    <div role="grid" className="flex flex-col">
      {/* 视觉上不画表头（交易列表按日期分组，再加一行列名是噪音），但 role=grid
          没有 columnheader 对读屏是残缺的——它会念出单元格却说不出这是哪一列。
          所以这里放一行 sr-only 表头：position:absolute，不占布局，只进无障碍树。
          Column.header 就是给它用的。 */}
      <div role="row" className="sr-only">
        {selection && <span role="columnheader">选择</span>}
        {columns.map((col) => (
          <span key={col.key} role="columnheader">
            {col.header}
          </span>
        ))}
      </div>
      {rows.map((row, index) => {
        const key = rowKey(row)
        const group = groupBy?.(row, prev) ?? null
        const isCursor = cursor === index
        prev = row
        const selected = selection?.selected.has(key) ?? false
        return (
          <div key={key}>
            {group && (
              <div role="rowheader" className={GROUP_CLASS}>
                {group.label}
              </div>
            )}
            <div
              role="row"
              tabIndex={isCursor ? 0 : -1}
              ref={(el) => {
                if (el) rowEls.current.set(key, el)
                else rowEls.current.delete(key)
              }}
              onClick={onActivate ? () => onActivate(row) : undefined}
              onMouseEnter={() => setCursor(index)}
              className={`${ROW_CLASS} ${selected ? 'bg-[var(--surface-selected)] ' : ''} ${onActivate ? 'cursor-pointer' : ''}`}
              style={{ height: 'var(--row-h)' }}
            >
              {selection && (
                <span role="gridcell" className="flex w-10 shrink-0 items-center justify-center">
                  <input
                    type="checkbox"
                    className="size-6 cursor-pointer accent-[var(--brand)]"
                    checked={selected}
                    onChange={(e) => {
                      const next = new Set(selection.selected)
                      if (e.target.checked) next.add(key)
                      else next.delete(key)
                      selection.onChange(next)
                    }}
                    onClick={(e) => e.stopPropagation()}
                    aria-label="选择此行"
                  />
                </span>
              )}
              {columns.map((col) => {
                const hide = col.hideBelow === 'md' ? 'hidden md:flex' : col.hideBelow === 'sm' ? 'hidden sm:flex' : col.hideBelow === 'lg' ? 'hidden lg:flex' : 'flex'
                const grow = col.width === 'minmax(0,1fr)' ? 'min-w-0 flex-1' : 'shrink-0'
                return (
                  <span
                    key={col.key}
                    role="gridcell"
                    className={`items-center gap-2 ${hide} ${grow} ${col.align === 'end' ? 'justify-end text-right' : ''}`}
                    style={col.width && col.width !== 'minmax(0,1fr)' ? { width: col.width } : undefined}
                  >
                    {col.cell(row)}
                  </span>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
