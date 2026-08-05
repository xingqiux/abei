import { create } from 'zustand'

/** 移动端底部 tab「我的」弹出 sheet 的全局开关（规范 §3 移动端断点）。 */
interface MoreSheetState {
  open: boolean
  openSheet: () => void
  close: () => void
}

export const useMoreSheetStore = create<MoreSheetState>((set) => ({
  open: false,
  openSheet: () => set({ open: true }),
  close: () => set({ open: false }),
}))
