import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import gsap from 'gsap'
import { prefersReducedMotion } from '../../motion/reducedMotion'

export interface ComboboxItem {
  id: string
  label: string
}

const defaultExtractQuery = (v: string) => v.trim()
const defaultApplySelection = (item: ComboboxItem, _currentValue: string) => item.label

export interface ComboboxProps {
  value: string
  onChange: (value: string) => void
  /**
   * 防抖后的查询串回调（默认 200ms）。父级据此触发 useQuery，
   * enabled 由 query 长度 ≥1 控制（参考 useSearchTransactions）。
   */
  onDebouncedQuery: (query: string) => void
  items: ComboboxItem[]
  isLoading?: boolean
  placeholder?: string
  hasError?: string
  /** 从完整 value 提取 API 查询子串；默认整值。标签字段取最后一个逗号后 token。 */
  extractQuery?: (value: string) => string
  /** 选中候选项写回 value；默认整值替换为 label。 */
  applySelection?: (item: ComboboxItem, currentValue: string) => string
  debounceMs?: number
  className?: string
  style?: CSSProperties
  'aria-label'?: string
  id?: string
}

/**
 * 自由文本 + 候选建议 Combobox（规范 §4.3 输入补全）。
 * - 候选只是建议，不强制选中，可直接自由输入提交
 * - 键盘：↑↓ 移动、Enter 选中、Esc 关闭
 * - 高亮项浅灰底；下拉 120ms 淡入（reduced-motion 直显）
 * 皮肤自绘，不依赖组件库皮肤。
 */
export function Combobox({
  value,
  onChange,
  onDebouncedQuery,
  items,
  isLoading = false,
  placeholder,
  hasError,
  extractQuery = defaultExtractQuery,
  applySelection = defaultApplySelection,
  debounceMs = 200,
  className = '',
  style,
  'aria-label': ariaLabel,
  id: idProp,
}: ComboboxProps) {
  const autoId = useId()
  const listboxId = `${idProp ?? autoId}-listbox`
  const inputId = idProp ?? autoId

  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  /** 仅在用户按过 ↑↓ 后，Enter 才选中候选，避免覆盖自由文本 */
  const [kbdNav, setKbdNav] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const ignoreBlurRef = useRef(false)

  // 防抖：value 变化 → extractQuery → onDebouncedQuery
  useEffect(() => {
    const q = extractQuery(value)
    const t = window.setTimeout(() => onDebouncedQuery(q), debounceMs)
    return () => window.clearTimeout(t)
  }, [value, extractQuery, onDebouncedQuery, debounceMs])

  // 有候选且输入框聚焦时展示列表
  const showList = open && (items.length > 0 || isLoading)

  useEffect(() => {
    if (!showList) return
    setHighlight(0)
    setKbdNav(false)
  }, [items, showList])

  // 下拉 120ms 淡入（规范 §6 时长档）
  useLayoutEffect(() => {
    const el = listRef.current
    if (!showList || !el || prefersReducedMotion()) return
    gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.12, ease: 'power1.out' })
  }, [showList])

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function selectItem(item: ComboboxItem) {
    onChange(applySelection(item, value))
    setOpen(false)
    setKbdNav(false)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        setKbdNav(false)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        // 打开后首次 ↓ 落在第 0 项；items 尚未就绪时等列表出现再导航
        if (items.length > 0) {
          setKbdNav(true)
          setHighlight(0)
        }
        return
      }
      if (items.length === 0) return
      // 首次键盘导航：highlight 默认 0，若直接 +1 会跳到第 2 项
      if (!kbdNav) {
        setKbdNav(true)
        setHighlight(0)
        return
      }
      setHighlight((h) => (h + 1) % items.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open || items.length === 0) return
      if (!kbdNav) {
        setKbdNav(true)
        setHighlight(items.length - 1)
        return
      }
      setHighlight((h) => (h - 1 + items.length) % items.length)
      return
    }
    if (e.key === 'Enter') {
      // 未键盘导航时保留自由文本（不 preventDefault，便于表单默认提交行为若有）
      if (open && kbdNav && items[highlight]) {
        e.preventDefault()
        selectItem(items[highlight])
      }
    }
  }

  const inputClass = [
    'w-full rounded-md border px-2.5 py-1.5 text-[12.5px] outline-none',
    'bg-[var(--surface-hover)] text-[var(--text-primary)]  ',
    hasError ? 'border-[var(--danger)] ' : 'border-[var(--border-subtle)] ',
  ].join(' ')

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <input
        id={inputId}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          showList && kbdNav && items[highlight] ? `${listboxId}-opt-${highlight}` : undefined
        }
        aria-label={ariaLabel}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // 列表 mousedown 会先触发 blur；延后关闭以允许点击选中
          if (ignoreBlurRef.current) return
          window.setTimeout(() => setOpen(false), 120)
        }}
        onKeyDown={onKeyDown}
        className={inputClass}
        style={style}
      />

      {showList && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] py-0.5 shadow-sm  "
        >
          {isLoading && items.length === 0 && (
            <li
              className="px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)] "
              role="presentation"
            >
              搜索中…
            </li>
          )}
          {items.map((item, i) => {
            const active = kbdNav && i === highlight
            return (
              <li
                key={item.id}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={active}
                className={`cursor-pointer px-2.5 py-1.5 text-[12.5px] text-[var(--text-primary)]  ${
                  active ? 'bg-[var(--surface-hover)] ' : ''
                }`}
                onMouseEnter={() => {
                  setKbdNav(true)
                  setHighlight(i)
                }}
                onMouseDown={(e) => {
                  // 阻止 input blur 抢先关列表
                  e.preventDefault()
                  ignoreBlurRef.current = true
                }}
                onClick={() => {
                  selectItem(item)
                  ignoreBlurRef.current = false
                }}
              >
                {item.label}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
