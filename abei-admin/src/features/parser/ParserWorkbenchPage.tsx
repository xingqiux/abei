import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Copy,
  FloppyDisk,
  Play,
  Plus,
  RocketLaunch,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react'
import {
  cloneParserFlow,
  createParserFlow,
  createParserTestCase,
  getParserFlow,
  getParserFlows,
  getParserVersion,
  getParserVersions,
  previewParserPublish,
  publishParserFlow,
  retireParserFlow,
  rollbackParserFlow,
  testParserEml,
  testParserFlow,
  updateParserFlow,
  type ParseOutput,
  type ParserBreakingChange,
  type ParserFlowDefinition,
  type ParserNode,
  type ParserVersionDetail,
} from '../../api/parser'
import { getMailSamples } from '../../api/mail'
import { AbeiApiError } from '../../api/client'
import { EmptyState } from '../../components/abei/EmptyState'
import { ErrorState, InlineError } from '../../components/abei/ErrorState'
import { Modal } from '../../components/abei/Modal'
import { StatusChip } from '../../components/abei/StatusChip'
import { Button, IconButton } from '../../components/ui/Button'
import { CONTROL_COMPACT, Field, Input } from '../../components/ui/Field'
import { Tabs } from '../../components/ui/Tabs'
import { showToast } from '../../store/toastStore'
import { ParserNodeEditor } from './ParserNodeEditor'
import { ParserResultsPane, type ResultTab } from './ParserResultsPane'
import {
  NODE_TEMPLATES,
  addNode,
  defaultSlug,
  emptyFlow,
  flowYaml,
  moveNode,
  nodeLabel,
  parseFlow,
} from './parserFlow'

type EditorMode = 'node' | 'source'
type ConfirmAction = {
  type: 'publish'
  checksum: string
  cases: number
  baselineVersion: number | null
  changes: ParserBreakingChange[]
} | { type: 'rollback'; version: number } | { type: 'retire' }

interface EditorState {
  id: string | null
  owner: 'system' | 'user'
  name: string
  slug: string
  definition: ParserFlowDefinition
}

const EDITOR_TABS = [
  { value: 'node', label: '节点参数' },
  { value: 'source', label: '完整 YAML' },
] as const

function newEditor(): EditorState {
  return {
    id: null,
    owner: 'user',
    name: '新解析流程',
    slug: `flow-${Date.now().toString(36)}`,
    definition: emptyFlow(),
  }
}

