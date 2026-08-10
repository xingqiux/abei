import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { useListKeyboard } from '../../hooks/useListKeyboard'
import { Skeleton } from '../abei/Skeleton'

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
  /**
   * 画出列头。列少、按日分组时是噪音（默认关）；列多到要靠对齐读的时候
   * 必须有，否则「这一列是对手方还是账户」只能靠猜。
   */
  showHeader?: boolean
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
  showHeader = false,
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
  const gridRef = useRef<HTMLDivElement>(null)

  /**
   * 滚动容器（AppShell 的 main）自己带 padding-top，sticky 的 top:0 落在它的内容边缘，
   * 行会从上面那条 padding 里露出来压在列头上方。把这段量出来往回顶。
   * 收件箱页的顶部条也是这么处理的（--stick-pad）。
   */
  useLayoutEffect(() => {
    const grid = gridRef.current
    const scroller = grid?.closest('main')
    if (!grid || !scroller) return
    const write = () => {
      const pad = Number.parseFloat(getComputedStyle(scroller).paddingTop) || 0
      grid.style.setProperty('--stick-pad', `${pad}px`)
    }
    write()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(write)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (rows.length === 0) return
    const el = rowEls.current.get(rowKeyRef.current(rows[cursor]))
    if (el) {
      el.focus({ preventScroll: true })
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [cursor, rows])

  const GROUP_CLASS = 'sticky z-10 flex h-7 items-center justify-between rounded-md bg-[var(--surface-0)] px-2 text-[11.5px] text-[var(--text-secondary)] '
  // 列头也是粘的，分组头就得让开它那 28px，否则两条会叠在一起
  const GROUP_TOP = `calc(${showHeader ? '28px' : '0px'} - var(--stick-pad, 0px))`
  const ROW_CLASS = 'flex items-center gap-2 px-2 transition-colors hover:bg-[var(--surface-hover)]  '

  /**
   * 先切成组再渲染。原先每行各自套一个 div、分组头挂在首行那个 div 里，
   * 它的 sticky 只能在一行的高度内生效——等于没粘住。
   */
  const sections = useMemo(() => {
    const list: { key: string; label: ReactNode | null; rows: { row: T; index: number }[] }[] = []
    let prev: T | null = null
    rows.forEach((row, index) => {
      const group = groupBy?.(row, prev) ?? null
      prev = row
      if (group || list.length === 0) {
        list.push({ key: group?.key ?? '__all', label: group?.label ?? null, rows: [] })
      }
      list[list.length - 1].rows.push({ row, index })
    })
    return list
  }, [rows, groupBy])

  if (loading) {
    return (
      <div role="grid" aria-busy="true" className="flex flex-col">
        {Array.from({ length: skeletonRows }).map((_, i) => (
          <div key={i} role="row" className="flex h-[var(--row-h)] items-center gap-2 px-2">
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </div>
    )
  }

  if (rows.length === 0) return <>{emptyState}</>

  return (
    <div ref={gridRef} role="grid" className="flex flex-col">
      {/* 不画表头的时候仍然要给 role=grid 一行 columnheader：没有它读屏会念出单元格
          却说不出这是哪一列。sr-only 是 position:absolute，不占布局，只进无障碍树。
          showHeader 打开时那一行本身就是 columnheader，不必再来一份。 */}
      {showHeader ? (
        <div
          role="row"
          style={{ top: 'calc(var(--stick-pad, 0px) * -1)' }}
          className="sticky z-20 flex h-7 items-center gap-2 bg-[var(--surface-1)] px-2 text-[11px] text-[var(--text-secondary)] shadow-[0_1px_0_var(--border-subtle)]"
        >
          {/* 勾选列的表头只给读屏，画出来是一列谁都不看的「选择」二字 */}
          {selection && (
            <span role="columnheader" className="w-10 shrink-0">
              <span className="sr-only">选择</span>
            </span>
          )}
          {columns.map((col) => {
            const hide = col.hideBelow === 'md' ? 'hidden md:flex' : col.hideBelow === 'sm' ? 'hidden sm:flex' : col.hideBelow === 'lg' ? 'hidden lg:flex' : 'flex'
            const grow = col.width === 'minmax(0,1fr)' ? 'min-w-0 flex-1' : 'shrink-0'
            return (
              <span
                key={col.key}
                role="columnheader"
                className={`items-center ${hide} ${grow} ${col.align === 'end' ? 'justify-end text-right' : ''}`}
                style={col.width && col.width !== 'minmax(0,1fr)' ? { width: col.width } : undefined}
              >
                {col.header}
              </span>
            )
          })}
        </div>
      ) : (
        <div role="row" className="sr-only">
          {selection && <span role="columnheader">选择</span>}
          {columns.map((col) => (
            <span key={col.key} role="columnheader">
              {col.header}
            </span>
          ))}
        </div>
      )}
      {sections.map((section) => (
        <div key={section.key} className="flex flex-col">
          {section.label != null && (
            <div role="rowheader" className={GROUP_CLASS} style={{ top: GROUP_TOP }}>
              {section.label}
            </div>
          )}
          {section.rows.map(({ row, index }) => {
            const key = rowKey(row)
            const isCursor = cursor === index
            const selected = selection?.selected.has(key) ?? false
            return (
              <div
                key={key}
                role="row"
                tabIndex={isCursor ? 0 : -1}
                ref={(el) => {
                  if (el) rowEls.current.set(key, el)
                  else rowEls.current.delete(key)
                }}
                onClick={onActivate ? () => onActivate(row) : undefined}
                onMouseEnter={() => setCursor(index)}
                className={`${ROW_CLASS} h-[var(--row-h)] ${selected ? 'bg-[var(--surface-selected)]' : ''} ${onActivate ? 'cursor-pointer' : ''}`}
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
            )
          })}
        </div>
      ))}
    </div>
  )
}
