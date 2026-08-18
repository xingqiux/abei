import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileText, FloppyDisk, Plus, Trash } from '@phosphor-icons/react'
import { AbeiApiError, apiDeleteJson, apiGet, apiPatch, apiPost } from '../../api/client'
import { useAiRun, useAiRuns } from '../../api/queries'
import type { AiRun, AiRunDetailEntry } from '../../api/schemas'
import { EmptyState } from '../../components/abei/EmptyState'
import { ErrorState } from '../../components/abei/ErrorState'
import { ConfirmDialog } from '../../components/abei/ConfirmDialog'
import { Button, IconButton } from '../../components/ui/Button'
import { Card, SectionHeading } from '../../components/ui/Card'
import { Field, Input, Textarea } from '../../components/ui/Field'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { formatDateTime } from '../../lib/format'
import { showToast } from '../../store/toastStore'

interface ProfileDocSummary {
  slug: string
  title: string
  version: number
  content_sha256: string
  updated_by: string
  updated_source: 'cli' | 'web'
  created_at: string
  updated_at: string
}

interface ProfileDoc extends ProfileDocSummary {
  content_md: string
}

interface ListResponse {
  data: ProfileDocSummary[]
}

interface DetailResponse {
  data: ProfileDoc
  no_op?: boolean
}

const MAX_CONTENT_BYTES = 1024 * 1024
const DISCARD_DRAFT_MESSAGE = '当前修改还没有保存，确定放弃吗？'
const EMPTY_PROFILE_DOCS: ProfileDocSummary[] = []

/**
 * 《个人记账规则》：阿贝越用越懂你的那份底稿。
 *
 * 阿贝每次预填和回填都会先读这份文档，规则说了怎么归类的就照规则来。
 * 分块和示例都是固定的：「商户固定分类」那一块阿贝会逐行解析成确定规则，
 * 写成别的样子就只当参考。改这里的块名之前，先看 abei-agent 的 rule-doc.ts。
 */
const RULES_DOC_SLUG = 'personal-accounting-rules'
const RULES_DOC_TITLE = '个人记账规则'
const RULES_DOC_TEMPLATE = `# 个人记账规则

## 总原则
- 拿不准就留空，别猜。

## 场景分类规则
- 工作日中午的外卖 → 餐饮

## 已确认的人和账户
- 「张三」是同事，和他的往来记在「代付」

## 商户固定分类
- 商户名含「滴滴」 → 交通出行

## 需保留详情的类型
- 医疗类要在备注里写清就诊人和项目

## 已失效规则
- （不再适用的规则搬到这里，别直接删，好回头查）
`