export function ParserWorkbenchPage() {
  const queryClient = useQueryClient()
  const search = useRouterState({ select: (state) => state.location.search as { flow?: string; sample?: string } })
  const [selectedFlowId, setSelectedFlowId] = useState<string | 'new' | null>(search.flow ?? null)
  const [editor, setEditor] = useState<EditorState>(() => newEditor())
  const [baseline, setBaseline] = useState('')
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedSampleId, setSelectedSampleId] = useState<string>(search.sample ?? '')
  const [output, setOutput] = useState<ParseOutput | null>(null)
  const [editorMode, setEditorMode] = useState<EditorMode>('node')
  const [resultTab, setResultTab] = useState<ResultTab>('steps')
  const [nodeType, setNodeType] = useState('select_attachment')
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [inspectedVersion, setInspectedVersion] = useState<number | null>(null)
  const emlInputRef = useRef<HTMLInputElement>(null)

  const flowsQuery = useQuery({ queryKey: ['parser-flows'], queryFn: getParserFlows })
  const flows = flowsQuery.data?.data ?? []
  const detailQuery = useQuery({
    queryKey: ['parser-flow', selectedFlowId],
    queryFn: () => getParserFlow(selectedFlowId as string),
    enabled: selectedFlowId !== null && selectedFlowId !== 'new',
  })
  const samplesQuery = useQuery({ queryKey: ['mail-samples'], queryFn: getMailSamples })
  const samples = samplesQuery.data?.data ?? []
  const versionsQuery = useQuery({
    queryKey: ['parser-versions', editor.id],
    queryFn: () => getParserVersions(editor.id as string),
    enabled: editor.id !== null,
  })
  const versionQuery = useQuery({
    queryKey: ['parser-version', editor.id, inspectedVersion],
    queryFn: () => getParserVersion(editor.id as string, inspectedVersion as number),
    enabled: editor.id !== null && inspectedVersion !== null,
  })

  useEffect(() => {
    if (selectedFlowId !== null || flowsQuery.isLoading) return
    setSelectedFlowId(flows[0]?.id ?? 'new')
  }, [flows, flowsQuery.isLoading, selectedFlowId])

  useEffect(() => {
    const detail = detailQuery.data?.data
    if (!detail || detail.id !== selectedFlowId) return
    const next: EditorState = {
      id: detail.id,
      owner: detail.attributes.owner,
      name: detail.attributes.name,
      slug: detail.attributes.slug,
      definition: structuredClone(detail.attributes.draft_definition),
    }
    setEditor(next)
    setBaseline(editorFingerprint(next))
    setSelectedNodeId(next.definition.nodes[0]?.id ?? null)
    setOutput(null)
    setInspectedVersion(null)
  }, [detailQuery.data, selectedFlowId])

  useEffect(() => {
    if (selectedFlowId !== 'new') return
    const next = newEditor()
    setEditor(next)
    setBaseline('')
    setSelectedNodeId(next.definition.nodes[0]?.id ?? null)
    setOutput(null)
    setInspectedVersion(null)
  }, [selectedFlowId])

  useEffect(() => {
    if (selectedSampleId || samples.length === 0) return
    const preferred = samples.find((sample) => sample.purpose === 'parser') ?? samples[0]
    setSelectedSampleId(preferred?.id ?? '')
  }, [samples, selectedSampleId])

  useEffect(() => {
    if (selectedNodeId && editor.definition.nodes.some((node) => node.id === selectedNodeId)) return
    setSelectedNodeId(editor.definition.nodes[0]?.id ?? null)
  }, [editor.definition.nodes, selectedNodeId])

  const dirty = editor.id === null || editorFingerprint(editor) !== baseline
  const readOnly = editor.owner === 'system'
  const validation = validateEditor(editor)
  const selectedNode = editor.definition.nodes.find((node) => node.id === selectedNodeId) ?? null
  const detail = detailQuery.data?.data
  const selectedSample = samples.find((sample) => sample.id === selectedSampleId)

  function applyDefinition(definition: ParserFlowDefinition) {
    setEditor((current) => ({ ...current, definition }))
    setOutput(null)
  }

  function replaceSelectedNode(node: ParserNode) {
    applyDefinition({
      ...editor.definition,
      nodes: editor.definition.nodes.map((item) => item.id === selectedNodeId ? node : item),
    })
    if (node.id !== selectedNodeId) setSelectedNodeId(node.id)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const source_yaml = flowYaml(editor.definition)
      return editor.id
        ? updateParserFlow(editor.id, { name: editor.name.trim(), source_yaml })
        : createParserFlow({ name: editor.name.trim(), slug: editor.slug.trim(), source_yaml })
    },
    onSuccess: (response) => {
      const detail = response.data
      const next: EditorState = {
        id: detail.id,
        owner: detail.attributes.owner,
        name: detail.attributes.name,
        slug: detail.attributes.slug,
        definition: structuredClone(detail.attributes.draft_definition),
      }
      setEditor(next)
      setBaseline(editorFingerprint(next))
      setSelectedFlowId(detail.id)
      void queryClient.invalidateQueries({ queryKey: ['parser-flows'] })
      queryClient.setQueryData(['parser-flow', detail.id], response)
      showToast({ kind: 'success', message: '解析流程草稿已保存' })
    },
    onError: mutationError('解析流程保存失败'),
  })

  const cloneMutation = useMutation({
    mutationFn: () => cloneParserFlow(editor.id as string, {
      name: `${editor.name} 副本`,
      slug: `${defaultSlug(editor.slug)}-${Date.now().toString(36)}`,
    }),
    onSuccess: (response) => {
      void queryClient.invalidateQueries({ queryKey: ['parser-flows'] })
      setSelectedFlowId(response.data.id)
      showToast({ kind: 'success', message: '已创建可编辑副本' })
    },
    onError: mutationError('复制解析流程失败'),
  })

  const testMutation = useMutation({
    mutationFn: () => testParserFlow(editor.id as string, {
      mail_sample_id: Number(selectedSampleId),
      source_yaml: flowYaml(editor.definition),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    }),
    onSuccess: (response) => {
      setOutput(response.data.output)
      setResultTab('steps')
      const last = response.data.output.node_results.at(-1)
      if (last) setSelectedNodeId(last.node_id)
      showToast({ kind: 'success', message: `解析完成：${response.data.output.valid_rows.length} 条有效记录` })
    },
    onError: mutationError('解析测试失败'),
  })

  const emlTestMutation = useMutation({
    mutationFn: (eml: File) => testParserEml(editor.id as string, {
      eml,
      source_yaml: flowYaml(editor.definition),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    }),
    onSuccess: (response) => {
      setOutput(response.data.output)
      setResultTab('steps')
      const last = response.data.output.node_results.at(-1)
      if (last) setSelectedNodeId(last.node_id)
      showToast({ kind: 'success', message: `EML 解析完成：${response.data.output.valid_rows.length} 条有效记录` })
    },
    onError: mutationError('EML 解析测试失败'),
  })

  const testCaseMutation = useMutation({
    mutationFn: () => createParserTestCase(editor.id as string, {
      name: selectedSample?.name || '解析样本',
      mail_sample_id: Number(selectedSampleId),
      expected: {
        valid_rows: output?.valid_rows.length ?? 0,
        invalid_rows: output?.invalid_rows.length ?? 0,
        warnings: output?.warnings.length ?? 0,
      },
      enabled: true,
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['parser-flow', editor.id] })
      showToast({ kind: 'success', message: '已加入发布门禁' })
    },
    onError: mutationError('测试用例保存失败'),
  })

  const publishPreviewMutation = useMutation({
    mutationFn: () => previewParserPublish(editor.id as string),
    onSuccess: (response) => setConfirmAction({
      type: 'publish',
      checksum: response.data.checksum,
      cases: response.data.test_cases.length,
      baselineVersion: response.data.comparison.baseline_version,
      changes: response.data.comparison.changes,
    }),
    onError: mutationError('发布检查失败'),
  })
  const publishMutation = useMutation({
    mutationFn: () => publishParserFlow(editor.id as string),
    onSuccess: (response) => {
      setConfirmAction(null)
      queryClient.setQueryData(['parser-flow', editor.id], response)
      void queryClient.invalidateQueries({ queryKey: ['parser-flows'] })
      void queryClient.invalidateQueries({ queryKey: ['parser-versions', editor.id] })
      showToast({ kind: 'success', message: `解析流程 v${response.data.attributes.current_version} 已发布` })
    },
    onError: mutationError('解析流程发布失败'),
  })
  const rollbackMutation = useMutation({
    mutationFn: (version: number) => rollbackParserFlow(editor.id as string, version),
    onSuccess: (response) => {
      setConfirmAction(null)
      queryClient.setQueryData(['parser-flow', editor.id], response)
      void queryClient.invalidateQueries({ queryKey: ['parser-flows'] })
      showToast({ kind: 'success', message: `已回滚到版本 ${response.data.attributes.current_version}` })
    },
    onError: mutationError('解析流程回滚失败'),
  })
  const retireMutation = useMutation({
    mutationFn: () => retireParserFlow(editor.id as string),
    onSuccess: (response) => {
      setConfirmAction(null)
      queryClient.setQueryData(['parser-flow', editor.id], response)
      void queryClient.invalidateQueries({ queryKey: ['parser-flows'] })
      showToast({ kind: 'success', message: '解析流程已停用' })
    },
    onError: mutationError('解析流程停用失败'),
  })

  const versionDetail = versionQuery.data?.data ?? null

  if (flowsQuery.isError) {
    return <ErrorState message="解析流程加载失败" error={flowsQuery.error} onRetry={() => void flowsQuery.refetch()} />
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold text-[var(--text-primary)]">解析工作台</h1>
            {editor.id && (
              <StatusChip
                label={detail?.attributes.status === 'published' ? `已发布 v${detail.attributes.current_version}` : detail?.attributes.status === 'retired' ? '已停用' : '草稿'}
                kind={detail?.attributes.status === 'published' ? 'ok' : detail?.attributes.status === 'retired' ? 'muted' : 'accent'}
              />
            )}
            {dirty && !readOnly && <StatusChip label="有未保存修改" kind="warn" />}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="解析流程"
            className={`${CONTROL_COMPACT} min-w-[210px]`}
            value={selectedFlowId ?? ''}
            onChange={(event) => setSelectedFlowId(event.target.value as string | 'new')}
          >
            <option value="new">新解析流程</option>
            {flows.map((flow) => (
              <option key={flow.id} value={flow.id}>{flow.attributes.name}{flow.attributes.owner === 'system' ? ' · 内建' : ''}</option>
            ))}
          </select>
          <IconButton label="新建解析流程" variant="secondary" onClick={() => setSelectedFlowId('new')}>
            <Plus aria-hidden className="size-4" />
          </IconButton>
          {readOnly ? (
            <Button variant="primary" disabled={cloneMutation.isPending} onClick={() => cloneMutation.mutate()}>
              <Copy aria-hidden className="size-4" />{cloneMutation.isPending ? '复制中…' : '复制后编辑'}
            </Button>
          ) : (
            <>
              <Button variant="secondary" disabled={Boolean(validation) || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
                <FloppyDisk aria-hidden className="size-4" />{saveMutation.isPending ? '保存中…' : '保存草稿'}
              </Button>
              <Button
                variant="primary"
                disabled={!editor.id || dirty || Boolean(validation) || publishPreviewMutation.isPending}
                onClick={() => publishPreviewMutation.mutate()}
              >
                <RocketLaunch aria-hidden className="size-4" />{publishPreviewMutation.isPending ? '检查中…' : '发布'}
              </Button>
              {editor.id && (
                <IconButton label="停用解析流程" variant="ghost-danger" onClick={() => setConfirmAction({ type: 'retire' })}>
                  <Archive aria-hidden className="size-4" />
                </IconButton>
              )}
            </>
          )}
        </div>
      </header>

      {validation && <InlineError message={validation} />}
      {detailQuery.isError && <InlineError message="解析流程详情加载失败" error={detailQuery.error} onRetry={() => void detailQuery.refetch()} />}

      <div className="grid min-h-[690px] overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-1)] xl:grid-cols-[250px_minmax(360px,1.05fr)_minmax(380px,1fr)]">
        <section className="flex min-h-0 flex-col border-b border-[var(--border-subtle)] xl:border-r xl:border-b-0">
          <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] p-3">
            <select aria-label="新增节点类型" className={`${CONTROL_COMPACT} min-w-0 flex-1`} value={nodeType} disabled={readOnly} onChange={(event) => setNodeType(event.target.value)}>
              {NODE_TEMPLATES.map((template) => <option key={template.type} value={template.type}>{template.label}</option>)}
            </select>
            <IconButton
              label="添加节点"
              variant="secondary"
              disabled={readOnly}
              onClick={() => {
                const definition = addNode(editor.definition, nodeType)
                applyDefinition(definition)
                setSelectedNodeId(definition.nodes.at(-1)?.id ?? null)
              }}
            >
              <Plus aria-hidden className="size-4" />
            </IconButton>
          </div>
          <ol className="min-h-0 flex-1 divide-y divide-[var(--border-subtle)] overflow-y-auto xl:max-h-[635px]">
            {editor.definition.nodes.map((node, index) => (
              <li key={`${node.id}:${index}`} className={selectedNodeId === node.id ? 'bg-[var(--surface-selected)]' : ''}>
                <div className="grid grid-cols-[24px_minmax(0,1fr)_52px] items-center gap-2 px-2 py-2">
                  <input
                    aria-label={`${node.id} 启用状态`}
                    type="checkbox"
                    checked={node.enabled !== false}
                    disabled={readOnly}
                    className="size-3.5 accent-[var(--brand)]"
                    onChange={(event) => applyDefinition({
                      ...editor.definition,
                      nodes: editor.definition.nodes.map((item, itemIndex) => itemIndex === index ? { ...item, enabled: event.target.checked } : item),
                    })}
                  />
                  <button type="button" className="min-w-0 text-left" onClick={() => setSelectedNodeId(node.id)}>
                    <span className="block truncate text-xs font-semibold text-[var(--text-primary)]">{nodeLabel(node.type)}</span>
                    <span className="block truncate font-mono text-[10px] text-[var(--text-tertiary)]">{node.id}</span>
                  </button>
                  <span className="flex items-center justify-end">
                    <IconButton label="上移节点" disabled={readOnly || index === 0} onClick={() => applyDefinition(moveNode(editor.definition, index, -1))}>
                      <ArrowUp aria-hidden className="size-3.5" />
                    </IconButton>
                    <IconButton label="下移节点" disabled={readOnly || index === editor.definition.nodes.length - 1} onClick={() => applyDefinition(moveNode(editor.definition, index, 1))}>
                      <ArrowDown aria-hidden className="size-3.5" />
                    </IconButton>
                  </span>
                </div>
                {selectedNodeId === node.id && !readOnly && (
                  <div className="flex justify-end px-2 pb-2">
                    <IconButton
                      label="删除节点"
                      variant="ghost-danger"
                      onClick={() => applyDefinition({ ...editor.definition, nodes: editor.definition.nodes.filter((_, itemIndex) => itemIndex !== index) })}
                    >
                      <Trash aria-hidden className="size-3.5" />
                    </IconButton>
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>

        <section className="min-w-0 border-b border-[var(--border-subtle)] xl:border-r xl:border-b-0">
          <div className="grid gap-3 border-b border-[var(--border-subtle)] p-4 sm:grid-cols-2">
            <Field label="流程名称"><Input value={editor.name} disabled={readOnly} onChange={(event) => setEditor({ ...editor, name: event.target.value })} /></Field>
            <Field label="Slug"><Input className="font-mono" value={editor.slug} disabled={readOnly || editor.id !== null} onChange={(event) => setEditor({ ...editor, slug: event.target.value })} /></Field>
            <Field label="渠道标识"><Input className="font-mono" value={editor.definition.channel_key} disabled={readOnly} onChange={(event) => applyDefinition({ ...editor.definition, channel_key: event.target.value })} /></Field>
            <Field label="账单类型"><Input value={editor.definition.statement_kind ?? ''} disabled={readOnly} onChange={(event) => applyDefinition({ ...editor.definition, statement_kind: event.target.value || null })} /></Field>
          </div>
          <div className="px-4 pt-3">
            <Tabs tabs={EDITOR_TABS} value={editorMode} onChange={setEditorMode} aria-label="流程编辑方式" />
          </div>
          {editorMode === 'node' ? (
            <ParserNodeEditor node={selectedNode} readOnly={readOnly} onChange={replaceSelectedNode} />
          ) : (
            <FlowSourceEditor definition={editor.definition} readOnly={readOnly} onChange={applyDefinition} />
          )}
        </section>

        <section className="flex min-w-0 flex-col">
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 border-b border-[var(--border-subtle)] p-3">
            <select aria-label="解析邮件样本" className={CONTROL_COMPACT} value={selectedSampleId} onChange={(event) => setSelectedSampleId(event.target.value)}>
              <option value="">选择邮件样本</option>
              {samples.map((sample) => <option key={sample.id} value={sample.id}>{sample.name} · {sample.message.subject || sample.message.from_address || sample.message.id}</option>)}
            </select>
            <Button
              variant="secondary"
              disabled={!editor.id || !selectedSampleId || Boolean(validation) || testMutation.isPending || emlTestMutation.isPending}
              onClick={() => testMutation.mutate()}
            >
              <Play aria-hidden className="size-4" />{testMutation.isPending ? '运行中…' : '运行'}
            </Button>
            <input
              ref={emlInputRef}
              type="file"
              accept=".eml,message/rfc822"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (!file) return
                if (file.size > 25 * 1024 * 1024) {
                  showToast({ kind: 'error', message: 'EML 不能超过 25 MiB' })
                  return
                }
                emlTestMutation.mutate(file)
              }}
            />
            <IconButton
              label="上传 EML 运行"
              variant="secondary"
              disabled={!editor.id || Boolean(validation) || testMutation.isPending || emlTestMutation.isPending}
              onClick={() => emlInputRef.current?.click()}
            >
              <UploadSimple aria-hidden className="size-4" />
            </IconButton>
          </div>
          {output && !readOnly && (
            <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-3 py-2">
              <span className="text-xs text-[var(--text-secondary)]">本次结果：{output.valid_rows.length} 条有效，{output.invalid_rows.length} 条无效</span>
              <Button
                variant="ghost"
                size="xs"
                disabled={dirty || testCaseMutation.isPending}
                onClick={() => testCaseMutation.mutate()}
              >
                <Plus aria-hidden className="size-3.5" />{testCaseMutation.isPending ? '保存中…' : '加入发布门禁'}
              </Button>
            </div>
          )}
          <ParserResultsPane
            tab={resultTab}
            output={output}
            selectedNodeId={selectedNodeId}
            versions={versionsQuery.data?.data ?? []}
            versionDetail={versionDetail as ParserVersionDetail | null}
            testCases={detail?.attributes.test_cases ?? []}
            readOnly={readOnly}
            onTabChange={setResultTab}
            onSelectNode={(id) => {
              setSelectedNodeId(id)
              setEditorMode('node')
            }}
            onInspectVersion={(version) => {
              setInspectedVersion(version)
              setResultTab('versions')
            }}
            onRollback={(version) => setConfirmAction({ type: 'rollback', version })}
          />
        </section>
      </div>

      {samples.length === 0 && !samplesQuery.isLoading && (
        <EmptyState message="还没有固定的邮件样本" action={{ label: '去邮件工作台选择', to: '/mail' }} />
      )}

      <ConfirmDialog
        action={confirmAction}
        pending={publishMutation.isPending || rollbackMutation.isPending || retireMutation.isPending}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          if (confirmAction?.type === 'publish') publishMutation.mutate()
          if (confirmAction?.type === 'rollback') rollbackMutation.mutate(confirmAction.version)
          if (confirmAction?.type === 'retire') retireMutation.mutate()
        }}
      />
    </div>
  )
}

