import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import gsap from 'gsap'
import { BanknotesIcon, MagnifyingGlassIcon, PlusIcon } from '@heroicons/react/24/outline'
import { useCommandPaletteStore } from '../../store/commandPaletteStore'
import { useRecordTxStore } from '../../store/recordTxStore'
import { useSearchAccounts, useSearchTransactionCount, useSearchTransactions } from '../../api/queries'
import { ALL_ROUTES } from '../../routes/navItems'
import { txSearch } from '../../routes/transactionSearch'
import { fuzzyMatch } from '../../lib/fuzzyMatch'
import { formatDateTime, formatSignedAmount, semanticOf } from '../../lib/format'
import { LottieIcon } from '../../components/abaku/LottieIcon'
import { prefersReducedMotion } from '../../motion/reducedMotion'
import { useDialogBehavior } from '../../components/abaku/useDialogBehavior'
import { toTransactionGroupView } from '../../lib/transactionGroup'

const RECORD_KEYWORDS = ['记一笔', '记账', '新增交易', 'record', 'add', '+']

interface ActionItem {
  key: 'action'
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  run: () => void
}

interface NavPaletteItem {
  key: 'nav'
  id: string
  label: string
  icon: ComponentType<{ className?: string }>
  run: () => void
}

interface SearchPaletteItem {
  key: 'search'
  id: string
  description: string
  date: string
  amountLabel: string
  run: () => void
}

interface AccountSearchPaletteItem {
  key: 'account-search'
  id: string
  name: string
  accountType: string
  run: () => void
}

type PaletteItem = ActionItem | NavPaletteItem | SearchPaletteItem | AccountSearchPaletteItem

/**
 * 全局命令面板（Cmd+K）：搜索交易 / 跳页 / 快捷记账三合一。
 * 触发：Cmd+K、Ctrl+K（随时可切换）、`/`（仅在未聚焦输入控件且面板未打开时）、顶栏搜索框点击。
 */