export function ProfilePage() {
  const queryClient = useQueryClient()
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ProfileDoc | null>(null)
  const [reloadOpen, setReloadOpen] = useState(false)
  useBlocker({
    shouldBlockFn: () => dirty && !window.confirm(DISCARD_DRAFT_MESSAGE),
    enableBeforeUnload: dirty,
  })
  const listQuery = useQuery({
    queryKey: ['profile-doc'],
    queryFn: () => apiGet<ListResponse>('/v1/profile-doc'),
  })
  const documents = listQuery.data?.data ?? EMPTY_PROFILE_DOCS
  const detailQuery = useQuery({
    queryKey: ['profile-doc', selectedSlug],
    queryFn: () => apiGet<DetailResponse>(`/v1/profile-doc/${selectedSlug}`),
    enabled: selectedSlug !== null && !creating,
  })

  useEffect(() => {
    if (!creating && selectedSlug === null && documents.length > 0) {
      setSelectedSlug(documents[0].slug)
    }
  }, [creating, documents, selectedSlug])

  function mayDiscardDraft(): boolean {
    return !dirty || window.confirm(DISCARD_DRAFT_MESSAGE)
  }

  function selectDocument(slug: string) {
    if (slug === selectedSlug && !creating) return
    if (!mayDiscardDraft()) return
    setDirty(false)
    setCreating(false)
    setSelectedSlug(slug)
  }

  function startCreating() {
    if (!mayDiscardDraft()) return
    setDirty(false)
    setSelectedSlug(null)
    setCreating(true)
  }

  function saved(document: ProfileDoc) {
    queryClient.setQueryData<DetailResponse>(['profile-doc', document.slug], {
      data: document,
    })
    void queryClient.invalidateQueries({
      queryKey: ['profile-doc'],
      exact: true,
    })
    setDirty(false)
    setCreating(false)
    setSelectedSlug(document.slug)
  }

  function deleted(slug: string) {
    const index = documents.findIndex((document) => document.slug === slug)
    const next = documents[index + 1] ?? documents[index - 1]
    queryClient.removeQueries({ queryKey: ['profile-doc', slug], exact: true })
    queryClient.setQueryData<ListResponse>(['profile-doc'], (current) => ({
      data: (current?.data ?? documents).filter((document) => document.slug !== slug),
    }))
    setDirty(false)
    setPendingDelete(null)
    setCreating(false)
    setSelectedSlug(next?.slug ?? null)
  }

  const hasRulesDoc = documents.some((document) => document.slug === RULES_DOC_SLUG)
  const missingRulesDoc = !listQuery.isLoading && !listQuery.isError && !hasRulesDoc

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold text-[var(--text-primary)]">用户资料</h1>
        <Button variant="primary" size="md" onClick={startCreating}>
          <Plus aria-hidden className="size-4" />
          新建资料
        </Button>
      </div>

      {/* 还没有规则文档时才出现。已经有了就不必再劝一遍。 */}
      {missingRulesDoc && documents.length > 0 && (
        <RulesDocGuide onCreated={saved} mayStart={mayDiscardDraft} />
      )}

      {hasRulesDoc && <LearnedRulesCard />}

      <div className="grid min-h-[620px] items-stretch gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <Card padded={false} className="overflow-hidden">
          <div className="border-b border-[var(--border-subtle)] px-4 py-3">
            <SectionHeading title="资料文档" />
          </div>
          {listQuery.isLoading ? (
            <p role="status" className="px-4 py-8 text-center text-sm text-[var(--text-secondary)]">
              正在加载…
            </p>
          ) : listQuery.isError ? (
            <ErrorState message="用户资料加载失败" error={listQuery.error} onRetry={() => void listQuery.refetch()} />
          ) : documents.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-[var(--text-secondary)]">还没有资料文档</p>
          ) : (
            <ul role="list" className="divide-y divide-[var(--border-subtle)]">
              {documents.map((document) => {
                const active = !creating && selectedSlug === document.slug
                return (
                  <li key={document.slug}>
                    <button
                      type="button"
                      aria-current={active ? 'page' : undefined}
                      onClick={() => selectDocument(document.slug)}
                      className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
                        active ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]'
                      }`}
                    >
                      <FileText aria-hidden className={`mt-0.5 size-4.5 shrink-0 ${active ? 'text-[var(--brand-text)]' : 'text-[var(--text-tertiary)]'}`} />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-[var(--text-primary)]">{document.title}</span>
                        <span className="mt-1 block truncate font-mono text-[11px] text-[var(--text-tertiary)]">
                          {document.slug} · v{document.version}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {creating ? (
          <ProfileEditor key="new" onSaved={saved} onDirtyChange={setDirty} />
        ) : selectedSlug === null ? (
          // 一份资料都没有：与其摆个「还没有资料文档」，不如直接告诉人第一份该写什么。
          missingRulesDoc ? (
            <RulesDocGuide onCreated={saved} mayStart={mayDiscardDraft} />
          ) : (
            <Card>
              <EmptyState icon={<FileText className="size-8" />} message="还没有资料文档" action={{ label: '新建资料', onClick: startCreating }} />
            </Card>
          )
        ) : detailQuery.isLoading ? (
          <Card>
            <p role="status" className="py-16 text-center text-sm text-[var(--text-secondary)]">
              正在读取…
            </p>
          </Card>
        ) : detailQuery.isError ? (
          <Card>
            <ErrorState message="资料文档读取失败" error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />
          </Card>
        ) : detailQuery.data ? (
          <ProfileEditor
            key={`${detailQuery.data.data.slug}:${detailQuery.data.data.version}`}
            document={detailQuery.data.data}
            onSaved={saved}
            onDirtyChange={setDirty}
            onDelete={() => setPendingDelete(detailQuery.data.data)}
            onReload={() => setReloadOpen(true)}
          />
        ) : null}
      </div>

      {pendingDelete && (
        <DeleteProfileDocDialog
          document={pendingDelete}
          onClose={() => setPendingDelete(null)}
          onDeleted={deleted}
        />
      )}

      <ConfirmDialog
        open={reloadOpen}
        title="重新载入"
        confirmLabel="放弃草稿并载入"
        tone="primary"
        onConfirm={() => {
          setReloadOpen(false)
          setDirty(false)
          void detailQuery.refetch()
        }}
        onClose={() => setReloadOpen(false)}
      >
        <p>会用服务端最新的一版覆盖编辑器里的内容，当前未保存的修改就没了。</p>
      </ConfirmDialog>
    </div>
  )
}

/**
 * 「阿贝学会了这些」。
 *
 * 阿贝预填之后会回头看：同一个商户，你连着三次都改成同一个分类，或者连着三次
 * 原样入账，它就把这条规则自己写进「商户固定分类」；文档里的老规则被你反复推翻，
 * 它就搬进「已失效规则」。这块只是把它动过的手摆出来，不用确认也不用点。
 */
function LearnedRulesCard() {
  const runsQuery = useAiRuns({ kind: 'learn', limit: 5 })
  const runs = runsQuery.data ?? []
  // 阿贝还没配模型、或者还没学到东西时，这块就不该占地方。
  if (runsQuery.isLoading || runsQuery.isError || runs.length === 0) return null

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <SectionHeading title="阿贝学会了这些" />
        <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
          同一个商户你连着改成同一个分类，阿贝就把这条写进上面的《个人记账规则》；
          写错了直接在文档里改，改完它就照新的来。
        </p>
      </div>
      <ul role="list" className="flex flex-col gap-2">
        {runs.map((run) => (
          <LearnRunRow key={run.id} run={run} />
        ))}
      </ul>
    </Card>
  )
}

function LearnRunRow({ run }: { run: AiRun }) {
  const detailQuery = useAiRun(run.id)
  const entries = detailQuery.data?.detail ?? []
  if (entries.length === 0) return null

  return (
    <li className="rounded-lg bg-[var(--surface-hover)] px-3 py-2.5">
      <p className="text-[11px] text-[var(--text-tertiary)]">{formatDateTime(run.started_at)}</p>
      <ul role="list" className="mt-1.5 flex flex-col gap-1">
        {entries.map((entry, index) => (
          <li key={`${run.id}:${index}`} className="text-xs leading-5">
            <span
              className={
                entry.kind === 'rule_retired'
                  ? 'text-[var(--text-tertiary)]'
                  : 'text-[var(--brand-text)]'
              }
            >
              {entry.kind === 'rule_retired' ? '停用' : '新增'}
            </span>
            <span className="ml-2 text-[var(--text-primary)]">{learnedRuleText(entry)}</span>
            <span className="ml-1 text-[var(--text-tertiary)]">（{learnedBasisText(entry)}）</span>
          </li>
        ))}
      </ul>
    </li>
  )
}

/** 明细里 line 就是文档里那一行的原文，去掉列表符号直接摆出来。 */
function learnedRuleText(entry: AiRunDetailEntry): string {
  const line = typeof entry.line === 'string' ? entry.line : ''
  return line.replace(/^[-*+]\s*/, '') || '一条商户分类规则'
}

function learnedBasisText(entry: AiRunDetailEntry): string {
  const corrected = typeof entry.corrected === 'number' ? entry.corrected : 0
  const confirmed = typeof entry.confirmed === 'number' ? entry.confirmed : 0
  if (entry.kind === 'rule_retired') return `你改过 ${corrected} 次`
  if (corrected > 0 && confirmed > 0) return `你改过 ${corrected} 次，认过 ${confirmed} 次`
  if (corrected > 0) return `你改过 ${corrected} 次`
  return `你认过 ${confirmed} 次`
}

/**
 * 「创建规则文档」引导卡。
 *
 * 建档走的是和手写新建同一条路（create 端点 + confirm 闸门），只是内容换成模板，
 * 免得人对着一张空白 Markdown 猜该写什么。
 */
function RulesDocGuide({
  onCreated,
  mayStart,
}: {
  onCreated: (document: ProfileDoc) => void
  mayStart: () => boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: () =>
      apiPost<DetailResponse>(
        '/v1/profile-doc',
        {
          slug: RULES_DOC_SLUG,
          title: RULES_DOC_TITLE,
          content_md: RULES_DOC_TEMPLATE,
          source: 'web',
        },
        { confirm: true },
      ),
  })

  async function create() {
    if (!mayStart()) return
    setError(null)
    try {
      const response = await mutation.mutateAsync()
      onCreated(response.data)
      showToast({ kind: 'success', message: '规则文档已创建' })
    } catch (caught) {
      setError(caught instanceof AbeiApiError ? (caught.detail ?? caught.message) : '规则文档创建失败')
    }
  }

  return (
    <Card className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-semibold text-[var(--text-primary)]">写一份记账规则，阿贝照着做</h2>
        <p className="mt-1 text-sm leading-6 text-[var(--text-secondary)]">
          阿贝每次替你补分类、补描述之前都会先读这份文档：你写「商户名含滴滴归交通出行」，它就照着归。
          先按模板建一份，之后想到什么随时往里加。
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {error}
        </p>
      )}
      <div>
        <Button variant="primary" size="md" disabled={mutation.isPending} onClick={() => void create()}>
          <Plus aria-hidden className="size-4" />
          {mutation.isPending ? '创建中…' : '创建规则文档'}
        </Button>
      </div>
    </Card>
  )
}

function ProfileEditor({
  document,
  onSaved,
  onDirtyChange,
  onDelete,
  onReload,
}: {
  document?: ProfileDoc
  onSaved: (document: ProfileDoc) => void
  onDirtyChange: (dirty: boolean) => void
  onDelete?: () => void
  onReload?: () => void
}) {
  const creating = document === undefined
  const [slug, setSlug] = useState(document?.slug ?? '')
  const [title, setTitle] = useState(document?.title ?? '')
  const [content, setContent] = useState(document?.content_md ?? '')
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [error, setError] = useState<string | null>(null)
  const [versionConflict, setVersionConflict] = useState(false)
  const contentBytes = new TextEncoder().encode(content).length
  const dirty = creating ? slug !== '' || title !== '' || content !== '' : title !== document.title || content !== document.content_md
  const validSlug = /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  const mutation = useMutation({
    mutationFn: async () => {
      if (creating) {
        return apiPost<DetailResponse>('/v1/profile-doc', { slug, title: title.trim(), content_md: content, source: 'web' }, { confirm: true })
      }
      return apiPatch<DetailResponse>(
        `/v1/profile-doc/${document.slug}`,
        {
          expected_version: document.version,
          title: title.trim(),
          content_md: content,
          source: 'web',
        },
        { confirm: true },
      )
    },
  })

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setVersionConflict(false)
    try {
      const response = await mutation.mutateAsync()
      onSaved(response.data)
      showToast({
        kind: 'success',
        message: creating ? '资料已创建' : '资料已保存',
      })
    } catch (caught) {
      if (caught instanceof AbeiApiError && caught.status === 409) {
        setError(`${caught.detail ?? caught.message} 当前草稿仍保留，请重新读取后再保存。`)
        setVersionConflict(!creating)
      } else {
        setError(caught instanceof AbeiApiError ? (caught.detail ?? caught.message) : '资料保存失败')
      }
    }
  }

  const canSave = dirty && validSlug && title.trim().length > 0 && title.trim().length <= 200 && contentBytes <= MAX_CONTENT_BYTES

  return (
    <Card padded={false} className="flex min-w-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-[var(--text-primary)]">{creating ? '新建资料' : document.title}</h2>
          {!creating && (
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              v{document.version} · {formatDateTime(document.updated_at)}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl
            aria-label="资料视图"
            value={mode}
            onChange={setMode}
            segments={[
              { value: 'edit', label: '编辑' },
              { value: 'preview', label: '预览' },
            ]}
          />
          {!creating && onDelete && (
            <IconButton label="删除资料" variant="ghost-danger" disabled={mutation.isPending} onClick={onDelete}>
              <Trash aria-hidden className="size-4" />
            </IconButton>
          )}
        </div>
      </div>

      <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => void submit(event)}>
        {mode === 'edit' ? (
          <div className="flex flex-1 flex-col gap-4 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Slug" hint="小写字母、数字和中划线，最多 64 个字符" error={slug !== '' && !validSlug ? 'Slug 格式不正确' : undefined}>
                <Input
                  required
                  disabled={!creating}
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  pattern="[a-z0-9][a-z0-9-]{0,63}"
                  maxLength={64}
                />
              </Field>
              <Field label="标题" hint={`${title.trim().length}/200`}>
                <Input required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} />
              </Field>
            </div>
            <Field
              label="Markdown 正文"
              hint={`${formatBytes(contentBytes)} / 1 MiB`}
              error={contentBytes > MAX_CONTENT_BYTES ? 'Markdown 正文不能超过 1 MiB' : undefined}
            >
              <Textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                spellCheck={false}
                className="min-h-[420px] flex-1 resize-y font-mono text-[13px] leading-6"
              />
            </Field>
          </div>
        ) : (
          <article className="min-h-[520px] overflow-auto px-5 py-4 text-sm leading-7 text-[var(--text-primary)]">
            {content === '' ? (
              <p className="text-[var(--text-secondary)]">暂无正文</p>
            ) : (
              <Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrl} components={MARKDOWN_COMPONENTS}>
                {content}
              </Markdown>
            )}
          </article>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border-subtle)] px-4 py-3">
          <div className="min-w-0 flex-1">
            {error && (
              <p role="alert" className="text-sm text-[var(--danger)]">
                {error}
              </p>
            )}
          </div>
          {versionConflict && onReload && (
            <Button variant="secondary" size="md" onClick={onReload}>
              重新载入
            </Button>
          )}
          <Button type="submit" variant="primary" size="md" disabled={!canSave || mutation.isPending}>
            <FloppyDisk aria-hidden className="size-4" />
            {mutation.isPending ? '保存中…' : '保存'}
          </Button>
        </div>
      </form>
    </Card>
  )
}

function DeleteProfileDocDialog({
  document,
  onClose,
  onDeleted,
}: {
  document: ProfileDoc
  onClose: () => void
  onDeleted: (slug: string) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const mutation = useMutation({
    mutationFn: () => apiDeleteJson(
      `/v1/profile-doc/${document.slug}`,
      { expected_version: document.version },
      { confirm: true },
    ),
  })

  async function remove() {
    setError(null)
    try {
      await mutation.mutateAsync()
      showToast({ kind: 'success', message: '资料已删除' })
      onDeleted(document.slug)
    } catch (caught) {
      setError(caught instanceof AbeiApiError ? (caught.detail ?? caught.message) : '资料删除失败')
    }
  }

  return (
    <ConfirmDialog
      open
      title="删除资料文档"
      confirmLabel="永久删除"
      pending={mutation.isPending}
      onConfirm={() => void remove()}
      onClose={onClose}
    >
      <p>“{document.title}”及其全部历史版本将被永久删除，无法恢复。</p>
      <p>当前未保存的修改也会丢失。</p>
      {error && <p role="alert" className="text-[var(--danger)]">{error}</p>}
    </ConfirmDialog>
  )
}

function safeMarkdownUrl(url: string): string {
  if (/^(?:#|\/|\.\/|\.\.\/|\?)/.test(url)) return url
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol) ? url : ''
  } catch {
    return ''
  }
}

const MARKDOWN_COMPONENTS = {
  h1: ({ children }: { children?: React.ReactNode }) => <h1 className="mb-4 mt-2 text-xl font-semibold text-[var(--text-primary)]">{children}</h1>,
  h2: ({ children }: { children?: React.ReactNode }) => <h2 className="mb-2 mt-6 text-lg font-semibold text-[var(--text-primary)]">{children}</h2>,
  h3: ({ children }: { children?: React.ReactNode }) => <h3 className="mb-2 mt-5 text-base font-semibold text-[var(--text-primary)]">{children}</h3>,
  p: ({ children }: { children?: React.ReactNode }) => <p className="my-3">{children}</p>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="my-3 list-disc pl-6">{children}</ul>,
  ol: ({ children }: { children?: React.ReactNode }) => <ol className="my-3 list-decimal pl-6">{children}</ol>,
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-4 border-l-2 border-[var(--border-strong)] pl-4 text-[var(--text-secondary)]">{children}</blockquote>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="rounded bg-[var(--surface-hover)] px-1 py-0.5 font-mono text-[0.9em]">{children}</code>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-[var(--brand-text)] underline underline-offset-2">
      {children}
    </a>
  ),
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border border-[var(--border-subtle)] bg-[var(--surface-hover)] px-2 py-1.5 font-semibold">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => <td className="border border-[var(--border-subtle)] px-2 py-1.5">{children}</td>,
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`
}