function FlowSourceEditor({
  definition,
  readOnly,
  onChange,
}: {
  definition: ParserFlowDefinition
  readOnly: boolean
  onChange: (definition: ParserFlowDefinition) => void
}) {
  const [source, setSource] = useState(() => flowYaml(definition))
  const [error, setError] = useState<string | null>(null)
  const locallyEmitted = useRef<string | null>(null)

  useEffect(() => {
    const incoming = flowYaml(definition)
    if (incoming === locallyEmitted.current) {
      locallyEmitted.current = null
      return
    }
    setSource(incoming)
    setError(null)
  }, [definition])

  function update(next: string) {
    setSource(next)
    const parsed = parseFlow(next)
    setError(parsed.error)
    if (parsed.definition) {
      locallyEmitted.current = flowYaml(parsed.definition)
      onChange(parsed.definition)
    }
  }

  return (
    <div className="p-4">
      <textarea
        aria-label="完整流程 YAML"
        spellCheck={false}
        disabled={readOnly}
        value={source}
        onChange={(event) => update(event.target.value)}
        className="min-h-[460px] w-full resize-y rounded-md bg-[var(--surface-0)] p-3 font-mono text-xs leading-5 text-[var(--text-primary)] outline-1 -outline-offset-1 outline-[var(--border-strong)] focus:outline-2 focus:-outline-offset-2 focus:outline-[var(--focus-ring)] disabled:opacity-60"
      />
      {error && <div className="mt-3"><InlineError message={error} /></div>}
    </div>
  )
}

