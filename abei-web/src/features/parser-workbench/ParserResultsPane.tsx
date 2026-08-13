import { ArrowCounterClockwise, CheckCircle, FileText, Warning } from '@phosphor-icons/react'
import type {
  ParseOutput,
  ParserNodeResult,
  ParserTestCase,
  ParserVersion,
  ParserVersionDetail,
} from '../../api/parser'
import { EmptyState } from '../../components/abei/EmptyState'
import { StatusChip } from '../../components/abei/StatusChip'
import { Button } from '../../components/ui/Button'
import { Tabs } from '../../components/ui/Tabs'

export type ResultTab = 'steps' | 'rows' | 'issues' | 'versions'

const RESULT_TABS = [
  { value: 'steps', label: '执行步骤' },
  { value: 'rows', label: '账单行' },
  { value: 'issues', label: '诊断' },
  { value: 'versions', label: '版本' },
] as const

export function ParserResultsPane({
  tab,
  output,
  selectedNodeId,
  versions,
  versionDetail,
  testCases,
  readOnly,
  onTabChange,
  onSelectNode,
  onInspectVersion,
  onRollback,
}: {
  tab: ResultTab
  output: ParseOutput | null
  selectedNodeId: string | null
  versions: ParserVersion[]
  versionDetail: ParserVersionDetail | null
  testCases: ParserTestCase[]
  readOnly: boolean
  onTabChange: (tab: ResultTab) => void
  onSelectNode: (nodeId: string) => void
  onInspectVersion: (version: number) => void
  onRollback: (version: number) => void
}) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="px-4 pt-3">
        <Tabs
          tabs={RESULT_TABS.map((item) => ({
            ...item,
            count: item.value === 'rows'
              ? output?.valid_rows.length
              : item.value === 'issues'
                ? (output?.invalid_rows.length ?? 0) + (output?.warnings.length ?? 0)
                : item.value === 'versions'
                  ? versions.length
                  : undefined,
          }))}
          value={tab}
          onChange={onTabChange}
          aria-label="解析结果"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4 lg:max-h-[650px]">
        {tab === 'steps' && (
          <StepResults
            output={output}
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectNode}
          />
        )}
        {tab === 'rows' && <BillRows output={output} onOpenIssues={() => onTabChange('issues')} />}
        {tab === 'issues' && <Issues output={output} onOpenRows={() => onTabChange('rows')} />}
        {tab === 'versions' && (
          <Versions
            versions={versions}
            versionDetail={versionDetail}
            testCases={testCases}
            readOnly={readOnly}
            onInspect={onInspectVersion}
            onRollback={onRollback}
          />
        )}
      </div>
    </div>
  )
}

