import { useState } from 'react'
import { ArrowDownTrayIcon } from '@heroicons/react/20/solid'
import { exportData, type ExportDataType } from '../../api/firefly'
import { useAssetAccounts } from '../../api/queries'
import { useDateRangeStore } from '../../store/dateRangeStore'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'

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

const inputClass =
  'rounded-md bg-[var(--surface-1)] px-2.5 py-1.5 text-[13px] text-[var(--text-primary)] shadow-sm ring-1 ring-inset ring-[var(--border-strong)]   '

export function ExportPanel() {
  const range = useDateRangeStore()
  const accounts = useAssetAccounts({ includeLiabilities: false })
  const [type, setType] = useState<ExportDataType>('transactions')
  const [start, setStart] = useState(range.start)
  const [end, setEnd] = useState(range.end)
  const [accountIds, setAccountIds] = useState<string[]>([])
  const [pending, setPending] = useState(false)

  async function run() {
    if (type === 'transactions' && (!start || !end || start > end)) {
      showToast({ kind: 'error', message: '开始日期不能晚于结束日期' })
      return
    }
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
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[140px] flex-1 flex-col gap-1 text-[11.5px] text-[var(--text-secondary)] ">
          类型
          <select value={type} onChange={(event) => setType(event.target.value as ExportDataType)} className={inputClass}>
            {TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        {type === 'transactions' && (
          <>
            <label className="flex flex-col gap-1 text-[11.5px] text-[var(--text-secondary)] ">
              开始
              <input type="date" value={start} max={end} onChange={(event) => setStart(event.target.value)} className={`font-mono ${inputClass}`} />
            </label>
            <label className="flex flex-col gap-1 text-[11.5px] text-[var(--text-secondary)] ">
              结束
              <input type="date" value={end} min={start} onChange={(event) => setEnd(event.target.value)} className={`font-mono ${inputClass}`} />
            </label>
          </>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => void run()}
          className="flex items-center gap-1.5 rounded-md bg-[var(--brand)] px-3 py-1.5 text-[13px] font-semibold text-white shadow-sm hover:bg-[var(--brand-hover)] disabled:opacity-50"
        >
          <ArrowDownTrayIcon aria-hidden className="size-4" />
          {pending ? '导出中…' : '导出'}
        </button>
      </div>
      {type === 'transactions' && (
        accounts.isError ? (
          <div className="flex items-center gap-2 text-[11.5px] text-[var(--danger)] ">
            <span>账户加载失败</span>
            <button type="button" onClick={() => void accounts.refetch()} className="text-[var(--brand)] ">重试</button>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {(accounts.data ?? []).map((account) => (
              <label key={account.id} className="flex items-center gap-1 rounded-md bg-[var(--surface-hover)] px-1.5 py-1 text-[11px] text-[var(--text-primary)]  ">
                <input type="checkbox" checked={accountIds.includes(account.id)} onChange={(event) => setAccountIds((current) => event.target.checked ? [...current, account.id] : current.filter((id) => id !== account.id))} />
                {account.name}
              </label>
            ))}
          </div>
        )
      )}
    </div>
  )
}
