import { useState, type ReactNode } from 'react'
import { TOKEN_READY_EVENT, setStoredToken } from '../../api/client'
import { createApiToken } from '../../api/firefly'
import {
  useAbout,
  useCurrencies,
} from '../../api/queries'
import { Modal } from '../../components/granary/Modal'
import { Skeleton } from '../../components/granary/Skeleton'
import pkg from '../../../package.json'
import { showToast } from '../../store/toastStore'
import { ReferenceDataPanel } from './ReferenceDataPanel'

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-[10px] p-3.5" style={{ background: 'var(--g-surface)', boxShadow: 'var(--g-shadow)' }}>
      <div
        className="mb-3 text-[12px]"
        style={{ color: 'var(--g-ink-2)', fontWeight: 'var(--g-weight-demibold)', letterSpacing: '.02em' }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

function Empty() {
  return (
    <div className="text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>
      暂无
    </div>
  )
}

export function SettingsPage() {
  const currenciesQuery = useCurrencies()
  const aboutQuery = useAbout()
  const [tokenModal, setTokenModal] = useState<{ generating: boolean; token: string | null; error: string | null }>({
    generating: false,
    token: null,
    error: null,
  })

  const currencies = [...(currenciesQuery.data?.data ?? [])].sort((a, b) => {
    const enabledDiff = Number(b.attributes.enabled ?? false) - Number(a.attributes.enabled ?? false)
    if (enabledDiff !== 0) return enabledDiff
    return a.attributes.code.localeCompare(b.attributes.code)
  })

  async function generateToken() {
    setTokenModal({ generating: true, token: null, error: null })
    try {
      const token = await createApiToken()
      setTokenModal({ generating: false, token, error: null })
    } catch (err) {
      setTokenModal({ generating: false, token: null, error: err instanceof Error ? err.message : '生成失败' })
    }
  }

  function applyNewToken(token: string) {
    setStoredToken(token)
    setTokenModal({ generating: false, token: null, error: null })
    window.dispatchEvent(new CustomEvent(TOKEN_READY_EVENT))
    showToast({ message: '已切换到新令牌', kind: 'success' })
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[18px]" style={{ fontWeight: 'var(--g-weight-demibold)', color: 'var(--g-ink)' }}>
        设置
      </h1>

      <Card title="基础资料"><ReferenceDataPanel /></Card>

      <Card title="币种">
        {currenciesQuery.isLoading ? (
          <Skeleton className="h-6" />
        ) : currenciesQuery.isError ? (
          <div className="text-[12.5px]" style={{ color: 'var(--g-ink-2)' }}>
            加载失败
          </div>
        ) : currencies.length === 0 ? (
          <Empty />
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {currencies.map((c) => (
              <span
                key={c.id}
                className="inline-flex h-[18px] items-center gap-1 rounded-[4px] px-1.5 text-[11px]"
                style={{
                  background: c.attributes.default ? 'var(--g-accent)' : 'var(--g-surface-2)',
                  color: c.attributes.default ? 'var(--g-accent-ink)' : c.attributes.enabled ? 'var(--g-ink)' : 'var(--g-ink-2)',
                  fontWeight: c.attributes.default ? 'var(--g-weight-demibold)' : 'var(--g-weight-regular)',
                }}
              >
                {c.attributes.code}
                {c.attributes.default && ' · 默认'}
              </span>
            ))}
          </div>
        )}
      </Card>

      <Card title="访问令牌">
        <div className="flex flex-col gap-2.5 text-[12.5px]" style={{ color: 'var(--g-ink)' }}>
          <p style={{ color: 'var(--g-ink-2)' }}>
            前端全靠个人访问令牌（PAT）访问 Firefly API。令牌只显示一次，生成后请立即保存。
          </p>
          <div>
            <button
              type="button"
              disabled={tokenModal.generating}
              onClick={generateToken}
              className="rounded-[6px] px-2.5 py-1.5 text-[12.5px]"
              style={{
                background: 'var(--g-accent)',
                color: 'var(--g-accent-ink)',
                fontWeight: 'var(--g-weight-demibold)',
              }}
            >
              {tokenModal.generating ? '生成中…' : '生成新令牌'}
            </button>
          </div>
        </div>
      </Card>

      <Card title="关于">
        <div className="flex flex-col gap-2.5 text-[12.5px]" style={{ color: 'var(--g-ink)' }}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              Firefly 版本：
              <span className="font-num" style={{ color: 'var(--g-ink-2)' }}>
                {aboutQuery.isLoading ? '…' : aboutQuery.isError ? '获取失败' : (aboutQuery.data?.data.version ?? '暂无')}
              </span>
            </span>
            <span>
              谷仓 Web 版本：
              <span className="font-num" style={{ color: 'var(--g-ink-2)' }}>{pkg.version}</span>
            </span>
          </div>
        </div>
      </Card>

      <Modal
        open={tokenModal.token !== null || tokenModal.error !== null}
        onClose={() => setTokenModal({ generating: false, token: null, error: null })}
        title="新令牌"
        width={480}
        footer={tokenModal.token ? (
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setTokenModal({ generating: false, token: null, error: null })}
              className="rounded-[6px] px-2.5 py-1.5 text-[12.5px]"
              style={{ color: 'var(--g-ink-2)' }}
            >
              关闭
            </button>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(tokenModal.token ?? '')}
              className="rounded-[6px] px-2.5 py-1.5 text-[12.5px]"
              style={{ color: 'var(--g-ink)' }}
            >
              复制
            </button>
            <button
              type="button"
              onClick={() => applyNewToken(tokenModal.token!)}
              className="rounded-[6px] px-2.5 py-1.5 text-[12.5px]"
              style={{ background: 'var(--g-accent)', color: 'var(--g-accent-ink)', fontWeight: 'var(--g-weight-demibold)' }}
            >
              保存并使用
            </button>
          </div>
        ) : undefined}
      >
        {tokenModal.token ? (
          <div className="flex flex-col gap-2">
            <p style={{ color: 'var(--g-ink-2)' }}>请复制并妥善保存，此令牌不会再次显示。</p>
            <code
              className="block break-all rounded-[6px] p-2 font-mono text-[11.5px] leading-relaxed"
              style={{ background: 'var(--g-surface-2)', color: 'var(--g-ink)', border: '1px solid var(--g-border)' }}
            >
              {tokenModal.token}
            </code>
          </div>
        ) : (
          <p style={{ color: 'var(--g-danger)' }}>{tokenModal.error ?? '未知错误'}</p>
        )}
      </Modal>
    </div>
  )
}
