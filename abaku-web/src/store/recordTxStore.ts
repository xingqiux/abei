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

/** 「记一笔」/「编辑交易」表单全局状态：顶栏、快捷键 n、行内编辑共用（规范 §4.3）。 */
interface RecordTxState {
  open: boolean
  mode: 'create' | 'edit'
  edit: RecordTxEditPayload | null
  openForm: () => void
  openEdit: (payload: RecordTxEditPayload) => void
  close: () => void
}

export const useRecordTxStore = create<RecordTxState>((set) => ({
  open: false,
  mode: 'create',
  edit: null,
  openForm: () => set({ open: true, mode: 'create', edit: null }),
  openEdit: (payload) => set({ open: true, mode: 'edit', edit: payload }),
  close: () => set({ open: false, mode: 'create', edit: null }),
}))
