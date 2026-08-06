import { useState } from 'react'
import { TOKEN_READY_EVENT, setStoredToken } from '../../api/client'
import { createApiToken } from '../../api/firefly'
import { useApiTokens, useRevokeApiToken } from '../../api/queries'
import type { ApiToken } from '../../api/schemas'
import { Modal } from '../../components/abaku/Modal'
import { Skeleton } from '../../components/abaku/Skeleton'
import { ErrorState } from '../../components/abaku/ErrorState'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { StackedList, StackedListItem } from '../../components/ui/Card'
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
    <div className="flex flex-col gap-4">
      {tokens.isLoading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : tokens.isError ? (
        <ErrorState message="令牌列表加载失败" onRetry={() => void tokens.refetch()} />
      ) : (
        <StackedList className="-mx-4">
          {(tokens.data ?? []).map((t) => (
            <StackedListItem key={t.id}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
                    {t.name}
                  </span>
                  {t.current && <Badge tone="brand">当前会话</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                  创建于 {when(t.created_at)} · 最后使用 {when(t.last_used)}
                </p>
              </div>
              {!t.current && (
                <Button
                  variant="ghost"
                  size="xs"
                  className="text-[var(--danger)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                  onClick={() => setRevoking(t)}
                >
                  撤销
                </Button>
              )}
            </StackedListItem>
          ))}
        </StackedList>
      )}

      <div>
        <Button variant="primary" disabled={creating} onClick={() => void create()}>
          {creating ? '生成中…' : '生成新令牌'}
        </Button>
        <p className="mt-2 text-xs text-[var(--text-secondary)]">
          前端全靠 PAT 访问 Firefly API。令牌只显示一次，生成后请立即保存。
        </p>
      </div>

      <Modal
        open={newToken !== null}
        onClose={() => setNewToken(null)}
        title="新令牌已生成"
        footer={
          newToken ? (
            <Button variant="primary" onClick={() => applyToken(newToken)}>
              使用此令牌
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-2">
          <p className="text-sm text-[var(--text-secondary)]">
            此令牌只显示一次，关闭后无法再查看。
          </p>
          <code className="rounded-md bg-[var(--surface-hover)] p-2.5 font-mono text-xs break-all text-[var(--text-primary)]">
            {newToken}
          </code>
        </div>
      </Modal>

      <Modal
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="撤销令牌"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              disabled={revokeMutation.isPending}
              onClick={() => void confirmRevoke()}
            >
              {revokeMutation.isPending ? '撤销中…' : '确认撤销'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-[var(--text-primary)]">
          撤销后使用该令牌的程序会立刻失效。确认撤销「{revoking?.name}」？
        </p>
      </Modal>
    </div>
  )
}