function StepResults({
  output,
  selectedNodeId,
  onSelectNode,
}: {
  output: ParseOutput | null
  selectedNodeId: string | null
  onSelectNode: (nodeId: string) => void
}) {
  if (!output) {
    return <EmptyState compact icon={<FileText className="size-7" />} message="尚未运行解析" action={{ label: '选择邮件样本', to: '/mail-workbench' }} />
  }
  const selected = output.node_results.find((result) => result.node_id === selectedNodeId)
    ?? output.node_results.at(-1)
    ?? null
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 gap-3 border-b border-[var(--border-subtle)] pb-4 text-center">
        <Metric label="耗时" value={`${output.metrics.duration_ms} ms`} />
        <Metric label="有效" value={String(output.metrics.valid_rows)} />
        <Metric label="无效" value={String(output.metrics.invalid_rows)} />
      </dl>
      <ol className="space-y-1">
        {output.node_results.map((result) => (
          <li key={result.node_id}>
            <button
              type="button"
              aria-current={selected?.node_id === result.node_id ? 'step' : undefined}
              onClick={() => onSelectNode(result.node_id)}
              className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2.5 py-2 text-left text-xs transition-colors ${selected?.node_id === result.node_id ? 'bg-[var(--surface-selected)]' : 'hover:bg-[var(--surface-hover)]'}`}
            >
              <span className="min-w-0 truncate font-medium text-[var(--text-primary)]">{result.node_id}</span>
              <span className="tabular-nums text-[var(--text-tertiary)]">{result.input_count} → {result.output_count} · {result.duration_ms} ms</span>
            </button>
          </li>
        ))}
      </ol>
      {selected && <NodePreview result={selected} />}
    </div>
  )
}

function NodePreview({ result }: { result: ParserNodeResult }) {
  return (
    <div className="border-t border-[var(--border-subtle)] pt-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold text-[var(--text-secondary)]">{result.node_id} 输出</h3>
        <StatusChip label={`${result.output_count} 项`} kind={result.diagnostics.length > 0 ? 'warn' : 'ok'} />
      </div>
      <pre className="max-h-72 overflow-auto rounded-md bg-[var(--surface-0)] p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-[var(--text-secondary)]">
        {JSON.stringify(result.preview, null, 2)}
      </pre>
    </div>
  )
}

function BillRows({ output, onOpenIssues }: { output: ParseOutput | null; onOpenIssues: () => void }) {
  if (!output) return <EmptyState compact icon={<FileText className="size-7" />} message="尚未运行解析" action={{ label: '选择邮件样本', to: '/mail-workbench' }} />
  if (output.valid_rows.length === 0) return <EmptyState compact icon={<FileText className="size-7" />} message="没有有效账单行" action={{ label: '查看诊断', onClick: onOpenIssues }} />
  return (
    <div className="overflow-x-auto rounded-md border border-[var(--border-subtle)]">
      <table className="min-w-[680px] w-full text-left text-xs">
        <thead className="bg-[var(--surface-0)] text-[var(--text-secondary)]">
          <tr>
            <th className="px-3 py-2 font-semibold">时间</th>
            <th className="px-3 py-2 font-semibold">描述</th>
            <th className="px-3 py-2 font-semibold">对方</th>
            <th className="px-3 py-2 text-right font-semibold">金额</th>
            <th className="px-3 py-2 font-semibold">来源</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--border-subtle)]">
          {output.valid_rows.map((row, index) => (
            <tr key={`${row.provider_transaction_id ?? row.occurred_at}:${index}`}>
              <td className="whitespace-nowrap px-3 py-2 text-[var(--text-secondary)]">{row.occurred_at}</td>
              <td className="max-w-56 truncate px-3 py-2 font-medium text-[var(--text-primary)]">{row.description}</td>
              <td className="max-w-40 truncate px-3 py-2 text-[var(--text-secondary)]">{row.counterparty ?? '—'}</td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-[var(--text-primary)]">{row.signed_amount} {row.currency_code}</td>
              <td className="whitespace-nowrap px-3 py-2 text-[var(--text-tertiary)]">{locatorText(row.source_locator)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Issues({ output, onOpenRows }: { output: ParseOutput | null; onOpenRows: () => void }) {
  if (!output) return <EmptyState compact icon={<Warning className="size-7" />} message="尚未运行解析" action={{ label: '选择邮件样本', to: '/mail-workbench' }} />
  const diagnostics = [
    ...output.warnings,
    ...output.invalid_rows.flatMap((row) => row.issues.map((issue) => ({ ...issue, locator: issue.locator ?? row.locator }))),
  ]
  if (diagnostics.length === 0) {
    return <EmptyState compact icon={<CheckCircle className="size-7" />} message="没有诊断问题" action={{ label: '查看账单行', onClick: onOpenRows }} />
  }
  return (
    <ul className="divide-y divide-[var(--border-subtle)] rounded-md border border-[var(--border-subtle)]">
      {diagnostics.map((diagnostic, index) => (
        <li key={`${diagnostic.code}:${index}`} className="px-3 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[11px] text-[var(--text-secondary)]">{diagnostic.code}</span>
            <StatusChip label={diagnostic.severity === 'error' ? '错误' : '提醒'} kind={diagnostic.severity === 'error' ? 'danger' : 'warn'} />
          </div>
          <p className="mt-1 text-xs text-[var(--text-primary)]">{diagnostic.message}</p>
          <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">{diagnostic.node_id ?? '流程'} · {locatorText(diagnostic.locator ?? {})}</p>
        </li>
      ))}
    </ul>
  )
}

function Versions({
  versions,
  versionDetail,
  testCases,
  readOnly,
  onInspect,
  onRollback,
}: {
  versions: ParserVersion[]
  versionDetail: ParserVersionDetail | null
  testCases: ParserTestCase[]
  readOnly: boolean
  onInspect: (version: number) => void
  onRollback: (version: number) => void
}) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">发布门禁</h3>
        {testCases.length === 0 ? (
          <p className="text-xs text-[var(--text-tertiary)]">没有测试用例</p>
        ) : (
          <ul className="space-y-1">
            {testCases.map((testCase) => (
              <li key={testCase.id} className="flex items-center justify-between gap-3 rounded-md bg-[var(--surface-0)] px-2.5 py-2 text-xs">
                <span className="min-w-0 truncate text-[var(--text-primary)]">{testCase.attributes.name}</span>
                <StatusChip label={testCase.attributes.enabled ? '启用' : '停用'} kind={testCase.attributes.enabled ? 'ok' : 'muted'} />
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="border-t border-[var(--border-subtle)] pt-4">
        <h3 className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">历史版本</h3>
        {versions.length === 0 ? (
          <p className="text-xs text-[var(--text-tertiary)]">尚未发布</p>
        ) : (
          <ul className="space-y-1">
            {versions.map((version) => (
              <li key={version.version} className="flex items-center justify-between gap-3 rounded-md px-2 py-2 hover:bg-[var(--surface-hover)]">
                <button type="button" className="min-w-0 text-left" onClick={() => onInspect(version.version)}>
                  <span className="block text-xs font-semibold text-[var(--text-primary)]">版本 {version.version}</span>
                  <span className="block truncate font-mono text-[10px] text-[var(--text-tertiary)]">{version.checksum.slice(0, 12)} · {version.created_by}</span>
                </button>
                {!readOnly && (
                  <Button variant="ghost" size="xs" onClick={() => onRollback(version.version)}>
                    <ArrowCounterClockwise aria-hidden className="size-3.5" />回滚
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {versionDetail && (
        <div className="border-t border-[var(--border-subtle)] pt-4">
          <h3 className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">版本 {versionDetail.version}</h3>
          {versionDetail.compared_to_version !== null && (
            <div className="mb-3">
              <p className="mb-1 text-[11px] text-[var(--text-tertiary)]">相对版本 {versionDetail.compared_to_version}</p>
              {versionDetail.diff_from_previous.length === 0 ? (
                <p className="text-xs text-[var(--text-secondary)]">定义没有字段变化</p>
              ) : (
                <ul className="max-h-44 divide-y divide-[var(--border-subtle)] overflow-auto rounded-md border border-[var(--border-subtle)]">
                  {versionDetail.diff_from_previous.map((change, index) => (
                    <li key={`${change.path}:${index}`} className="grid gap-1 px-2.5 py-2 text-[11px]">
                      <span className="font-mono text-[var(--text-primary)]">{change.path}</span>
                      <span className="break-all text-[var(--text-tertiary)]">{change.kind} · {diffValue(change.before)} → {diffValue(change.after)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {versionDetail.diff_truncated && <p className="mt-1 text-[11px] text-[var(--text-tertiary)]">仅显示前 500 项变化</p>}
            </div>
          )}
          <pre className="max-h-80 overflow-auto rounded-md bg-[var(--surface-0)] p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap text-[var(--text-secondary)]">{versionDetail.source_yaml}</pre>
        </div>
      )}
    </div>
  )
}

function diffValue(value: unknown): string {
  if (value === null || value === undefined) return '空'
  if (typeof value === 'string') return value
  return JSON.stringify(value)
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] text-[var(--text-tertiary)]">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold tabular-nums text-[var(--text-primary)]">{value}</dd>
    </div>
  )
}

function locatorText(locator: { sheet?: string | null; page?: number | null; row?: number | null; dom_path?: string | null }): string {
  return [
    locator.sheet ? `工作表 ${locator.sheet}` : null,
    locator.page ? `第 ${locator.page} 页` : null,
    locator.row ? `第 ${locator.row} 行` : null,
    locator.dom_path ?? null,
  ].filter(Boolean).join(' · ') || '邮件'
}
