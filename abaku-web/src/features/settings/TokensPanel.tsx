import { useState } from 'react'
import { TOKEN_READY_EVENT, setStoredToken } from '../../api/client'
import { createApiToken } from '../../api/firefly'
import { useApiTokens, useRevokeApiToken } from '../../api/queries'
import type { ApiToken } from '../../api/schemas'
import { Modal } from '../../components/abaku/Modal'
import { Skeleton } from '../../components/abaku/Skeleton'
import { ErrorState } from '../../components/abaku/ErrorState'
import { showToast } from '../../store/toastStore'
import { formatDateTime } from '../../lib/format'

function when(iso: string | null): string {
  return iso ? formatDateTime(iso) : '—'
}

/** 访问令牌：列出 / 生成 / 撤销，当前会话那行不给撤销按钮。 */
export function TokensPanel() {
  const tokens = useApiTokens()
  const revokeMutation = useRevokeApiToken()
  const [creating, setCreating] = useState(false)
  const [newToken, setNewToken] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<ApiToken | null>(null)

  async function create() {
    setCreating(true)
    try {
      const token = await createApiToken()
      setNewToken(token)
      void tokens.refetch()
    } catch (err) {
      showToast({ kind: 'error', message: err instanceof Error ? err.message : '生成失败' })
    } finally {
      setCreating(false)
    }
  }

  function applyToken(token: string) {
    setStoredToken(token)
    setNewToken(null)
    window.dispatchEvent(new CustomEvent(TOKEN_READY_EVENT))
    showToast({ kind: 'success', message: '已切换到新令牌' })
  }

  async function confirmRevoke() {
    if (!revoking) return
    try {
      await revokeMutation.mutateAsync(revoking.id)
      showToast({ kind: 'success', message: `已撤销「${revoking.name}」` })
      setRevoking(null)
    } catch (err) {
      showToast({ kind: 'error', message: err instanceof Error ? err.message : '撤销失败' })
    }
  }

  return (
    <div className="flex flex-col gap-3 text-[12.5px] text-[var(--text-primary)] ">
      {tokens.isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : tokens.isError ? (
        <ErrorState message="令牌列表加载失败" onRetry={() => void tokens.refetch()} />
      ) : (
        <div className="flex flex-col">
          {(tokens.data ?? []).map((t) => (
            <div key={t.id} className="flex min-h-11 items-center gap-3 border-b border-[var(--border-subtle)] py-2 last:border-b-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold">{t.name}</span>
                  {t.current && <span className="rounded bg-[var(--surface-selected)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)] ">当前会话</span>}
                </div>
                <div className="text-[11px] text-[var(--text-secondary)] ">
                  创建于 {when(t.created_at)} · 最后使用 {when(t.last_used)}
                </div>
              </div>
              {!t.current && (
                <button
                  type="button"
                  onClick={() => setRevoking(t)}
                  className="shrink-0 rounded-md px-2.5 py-1.5 text-[12px] text-[var(--danger)] hover:bg-[var(--danger-soft)] "
                >
                  撤销
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div>
        <button
          type="button"
          disabled={creating}
          onClick={() => void create()}
          className="rounded-[6px] bg-[var(--brand)] px-2.5 py-1.5 text-[12.5px] font-semibold text-[var(--brand-on)] hover:bg-[var(--brand-hover)] disabled:opacity-50"
        >
          {creating ? '生成中…' : '生成新令牌'}
        </button>
        <p className="mt-1.5 text-[11.5px] text-[var(--text-secondary)] ">
          前端全靠 PAT 访问 Firefly API。令牌只显示一次，生成后请立即保存。
        </p>
      </div>

      <Modal
        open={newToken !== null}
        onClose={() => setNewToken(null)}
        title="新令牌已生成"
        footer={
          newToken ? (
            <button type="button" onClick={() => applyToken(newToken)} className="rounded-md bg-[var(--brand)] px-3 py-1.5 text-[13px] font-semibold text-[var(--brand-on)] hover:bg-[var(--brand-hover)]">
              使用此令牌
            </button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px] text-[var(--text-secondary)] ">此令牌只显示一次，关闭后无法再查看。</p>
          <code className="break-all rounded-md bg-[var(--surface-hover)] p-2.5 font-mono text-[12px] text-[var(--text-primary)] ">{newToken}</code>
        </div>
      </Modal>

      <Modal
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="撤销令牌"
        footer={
          <>
            <button type="button" onClick={() => setRevoking(null)} className="rounded-md px-3 py-1.5 text-[13px] text-[var(--text-secondary)] ">
              取消
            </button>
            <button
              type="button"
              disabled={revokeMutation.isPending}
              onClick={() => void confirmRevoke()}
              className="rounded-md bg-[var(--danger)] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[var(--danger-hover)] disabled:opacity-50"
            >
              {revokeMutation.isPending ? '撤销中…' : '确认撤销'}
            </button>
          </>
        }
      >
        <p className="text-[13px] text-[var(--text-primary)] ">
          撤销后使用该令牌的程序会立刻失效。确认撤销「{revoking?.name}」？
        </p>
      </Modal>
    </div>
  )
}
