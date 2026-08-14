import { useEffect, useState } from 'react'
import type { ParserNode } from '../../api/parser'
import { InlineError } from '../../components/abei/ErrorState'
import { Field, Input } from '../../components/ui/Field'
import { nodeLabel, nodeYaml, parseNode } from './parserFlow'

export function ParserNodeEditor({
  node,
  readOnly,
  onChange,
}: {
  node: ParserNode | null
  readOnly: boolean
  onChange: (node: ParserNode) => void
}) {
  const [source, setSource] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setSource(node ? nodeYaml(node) : '')
    setError(null)
  }, [node])

  if (!node) {
    return (
      <div className="flex min-h-72 items-center justify-center text-sm text-[var(--text-tertiary)]">
        选择一个节点
      </div>
    )
  }

  function updateSource(next: string) {
    setSource(next)
    try {
      const parsed = parseNode(next)
      setError(null)
      onChange(parsed)
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '节点 YAML 无法解析')
    }
  }

  function updateScript(next: string) {
    if (!node) return
    const updated: ParserNode = { ...node, source: next }
    setSource(nodeYaml(updated))
    setError(null)
    onChange(updated)
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="grid gap-3 border-b border-[var(--border-subtle)] p-4 sm:grid-cols-[minmax(0,1fr)_160px]">
        <Field label="节点 ID">
          <Input
            className="font-mono"
            value={node.id}
            disabled={readOnly}
            onChange={(event) => onChange({ ...node, id: event.target.value })}
          />
        </Field>
        <Field label="节点类型">
          <Input value={nodeLabel(node.type)} disabled />
        </Field>
      </div>
      {node.type === 'transform_script' ? (
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <label htmlFor="parser-script" className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">
            转换脚本
          </label>
          <textarea
            id="parser-script"
            spellCheck={false}
            disabled={readOnly}
            value={typeof node.source === 'string' ? node.source : ''}
            onChange={(event) => updateScript(event.target.value)}
            className="min-h-[390px] flex-1 resize-y rounded-md bg-[var(--surface-0)] p-3 font-mono text-xs leading-5 text-[var(--text-primary)] outline-1 -outline-offset-1 outline-[var(--border-strong)] focus:outline-2 focus:-outline-offset-2 focus:outline-[var(--focus-ring)] disabled:opacity-60"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col p-4">
          <label htmlFor="parser-node-yaml" className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">
            节点参数
          </label>
          <textarea
            id="parser-node-yaml"
            spellCheck={false}
            disabled={readOnly}
            value={source}
            onChange={(event) => updateSource(event.target.value)}
            className="min-h-[390px] flex-1 resize-y rounded-md bg-[var(--surface-0)] p-3 font-mono text-xs leading-5 text-[var(--text-primary)] outline-1 -outline-offset-1 outline-[var(--border-strong)] focus:outline-2 focus:-outline-offset-2 focus:outline-[var(--focus-ring)] disabled:opacity-60"
          />
          {error && <div className="mt-3"><InlineError message={error} /></div>}
        </div>
      )}
    </div>
  )
}
