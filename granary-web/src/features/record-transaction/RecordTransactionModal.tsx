import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import gsap from 'gsap'
import { Modal } from '../../components/granary/Modal'
import { Combobox, type ComboboxItem } from '../../components/granary/Combobox'
import {
  useAssetAccounts,
  useAutocompleteAccounts,
  useAutocompleteCategories,
  useAutocompleteTags,
  useAutocompleteTransactions,
  useCreateTransaction,
  useUpdateTransaction,
} from '../../api/queries'
import { FireflyApiError } from '../../api/client'
import type { CreateTransactionType } from '../../api/firefly'
import { showToast } from '../../store/toastStore'
import { useRecordTxStore } from '../../store/recordTxStore'
import { toDateInputValue, formatAmount } from '../../lib/format'
import { prefersReducedMotion } from '../../motion/reducedMotion'

/** 标签多值：只对最后一个逗号后的 token 做补全查询 */
function extractLastTagToken(value: string): string {
  const parts = value.split(',')
  return (parts[parts.length - 1] ?? '').trim()
}

/** 标签多值：选中后替换最后一个 token，保留前面已有标签 */
function applyTagSelection(item: ComboboxItem, currentValue: string): string {
  const parts = currentValue.split(',')
  const prefix = parts
    .slice(0, -1)
    .map((p) => p.trim())
    .filter(Boolean)
  const next = [...prefix, item.label]
  return `${next.join(', ')}, `
}

const TYPE_OPTIONS: { value: CreateTransactionType; label: string }[] = [
  { value: 'withdrawal', label: '支出' },
  { value: 'deposit', label: '收入' },
  { value: 'transfer', label: '转账' },
]

interface FieldErrors {
  amount?: string
  description?: string
  source?: string
  destination?: string
}

/** 金额输入过滤：只留数字和最多一个小数点 */
function sanitizeAmountInput(raw: string): string {
  let v = raw.replace(/[^0-9.]/g, '')
  const dotIdx = v.indexOf('.')
  if (dotIdx !== -1) {
    v = v.slice(0, dotIdx + 1) + v.slice(dotIdx + 1).replace(/\./g, '')
  }
  return v
}

function todayInput(): string {
  return toDateInputValue(new Date())
}

const fieldLabelStyle = { color: 'var(--g-ink-2)', fontSize: 11 } as const
const errorStyle = { color: 'var(--g-danger)', fontSize: 11 } as const

function inputStyle(hasError?: string) {
  return {
    background: 'var(--g-surface-2)',
    color: 'var(--g-ink)',
    border: `1px solid ${hasError ? 'var(--g-danger)' : 'var(--g-border)'}`,
  }
}

/**
 * 「记一笔」/「编辑交易」表单（规范 §4.3）。
 * 创建：顶栏 + 快捷键 n；编辑：行操作 openEdit。多拆分 group v1 不支持编辑。
 */
