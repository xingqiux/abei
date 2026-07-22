import { useEffect, useState } from 'react'
import type { Account } from '../../api/schemas'
import type { AccountInput, AccountType } from '../../api/firefly'
import { useCreateAccount, useCurrencies, useUpdateAccount } from '../../api/queries'
import { Modal } from '../../components/granary/Modal'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { compareDecimalStrings, normalizeDecimalString } from '../../lib/decimal'

const inputStyle = {
  background: 'var(--g-surface-2)',
  color: 'var(--g-ink)',
  border: '1px solid var(--g-border)',
} as const

function initialForm(type: AccountType, account: Account | null): AccountInput {
  const attrs = account?.attributes
  return {
    name: attrs?.name ?? '',
    type,
    currency_code: attrs?.currency_code ?? '',
    active: attrs?.active ?? true,
    include_net_worth: attrs?.include_net_worth ?? true,
    account_role: attrs?.account_role ?? 'defaultAsset',
    liability_type: (attrs?.liability_type as AccountInput['liability_type']) ?? 'debt',
    liability_direction: attrs?.liability_direction ?? 'credit',
    interest: attrs?.interest ?? '0',
    interest_period: attrs?.interest_period ?? 'monthly',
    credit_card_type: (attrs?.credit_card_type as AccountInput['credit_card_type']) ?? undefined,
    monthly_payment_date: attrs?.monthly_payment_date?.slice(0, 10) ?? undefined,
    opening_balance: attrs?.opening_balance ?? undefined,
    opening_balance_date: attrs?.opening_balance_date?.slice(0, 10) ?? undefined,
    account_number: attrs?.account_number ?? undefined,
    notes: attrs?.notes ?? undefined,
  }
}