export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open)
  const openPalette = useCommandPaletteStore((s) => s.openPalette)
  const closePalette = useCommandPaletteStore((s) => s.close)
  const toggle = useCommandPaletteStore((s) => s.toggle)
  const openRecordForm = useRecordTxStore((s) => s.openForm)
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)

  const cardRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  useDialogBehavior(open, cardRef, closePalette)

  function close() {
    closePalette()
  }

  // 全局触发键：Cmd+K/Ctrl+K 随时可切换开关；`/` 只在未聚焦输入控件且面板尚未打开时打开。
  useEffect(() => {
    function onKeyDown(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        toggle()
        return
      }
      if (e.key === '/' && !open) {
        const target = e.target as HTMLElement | null
        if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
        if (target?.isContentEditable) return
        e.preventDefault()
        openPalette()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, openPalette, toggle])

  // 每次打开都重置查询态并自动聚焦输入框
  useEffect(() => {
    if (!open) return
    setQuery('')
    setDebouncedQuery('')
    setActiveIndex(0)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  // 搜索交易 300ms 防抖
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQuery(query), 300)
    return () => window.clearTimeout(t)
  }, [query])

  const trimmedDebounced = debouncedQuery.trim()
  const searchEnabled = open && trimmedDebounced.length >= 2
  const searchQuery = useSearchTransactions(trimmedDebounced, { enabled: searchEnabled })
  const searchCountQuery = useSearchTransactionCount(trimmedDebounced, { enabled: searchEnabled })
  const accountSearchQuery = useSearchAccounts(trimmedDebounced, { enabled: searchEnabled })
  const isSearchLoading = searchEnabled && (searchQuery.isFetching || searchCountQuery.isFetching || accountSearchQuery.isFetching)
  const hasSearchError = searchQuery.isError || searchCountQuery.isError || accountSearchQuery.isError

  // 入场动效：240ms 入场，尊重 reduced-motion
  useLayoutEffect(() => {
    if (!open) return
    const el = cardRef.current
    if (!el || prefersReducedMotion()) return
    gsap.fromTo(
      el,
      { opacity: 0, y: -8, scale: 0.98 },
      { opacity: 1, y: 0, scale: 1, duration: 0.24, ease: 'power3.out' },
    )
  }, [open])

  const actionItems = useMemo<ActionItem[]>(() => {
    const matches = !query.trim() || RECORD_KEYWORDS.some((k) => fuzzyMatch(query, k))
    if (!matches) return []
    return [
      {
        key: 'action',
        id: 'action-record',
        label: '记一笔',
        icon: PlusIcon,
        run: () => {
          close()
          openRecordForm()
        },
      },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, openRecordForm])

  const navPaletteItems = useMemo<NavPaletteItem[]>(() => {
    return ALL_ROUTES.filter((item) => fuzzyMatch(query, item.label)).map((item) => ({
      key: 'nav' as const,
      id: `nav-${item.to}`,
      label: item.label,
      icon: item.icon,
      run: () => {
        close()
        navigate({ to: item.to })
      },
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, navigate])

  const searchItems = useMemo<SearchPaletteItem[]>(() => {
    if (!searchEnabled) return []
    const groups = searchQuery.data?.data ?? []
    const items: SearchPaletteItem[] = []
    for (const group of groups) {
      const view = toTransactionGroupView(group)
      const first = view?.splits[0]
      if (!view || !first) continue
      items.push({
        key: 'search',
        id: `search-${group.id}`,
        description: `${first.description}${view.splits.length > 1 ? ` · ${view.splits.length} 条拆分` : ''}`,
        date: first.date,
        amountLabel: view.totals.map((total) => formatSignedAmount(total.amount, semanticOf(first.type), total.currencySymbol || total.currencyCode || '')).join(' / '),
        run: () => {
          close()
          navigate({ to: '/transactions', search: txSearch({ transaction: Number(group.id) }) })
        },
      })
    }
    return items
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchEnabled, searchQuery.data, navigate])

  const accountSearchItems = useMemo<AccountSearchPaletteItem[]>(() => {
    if (!searchEnabled) return []
    return (accountSearchQuery.data?.data ?? []).slice(0, 10).map((account) => ({
      key: 'account-search',
      id: `account-search-${account.id}`,
      name: account.attributes.name,
      accountType: account.attributes.type,
      run: () => {
        close()
        navigate({ to: '/accounts/$accountId', params: { accountId: account.id } })
      },
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchEnabled, accountSearchQuery.data, navigate])

  const flatItems = useMemo<PaletteItem[]>(
    () => [...actionItems, ...navPaletteItems, ...searchItems, ...accountSearchItems],
    [actionItems, navPaletteItems, searchItems, accountSearchItems],
  )
  const indexById = useMemo(() => {
    const m = new Map<string, number>()
    flatItems.forEach((item, i) => m.set(item.id, i))
    return m
  }, [flatItems])

  // 列表随查询变化时把高亮索引夹回有效范围
  useEffect(() => {
    setActiveIndex((prev) => (flatItems.length === 0 ? 0 : Math.min(prev, flatItems.length - 1)))
  }, [flatItems.length])

  useEffect(() => {
    if (!open) return
    const el = listRef.current?.querySelector(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open])

  function handleInputKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((prev) => (flatItems.length === 0 ? 0 : (prev + 1) % flatItems.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((prev) => (flatItems.length === 0 ? 0 : (prev - 1 + flatItems.length) % flatItems.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flatItems[activeIndex]?.run()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      close()
    }
  }

  if (!open) return null

  const showSearchSection = searchEnabled && (isSearchLoading || searchItems.length > 0)
  const showNoResults = query.trim() !== '' && flatItems.length === 0 && !isSearchLoading && !hasSearchError
  const accountTotal = accountSearchQuery.data?.meta?.pagination?.total ?? accountSearchItems.length

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex justify-center p-4"
      style={{ background: 'rgb(0 0 0 / 0.5)', paddingTop: '25vh' }}
      onClick={close}
      role="presentation"
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="flex h-fit max-h-[60vh] w-full max-w-[560px] flex-col rounded-xl bg-[var(--surface-1)] shadow-2xl ring-1 ring-[var(--border-subtle)]  "
      >
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-4 py-3 ">
          <MagnifyingGlassIcon aria-hidden className="size-4 text-[var(--text-tertiary)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="搜索交易、跳转页面、记一笔…"
            aria-label="命令面板搜索"
            className="w-full bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] "
          />
          <kbd className="shrink-0 rounded border border-[var(--border-strong)] px-1.5 py-0.5 font-sans text-[10px] text-[var(--text-tertiary)] ">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {actionItems.length > 0 && (
            <PaletteSection label="动作">
              {actionItems.map((item) => (
                <PaletteRow
                  key={item.id}
                  icon={item.icon}
                  label={item.label}
                  index={indexById.get(item.id) ?? 0}
                  active={indexById.get(item.id) === activeIndex}
                  onSelect={item.run}
                  onHover={() => setActiveIndex(indexById.get(item.id) ?? 0)}
                />
              ))}
            </PaletteSection>
          )}

          {navPaletteItems.length > 0 && (
            <PaletteSection label="跳转">
              {navPaletteItems.map((item) => (
                <PaletteRow
                  key={item.id}
                  icon={item.icon}
                  label={item.label}
                  index={indexById.get(item.id) ?? 0}
                  active={indexById.get(item.id) === activeIndex}
                  onSelect={item.run}
                  onHover={() => setActiveIndex(indexById.get(item.id) ?? 0)}
                />
              ))}
            </PaletteSection>
          )}

          {(showSearchSection || searchQuery.isError || searchCountQuery.isError) && (
            <PaletteSection label={`搜索交易组${searchCountQuery.data ? ` · ${searchCountQuery.data.count}` : ''}`} loading={searchQuery.isFetching || searchCountQuery.isFetching}>
              {(searchQuery.isError || searchCountQuery.isError) && <SearchError label="交易搜索失败" onRetry={() => { void searchQuery.refetch(); void searchCountQuery.refetch() }} />}
              {searchItems.map((item) => {
                const idx = indexById.get(item.id) ?? 0
                const active = idx === activeIndex
                return (
                  <div
                    key={item.id}
                    data-index={idx}
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setActiveIndex(idx)}
                    onClick={item.run}
                    className={`mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 ${active ? 'bg-[var(--surface-hover)] ' : ''}`}
                  >
                    <MagnifyingGlassIcon aria-hidden className="size-4 shrink-0 text-[var(--text-tertiary)]" />
                    <div className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)] ">
                      {item.description}
                    </div>
                    <div className="shrink-0 font-mono text-[11px] text-[var(--text-tertiary)]">
                      {formatDateTime(item.date)}
                    </div>
                    <span className="shrink-0 font-mono text-[13px] text-[var(--text-primary)] ">{item.amountLabel}</span>
                  </div>
                )
              })}
            </PaletteSection>
          )}

          {searchEnabled && (accountSearchQuery.isFetching || accountSearchItems.length > 0 || accountSearchQuery.isError) && (
            <PaletteSection label={`搜索账户${accountSearchQuery.data ? ` · ${accountTotal}` : ''}`} loading={accountSearchQuery.isFetching}>
              {accountSearchQuery.isError && <SearchError label="账户搜索失败" onRetry={() => void accountSearchQuery.refetch()} />}
              {accountSearchItems.map((item) => {
                const idx = indexById.get(item.id) ?? 0
                const active = idx === activeIndex
                return (
                  <div key={item.id} data-index={idx} role="option" aria-selected={active} onMouseEnter={() => setActiveIndex(idx)} onClick={item.run} className={`mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 ${active ? 'bg-[var(--surface-hover)] ' : ''}`}>
                    <BanknotesIcon aria-hidden className="size-4 text-[var(--text-tertiary)]" />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--text-primary)] ">{item.name}</span>
                    <span className="text-[11px] text-[var(--text-tertiary)]">{item.accountType}</span>
                  </div>
                )
              })}
            </PaletteSection>
          )}

          {showNoResults && (
            <div className="px-4 py-6 text-center text-[13px] text-[var(--text-tertiary)]">
              没有匹配结果
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

function PaletteSection({ label, loading, children }: { label: string; loading?: boolean; children: ReactNode }) {
  return (
    <div className="py-1">
      <div className="flex items-center gap-1.5 px-4 py-1 text-[10.5px] font-medium uppercase tracking-wider text-[var(--text-tertiary)]">
        {label}
        {loading && <LottieIcon kind="loading" size={12} />}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

function SearchError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return <div className="mx-3 flex items-center justify-between rounded px-2 py-1.5 text-[11.5px] text-[var(--danger)] "><span>{label}</span><button type="button" onClick={onRetry} className="text-[var(--brand)] ">重试</button></div>
}

function PaletteRow({
  icon: Icon,
  label,
  index,
  active,
  onSelect,
  onHover,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  index: number
  active: boolean
  onSelect: () => void
  onHover: () => void
}) {
  return (
    <div
      data-index={index}
      role="option"
      aria-selected={active}
      onMouseEnter={onHover}
      onClick={onSelect}
      className={`mx-1.5 flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 ${active ? 'bg-[var(--surface-hover)] ' : ''}`}
    >
      <Icon aria-hidden className={`size-4 ${active ? 'text-[var(--text-primary)] ' : 'text-[var(--text-tertiary)]'}`} />
      <span className="text-[13px] text-[var(--text-primary)] ">
        {label}
      </span>
    </div>
  )
}
