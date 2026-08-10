import { create } from 'zustand'

/** 命令面板（Cmd+K）全局开关：顶栏搜索框、快捷键 Cmd+K/Ctrl+K/`/` 共用同一入口（规范 §5）。 */
interface CommandPaletteState {
  open: boolean
  openPalette: () => void
  close: () => void
  toggle: () => void
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  openPalette: () => set({ open: true }),
  close: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
}))
