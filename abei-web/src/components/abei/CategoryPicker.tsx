import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import gsap from 'gsap'
import { prefersReducedMotion } from '../../motion/reducedMotion'
import { CONTROL_BASE, CONTROL_INVALID, useFieldControl } from '../ui/Field'
import { CategoryIcon } from './CategoryIcon'
import { useCategories } from '../../api/queries'
import type { Category } from '../../api/schemas'

export type CategoryDomain = 'income' | 'expense' | 'transfer'

const DEFAULT_DOMAINS: CategoryDomain[] = ['income', 'expense']

const DOMAIN_LABEL: Record<CategoryDomain, string> = {
  income: '收入',
  expense: '支出',
  transfer: '资金往来',
}

/**
 * 交易类型 → 可挑的域。支出挑支出域，收入挑收入域，转账只能挑资金往来——
 * 这是把「转账、还款、余额校准混进消费分类」那个老毛病堵死在表单层。
 */
export const DOMAINS_BY_TX_TYPE: Record<'withdrawal' | 'deposit' | 'transfer', CategoryDomain[]> = {
  withdrawal: ['expense'],
  deposit: ['income'],
  transfer: ['transfer'],
}

/** 存名字数组，取前 8。键沿用 granary.* 前缀（历史存储键故意不跟着改名走）。 */
const RECENTS_KEY = 'granary.category-recents'
const RECENTS_MAX = 8

export function readCategoryRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string' && v !== '').slice(0, RECENTS_MAX)
  } catch {
    return []
  }
}

export function pushCategoryRecent(name: string) {
  try {
    const next = [name, ...readCategoryRecents().filter((n) => n !== name)].slice(0, RECENTS_MAX)
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式下 localStorage 会抛，最近用过没了不影响选分类
  }
}

interface Leaf {
  id: string
  name: string
  /** 组名；收入域与资金往来域的分类没有父级，这里是 null */
  group: string | null
  domain: CategoryDomain
  category: Category
}

/** 一项候选：清空项 + 分类项两种 */
type Entry = { kind: 'clear' } | { kind: 'leaf'; key: string; leaf: Leaf }

interface Section {
  key: string
  label: string
  entries: Entry[]
}

function domainOf(category: Category): CategoryDomain {
  const d = category.attributes.domain
  return d === 'income' || d === 'transfer' || d === 'expense' ? d : 'expense'
}

function parentIdOf(category: Category): string | null {
  const p = category.attributes.parent_id
  return p == null ? null : String(p)
}

export interface CategoryPickerProps {
  /** 分类名；null = 未分类 */
  value: string | null
  onChange: (name: string | null, category?: Category) => void
  /** 允许挑选的域，默认收入 + 支出（记账表单里的收支流水） */
  domains?: CategoryDomain[]
  placeholder?: string
  hasError?: string
  disabled?: boolean
  className?: string
  style?: CSSProperties
  'aria-label'?: string
  id?: string
}

/**
 * 分类选择器（设计稿 01 §6）。搜索式两级：输入即过滤叶子，按域分节，最近用过的置顶。
 * 每项 = 图标 + 「组 / 叶子」全路径。允许清空回到未分类。
 *
 * 浮层与键盘交互沿用 Combobox 的那套（↑↓ 移动、Enter 选中、Esc 关闭、点外面关），
 * 区别是这里不收自由文本：值只能来自词表，避免用户逐单发明分类。
 */
