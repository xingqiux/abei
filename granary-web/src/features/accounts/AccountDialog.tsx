import { useEffect, useState } from 'react'
import type { Account } from '../../api/schemas'
import type { AccountInput, AccountType } from '../../api/firefly'
import { useCreateAccount, useCurrencies, useUpdateAccount } from '../../api/queries'
import { Modal } from '../../components/granary/Modal'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'

const inputStyle = {
  background: 'light-dark(var(--color-gray-100), var(--color-gray-700))',
  color: 'light-dark(var(--color-gray-900), var(--color-gray-100))',
  border: '1px solid light-dark(var(--color-gray-200), var(--color-gray-600))',
} as const

function defaultRole(type: AccountType): string {
  if (type === 'cash') return 'cash'
  if (type === 'liabilities') return 'card'
  return 'bank'
}

function initialForm(type: AccountType, account: Account | null): AccountInput {
  const attributes = account?.attributes
  const liabilityType = attributes?.liability_type
  return {
    name: attributes?.name ?? '',
    type,
    currency_code: attributes?.currency_code ?? '',
    account_role: attributes?.account_role ?? (attributes?.liability_type === 'loan' ? 'loan' : defaultRole(type)),
    liability_type: liabilityType === 'loan' || liabilityType === 'mortgage' ? liabilityType : undefined,
    version: typeof attributes?.version === 'number' ? attributes.version : undefined,
  }
}

export function AccountDialog({
  open,
  type,
  account,
  onClose,
}: {
  open: boolean
  type: AccountType
  account: Account | null
  onClose: () => void
}) {
  const [form, setForm] = useState<AccountInput>(() => initialForm(type, account))
  const createMutation = useCreateAccount()
  const updateMutation = useUpdateAccount()
  const currenciesQuery = useCurrencies()
  const pending = createMutation.isPending || updateMutation.isPending

  useEffect(() => {
    if (open) setForm(initialForm(type, account))
  }, [account, open, type])

  useEffect(() => {
    if (!open || account || form.currency_code) return
    const currencies = currenciesQuery.data?.data ?? []
    const preferred = currencies.find((currency) => currency.attributes.default)
      ?? currencies.find((currency) => currency.attributes.enabled !== false)
    if (preferred) setForm((current) => ({ ...current, currency_code: preferred.attributes.code }))
  }, [account, currenciesQuery.data, form.currency_code, open])

  async function save() {
    if (!form.name.trim()) {
      showToast({ kind: 'error', message: '账户名称不能为空' })
      return
    }
    if (!form.currency_code) {
      showToast({ kind: 'error', message: '请选择币种' })
      return
    }
    try {
      const input = { ...form, name: form.name.trim() }
      if (account) await updateMutation.mutateAsync({ accountId: account.id, input })
      else await createMutation.mutateAsync(input)
      showToast({ kind: 'success', message: account ? '账户已更新' : '账户已创建' })
      onClose()
    } catch (reason) {
      showToast({
        kind: 'error',
        message: reason instanceof FireflyApiError ? reason.message : '账户保存失败',
        duration: 6000,
      })
    }
  }

  const roles = type === 'liabilities'
    ? [['card', '信用卡'], ['loan', '贷款'], ['other', '其他负债']]
    : type === 'cash'
      ? [['cash', '现金']]
      : [['bank', '银行账户'], ['other', '其他资产']]

  return (
    <Modal open={open} onClose={onClose} title={account ? '编辑账户' : '新建账户'} width={480} footer={<>
      <button type="button" onClick={onClose} className="rounded-[6px] px-3 py-1.5 text-[12.5px] text-gray-500 dark:text-gray-400">取消</button>
      <button type="button" disabled={pending} onClick={() => void save()} className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50 bg-indigo-600 text-white font-semibold shadow-sm hover:bg-indigo-500">{pending ? '保存中...' : '保存'}</button>
    </>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="名称"><input autoFocus value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></Field>
        <Field label="币种"><select value={form.currency_code ?? ''} disabled={currenciesQuery.isLoading || !!account} onChange={(event) => setForm((current) => ({ ...current, currency_code: event.target.value }))} className="font-mono tabular-nums rounded-[6px] px-2.5 py-1.5" style={inputStyle}><option value="">选择币种...</option>{(currenciesQuery.data?.data ?? []).map((currency) => <option key={currency.id} value={currency.attributes.code}>{currency.attributes.code} · {currency.attributes.name}</option>)}</select></Field>
        <Field label="账户角色"><select value={form.account_role} onChange={(event) => setForm((current) => ({ ...current, account_role: event.target.value }))} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle}>{roles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1 text-[12px] text-gray-500 dark:text-gray-400"><span>{label}</span>{children}</label>
}
