import { useEffect, useState } from 'react'
import type { Account } from '../../api/schemas'
import type { AccountInput, AccountType } from '../../api/firefly'
import { useCreateAccount, useCurrencies, useUpdateAccount } from '../../api/queries'
import { Modal } from '../../components/abei/Modal'
import { AbeiApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { Button } from '../../components/ui/Button'
import { Field, Input, Select } from '../../components/ui/Field'

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

function validate(form: AccountInput): { name?: string; currency?: string } {
  return {
    name: !form.name.trim() ? '账户名称不能为空' : undefined,
    currency: !form.currency_code ? '请选择币种' : undefined,
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
  /** 点过保存之后才标红。刚打开就一片红字是在骂人 */
  const [submitted, setSubmitted] = useState(false)
  const createMutation = useCreateAccount()
  const updateMutation = useUpdateAccount()
  const currenciesQuery = useCurrencies()
  const pending = createMutation.isPending || updateMutation.isPending

  const errors: { name?: string; currency?: string } = submitted ? validate(form) : {}

  useEffect(() => {
    if (open) {
      setForm(initialForm(type, account))
      setSubmitted(false)
    }
  }, [account, open, type])

  useEffect(() => {
    if (!open || account || form.currency_code) return
    const currencies = currenciesQuery.data?.data ?? []
    const preferred = currencies.find((currency) => currency.attributes.default)
      ?? currencies.find((currency) => currency.attributes.enabled !== false)
    if (preferred) setForm((current) => ({ ...current, currency_code: preferred.attributes.code }))
  }, [account, currenciesQuery.data, form.currency_code, open])

  async function save() {
    setSubmitted(true)
    // 现算一遍：setSubmitted 要到下一次渲染才生效，这里读 errors 拿到的还是旧值
    if (Object.values(validate(form)).some(Boolean)) return
    try {
      const input = { ...form, name: form.name.trim() }
      if (account) await updateMutation.mutateAsync({ accountId: account.id, input })
      else await createMutation.mutateAsync(input)
      showToast({ kind: 'success', message: account ? '账户已更新' : '账户已创建' })
      onClose()
    } catch (reason) {
      showToast({
        kind: 'error',
        message: reason instanceof AbeiApiError ? reason.message : '账户保存失败',
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
    <Modal
      open={open}
      onClose={onClose}
      title={account ? '编辑账户' : '新建账户'}
      width={480}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>取消</Button>
          {/* 不做「填完才能点」：按钮灰着不说明缺什么，点一下把缺口标红更清楚 */}
          <Button variant="primary" size="md" disabled={pending} onClick={() => void save()}>
            {pending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="名称" error={errors.name}>
          <Input autoFocus value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
        </Field>
        {/* 币种建号后不能改（Firefly 不允许换币种），所以直接说明，而不是让人点了没反应 */}
        <Field label="币种" error={errors.currency} hint={account ? '账户建好后不能改币种' : undefined}>
          <Select
            className="num"
            value={form.currency_code ?? ''}
            disabled={currenciesQuery.isLoading || !!account}
            onChange={(event) => setForm((current) => ({ ...current, currency_code: event.target.value }))}
          >
            <option value="">选择币种…</option>
            {(currenciesQuery.data?.data ?? []).map((currency) => (
              <option key={currency.id} value={currency.attributes.code}>
                {currency.attributes.code} · {currency.attributes.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="账户角色">
          <Select value={form.account_role} onChange={(event) => setForm((current) => ({ ...current, account_role: event.target.value }))}>
            {roles.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}
