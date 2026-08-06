import { useEffect, useState } from 'react'
import { Modal } from '../../components/abaku/Modal'
import { useBillInboxSettings, useUpdateBillInboxSettings } from '../../api/queries'
import type { BillInboxSettingsInput } from '../../api/firefly'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { Button } from '../../components/ui/Button'
import { Field, Input, Select } from '../../components/ui/Field'
import { InlineError } from '../../components/abaku/ErrorState'

const EMPTY: BillInboxSettingsInput = {
  enabled: false,
  provider: 'imap',
  email: '',
  host: '',
  port: 993,
  encryption: 'ssl',
  username: '',
  folder: 'INBOX',
  password: '',
}

export function BillInboxSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const query = useBillInboxSettings({ enabled: open })
  const mutation = useUpdateBillInboxSettings()
  const [form, setForm] = useState<BillInboxSettingsInput>(EMPTY)
  const [initialized, setInitialized] = useState(false)
  /** 点过保存之后才标红。刚打开就一片红字是在骂人 */
  const [submitted, setSubmitted] = useState(false)
  const hasPassword = query.data?.data.attributes.has_password ?? false

  useEffect(() => {
    if (!open) {
      setInitialized(false)
      setSubmitted(false)
      return
    }
    if (initialized || query.isFetching || query.isError) return
    const attrs = query.data?.data.attributes
    if (!attrs) return
    setForm({
      enabled: attrs.enabled,
      provider: attrs.provider,
      email: attrs.email,
      host: attrs.host,
      port: attrs.port,
      encryption: attrs.encryption,
      username: attrs.username,
      folder: attrs.folder,
      password: '',
    })
    setInitialized(true)
  }, [initialized, open, query.data, query.isError, query.isFetching])

  function set<K extends keyof BillInboxSettingsInput>(key: K, value: BillInboxSettingsInput[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  /**
   * 启用时才校验：没启用的邮箱可以留一堆空格子存着。
   * 校验结果就地挂在对应格子下（Field 的 error），不再是提交后弹一条 toast——
   * toast 不告诉你是哪一格错了。
   */
  const errors: Partial<Record<keyof BillInboxSettingsInput, string>> = {}
  if (submitted && form.enabled) {
    if (!form.email?.trim()) errors.email = '启用后必须填邮箱地址'
    else if (!form.email.includes('@')) errors.email = '邮箱地址格式不对'
    if (!form.username?.trim()) errors.username = '启用后必须填用户名'
    if (form.provider === 'imap') {
      if (!form.host?.trim()) errors.host = 'IMAP 必须填主机'
      if (!form.port || form.port < 1 || form.port > 65535) errors.port = '端口需在 1–65535 之间'
    }
    if (!hasPassword && !form.password?.trim()) errors.password = '首次启用必须填密码'
  }
  const hasErrors = Object.keys(errors).length > 0

  async function save() {
    if (!initialized || !query.data || query.isError || query.isLoading) return
    setSubmitted(true)
    // 上面的 errors 是这次渲染算出来的，submitted 还是 false，所以这里重算一遍
    if (form.enabled) {
      const emailBad = !form.email?.trim() || !form.email.includes('@')
      const imapBad = form.provider === 'imap' && (!form.host?.trim() || !form.port || form.port < 1 || form.port > 65535)
      if (emailBad || imapBad || !form.username?.trim() || (!hasPassword && !form.password?.trim())) {
        showToast({ kind: 'error', message: '请先补全标红的字段' })
        return
      }
    }
    try {
      await mutation.mutateAsync({
        ...form,
        password: form.password?.trim() || undefined,
      })
      showToast({ kind: 'success', message: '邮箱设置已保存' })
      onClose()
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof FireflyApiError ? error.message : '邮箱设置保存失败',
        duration: 6000,
      })
    }
  }

  const isGmail = form.provider === 'gmail'

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="邮箱设置"
      width={560}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={mutation.isPending || !initialized || query.isLoading || query.isError || !query.data || hasErrors}
            onClick={() => void save()}
          >
            {mutation.isPending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      {query.isError ? (
        <InlineError message="邮箱设置加载失败" onRetry={() => void query.refetch()} />
      ) : !initialized ? (
        <div role="status" className="py-4 text-sm text-[var(--text-secondary)]">邮箱设置加载中…</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 text-sm text-[var(--text-primary)] sm:col-span-2">
            <input
              type="checkbox"
              className="accent-[var(--brand)]"
              checked={form.enabled ?? false}
              onChange={(event) => set('enabled', event.target.checked)}
            />
            启用账单邮箱
          </label>
          <Field label="提供商" hint={isGmail ? 'Gmail 的主机与加密方式固定' : undefined}>
            <Select value={form.provider} onChange={(event) => set('provider', event.target.value as 'gmail' | 'imap')}>
              <option value="gmail">Gmail</option>
              <option value="imap">IMAP</option>
            </Select>
          </Field>
          <Field label="邮箱地址" error={errors.email}>
            <Input type="email" autoComplete="email" value={form.email ?? ''} onChange={(event) => set('email', event.target.value)} />
          </Field>
          <Field label="主机" error={errors.host}>
            <Input value={form.host ?? ''} onChange={(event) => set('host', event.target.value)} disabled={isGmail} />
          </Field>
          <Field label="端口" error={errors.port}>
            <Input type="number" min={1} max={65535} className="font-mono tabular-nums" value={form.port ?? ''} onChange={(event) => set('port', Number(event.target.value))} disabled={isGmail} />
          </Field>
          <Field label="加密">
            <Select value={form.encryption} onChange={(event) => set('encryption', event.target.value as 'none' | 'ssl' | 'tls' | 'starttls')} disabled={isGmail}>
              <option value="ssl">SSL</option>
              <option value="tls">TLS</option>
              <option value="starttls">STARTTLS</option>
              <option value="none">无</option>
            </Select>
          </Field>
          <Field label="文件夹">
            <Input value={form.folder ?? ''} onChange={(event) => set('folder', event.target.value)} />
          </Field>
          <Field label="用户名" error={errors.username}>
            <Input autoComplete="username" value={form.username ?? ''} onChange={(event) => set('username', event.target.value)} />
          </Field>
          <Field
            label={hasPassword ? '替换密码' : '密码'}
            error={errors.password}
            hint={hasPassword ? '留空保持不变' : undefined}
          >
            <Input type="password" autoComplete="new-password" value={form.password ?? ''} onChange={(event) => set('password', event.target.value)} />
          </Field>
        </div>
      )}
    </Modal>
  )
}
