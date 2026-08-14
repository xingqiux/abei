import { parse, stringify } from 'yaml'
import type { ParserFlowDefinition, ParserNode } from '../../api/parser'

export interface NodeTemplate {
  type: string
  label: string
  value: {
    type: string
    enabled?: boolean
    [key: string]: unknown
  }
}

export const NODE_TEMPLATES: NodeTemplate[] = [
  { type: 'first_available', label: '选择首个可用输入', value: { type: 'first_available', choices: [{ source: 'attachment', filename: '*' }], required: true } },
  { type: 'select_text_body', label: '选择纯文本正文', value: { type: 'select_text_body', required: true } },
  { type: 'select_html_body', label: '选择 HTML 正文', value: { type: 'select_html_body', required: true } },
  { type: 'select_attachment', label: '选择附件', value: { type: 'select_attachment', filename: '*', required: true } },
  { type: 'select_artifact', label: '选择派生文件', value: { type: 'select_artifact', filename: '*', required: true } },
  { type: 'extract_links', label: '提取下载链接', value: { type: 'extract_links', selector: 'a[href]' } },
  { type: 'download', label: '下载账单文件', value: { type: 'download', allowed_domains: ['example.com'], timeout_seconds: 15, max_bytes: 26214400 } },
  { type: 'decode_text', label: '文本解码', value: { type: 'decode_text', candidates: ['utf-8', 'gb18030', 'gbk', 'big5'] } },
  { type: 'unzip', label: '解压 ZIP', value: { type: 'unzip' } },
  { type: 'pdf_to_text', label: 'PDF 转文本', value: { type: 'pdf_to_text' } },
  { type: 'csv_table', label: '读取 CSV', value: { type: 'csv_table', header_contains: [] } },
  { type: 'xlsx_sheet', label: '读取工作表', value: { type: 'xlsx_sheet', header_contains: [] } },
  { type: 'html_table', label: '读取 HTML 表格', value: { type: 'html_table', selector: 'table' } },
  { type: 'html_elements', label: '提取 HTML 元素', value: { type: 'html_elements', row_selector: '.transaction', fields: { description: '.description' } } },
  { type: 'text_lines', label: '拆分文本行', value: { type: 'text_lines', skip_empty: true, field: 'line' } },
  { type: 'fixed_width_table', label: '读取定宽表格', value: { type: 'fixed_width_table', columns: [{ name: 'line', start: 0 }], skip_contains: [] } },
  { type: 'whitespace_table', label: '读取空白分列表格', value: { type: 'whitespace_table', columns: ['date', 'amount', 'description'], min_columns: 3 } },
  { type: 'switch', label: '按文件类型选择表格解析器', value: { type: 'switch', cases: [{ filename: '*.csv', parser: { type: 'csv_table', header_contains: [] } }], required: true } },
  { type: 'group_rows', label: '合并连续记录', value: { type: 'group_rows', count: 2, separator: '\n' } },
  { type: 'split_rows', label: '拆分记录', value: { type: 'split_rows', field: 'line', delimiter: '\n', target: 'line', trim: true, skip_empty: true } },
  { type: 'rename_fields', label: '字段映射', value: { type: 'rename_fields', mapping: { source: 'target' } } },
  { type: 'pick_fields', label: '保留字段', value: { type: 'pick_fields', fields: [] } },
  { type: 'join_fields', label: '合并字段', value: { type: 'join_fields', target: 'description', sources: [], separator: ' ' } },
  { type: 'set_constant', label: '设置常量', value: { type: 'set_constant', values: { currency_code: 'CNY' } } },
  { type: 'map_values', label: '映射字段值', value: { type: 'map_values', field: 'direction', values: {} } },
  { type: 'normalize_text', label: '清理文本', value: { type: 'normalize_text', fields: [] } },
  { type: 'filter_rows', label: '筛选记录', value: { type: 'filter_rows', field: 'status', operator: 'equals', value: '' } },
  { type: 'parse_money', label: '解析金额', value: { type: 'parse_money', source: 'amount', target: 'signed_amount', negative_when: {} } },
  { type: 'parse_date', label: '解析日期', value: { type: 'parse_date', source: 'date', target: 'occurred_at', formats: [] } },
  { type: 'validate_rows', label: '验证记录', value: { type: 'validate_rows', required: [] } },
  { type: 'transform_script', label: '转换脚本', value: { type: 'transform_script', source: 'fn transform(row, context) {\n    emit(row);\n}' } },
  { type: 'normalize_bill_rows', label: '生成账单草稿', value: { type: 'normalize_bill_rows', default_currency: 'CNY' } },
]

export function emptyFlow(): ParserFlowDefinition {
  return {
    schema_version: 1,
    channel_key: 'new-channel',
    nodes: [
      { id: 'select', type: 'select_html_body', required: true },
      { id: 'extract', type: 'html_table', selector: 'table' },
      { id: 'normalize', type: 'normalize_bill_rows', default_currency: 'CNY' },
    ],
    output: { require: ['occurred_at', 'signed_amount', 'currency_code'] },
  }
}

export function parseFlow(source: string): { definition: ParserFlowDefinition | null; error: string | null } {
  try {
    const value: unknown = parse(source)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('流程必须是对象')
    const candidate = value as Partial<ParserFlowDefinition>
    if (!Array.isArray(candidate.nodes)) throw new Error('nodes 必须是数组')
    if (typeof candidate.channel_key !== 'string') throw new Error('channel_key 必须是字符串')
    for (const [index, node] of candidate.nodes.entries()) {
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`第 ${index + 1} 个节点不是对象`)
      if (typeof node.id !== 'string' || typeof node.type !== 'string') throw new Error(`第 ${index + 1} 个节点缺少 id 或 type`)
    }
    return { definition: value as ParserFlowDefinition, error: null }
  } catch (error) {
    return { definition: null, error: error instanceof Error ? error.message : 'YAML 无法解析' }
  }
}

export function flowYaml(definition: ParserFlowDefinition): string {
  return stringify(definition, { lineWidth: 0 })
}

export function nodeYaml(node: ParserNode): string {
  return stringify(node, { lineWidth: 0 })
}

export function parseNode(source: string): ParserNode {
  const value: unknown = parse(source)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('节点必须是对象')
  const node = value as ParserNode
  if (typeof node.id !== 'string' || !node.id.trim()) throw new Error('节点需要 id')
  if (typeof node.type !== 'string' || !node.type.trim()) throw new Error('节点需要 type')
  return node
}

export function addNode(definition: ParserFlowDefinition, type: string): ParserFlowDefinition {
  const template = NODE_TEMPLATES.find((item) => item.type === type)
  if (!template) return definition
  const used = new Set(definition.nodes.map((node) => node.id))
  let id = type.replaceAll('_', '-')
  let suffix = 2
  while (used.has(id)) id = `${type.replaceAll('_', '-')}-${suffix++}`
  const node: ParserNode = { ...structuredClone(template.value), id }
  return { ...definition, nodes: [...definition.nodes, node] }
}

export function moveNode(definition: ParserFlowDefinition, index: number, offset: -1 | 1): ParserFlowDefinition {
  const target = index + offset
  if (target < 0 || target >= definition.nodes.length) return definition
  const nodes = [...definition.nodes]
  const [node] = nodes.splice(index, 1)
  if (!node) return definition
  nodes.splice(target, 0, node)
  return { ...definition, nodes }
}

export function nodeLabel(type: string): string {
  return NODE_TEMPLATES.find((item) => item.type === type)?.label ?? type
}

export function defaultSlug(name: string): string {
  const value = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return value || `flow-${Date.now().toString(36)}`
}
