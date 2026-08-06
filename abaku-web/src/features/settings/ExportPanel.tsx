import { useState } from 'react'
import { ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import { exportData, type ExportDataType } from '../../api/firefly'
import { useAssetAccounts } from '../../api/queries'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { Button } from '../../components/ui/Button'
import { Field, Input, Select } from '../../components/ui/Field'
import { InlineError } from '../../components/abaku/ErrorState'

const TYPES: Array<{ value: ExportDataType; label: string }> = [
  { value: 'transactions', label: '交易' },
  { value: 'accounts', label: '账户' },
  { value: 'bills', label: '账单' },
  { value: 'subscriptions', label: '订阅' },
  { value: 'budgets', label: '预算' },
  { value: 'categories', label: '分类' },
  { value: 'piggy-banks', label: '储蓄罐' },
  { value: 'recurring', label: '定期交易' },
  { value: 'rules', label: '规则' },
  { value: 'tags', label: '标签' },
]

export function ExportPanel() {
  const range = useDateRangeStore()
  const accounts = useAssetAccounts({ includeLiabilities: false })
  const [type, setType] = useState<ExportDataType>('transactions')
  const [start, setStart] = useState(range.start)
  const [end, setEnd] = useState(range.end)
  const [accountIds, setAccountIds] = useState<string[]>([])
  const [pending, setPending] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  // 日期是这两格自己的问题，错在哪就标在哪。原先弹 toast：提示浮在右上角，
  // 而出错的输入框在左下角，看完还得自己找回来。
  const rangeError = type !== 'transactions' ? undefined
    : !start ? '请选择开始日期'
      : !end ? '请选择结束日期'
        : start > end ? '开始日期不能晚于结束日期'
          : undefined

  async function run() {
    setSubmitted(true)
    if (rangeError) return
    setPending(true)
    try {
      const result = await exportData(type, type === 'transactions' ? { start, end, accounts: accountIds } : {})
      if (result.blob.size === 0) {
        showToast({ kind: 'error', message: '导出结果为空' })
        return
      }
      const url = URL.createObjectURL(result.blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.filename || `${type}-export.csv`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      showToast({ kind: 'success', message: 'CSV 已生成' })
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : 'CSV 导出失败', duration: 6000 })
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[140px] flex-1">
          <Field label="类型">
            <Select value={type} onChange={(event) => setType(event.target.value as ExportDataType)}>
              {TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {type === 'transactions' && (
          <>
            <Field label="开始">
              <Input
                type="date"
                className="font-mono"
                value={start}
                max={end}
                aria-invalid={submitted && rangeError ? true : undefined}
                onChange={(event) => setStart(event.target.value)}
              />
            </Field>
            {/* 错误只挂在「结束」这一格：两格共同构成一个区间，说两遍等于让人读两遍同一句话 */}
            <Field label="结束" error={submitted ? rangeError : undefined}>
              <Input
                type="date"
                className="font-mono"
                value={end}
                min={start}
                onChange={(event) => setEnd(event.target.value)}
              />
            </Field>
          </>
        )}
        <Button variant="primary" size="md" disabled={pending} onClick={() => void run()}>
          <ArrowDownTrayIcon aria-hidden className="size-4" />
          {pending ? '导出中…' : '导出'}
        </Button>
      </div>
      {type === 'transactions' && (
        accounts.isError ? (
          <InlineError message="账户加载失败" onRetry={() => void accounts.refetch()} />
        ) : (
          /* 一组复选框要有组名，否则读屏只念得出一串账户名，不知道这是在筛什么 */
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="mb-1 text-xs text-[var(--text-tertiary)]">限定账户（不勾选则导出全部）</legend>
            <div className="flex flex-wrap gap-1.5">
              {(accounts.data ?? []).map((account) => (
                <label
                  key={account.id}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md bg-[var(--surface-hover)] px-2 py-1 text-[11px] text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-selected)] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--focus-ring)]"
                >
                  <input
                    type="checkbox"
                    className="size-3.5 accent-[var(--brand)]"
                    checked={accountIds.includes(account.id)}
                    onChange={(event) => setAccountIds((current) => event.target.checked ? [...current, account.id] : current.filter((id) => id !== account.id))}
                  />
                  {account.name}
                </label>
              ))}
            </div>
          </fieldset>
        )
      )}
    </div>
  )
}
