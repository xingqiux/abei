import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDownIcon } from '@heroicons/react/20/solid'
import gsap from 'gsap'
import { Modal } from '../../components/abaku/Modal'
import { Combobox, type ComboboxItem } from '../../components/abaku/Combobox'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { Button } from '../../components/ui/Button'
import { Field, Input, Select, Textarea } from '../../components/ui/Field'
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
import { TransactionAttachments } from './TransactionAttachments'
import { MultiSplitTransactionEditor } from './MultiSplitTransactionEditor'
import { isPositiveDecimal, normalizeDecimalString } from '../../lib/decimal'

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
  category?: string
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

const MORE_PANEL_ID = 'record-tx-more-options'

/** 关掉表单前要确认放弃的那次点击。存下提示语和确认后要做的事 */
interface DiscardIntent {
  message: string
  confirm: () => void
}

/**
 * 「记一笔」/「编辑交易」表单（规范 §4.3）。
 * 创建：顶栏 + 快捷键 n；编辑：行操作 openEdit。多拆分 group 使用完整拆分编辑器。
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
  const [multiSplitDirty, setMultiSplitDirty] = useState(false)
  const [createMode, setCreateMode] = useState<'single' | 'split'>('single')
  const [discard, setDiscard] = useState<DiscardIntent | null>(null)

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
  const editingMultiSplit = isEdit && (edit?.splitCount ?? 0) > 1
  const creatingMultiSplit = !isEdit && createMode === 'split'
  const showMultiSplitEditor = editingMultiSplit || creatingMultiSplit

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
    setCreateMode('single')
    setMultiSplitDirty(false)
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
    if (!el || prefersReducedMotion() || showMultiSplitEditor) return
    gsap.fromTo(el, { opacity: 0.4 }, { opacity: 1, duration: 0.12, ease: 'power1.out' })
  }, [type, showMultiSplitEditor])

  function isDirty(): boolean {
    if (isEdit && edit) {
      // 对比打开编辑时的初值；未改动不弹确认
      return (
        type !== edit.type ||
        amount.trim() !== edit.amount.trim() ||
        description.trim() !== edit.description.trim() ||
        date !== edit.date ||
        sourceId !== (edit.sourceId ?? '') ||
        sourceName.trim() !== (edit.sourceName ?? '').trim() ||
        destId !== (edit.destId ?? '') ||
        destName.trim() !== (edit.destName ?? '').trim() ||
        category.trim() !== (edit.category ?? '').trim() ||
        tagsRaw.trim() !== (edit.tagsRaw ?? '').trim() ||
        notes.trim() !== (edit.notes ?? '').trim()
      )
    }
    // 创建：金额或描述有内容即视为已填写
    return amount.trim() !== '' || description.trim() !== ''
  }

  function discardAndClose() {
    setMultiSplitDirty(false)
    resetAll()
    close()
  }

  /**
   * 「有没填完的东西就直接关」这条防线原先走 window.confirm：不受主题控制，
   * 也说不清放弃的是哪一部分。换成和其他破坏性确认一致的对话框。
   */
  function handleRequestClose() {
    const dirty = showMultiSplitEditor ? multiSplitDirty || isDirty() : isDirty()
    if (!dirty) {
      discardAndClose()
      return
    }
    setDiscard({
      message: showMultiSplitEditor
        ? '已修改的拆分内容会全部丢掉，这笔交易不会被保存。'
        : isEdit
          ? '这次编辑的改动会全部丢掉，原交易保持不变。'
          : '已填写的内容会全部丢掉，不会记下这一笔。',
      confirm: discardAndClose,
    })
  }

  function selectCreateMode(next: 'single' | 'split') {
    if (next === createMode) return
    if (next === 'single' && multiSplitDirty) {
      setDiscard({
        message: '切回单笔会丢掉已填写的拆分行。',
        confirm: () => { setMultiSplitDirty(false); setCreateMode('single') },
      })
      return
    }
    setMultiSplitDirty(false)
    setCreateMode(next)
  }

  function validate(): FieldErrors {
    const errs: FieldErrors = {}
    try {
      if (!amount.trim() || !isPositiveDecimal(amount)) errs.amount = '请输入大于 0 的金额'
    } catch {
      errs.amount = '请输入有效金额'
    }
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
    if (type !== 'transfer' && !category.trim()) errs.category = '请选择已创建的分类'
    return errs
  }

  async function handleSave() {
    if (showMultiSplitEditor) return
    const errs = validate()
    setErrors(errs)
    if (errs.category) setMoreOpen(true)
    if (Object.keys(errs).length > 0) return

    const tags = tagsRaw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const amountStr = normalizeDecimalString(amount)
    const amountAccountId = type === 'deposit' ? destId : sourceId
    const amountAccount = accounts.find((account) => account.id === amountAccountId)
    const amountSymbol = amountAccount?.currencySymbol || amountAccount?.currencyCode || ''

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
        showToast({ kind: 'success', message: `已更新 ${amountSymbol}${formatAmount(amountStr)} · ${description.trim()}` })
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
        showToast({ kind: 'success', message: `已入账 ${amountSymbol}${formatAmount(amountStr)} · ${description.trim()}` })
        resetAll()
        close()
      }
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : isEdit ? '更新失败，请重试' : '保存失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    }
  }

  const title = isEdit ? '编辑交易' : '记一笔'

  const footer = showMultiSplitEditor ? (
    <Button variant="secondary" size="md" onClick={handleRequestClose}>关闭</Button>
  ) : (
    <>
      <Button variant="secondary" size="md" onClick={handleRequestClose}>取消</Button>
      <Button variant="primary" size="md" disabled={mutationPending} onClick={() => handleSave()}>
        {mutationPending ? '保存中…' : isEdit ? '保存修改' : '保存'}
      </Button>
    </>
  )

  return (
    <>
    <Modal open={open} onClose={handleRequestClose} title={title} width={520} footer={footer}>
      {!isEdit && (
        <SegmentedControl
          aria-label="记账模式"
          className="mb-3"
          value={createMode}
          onChange={selectCreateMode}
          segments={[
            { value: 'single', label: '单笔' },
            { value: 'split', label: '多拆分' },
          ]}
        />
      )}
      {showMultiSplitEditor ? (
        <MultiSplitTransactionEditor groupId={editingMultiSplit ? edit?.groupId : undefined} onDirtyChange={setMultiSplitDirty} onSaved={() => { setMultiSplitDirty(false); resetAll(); close() }} />
      ) : (
        <div className="flex flex-col gap-3.5">
          <SegmentedControl
            aria-label="交易类型"
            value={type}
            segments={TYPE_OPTIONS}
            onChange={(next) => {
              setType(next)
              setSourceId('')
              setSourceName('')
              setDestId('')
              setDestName('')
              setErrors({})
            }}
          />

          <div ref={fieldsRef} className="flex flex-col gap-3">
            <Field label="金额" error={errors.amount}>
              <Input
                ref={amountRef}
                autoFocus
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(sanitizeAmountInput(e.target.value))
                  setErrors((prev) => ({ ...prev, amount: undefined }))
                }}
                placeholder="0.00"
                className="py-2 text-right font-mono text-2xl font-semibold tabular-nums"
              />
            </Field>

            <Field label="描述" error={errors.description}>
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
              />
            </Field>

            <div className="flex flex-col gap-3 sm:flex-row">
              <div className="flex-1">
                <Field label="来源账户" error={errors.source}>
                  {type === 'deposit' ? (
                    <Combobox
                      value={sourceName}
                      onChange={setSourceName}
                      onDebouncedQuery={onSourceAcQuery}
                      items={revenueItems}
                      isLoading={revenueAccountsQ.isFetching}
                      placeholder="收入来源（可留空）"
                    />
                  ) : (
                    <Select
                      className="py-1.5 text-[12.5px]"
                      value={sourceId}
                      onChange={(e) => {
                        setSourceId(e.target.value)
                        setErrors((prev) => ({ ...prev, source: undefined }))
                      }}
                    >
                      <option value="">{accountsQuery.isLoading ? '加载中…' : '选择账户…'}</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </Select>
                  )}
                </Field>
              </div>

              <div className="flex-1">
                <Field label="目标账户" error={errors.destination}>
                  {type === 'withdrawal' ? (
                    <Combobox
                      value={destName}
                      onChange={setDestName}
                      onDebouncedQuery={onDestAcQuery}
                      items={expenseItems}
                      isLoading={expenseAccountsQ.isFetching}
                      placeholder="商家/用途（可留空）"
                    />
                  ) : (
                    <Select
                      className="py-1.5 text-[12.5px]"
                      value={destId}
                      onChange={(e) => {
                        setDestId(e.target.value)
                        setErrors((prev) => ({ ...prev, destination: undefined }))
                      }}
                    >
                      <option value="">{accountsQuery.isLoading ? '加载中…' : '选择账户…'}</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </Select>
                  )}
                </Field>
              </div>
            </div>

            <Field label="日期">
              <Input
                type="date"
                value={date}
                max={todayInput()}
                onChange={(e) => setDate(e.target.value)}
                className="py-1.5 font-mono text-[12.5px] tabular-nums"
              />
            </Field>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-expanded={moreOpen}
              aria-controls={MORE_PANEL_ID}
              className="flex items-center gap-1 rounded text-[11.5px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              更多选项
              <ChevronDownIcon
                aria-hidden
                className={`size-3.5 text-[var(--text-tertiary)] transition-transform duration-120 motion-reduce:transition-none ${moreOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {moreOpen && (
              <div id={MORE_PANEL_ID} className="mt-2.5 flex flex-col gap-3">
                <Field label="分类" error={errors.category}>
                  <Combobox
                    value={category}
                    onChange={setCategory}
                    onDebouncedQuery={onCategoryQuery}
                    items={categoryItems}
                    isLoading={categoriesQ.isFetching}
                    placeholder="如：餐饮"
                  />
                </Field>
                <Field label="标签" hint="多个标签用逗号分隔">
                  <Combobox
                    value={tagsRaw}
                    onChange={setTagsRaw}
                    onDebouncedQuery={onTagQuery}
                    extractQuery={extractLastTagToken}
                    applySelection={applyTagSelection}
                    items={tagItems}
                    isLoading={tagsQ.isFetching}
                  />
                </Field>
                <Field label="备注">
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    rows={2}
                    className="resize-none py-1.5 text-[12.5px]"
                  />
                </Field>
              </div>
            )}
          </div>
        </div>
      )}
      {isEdit && edit && <TransactionAttachments groupId={edit.groupId} journalId={edit.journalId} />}
    </Modal>

    <Modal
      open={discard !== null}
      onClose={() => setDiscard(null)}
      title="放弃未保存的内容？"
      width={380}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={() => setDiscard(null)}>继续编辑</Button>
          <Button
            variant="danger"
            size="md"
            onClick={() => {
              const run = discard?.confirm
              setDiscard(null)
              run?.()
            }}
          >
            放弃
          </Button>
        </>
      }
    >
      <p className="text-[var(--text-secondary)]">{discard?.message}</p>
    </Modal>
    </>
  )
}
