import { create } from 'zustand'

interface PrivacyState {
  hidden: boolean
  toggle: () => void
}

/** 隐私模式：Ctrl+P 把全站金额换成 ••••，只在 MoneyText 一处生效。 */
export const usePrivacyStore = create<PrivacyState>((set) => ({
  hidden: false,
  toggle: () => set((s) => ({ hidden: !s.hidden })),
}))
