import { useState } from 'react'
import {
  Check,
  Copy,
  Terminal,
  Trash,
} from '@phosphor-icons/react'
import { createApiToken } from '../../api/firefly'
import { useApiTokens, useRevokeApiToken } from '../../api/queries'
import type { ApiToken } from '../../api/schemas'
import { Modal } from '../../components/abei/Modal'
import { Skeleton } from '../../components/abei/Skeleton'
import { ErrorState } from '../../components/abei/ErrorState'
import { Badge } from '../../components/ui/Badge'
import { Button } from '../../components/ui/Button'
import { StackedList, StackedListItem } from '../../components/ui/Card'
import { showToast } from '../../store/toastStore'
import { formatDateTime } from '../../lib/format'

function when(iso: string | null): string {
  return iso ? formatDateTime(iso) : '—'
}

/** 到期时间已经过去。解析不出来就当没过期，宁可少标也不要误标成失效。 */
function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  const at = new Date(expiresAt).getTime()
  return Number.isFinite(at) && at < Date.now()
}

function buildPairingCommand(baseUrl: string, token: string): string {
  return `abei auth login --url ${shellQuote(baseUrl.replace(/\/+$/, ''))} --token ${shellQuote(token)}`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

/** abei CLI 连接：签发一次性配对命令，并管理当前用户的 PAT。 */
export function TokensPanel() {
  const tokens = useApiTokens()
  const revokeMutation = useRevokeApiToken()
  const [creating, setCreating] = useState(false)
  const [newToken, setNewToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<ApiToken | null>(null)

  async function create() {
    setCreating(true)
    try {
      const token = await createApiToken('abei CLI')
      setNewToken(token)
      setCopied(false)
      void tokens.refetch()
    } catch (err) {
      showToast({ kind: 'error', message: err instanceof Error ? err.message : '生成失败' })
    } finally {
      setCreating(false)
    }
  }

  async function copyPairingCommand() {
    if (!newToken) return
    try {
      await navigator.clipboard.writeText(buildPairingCommand(window.location.origin, newToken))
      setCopied(true)
      showToast({ kind: 'success', message: '配对命令已复制' })
    } catch {
      showToast({ kind: 'error', message: '复制失败，请手动选择命令' })
    }
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
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 rounded-md bg-[var(--surface-hover)] p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-[var(--brand-soft)] text-[var(--brand-text)]">
            <Terminal aria-hidden className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--text-primary)]">abei CLI 一键配对</p>
            <p className="mt-0.5 text-xs leading-5 text-[var(--text-secondary)]">
              命令会先验证当前平台和令牌，成功后才保存到本机。
            </p>
          </div>
        </div>
        <Button variant="primary" disabled={creating} onClick={() => void create()}>
          <Terminal aria-hidden className="size-4" />
          {creating ? '生成中…' : '生成配对命令'}
        </Button>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">已签发的连接</h3>
          {!tokens.isLoading && !tokens.isError && (
            <span className="num text-xs text-[var(--text-secondary)]">
              {(tokens.data ?? []).length} 个
            </span>
          )}
        </div>
        {tokens.isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : tokens.isError ? (
          <ErrorState message="令牌列表加载失败" error={tokens.error} onRetry={() => void tokens.refetch()} />
        ) : (
          <StackedList className="-mx-4">
            {(tokens.data ?? []).map((t) => {
              const expired = isExpired(t.expires_at)
              return (
                <StackedListItem key={t.id}>
                  {/* 过期的整条压暗：这条已经不能用了，不该和在用的令牌一样显眼 */}
                  <div className={`min-w-0 flex-1 ${expired ? 'opacity-60' : ''}`}>
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-[var(--text-primary)]">
                        {t.name}
                      </span>
                      {t.current && <Badge tone="brand">当前会话</Badge>}
                      {expired && <Badge>已过期</Badge>}
                    </div>
                    <p className="num mt-0.5 text-xs text-[var(--text-secondary)]">
                      签发于 {when(t.created_at)}
                      {t.expires_at
                        ? expired
                          ? ` · 已于 ${when(t.expires_at)} 过期`
                          : ` · 到期 ${when(t.expires_at)}`
                        : ''}
                    </p>
                  </div>
                  {!t.current && (
                    <Button
                      variant="ghost"
                      size="xs"
                      className="text-[var(--danger)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)]"
                      onClick={() => setRevoking(t)}
                    >
                      <Trash aria-hidden className="size-3.5" />
                      撤销
                    </Button>
                  )}
                </StackedListItem>
              )
            })}
          </StackedList>
        )}
      </div>

      <Modal
        open={newToken !== null}
        onClose={() => {
          setNewToken(null)
          setCopied(false)
        }}
        title="连接 abei CLI"
        footer={
          newToken ? (
            <>
              <Button variant="ghost" onClick={() => setNewToken(null)}>
                完成
              </Button>
              <Button variant="primary" onClick={() => void copyPairingCommand()}>
                {copied ? (
                  <Check aria-hidden className="size-4" />
                ) : (
                  <Copy aria-hidden className="size-4" />
                )}
                {copied ? '已复制' : '复制配对命令'}
              </Button>
            </>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--text-secondary)]">
            在安装了 abei 的终端运行下面这条命令，完成后直接运行 <code>abei</code>{' '}
            即可查看账况与待办。
          </p>
          <code className="select-all rounded-md bg-[var(--surface-hover)] p-3 font-mono text-xs leading-5 break-all text-[var(--text-primary)]">
            {newToken ? buildPairingCommand(window.location.origin, newToken) : ''}
          </code>
          <p className="text-xs text-[var(--text-secondary)]">
            命令包含访问凭证，仅显示一次。请勿转发；丢失后请撤销并重新生成。
          </p>
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
