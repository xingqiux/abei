import { useEffect, useMemo, useState } from 'react'
import { Trash } from '@phosphor-icons/react'
import type { BillTask } from '../../api/schemas'
import {
  useAssetAccounts,
  useBillAccountMappings,
  useDeleteBillAccountMapping,
  useUpsertBillAccountMapping,
} from '../../api/queries'
import { AbeiApiError } from '../../api/client'
import { AccountCombobox } from '../../components/abei/AccountCombobox'
import { Modal } from '../../components/abei/Modal'
import { Button, IconButton } from '../../components/ui/Button'
import { InlineError } from '../../components/abei/ErrorState'
import { showToast } from '../../store/toastStore'
import { channelDisplayName } from './billInboxHelpers'

interface MappingKey {
  channel: string
  hint: string
}

interface Draft {
  accountId: string
  accountName: string
}

function keyOf(candidate: MappingKey): string {
  return `${candidate.channel}\u0000${candidate.hint}`
}

export function AccountMappingDialog({
  open,
  tasks,
  onClose,
}: {
  open: boolean
  tasks: BillTask[]
  onClose: () => void
}) {
  const mappingsQuery = useBillAccountMappings({ enabled: open })
  const accountsQuery = useAssetAccounts()
  const upsert = useUpsertBillAccountMapping()
  const remove = useDeleteBillAccountMapping()
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})

  const candidates = useMemo(() => {
    const unique = new Map<string, MappingKey>()
    for (const task of tasks) {
      const hint = task.attributes.account_hint?.trim()
      const channel = task.attributes.source.trim()
      if (!hint || !channel) continue
      const candidate = { channel, hint }
      unique.set(keyOf(candidate), candidate)
    }
    for (const mapping of mappingsQuery.data?.data ?? []) {
      const candidate = {
        channel: mapping.attributes.channel_key,
        hint: mapping.attributes.account_hint,
      }
      unique.set(keyOf(candidate), candidate)
    }
    return Array.from(unique.values()).sort((left, right) =>
      `${left.channel}\u0000${left.hint}`.localeCompare(`${right.channel}\u0000${right.hint}`, 'zh-Hans-CN'),
    )
  }, [mappingsQuery.data, tasks])

  const mappings = useMemo(
    () => new Map((mappingsQuery.data?.data ?? []).map((mapping) => [
      keyOf({ channel: mapping.attributes.channel_key, hint: mapping.attributes.account_hint }),
      mapping,
    ])),
    [mappingsQuery.data],
  )

  useEffect(() => {
    if (!open) return
    setDrafts(Object.fromEntries(
      Array.from(mappings.entries()).map(([key, mapping]) => [key, {
        accountId: mapping.attributes.firefly_account_id,
        accountName: mapping.attributes.firefly_account_name,
      }]),
    ))
  }, [mappings, open])

  async function save(candidate: MappingKey) {
    const key = keyOf(candidate)
    const draft = drafts[key]
    if (!draft?.accountId) {
      showToast({ kind: 'error', message: '请从列表中选择一个 Firefly 账户' })
      return
    }
    try {
      await upsert.mutateAsync({
        channel_key: candidate.channel,
        account_hint: candidate.hint,
        firefly_account_id: draft.accountId,
      })
      showToast({ kind: 'success', message: `已把 ${candidate.hint} 映射到 ${draft.accountName}` })
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof AbeiApiError ? error.message : '账户映射保存失败',
      })
    }
  }

  async function removeMapping(mappingId: string, hint: string) {
    try {
      await remove.mutateAsync(mappingId)
      showToast({ kind: 'success', message: `已移除 ${hint} 的账户映射` })
    } catch (error) {
      showToast({
        kind: 'error',
        message: error instanceof AbeiApiError ? error.message : '账户映射移除失败',
      })
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="账户映射" width={680}>
      <div className="flex flex-col gap-3">
        {mappingsQuery.isError && (
          <InlineError
            message="账户映射加载失败"
            error={mappingsQuery.error}
            onRetry={() => void mappingsQuery.refetch()}
          />
        )}

        {candidates.length === 0 && !mappingsQuery.isLoading ? (
          <p className="py-6 text-center text-sm text-[var(--text-secondary)]">当前账单还没有需要映射的账户</p>
        ) : (
          <div className="divide-y divide-[var(--border-subtle)]">
            {candidates.map((candidate) => {
              const key = keyOf(candidate)
              const mapping = mappings.get(key)
              const draft = drafts[key] ?? { accountId: '', accountName: '' }
              const changed = !mapping
                || mapping.attributes.firefly_account_id !== draft.accountId
              return (
                <div key={key} className="grid gap-2 py-3 md:grid-cols-[minmax(150px,0.8fr)_minmax(220px,1.4fr)_auto] md:items-end">
                  <div className="min-w-0">
                    <div className="text-[11px] text-[var(--text-tertiary)]">
                      {channelDisplayName(candidate.channel)}
                    </div>
                    <div className="truncate text-sm font-medium text-[var(--text-primary)]" title={candidate.hint}>
                      {candidate.hint}
                    </div>
                  </div>
                  <AccountCombobox
                    accounts={accountsQuery.data ?? []}
                    text={draft.accountName}
                    isLoading={accountsQuery.isLoading}
                    placeholder="选择 Firefly 账户…"
                    aria-label={`${candidate.hint} 对应的 Firefly 账户`}
                    onChange={(accountName, accountId) => setDrafts((current) => ({
                      ...current,
                      [key]: { accountName, accountId },
                    }))}
                  />
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant={changed ? 'primary' : 'secondary'}
                      disabled={!draft.accountId || upsert.isPending}
                      onClick={() => void save(candidate)}
                    >
                      {mapping ? '更新' : '映射'}
                    </Button>
                    {mapping && (
                      <IconButton
                        label={`移除 ${candidate.hint} 的映射`}
                        variant="ghost-danger"
                        disabled={remove.isPending}
                        onClick={() => void removeMapping(mapping.id, candidate.hint)}
                      >
                        <Trash aria-hidden className="size-4" />
                      </IconButton>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Modal>
  )
}
