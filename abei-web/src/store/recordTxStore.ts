import { create } from 'zustand'
import type { CreateTransactionType } from '../api/firefly'

/** 编辑交易时的初值负载（groupId/journalId + 表单字段） */
export interface RecordTxEditPayload {
  groupId: string
  journalId: string
  /** group 内拆分数量；>1 时打开完整多拆分编辑器。 */
  splitCount: number
  type: CreateTransactionType
  amount: string
  description: string
  /** YYYY-MM-DD */
  date: string
  sourceId?: string
  sourceName?: string
  destId?: string
  destName?: string
  category?: string
  /** 逗号分隔展示用 */
  tagsRaw?: string
  notes?: string
}

/**
 * 打开「记一笔」时带过来的上下文。从收入 tab 点开就该默认是收入，
 * 从某个账户详情点开就该预填那个账户——让人少改两下。
 */
export interface RecordTxPreset {
  type?: CreateTransactionType
  sourceAccountId?: string
}

const TRANSACTION_TYPES: CreateTransactionType[] = ['withdrawal', 'deposit', 'transfer']

/**
 * 只认识白名单字段。必须这么防一手：有几个调用点是 `onClick={openForm}` 直接绑上去的，
 * 那样传进来的是一个 MouseEvent，不过滤的话它会被当成 preset 存进 store。
 */
function normalizePreset(raw: unknown): RecordTxPreset | null {
  if (raw == null || typeof raw !== 'object') return null
  const { type, sourceAccountId } = raw as Record<string, unknown>
  const preset: RecordTxPreset = {}
  if (typeof type === 'string' && (TRANSACTION_TYPES as string[]).includes(type)) {
    preset.type = type as CreateTransactionType
  }
  if (typeof sourceAccountId === 'string' && sourceAccountId !== '') {
    preset.sourceAccountId = sourceAccountId
  }
  return preset.type || preset.sourceAccountId ? preset : null
}

/** 「记一笔」/「编辑交易」表单全局状态：顶栏、快捷键 n、行内编辑共用（规范 §4.3）。 */
interface RecordTxState {
  open: boolean
  mode: 'create' | 'edit'
  edit: RecordTxEditPayload | null
  /** 创建模式的初值来源，关掉表单就清空。 */
  preset: RecordTxPreset | null
  openForm: (preset?: RecordTxPreset) => void
  openEdit: (payload: RecordTxEditPayload) => void
  close: () => void
}

export const useRecordTxStore = create<RecordTxState>((set) => ({
  open: false,
  mode: 'create',
  edit: null,
  preset: null,
  openForm: (preset) => set({ open: true, mode: 'create', edit: null, preset: normalizePreset(preset) }),
  openEdit: (payload) => set({ open: true, mode: 'edit', edit: payload, preset: null }),
  close: () => set({ open: false, mode: 'create', edit: null, preset: null }),
}))