export function CategoryPicker({
  value,
  onChange,
  domains = DEFAULT_DOMAINS,
  placeholder = '选分类…',
  hasError,
  disabled = false,
  className = '',
  style,
  'aria-label': ariaLabel,
  id: idProp,
}: CategoryPickerProps) {
  const autoId = useId()
  const field = useFieldControl()
  const inputId = idProp ?? field.id ?? autoId
  const listboxId = `${inputId}-listbox`
  const invalid = hasError != null || field.invalid

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [recents, setRecents] = useState<string[]>(() => readCategoryRecents())

  const categoriesQuery = useCategories()
  const all = useMemo(() => categoriesQuery.data?.data ?? [], [categoriesQuery.data])

  // 叶子 = 没有任何分类以它为父。收入域/资金往来域本身就是叶子。
  const leaves = useMemo<Leaf[]>(() => {
    const byId = new Map(all.map((c) => [c.id, c]))
    const parents = new Set<string>()
    for (const c of all) {
      const p = parentIdOf(c)
      if (p) parents.add(p)
    }
    return all
      .filter((c) => !parents.has(c.id))
      .map((c) => {
        const p = parentIdOf(c)
        return {
          id: c.id,
          name: c.attributes.name,
          group: p ? (byId.get(p)?.attributes.name ?? null) : null,
          domain: domainOf(c),
          category: c,
        }
      })
      .filter((leaf) => domains.includes(leaf.domain))
  }, [all, domains])

  const selectedLeaf = useMemo(
    () => (value ? (leaves.find((leaf) => leaf.name === value) ?? null) : null),
    [leaves, value],
  )

  const sections = useMemo<Section[]>(() => {
    const q = query.trim().toLowerCase()
    const matches = (leaf: Leaf) =>
      q === ''
      || leaf.name.toLowerCase().includes(q)
      || (leaf.group?.toLowerCase().includes(q) ?? false)
      || `${leaf.group ?? ''}/${leaf.name}`.toLowerCase().includes(q)

    const hit = leaves.filter(matches)
    const out: Section[] = []

    // 最近用过只在没输入时置顶——输入之后人已经知道自己要找什么了
    if (q === '') {
      const recentLeaves = recents
        .map((name) => hit.find((leaf) => leaf.name === name))
        .filter((leaf): leaf is Leaf => leaf != null)
        .slice(0, RECENTS_MAX)
      if (recentLeaves.length > 0) {
        out.push({
          key: 'recent',
          label: '最近用过',
          entries: recentLeaves.map((leaf) => ({ kind: 'leaf' as const, key: `recent-${leaf.id}`, leaf })),
        })
      }
    }

    for (const domain of domains) {
      const entries = hit
        .filter((leaf) => leaf.domain === domain)
        .map((leaf) => ({ kind: 'leaf' as const, key: `${domain}-${leaf.id}`, leaf }))
      if (entries.length > 0) out.push({ key: domain, label: DOMAIN_LABEL[domain], entries })
    }
    return out
  }, [leaves, query, recents, domains])

  // 扁平表：高亮索引在它上面走，渲染时按段落切回去
  const flat = useMemo<Entry[]>(() => {
    const clear: Entry[] = value ? [{ kind: 'clear' }] : []
    return [...clear, ...sections.flatMap((section) => section.entries)]
  }, [sections, value])

  useEffect(() => {
    if (!open) return
    setHighlight(0)
  }, [open, query])

  useLayoutEffect(() => {
    const el = listRef.current
    if (!open || !el || prefersReducedMotion()) return
    gsap.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 0.12, ease: 'power1.out' })
  }, [open])

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function commit(entry: Entry) {
    if (entry.kind === 'clear') {
      onChange(null)
    } else {
      pushCategoryRecent(entry.leaf.name)
      setRecents(readCategoryRecents())
      onChange(entry.leaf.name, entry.leaf.category)
    }
    setQuery('')
    setOpen(false)
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        setQuery('')
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) {
        setOpen(true)
        return
      }
      if (flat.length === 0) return
      setHighlight((h) => (h + 1) % flat.length)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open || flat.length === 0) return
      setHighlight((h) => (h - 1 + flat.length) % flat.length)
      return
    }
    if (e.key === 'Enter') {
      const entry = flat[highlight]
      if (open && entry) {
        e.preventDefault()
        // 收件箱行编辑那一格监听了 Enter 直接保存，选分类的回车不能冒上去
        e.stopPropagation()
        commit(entry)
      }
    }
  }

  const inputClass = `${CONTROL_BASE} w-full py-1.5 pr-2.5 text-[12.5px] ${
    selectedLeaf ? 'pl-7' : 'pl-2.5'
  } ${invalid ? CONTROL_INVALID : ''}`

  let index = -1

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {selectedLeaf && !open && (
        <span aria-hidden className="pointer-events-none absolute top-1/2 left-1 -translate-y-1/2">
          <CategoryIcon icon={selectedLeaf.category.attributes.icon} color={selectedLeaf.category.attributes.color} size={16} />
        </span>
      )}
      <input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={open && flat[highlight] ? `${listboxId}-opt-${highlight}` : undefined}
        aria-label={ariaLabel}
        aria-describedby={field.describedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        value={open ? query : (value ?? '')}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value)
          setOpen(true)
        }}
        onFocus={() => {
          setQuery('')
          setOpen(true)
        }}
        onBlur={() => {
          // 候选项按下时 preventDefault 了，不会走到这儿；这里只处理 Tab 出去的情况
          setOpen(false)
          setQuery('')
        }}
        onKeyDown={onKeyDown}
        className={inputClass}
        style={style}
      />

      {open && (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label="分类"
          className="absolute z-50 mt-1 max-h-72 w-full min-w-[220px] overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] py-1 shadow-sm"
        >
          {categoriesQuery.isLoading && (
            <li role="status" className="px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)]">
              加载分类…
            </li>
          )}

          {value && (() => {
            index += 1
            const i = index
            return (
              <Option
                id={`${listboxId}-opt-${i}`}
                active={i === highlight}
                onHover={() => setHighlight(i)}
                onPick={() => commit({ kind: 'clear' })}
              >
                <span className="text-[var(--text-secondary)]">清空（回到未分类）</span>
              </Option>
            )
          })()}

          {sections.map((section) => (
            <li key={section.key} role="group" aria-label={section.label}>
              <div aria-hidden className="px-2.5 pt-1.5 pb-0.5 text-[11px] font-medium tracking-wide text-[var(--text-tertiary)]">
                {section.label}
              </div>
              <ul role="presentation">
                {section.entries.map((entry) => {
                  index += 1
                  const i = index
                  if (entry.kind !== 'leaf') return null
                  const leaf = entry.leaf
                  return (
                    <Option
                      key={entry.key}
                      id={`${listboxId}-opt-${i}`}
                      active={i === highlight}
                      selected={leaf.name === value}
                      onHover={() => setHighlight(i)}
                      onPick={() => commit(entry)}
                    >
                      <CategoryIcon icon={leaf.category.attributes.icon} color={leaf.category.attributes.color} size={20} />
                      <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">{leaf.name}</span>
                      <span className="shrink-0 truncate text-[11.5px] text-[var(--text-secondary)]">
                        {leaf.group ? `${leaf.group} / ${leaf.name}` : DOMAIN_LABEL[leaf.domain]}
                      </span>
                    </Option>
                  )
                })}
              </ul>
            </li>
          ))}

          {!categoriesQuery.isLoading && flat.length === 0 && (
            <li className="px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)]">没有匹配的分类</li>
          )}
        </ul>
      )}
    </div>
  )
}

function Option({
  id,
  active,
  selected = false,
  onHover,
  onPick,
  children,
}: {
  id: string
  active: boolean
  selected?: boolean
  onHover: () => void
  onPick: () => void
  children: ReactNode
}) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      data-active={active ? 'true' : undefined}
      className={`flex min-h-11 cursor-pointer items-center gap-2 px-2.5 text-[12.5px] ${
        active ? 'bg-[var(--surface-hover)]' : ''
      } ${selected ? 'text-[var(--brand-text)]' : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        // 阻止 input blur 抢先关列表
        e.preventDefault()
      }}
      onClick={onPick}
    >
      {children}
    </li>
  )
}
