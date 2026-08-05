import { useEffect, useState } from 'react'
import { Modal } from '../../components/abaku/Modal'
import { useBillInboxSettings, useUpdateBillInboxSettings } from '../../api/queries'
import type { BillInboxSettingsInput } from '../../api/firefly'
import { FireflyApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'

const fieldStyle = {
  background: 'var(--surface-hover)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
} as const

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

  useEffect(() => {
    if (!open) {
      setInitialized(false)
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

  async function save() {
    if (!initialized || !query.data || query.isError || query.isLoading) return
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

  const hasPassword = query.data?.data.attributes.has_password ?? false

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="邮箱设置"
      width={560}
      footer={
        <>
          <button type="button" onClick={onClose} className="rounded-[6px] px-3 py-1.5 text-[12.5px] text-[var(--text-secondary)] ">
            取消
          </button>
          <button
            type="button"
            disabled={mutation.isPending || !initialized || query.isLoading || query.isError || !query.data}
            onClick={() => void save()}
            className="rounded-[6px] px-3 py-1.5 text-[12.5px] disabled:opacity-50 bg-[var(--brand)]  text-white"

          >
            {mutation.isPending ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      {query.isError ? (
        <div className="flex items-center justify-between gap-3 py-4 text-[12.5px] text-[var(--danger)] ">
          <span>邮箱设置加载失败</span>
          <button type="button" onClick={() => void query.refetch()} style={{ color: 'var(--brand)' }}>重试</button>
        </div>
      ) : !initialized ? (
        <div role="status" className="py-4 text-[12.5px] text-[var(--text-secondary)] ">邮箱设置加载中…</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="flex items-center gap-2 sm:col-span-2 text-[12.5px] text-[var(--text-primary)] ">
            <input type="checkbox" checked={form.enabled ?? false} onChange={(event) => set('enabled', event.target.checked)} />
            启用账单邮箱
          </label>
          <Field label="提供商">
            <select value={form.provider} onChange={(event) => set('provider', event.target.value as 'gmail' | 'imap')} className="rounded-[6px] px-2.5 py-1.5" style={fieldStyle}>
              <option value="gmail">Gmail</option>
              <option value="imap">IMAP</option>
            </select>
          </Field>
          <Field label="邮箱地址">
            <input type="email" value={form.email ?? ''} onChange={(event) => set('email', event.target.value)} className="rounded-[6px] px-2.5 py-1.5" style={fieldStyle} />
          </Field>
          <Field label="主机">
            <input value={form.host ?? ''} onChange={(event) => set('host', event.target.value)} disabled={form.provider === 'gmail'} className="rounded-[6px] px-2.5 py-1.5 disabled:opacity-60" style={fieldStyle} />
          </Field>
          <Field label="端口">
            <input type="number" min={1} max={65535} value={form.port ?? ''} onChange={(event) => set('port', Number(event.target.value))} disabled={form.provider === 'gmail'} className="font-mono tabular-nums rounded-[6px] px-2.5 py-1.5 disabled:opacity-60" style={fieldStyle} />
          </Field>
          <Field label="加密">
            <select value={form.encryption} onChange={(event) => set('encryption', event.target.value as 'none' | 'ssl' | 'tls' | 'starttls')} disabled={form.provider === 'gmail'} className="rounded-[6px] px-2.5 py-1.5 disabled:opacity-60" style={fieldStyle}>
              <option value="ssl">SSL</option>
              <option value="tls">TLS</option>
              <option value="starttls">STARTTLS</option>
              <option value="none">无</option>
            </select>
          </Field>
          <Field label="文件夹">
            <input value={form.folder ?? ''} onChange={(event) => set('folder', event.target.value)} className="rounded-[6px] px-2.5 py-1.5" style={fieldStyle} />
          </Field>
          <Field label="用户名">
            <input value={form.username ?? ''} onChange={(event) => set('username', event.target.value)} className="rounded-[6px] px-2.5 py-1.5" style={fieldStyle} />
          </Field>
          <Field label={hasPassword ? '替换密码' : '密码'}>
            <input type="password" autoComplete="new-password" value={form.password ?? ''} onChange={(event) => set('password', event.target.value)} placeholder={hasPassword ? '留空保持不变' : ''} className="rounded-[6px] px-2.5 py-1.5" style={fieldStyle} />
          </Field>
        </div>
      )}
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)] ">
      <span>{label}</span>
      {children}
    </label>
  )
}