export function RecordTransactionModal() {
  const open = useRecordTxStore((s) => s.open)
  const mode = useRecordTxStore((s) => s.mode)
  const edit = useRecordTxStore((s) => s.edit)
  const openForm = useRecordTxStore((s) => s.openForm)
  const close = useRecordTxStore((s) => s.close)

  const accountsQuery = useAssetAccounts()
  const accounts = accountsQuery.data ?? []
  const createMutation = useCreateTransaction()
  const updateMutation = useUpdateTransaction()
  const mutationPending = createMutation.isPending || updateMutation.isPending

  const [type, setType] = useState<CreateTransactionType>('withdrawal')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [date, setDate] = useState(todayInput())
  const [sourceId, setSourceId] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [destId, setDestId] = useState('')
  const [destName, setDestName] = useState('')
  const [category, setCategory] = useState('')
  const [tagsRaw, setTagsRaw] = useState('')
  const [notes, setNotes] = useState('')
  const [moreOpen, setMoreOpen] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [savingContinue, setSavingContinue] = useState(false)

  const [descQuery, setDescQuery] = useState('')
  const [sourceAcQuery, setSourceAcQuery] = useState('')
  const [destAcQuery, setDestAcQuery] = useState('')
  const [categoryQuery, setCategoryQuery] = useState('')
  const [tagQuery, setTagQuery] = useState('')

  const amountRef = useRef<HTMLInputElement>(null)
  const fieldsRef = useRef<HTMLDivElement>(null)

  const onDescQuery = useCallback((q: string) => setDescQuery(q), [])
  const onSourceAcQuery = useCallback((q: string) => setSourceAcQuery(q), [])
  const onDestAcQuery = useCallback((q: string) => setDestAcQuery(q), [])
  const onCategoryQuery = useCallback((q: string) => setCategoryQuery(q), [])
  const onTagQuery = useCallback((q: string) => setTagQuery(q), [])

  const isEdit = mode === 'edit'
  const multiSplitBlocked = isEdit && (edit?.splitCount ?? 0) > 1

  const expenseAccountsQ = useAutocompleteAccounts(destAcQuery, {
    types: 'Expense account',
    enabled: type === 'withdrawal' && destAcQuery.length >= 1,
  })
  const revenueAccountsQ = useAutocompleteAccounts(sourceAcQuery, {
    types: 'Revenue account',
    enabled: type === 'deposit' && sourceAcQuery.length >= 1,
  })
  const categoriesQ = useAutocompleteCategories(categoryQuery, {
    enabled: categoryQuery.length >= 1,
  })
  const tagsQ = useAutocompleteTags(tagQuery, {
    enabled: tagQuery.length >= 1,
  })
  const transactionsQ = useAutocompleteTransactions(descQuery, {
    enabled: descQuery.length >= 1 && !isEdit,
  })

  const expenseItems: ComboboxItem[] = (expenseAccountsQ.data ?? []).map((a) => ({
    id: a.id,
    label: a.name,
  }))
  const revenueItems: ComboboxItem[] = (revenueAccountsQ.data ?? []).map((a) => ({
    id: a.id,
    label: a.name,
  }))
  const categoryItems: ComboboxItem[] = (categoriesQ.data ?? []).map((c) => ({
    id: c.id,
    label: c.name,
  }))
  const tagItems: ComboboxItem[] = (tagsQ.data ?? []).map((t) => ({
    id: t.id,
    label: t.tag ?? t.name,
  }))
  const descItems: ComboboxItem[] = (transactionsQ.data ?? []).map((t) => ({
    id: t.id,
    label: t.description ?? t.name,
  }))

  function resetAll() {
    setType('withdrawal')
    setAmount('')
    setDescription('')
    setDate(todayInput())
    setSourceId('')
    setSourceName('')
    setDestId('')
    setDestName('')
    setCategory('')
    setTagsRaw('')
    setNotes('')
    setMoreOpen(false)
    setErrors({})
    setDescQuery('')
    setSourceAcQuery('')
    setDestAcQuery('')
    setCategoryQuery('')
    setTagQuery('')
  }

  // 打开时按 mode 灌初值 / 清空
  useEffect(() => {
    if (!open) return
    if (mode === 'edit' && edit) {
      setType(edit.type)
      setAmount(edit.amount)
      setDescription(edit.description)
      setDate(edit.date)
      setSourceId(edit.sourceId ?? '')
      setSourceName(edit.sourceName ?? '')
      setDestId(edit.destId ?? '')
      setDestName(edit.destName ?? '')
      setCategory(edit.category ?? '')
      setTagsRaw(edit.tagsRaw ?? '')
      setNotes(edit.notes ?? '')
      setMoreOpen(!!(edit.category || edit.tagsRaw || edit.notes))
      setErrors({})
      return
    }
    resetAll()
  }, [open, mode, edit])

  useLayoutEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'n' && e.key !== 'N') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (target?.isContentEditable) return
      e.preventDefault()
      openForm()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openForm])

  useLayoutEffect(() => {
    const el = fieldsRef.current
    if (!el || prefersReducedMotion() || multiSplitBlocked) return
    gsap.fromTo(el, { opacity: 0.4 }, { opacity: 1, duration: 0.12, ease: 'power1.out' })
  }, [type, multiSplitBlocked])

  function resetForContinue() {
    setAmount('')
    setDescription('')
    setErrors({})
    requestAnimationFrame(() => amountRef.current?.focus())
  }

  function isDirty(): boolean {
    if (isEdit && edit) {
      // 对比打开编辑时的初值；未改动不弹确认
      return (
        type !== edit.type ||
        amount.trim() !== edit.amount.trim() ||
        description.trim() !== edit.description.trim() ||
        date !== edit.date ||
        sourceId !== (edit.sourceId ?? '') ||
        destId !== (edit.destId ?? '') ||
        category.trim() !== (edit.category ?? '').trim() ||
        tagsRaw.trim() !== (edit.tagsRaw ?? '').trim() ||
        notes.trim() !== (edit.notes ?? '').trim()
      )
    }
    // 创建：金额或描述有内容即视为已填写
    return amount.trim() !== '' || description.trim() !== ''
  }

  function handleRequestClose() {
    if (multiSplitBlocked) {
      resetAll()
      close()
      return
    }
    if (isDirty() && !window.confirm(isEdit ? '放弃已修改的内容？' : '放弃已填写的记一笔内容？')) return
    resetAll()
    close()
  }

  function validate(): FieldErrors {
    const errs: FieldErrors = {}
    const amountNum = Number(amount)
    if (!amount.trim() || !(amountNum > 0)) errs.amount = '请输入大于 0 的金额'
    if (!description.trim()) errs.description = '请输入描述'

    if (type === 'withdrawal') {
      if (!sourceId) errs.source = '请选择来源账户'
    } else if (type === 'deposit') {
      if (!destId) errs.destination = '请选择目标账户'
    } else {
      if (!sourceId) errs.source = '请选择来源账户'
      if (!destId) errs.destination = '请选择目标账户'
      if (sourceId && destId && sourceId === destId) errs.destination = '来源与目标账户不能相同'
    }
    return errs
  }

  async function handleSave(continueAfter: boolean) {
    if (multiSplitBlocked) return
    const errs = validate()
    setErrors(errs)
    if (Object.keys(errs).length > 0) return

    const tags = tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const amountStr = Number(amount).toFixed(2)

    setSavingContinue(continueAfter)
    try {
      if (isEdit && edit) {
        await updateMutation.mutateAsync({
          groupId: edit.groupId,
          input: {
            transaction_journal_id: edit.journalId,
            type,
            date,
            amount: amountStr,
            description: description.trim(),
            source_id: type !== 'deposit' ? sourceId : undefined,
            source_name: type === 'deposit' ? sourceName.trim() || undefined : undefined,
            destination_id: type !== 'withdrawal' ? destId : undefined,
            destination_name: type === 'withdrawal' ? destName.trim() || undefined : undefined,
            category_name: category.trim() || '',
            tags,
            notes: notes.trim() || '',
          },
        })
        showToast({ kind: 'success', message: `已更新 ¥${formatAmount(amountStr)} · ${description.trim()}` })
        resetAll()
        close()
      } else {
        await createMutation.mutateAsync({
          type,
          date,
          amount: amountStr,
          description: description.trim(),
          source_id: type !== 'deposit' ? sourceId : undefined,
          source_name: type === 'deposit' ? sourceName.trim() || undefined : undefined,
          destination_id: type !== 'withdrawal' ? destId : undefined,
          destination_name: type === 'withdrawal' ? destName.trim() || undefined : undefined,
          category_name: category.trim() || undefined,
          tags: tags.length > 0 ? tags : undefined,
          notes: notes.trim() || undefined,
        })
        showToast({ kind: 'success', message: `已入账 ¥${formatAmount(amountStr)} · ${description.trim()}` })
        if (continueAfter) {
          resetForContinue()
        } else {
          resetAll()
          close()
        }
      }
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : isEdit ? '更新失败，请重试' : '保存失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    } finally {
      setSavingContinue(false)
    }
  }

  const title = isEdit ? '编辑交易' : '记一笔'

  const footer = multiSplitBlocked ? (
    <button
      type="button"
      onClick={handleRequestClose}
      className="rounded-[6px] px-3 py-1.5 text-[12.5px]"
      style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
    >
      关闭
    </button>
  ) : (
    <>
      {!isEdit && (
        <button
          type="button"
          disabled={mutationPending}
          onClick={() => handleSave(true)}
          className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50"
          style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
        >
          {mutationPending && savingContinue ? '保存中…' : '保存并继续'}
        </button>
      )}
      <button
        type="button"
        disabled={mutationPending}
        onClick={() => handleSave(false)}
        className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50"
        style={{ background: 'var(--g-accent)', color: 'var(--g-accent-ink)', fontWeight: 'var(--g-weight-demibold)' }}
      >
        {mutationPending && !savingContinue ? '保存中…' : isEdit ? '保存修改' : '保存'}
      </button>
    </>
  )

  return (
    <Modal open={open} onClose={handleRequestClose} title={title} width={520} footer={footer}>
      {multiSplitBlocked ? (
        <p className="m-0 leading-relaxed" style={{ color: 'var(--g-ink)' }}>
          这笔交易包含多个拆分（{edit?.splitCount} 笔），v1 暂不支持在此编辑。请在旧版 Firefly 界面中修改。
        </p>
      ) : (
        <div className="flex flex-col gap-3.5">
          <div
            className="flex gap-0.5 rounded-[6px] p-0.5"
            style={{ background: 'var(--g-surface-2)' }}
            role="tablist"
            aria-label="交易类型"
          >
            {TYPE_OPTIONS.map((opt) => {
              const active = opt.value === type
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => {
                    setType(opt.value)
                    setErrors({})
                  }}
                  className="flex-1 rounded-[4px] py-1.5 text-[12.5px] transition-colors"
                  style={{
                    background: active ? 'var(--g-accent)' : 'transparent',
                    color: active ? 'var(--g-accent-ink)' : 'var(--g-ink-2)',
                    fontWeight: active ? 'var(--g-weight-demibold)' : 'var(--g-weight-regular)',
                  }}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>

          <div ref={fieldsRef} className="flex flex-col gap-3">
            <div>
              <input
                ref={amountRef}
                autoFocus
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(sanitizeAmountInput(e.target.value))
                  setErrors((prev) => ({ ...prev, amount: undefined }))
                }}
                placeholder="0.00"
                aria-label="金额"
                className="font-num w-full rounded-[6px] px-3 py-2 text-right outline-none"
                style={{ ...inputStyle(errors.amount), fontSize: 24, fontWeight: 600 }}
              />
              {errors.amount && <div style={errorStyle}>{errors.amount}</div>}
            </div>

            <div className="flex flex-col gap-1">
              <label style={fieldLabelStyle}>描述</label>
              <Combobox
                value={description}
                onChange={(v) => {
                  setDescription(v)
                  setErrors((prev) => ({ ...prev, description: undefined }))
                }}
                onDebouncedQuery={onDescQuery}
                items={descItems}
                isLoading={transactionsQ.isFetching}
                placeholder="这笔钱花在了哪里…"
                hasError={errors.description}
                aria-label="描述"
              />
              {errors.description && <div style={errorStyle}>{errors.description}</div>}
            </div>

            <div className="flex gap-3">
              <div className="flex flex-1 flex-col gap-1">
                <label style={fieldLabelStyle}>来源账户</label>
                {type === 'deposit' ? (
                  <Combobox
                    value={sourceName}
                    onChange={setSourceName}
                    onDebouncedQuery={onSourceAcQuery}
                    items={revenueItems}
                    isLoading={revenueAccountsQ.isFetching}
                    placeholder="收入来源（可留空）"
                    aria-label="来源账户"
                  />
                ) : (
                  <select
                    value={sourceId}
                    onChange={(e) => {
                      setSourceId(e.target.value)
                      setErrors((prev) => ({ ...prev, source: undefined }))
                    }}
                    className="w-full rounded-[6px] px-2.5 py-1.5 text-[12.5px] outline-none"
                    style={inputStyle(errors.source)}
                  >
                    <option value="">{accountsQuery.isLoading ? '加载中…' : '选择账户…'}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
                {errors.source && <div style={errorStyle}>{errors.source}</div>}
              </div>

              <div className="flex flex-1 flex-col gap-1">
                <label style={fieldLabelStyle}>目标账户</label>
                {type === 'withdrawal' ? (
                  <Combobox
                    value={destName}
                    onChange={setDestName}
                    onDebouncedQuery={onDestAcQuery}
                    items={expenseItems}
                    isLoading={expenseAccountsQ.isFetching}
                    placeholder="商家/用途（可留空）"
                    aria-label="目标账户"
                  />
                ) : (
                  <select
                    value={destId}
                    onChange={(e) => {
                      setDestId(e.target.value)
                      setErrors((prev) => ({ ...prev, destination: undefined }))
                    }}
                    className="w-full rounded-[6px] px-2.5 py-1.5 text-[12.5px] outline-none"
                    style={inputStyle(errors.destination)}
                  >
                    <option value="">{accountsQuery.isLoading ? '加载中…' : '选择账户…'}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
                {errors.destination && <div style={errorStyle}>{errors.destination}</div>}
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label style={fieldLabelStyle}>日期</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="font-num rounded-[6px] px-2.5 py-1.5 text-[12.5px] outline-none"
                style={inputStyle()}
              />
            </div>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              className="flex items-center gap-1 text-[11.5px]"
              style={{ color: 'var(--g-ink-2)' }}
            >
              更多选项
              <ChevronDown
                aria-hidden
                size={13}
                color="var(--g-ink-2)"
                style={{ transform: moreOpen ? 'rotate(180deg)' : 'none', transition: 'transform 120ms' }}
              />
            </button>

            {moreOpen && (
              <div className="mt-2.5 flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <label style={fieldLabelStyle}>分类</label>
                  <Combobox
                    value={category}
                    onChange={setCategory}
                    onDebouncedQuery={onCategoryQuery}
                    items={categoryItems}
                    isLoading={categoriesQ.isFetching}
                    placeholder="如：餐饮"
                    aria-label="分类"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label style={fieldLabelStyle}>标签（逗号分隔）</label>
                  <Combobox
                    value={tagsRaw}
                    onChange={setTagsRaw}
                    onDebouncedQuery={onTagQuery}
                    extractQuery={extractLastTagToken}
                    applySelection={applyTagSelection}
                    items={tagItems}
                    isLoading={tagsQ.isFetching}
                    placeholder="如：报销, 出差"
                    aria-label="标签"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label style={fieldLabelStyle}>备注</label>
                  <textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    className="w-full resize-none rounded-[6px] px-2.5 py-1.5 text-[12.5px] outline-none"
                    style={inputStyle()}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
