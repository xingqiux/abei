import { useEffect, useState } from 'react'
import { Modal } from '../../components/abei/Modal'
import {
  useDisconnectGoogleMailbox,
  useMailboxSettings,
  useStartGoogleMailboxOAuth,
  useUpdateMailboxSettings,
  type MailboxSettingsInput,
} from '../../api/mailbox'
import { AbeiApiError } from '../../api/client'
import { showToast } from '../../store/toastStore'
import { Button } from '../../components/ui/Button'
import { Field, Input, Select } from '../../components/ui/Field'
import { InlineError } from '../../components/abei/ErrorState'

const EMPTY: MailboxSettingsInput = {
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

export function MailboxSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const query = useMailboxSettings({ enabled: open })
  const mutation = useUpdateMailboxSettings()
  const googleStart = useStartGoogleMailboxOAuth()
  const googleDisconnect = useDisconnectGoogleMailbox()
  const [form, setForm] = useState<MailboxSettingsInput>(EMPTY)
  const [initialized, setInitialized] = useState(false)
  /** 点过保存之后才标红。刚打开就一片红字是在骂人 */
  const [submitted, setSubmitted] = useState(false)
  const hasPassword = query.data?.data.attributes.has_password ?? false
  const googleConnected = query.data?.data.attributes.google_connected ?? false
  const googleAvailable = query.data?.data.attributes.google_oauth_available ?? false
  const isGmail = form.provider === 'gmail'

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

  function set<K extends keyof MailboxSettingsInput>(key: K, value: MailboxSettingsInput[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function setProvider(provider: 'gmail' | 'imap') {
    setSubmitted(false)
    setForm((current) => provider === 'gmail'
      ? { ...current, provider, enabled: false, password: '' }
      : { ...EMPTY, provider })
  }

  /**
   * 启用时才校验：没启用的邮箱可以留一堆空格子存着。
   * 校验结果就地挂在对应格子下（Field 的 error），不再是提交后弹一条 toast——
   * toast 不告诉你是哪一格错了。
   */
  const errors: Partial<Record<keyof MailboxSettingsInput, string>> = {}
  if (submitted && form.enabled && !isGmail) {
    if (!form.email?.trim()) errors.email = '启用后必须填邮箱地址'
    else if (!form.email.includes('@')) errors.email = '邮箱地址格式不对'
    if (!form.username?.trim()) errors.username = '启用后必须填用户名'
    if (!form.host?.trim()) errors.host = 'IMAP 必须填主机'
    if (!form.port || form.port < 1 || form.port > 65535) errors.port = '端口需在 1–65535 之间'
    if (!hasPassword && !form.password?.trim()) errors.password = '首次启用必须填密码'
  }
  const hasErrors = Object.keys(errors).length > 0

  async function save() {
    if (isGmail || !initialized || !query.data || query.isError || query.isLoading) return
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
        message: error instanceof AbeiApiError ? error.message : '邮箱设置保存失败',
        duration: 6000,
      })
    }
  }

  async function connectGoogle() {
    try {
      const response = await googleStart.mutateAsync()
      window.location.assign(response.data.attributes.authorization_url)
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof AbeiApiError ? error.message : 'Google 连接启动失败',
        duration: 6000,
      })
    }
  }

  async function disconnectGoogle() {
    if (!window.confirm('断开 Google 后将停止收取 Gmail 账单邮件。确定断开吗？')) return
    try {
      await googleDisconnect.mutateAsync()
      showToast({ kind: 'success', message: 'Google 邮箱已断开' })
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof AbeiApiError ? error.message : 'Google 邮箱断开失败',
        duration: 6000,
      })
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="邮箱设置"
      width={560}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            {isGmail ? '关闭' : '取消'}
          </Button>
          {!isGmail && (
            <Button
              variant="primary"
              size="md"
              disabled={mutation.isPending || !initialized || query.isLoading || query.isError || !query.data || hasErrors}
              onClick={() => void save()}
            >
              {mutation.isPending ? '保存中…' : '保存'}
            </Button>
          )}
        </>
      }
    >
      {query.isError ? (
        <InlineError message="邮箱设置加载失败" error={query.error} onRetry={() => void query.refetch()} />
      ) : !initialized ? (
        <div role="status" className="py-4 text-sm text-[var(--text-secondary)]">邮箱设置加载中…</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="提供商" hint={googleConnected ? '断开 Google 后可切换' : undefined}>
            <Select
              value={form.provider}
              disabled={googleConnected}
              onChange={(event) => setProvider(event.target.value as 'gmail' | 'imap')}
            >
              <option value="gmail">Gmail</option>
              <option value="imap">IMAP</option>
            </Select>
          </Field>
          {isGmail ? (
            <div className="flex min-h-16 items-center justify-between gap-4 border-t border-[var(--border-subtle)] pt-3 sm:col-span-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--text-primary)]">
                  {googleConnected ? '已连接' : '未连接'}
                </p>
                {googleConnected && (
                  <p className="truncate text-xs text-[var(--text-secondary)]">
                    {query.data?.data.attributes.email}
                  </p>
                )}
                {!googleAvailable && !googleConnected && (
                  <p className="text-xs text-[var(--text-secondary)]">服务器未配置 Google OAuth2</p>
                )}
              </div>
              {googleConnected ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={googleDisconnect.isPending}
                  onClick={() => void disconnectGoogle()}
                >
                  {googleDisconnect.isPending ? '断开中…' : '断开连接'}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!googleAvailable || googleStart.isPending}
                  onClick={() => void connectGoogle()}
                >
                  {googleStart.isPending ? '连接中…' : '连接 Google'}
                </Button>
              )}
            </div>
          ) : (
            <>
              <label className="flex items-center gap-2 text-sm text-[var(--text-primary)] sm:col-span-2">
                <input
                  type="checkbox"
                  className="accent-[var(--brand)]"
                  checked={form.enabled ?? false}
                  onChange={(event) => set('enabled', event.target.checked)}
                />
                启用账单邮箱
              </label>
              <Field label="邮箱地址" error={errors.email}>
                <Input type="email" autoComplete="email" value={form.email ?? ''} onChange={(event) => set('email', event.target.value)} />
              </Field>
              <Field label="主机" error={errors.host}>
                <Input value={form.host ?? ''} onChange={(event) => set('host', event.target.value)} />
              </Field>
              <Field label="端口" error={errors.port}>
                <Input type="number" min={1} max={65535} className="font-mono tabular-nums" value={form.port ?? ''} onChange={(event) => set('port', Number(event.target.value))} />
              </Field>
              <Field label="加密">
                <Select value={form.encryption} onChange={(event) => set('encryption', event.target.value as 'none' | 'ssl' | 'tls' | 'starttls')}>
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
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
