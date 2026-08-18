import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Question, Sparkle } from '@phosphor-icons/react'
import { AssistantApiError } from '../../api/assistant'
import {
  useActVocabSuggestion,
  useCreateCategory,
  useRunBackfill,
  useUpdateCategory,
  useVocabSuggestions,
} from '../../api/queries'
import type { VocabSuggestion } from '../../api/schemas'
import { Card } from '../../components/ui/Card'
import { Button, buttonClass } from '../../components/ui/Button'
import { showToast } from '../../store/toastStore'
import { txSearch, type TransactionSearch } from '../../routes/transactionSearch'

/**
 * 分类管理页顶部的两张卡：未分类交易、AI 词表建议。
 * 两张都是「有才显示」——没有未分类交易、没有建议时整卡不出现，不摆空卡占地方。
 *
 * 这里以前还有第三张「已学会的规则」。规则改由用户自己在《个人记账规则》
 * 文档里写（/profile 页），这张卡就没有对应的东西可看了。
 */

/**
 * 交易页的「未分类」视图。view 这个搜索参数由交易页那边补进 validateTransactionSearch，
 * 这里先按约定的参数名跳；等那边落地，断言就只是个多余的括号。
 */
const UNCATEGORIZED_SEARCH = { ...txSearch(), view: 'uncategorized' } as TransactionSearch

export function CategoryTopCards({ uncategorizedCount }: { uncategorizedCount: number }) {
  return (
    <>
      <UncategorizedCard count={uncategorizedCount} />
      <VocabSuggestionsCard />
    </>
  )
}

function UncategorizedCard({ count }: { count: number }) {
  const runBackfill = useRunBackfill()
  if (count <= 0) return null

  function handleRun() {
    runBackfill.mutate(undefined, {
      onSuccess: () => showToast({ message: 'AI 正在给未分类交易出建议' }),
      onError: (reason) => {
        // 409 是「后台已经在跑了」，不是失败——报成错误会让人反复点
        if (reason instanceof AssistantApiError && reason.status === 409) {
          showToast({ message: 'AI 已经在跑了，等它出完这一轮' })
          return
        }
        showToast({
          kind: 'error',
          message: reason instanceof AssistantApiError ? reason.message : '启动失败，稍后再试',
          duration: 6000,
        })
      },
    })
  }

  return (
    <Card className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-hover)]">
          <Question aria-hidden className="size-5 text-[var(--text-tertiary)]" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text-primary)]">
            未分类交易 <span className="num">{count}</span> 笔
          </p>
          <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
            AI 生成分类建议，在交易页逐笔确认。
          </p>
        </div>
      </div>
      <Link
        to="/transactions"
        search={UNCATEGORIZED_SEARCH}
        onClick={handleRun}
        className={buttonClass({ variant: 'primary', size: 'sm' })}
      >
        <Sparkle aria-hidden className="size-4" />
        {runBackfill.isPending ? '正在启动…' : '让 AI 出建议'}
      </Link>
    </Card>
  )
}

function VocabSuggestionsCard() {
  const query = useVocabSuggestions()
  const createCategory = useCreateCategory()
  const updateCategory = useUpdateCategory()
  const act = useActVocabSuggestion()
  const [busyId, setBusyId] = useState<string | null>(null)

  const pending = (query.data ?? []).filter((item) => item.status === 'pending')
  if (pending.length === 0) return null

  /**
   * 同意的顺序是「先落词表，成功了再回报 accept」。
   * 反过来的话，建卡失败但建议已标为已接受，这条建议就再也不会出现了。
   */
  async function accept(suggestion: VocabSuggestion) {
    setBusyId(suggestion.id)
    try {
      if (suggestion.action === 'enable' && suggestion.category_id) {
        await updateCategory.mutateAsync({ id: suggestion.category_id, attrs: { disabled: false } })
      } else {
        await createCategory.mutateAsync({
          name: suggestion.name,
          domain: suggestion.domain,
          parent_id: suggestion.parent_id ?? null,
          icon: suggestion.icon ?? null,
          color: suggestion.color ?? null,
        })
      }
      await act.mutateAsync({ id: suggestion.id, action: 'accept' })
      showToast({ message: `已启用「${suggestion.name}」` })
    } catch (reason) {
      showToast({
        kind: 'error',
        message: reason instanceof Error ? reason.message : '没能改词表，稍后再试',
        duration: 6000,
      })
    } finally {
      setBusyId(null)
    }
  }

  function ignore(suggestion: VocabSuggestion) {
    setBusyId(suggestion.id)
    act.mutate(
      { id: suggestion.id, action: 'ignore' },
      {
        onSuccess: () => showToast({ message: '已忽略，30 天内不再提这条' }),
        onError: () => showToast({ kind: 'error', message: '操作失败，稍后再试' }),
        onSettled: () => setBusyId(null),
      },
    )
  }

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Sparkle aria-hidden className="size-4 text-[var(--brand-text)]" />
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">AI 的词表建议</h2>
      </div>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">
        AI 只提供建议，不会自动写入。
      </p>
      <ul role="list" className="mt-3 divide-y divide-[var(--border-subtle)]">
        {pending.map((suggestion) => (
          <li
            key={suggestion.id}
            className="flex flex-wrap items-center justify-between gap-3 py-2.5"
          >
            <div className="min-w-0">
              <p className="text-sm text-[var(--text-primary)]">
                {suggestion.action === 'enable' ? '建议启用' : '建议新建'}「
                {suggestion.parent_name ? `${suggestion.parent_name} / ` : ''}
                {suggestion.name}」
              </p>
              {suggestion.reason && (
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">{suggestion.reason}</p>
              )}
            </div>
            <span className="flex shrink-0 items-center gap-2">
              <Button
                variant="ghost"
                size="xs"
                disabled={busyId === suggestion.id}
                onClick={() => ignore(suggestion)}
              >
                忽略
              </Button>
              <Button
                variant="secondary"
                size="xs"
                disabled={busyId === suggestion.id}
                onClick={() => void accept(suggestion)}
              >
                同意
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