export function AccountDialog({ open, type, account, onClose }: { open: boolean; type: AccountType; account: Account | null; onClose: () => void }) {
  const [form, setForm] = useState<AccountInput>(() => initialForm(type, account))
  const createMutation = useCreateAccount()
  const updateMutation = useUpdateAccount()
  const currenciesQuery = useCurrencies()
  const pending = createMutation.isPending || updateMutation.isPending

  useEffect(() => {
    if (open) setForm(initialForm(type, account))
  }, [open, type, account])

  useEffect(() => {
    if (!open || account || form.currency_code) return
    const currencies = currenciesQuery.data?.data ?? []
    const preferred = currencies.find((currency) => currency.attributes.default && currency.attributes.enabled !== false)
      ?? currencies.find((currency) => currency.attributes.enabled !== false)
    if (preferred) set('currency_code', preferred.attributes.code)
  }, [open, account, form.currency_code, currenciesQuery.data])

  function set<K extends keyof AccountInput>(key: K, value: AccountInput[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  async function save() {
    if (!form.name.trim()) {
      showToast({ kind: 'error', message: '账户名称不能为空' })
      return
    }
    if (!form.currency_code) {
      showToast({ kind: 'error', message: '请选择币种' })
      return
    }
    if (type === 'asset' && form.account_role === 'ccAsset') {
      if (form.credit_card_type !== 'monthlyFull') {
        showToast({ kind: 'error', message: '请选择信用卡还款方式' })
        return
      }
      if (!form.monthly_payment_date) {
        showToast({ kind: 'error', message: '请选择每月还款日' })
        return
      }
    }
    if (!!form.opening_balance !== !!form.opening_balance_date) {
      showToast({ kind: 'error', message: '期初余额和日期必须同时填写' })
      return
    }
    let normalizedOpeningBalance = form.opening_balance
    if (normalizedOpeningBalance) {
      try {
        normalizedOpeningBalance = normalizeDecimalString(normalizedOpeningBalance)
      } catch {
        showToast({ kind: 'error', message: '请输入有效的期初余额' })
        return
      }
    }
    let normalizedInterest = form.interest
    if (type === 'liabilities') {
      try {
        const interest = normalizeDecimalString(form.interest || '0')
        if (compareDecimalStrings(interest, '0') < 0 || compareDecimalStrings(interest, '100') > 0) throw new Error('out of range')
        normalizedInterest = interest
      } catch {
        showToast({ kind: 'error', message: '利率必须是 0 到 100 之间的数字' })
        return
      }
    }
    const input: AccountInput = {
      ...form,
      name: form.name.trim(),
      opening_balance: normalizedOpeningBalance,
      interest: normalizedInterest,
    }
    if (type !== 'asset') delete input.account_role
    if (type !== 'asset' || input.account_role !== 'ccAsset') {
      delete input.credit_card_type
      delete input.monthly_payment_date
    }
    if (type !== 'liabilities') {
      delete input.liability_type
      delete input.liability_direction
      delete input.interest
      delete input.interest_period
    }
    if (!input.opening_balance) {
      if (account?.attributes.opening_balance) {
        input.opening_balance = ''
        input.opening_balance_date = ''
      } else {
        delete input.opening_balance
        delete input.opening_balance_date
      }
    }
    try {
      if (account) await updateMutation.mutateAsync({ accountId: account.id, input })
      else await createMutation.mutateAsync(input)
      showToast({ kind: 'success', message: account ? '账户已更新' : '账户已创建' })
      onClose()
    } catch (error) {
      showToast({ kind: 'error', message: error instanceof FireflyApiError ? error.message : '账户保存失败', duration: 6000 })
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={account ? '编辑账户' : '新建账户'} width={560} footer={<>
      <button type="button" onClick={onClose} className="rounded-[6px] px-3 py-1.5 text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>取消</button>
      <button type="button" disabled={pending} onClick={() => void save()} className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50" style={{ background: 'var(--g-accent)', color: 'var(--g-accent-ink)' }}>{pending ? '保存中…' : '保存'}</button>
    </>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="名称"><input autoFocus value={form.name} onChange={(event) => set('name', event.target.value)} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></Field>
        <Field label="币种"><select value={form.currency_code ?? ''} disabled={currenciesQuery.isLoading} onChange={(event) => set('currency_code', event.target.value)} className="font-num rounded-[6px] px-2.5 py-1.5" style={inputStyle}><option value="">选择币种…</option>{(currenciesQuery.data?.data ?? []).map((currency) => <option key={currency.id} value={currency.attributes.code} disabled={currency.attributes.enabled === false}>{currency.attributes.code} · {currency.attributes.name}</option>)}</select></Field>
        {type === 'asset' && <Field label="账户角色"><select value={form.account_role} onChange={(event) => set('account_role', event.target.value)} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle}><option value="defaultAsset">普通资产</option><option value="sharedAsset">共享资产</option><option value="savingAsset">储蓄</option><option value="cashWalletAsset">现金</option><option value="ccAsset">信用卡</option></select></Field>}
        {type === 'liabilities' && <>
          <Field label="负债类型"><select value={form.liability_type} onChange={(event) => set('liability_type', event.target.value as AccountInput['liability_type'])} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle}><option value="debt">债务</option><option value="loan">贷款</option><option value="mortgage">抵押贷款</option></select></Field>
          <Field label="余额方向"><select value={form.liability_direction} onChange={(event) => set('liability_direction', event.target.value as 'credit' | 'debit')} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle}><option value="credit">我欠他人</option><option value="debit">他人欠我</option></select></Field>
          <Field label="利率"><input inputMode="decimal" value={form.interest ?? ''} onChange={(event) => set('interest', event.target.value)} className="font-num rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></Field>
          <Field label="计息周期"><select value={form.interest_period} onChange={(event) => set('interest_period', event.target.value as AccountInput['interest_period'])} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle}><option value="daily">每日</option><option value="weekly">每周</option><option value="monthly">每月</option><option value="quarterly">每季度</option><option value="half-year">每半年</option><option value="yearly">每年</option></select></Field>
        </>}
        {type === 'asset' && form.account_role === 'ccAsset' && <>
          <Field label="信用卡还款方式"><select value={form.credit_card_type ?? ''} onChange={(event) => set('credit_card_type', event.target.value as AccountInput['credit_card_type'])} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle}><option value="">选择方式…</option><option value="monthlyFull">每月全额还款</option></select></Field>
          {form.credit_card_type === 'monthlyFull' && <Field label="每月还款日"><input type="date" value={form.monthly_payment_date ?? ''} onChange={(event) => set('monthly_payment_date', event.target.value)} className="font-num rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></Field>}
        </>}
        <Field label="账号"><input value={form.account_number ?? ''} onChange={(event) => set('account_number', event.target.value)} className="rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></Field>
        {(type === 'asset' || type === 'cash' || type === 'liabilities') && <>
          <Field label="期初余额"><input inputMode="decimal" value={form.opening_balance ?? ''} onChange={(event) => set('opening_balance', event.target.value)} className="font-num rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></Field>
          <Field label="期初日期"><input type="date" value={form.opening_balance_date ?? ''} onChange={(event) => set('opening_balance_date', event.target.value)} className="font-num rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></Field>
        </>}
        <Field label="备注" wide><textarea rows={3} value={form.notes ?? ''} onChange={(event) => set('notes', event.target.value)} className="resize-none rounded-[6px] px-2.5 py-1.5" style={inputStyle} /></Field>
        <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--g-ink)' }}><input type="checkbox" checked={form.active ?? true} onChange={(event) => set('active', event.target.checked)} />启用</label>
        <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--g-ink)' }}><input type="checkbox" checked={form.include_net_worth ?? true} onChange={(event) => set('include_net_worth', event.target.checked)} />计入净资产</label>
      </div>
    </Modal>
  )
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return <label className={`flex flex-col gap-1 text-[12px] ${wide ? 'sm:col-span-2' : ''}`} style={{ color: 'var(--g-ink-2)' }}><span>{label}</span>{children}</label>
}