function ConfirmDialog({
  action,
  pending,
  onClose,
  onConfirm,
}: {
  action: ConfirmAction | null
  pending: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const title = action?.type === 'publish' ? '发布解析流程' : action?.type === 'rollback' ? '回滚解析流程' : '停用解析流程'
  return (
    <Modal
      open={action !== null}
      onClose={() => { if (!pending) onClose() }}
      title={title}
      footer={
        <>
          <Button variant="secondary" size="md" disabled={pending} onClick={onClose}>取消</Button>
          <Button variant={action?.type === 'retire' ? 'danger' : 'primary'} size="md" disabled={pending} onClick={onConfirm}>
            {pending ? '处理中…' : action?.type === 'publish' ? '确认发布' : action?.type === 'rollback' ? '确认回滚' : '确认停用'}
          </Button>
        </>
      }
    >
      {action?.type === 'publish' && (
        <div className="space-y-2">
          <p>发布门禁已通过 {action.cases} 个测试用例。</p>
          {action.baselineVersion !== null && action.changes.length === 0 && (
            <p className="text-sm text-[var(--text-secondary)]">与版本 {action.baselineVersion} 对拍未发现破坏性变化。</p>
          )}
          {action.changes.length > 0 && (
            <div className="border-l-2 border-[var(--attention)] pl-3">
              <p className="text-sm font-semibold text-[var(--text-primary)]">发现 {action.changes.length} 项结果变化</p>
              <ul className="mt-2 max-h-44 space-y-1 overflow-auto text-xs text-[var(--text-secondary)]">
                {action.changes.map((change, index) => (
                  <li key={`${change.case_id}:${change.code}:${index}`}>{breakingChangeText(change)}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="break-all font-mono text-[11px] text-[var(--text-secondary)]">{action.checksum}</p>
        </div>
      )}
      {action?.type === 'rollback' && <p>草稿和当前发布指针将恢复到版本 {action.version}，历史版本不会删除。</p>}
      {action?.type === 'retire' && <p>邮件规则将不能再选择这个流程；历史运行仍保留。</p>}
    </Modal>
  )
}

function breakingChangeText(change: ParserBreakingChange): string {
  if (change.code === 'valid_rows_decreased') return `${change.case_name}：有效行从 ${String(change.before)} 减少到 ${String(change.after)}`
  if (change.code === 'amount_total_changed') return `${change.case_name}：${change.currency_code ?? ''} 合计从 ${String(change.before)} 变为 ${String(change.after)}`
  return `${change.case_name}：${change.row ?? '账单行'} 的 ${change.field ?? '字段'} 变为空`
}

function editorFingerprint(editor: EditorState): string {
  return JSON.stringify({ name: editor.name.trim(), definition: editor.definition })
}

function validateEditor(editor: EditorState): string | null {
  if (!editor.name.trim()) return '请填写流程名称。'
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(editor.slug.trim())) return 'Slug 只能使用小写字母、数字、中划线和下划线。'
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(editor.definition.channel_key.trim())) return '渠道标识格式不正确。'
  if (editor.definition.nodes.length === 0) return '流程至少需要一个节点。'
  const ids = new Set<string>()
  for (const node of editor.definition.nodes) {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(node.id)) return `节点 ID ${node.id || '（空）'} 格式不正确。`
    if (ids.has(node.id)) return `节点 ID ${node.id} 重复。`
    ids.add(node.id)
  }
  return null
}

function mutationError(fallback: string) {
  return (error: Error) => showToast({
    kind: 'error',
    message: error instanceof AbeiApiError ? error.message : fallback,
    duration: 7000,
  })
}
