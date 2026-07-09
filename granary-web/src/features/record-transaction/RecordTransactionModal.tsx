import { useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import gsap from 'gsap'
import { Modal } from '../../components/granary/Modal'
import { useAssetAccounts, useCreateTransaction } from '../../api/queries'
import { FireflyApiError } from '../../api/client'
import type { CreateTransactionType } from '../../api/firefly'
import { showToast } from '../../store/toastStore'
import { useRecordTxStore } from '../../store/recordTxStore'
import { toDateInputValue, formatAmount } from '../../lib/format'
import { prefersReducedMotion } from '../../motion/reducedMotion'

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
 * 「记一笔」交易创建表单（规范 §4.3）：金额优先 5 字段首屏 + 折叠更多选项。
 * 顶栏「+ 记一笔」按钮和全局快捷键 n 共用 useRecordTxStore 开关。
 */
export function RecordTransactionModal() {
  const open = useRecordTxStore((s) => s.open)
  const openForm = useRecordTxStore((s) => s.openForm)
  const close = useRecordTxStore((s) => s.close)

  const accountsQuery = useAssetAccounts()
  const accounts = accountsQuery.data ?? []
  const mutation = useCreateTransaction()

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

  const amountRef = useRef<HTMLInputElement>(null)
  const fieldsRef = useRef<HTMLDivElement>(null)

  // 全局快捷键 n：不在输入框/文本域聚焦时打开表单（规范要求）
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

  // 类型切换时字段区 120ms 淡入过渡（规范 §6）
  useLayoutEffect(() => {
    const el = fieldsRef.current
    if (!el || prefersReducedMotion()) return
    gsap.fromTo(el, { opacity: 0.4 }, { opacity: 1, duration: 0.12, ease: 'power1.out' })
  }, [type])

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
  }

  function resetForContinue() {
    setAmount('')
    setDescription('')
    setErrors({})
    requestAnimationFrame(() => amountRef.current?.focus())
  }

  function handleRequestClose() {
    const dirty = amount.trim() !== '' || description.trim() !== ''
    if (dirty && !window.confirm('放弃已填写的记一笔内容？')) return
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
      await mutation.mutateAsync({
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
    } catch (err) {
      const message = err instanceof FireflyApiError ? err.message : '保存失败，请重试'
      showToast({ kind: 'error', message, duration: 6000 })
    } finally {
      setSavingContinue(false)
    }
  }

  const footer = (
    <>
      <button
        type="button"
        disabled={mutation.isPending}
        onClick={() => handleSave(true)}
        className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50"
        style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)' }}
      >
        {mutation.isPending && savingContinue ? '保存中…' : '保存并继续'}
      </button>
      <button
        type="button"
        disabled={mutation.isPending}
        onClick={() => handleSave(false)}
        className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50"
        style={{ background: 'var(--g-accent)', color: 'var(--g-accent-ink)', fontWeight: 'var(--g-weight-demibold)' }}
      >
        {mutation.isPending && !savingContinue ? '保存中…' : '保存'}
      </button>
    </>
  )

  return (
    <Modal open={open} onClose={handleRequestClose} title="记一笔" width={520} footer={footer}>
      <div className="flex flex-col gap-3.5">
        {/* 分段控件：支出/收入/转账 */}
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
          {/* 金额：大号 mono 右对齐，自动聚焦 */}
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

          {/* 描述 */}
          <div className="flex flex-col gap-1">
            <label style={fieldLabelStyle}>描述</label>
            <input
              value={description}
              onChange={(e) => {
                setDescription(e.target.value)
                setErrors((prev) => ({ ...prev, description: undefined }))
              }}
              placeholder="这笔钱花在了哪里…"
              className="w-full rounded-[6px] px-2.5 py-1.5 text-[12.5px] outline-none"
              style={inputStyle(errors.description)}
            />
            {errors.description && <div style={errorStyle}>{errors.description}</div>}
          </div>

          {/* 来源 / 目标账户：按类型变化 */}
          <div className="flex gap-3">
            <div className="flex flex-1 flex-col gap-1">
              <label style={fieldLabelStyle}>来源账户</label>
              {type === 'deposit' ? (
                <input
                  value={sourceName}
                  onChange={(e) => setSourceName(e.target.value)}
                  placeholder="收入来源（可留空）"
                  className="w-full rounded-[6px] px-2.5 py-1.5 text-[12.5px] outline-none"
                  style={inputStyle()}
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
                <input
                  value={destName}
                  onChange={(e) => setDestName(e.target.value)}
                  placeholder="商家/用途（可留空）"
                  className="w-full rounded-[6px] px-2.5 py-1.5 text-[12.5px] outline-none"
                  style={inputStyle()}
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

          {/* 日期 */}
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

        {/* 更多选项 */}
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
                <input
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="如：餐饮"
                  className="w-full rounded-[6px] px-2.5 py-1.5 text-[12.5px] outline-none"
                  style={inputStyle()}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label style={fieldLabelStyle}>标签（逗号分隔）</label>
                <input
                  value={tagsRaw}
                  onChange={(e) => setTagsRaw(e.target.value)}
                  placeholder="如：报销, 出差"
                  className="w-full rounded-[6px] px-2.5 py-1.5 text-[12.5px] outline-none"
                  style={inputStyle()}
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
    </Modal>
  )
}
