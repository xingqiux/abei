import { create } from 'zustand'

/** 「记一笔」表单的全局开关状态：顶栏按钮和全局快捷键 n 共用同一入口（规范 §4.3）。 */
interface RecordTxState {
  open: boolean
  openForm: () => void
  close: () => void
}

export const useRecordTxStore = create<RecordTxState>((set) => ({
  open: false,
  openForm: () => set({ open: true }),
  close: () => set({ open: false }),
}))
