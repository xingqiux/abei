import { create } from 'zustand'

export type ToastKind = 'success' | 'error' | 'loading' | 'inbox'

export interface ToastItem {
  id: number
  message: string
  kind: ToastKind
  /** 0 = 不自动消失 */
  duration: number
  /** 可选操作：如「查看」跳转到新建的交易 */
  action?: { label: string; to: string }
}

interface ToastState {
  toasts: ToastItem[]
  push: (toast: { message: string; kind?: ToastKind; duration?: number; action?: { label: string; to: string } }) => number
  dismiss: (id: number) => void
  clear: () => void
}

let nextId = 1

const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 2500,
  error: 4000,
  loading: 0,
  inbox: 4000,
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: ({ message, kind = 'success', duration, action }) => {
    const id = nextId++
    const resolvedDuration = duration ?? DEFAULT_DURATION[kind]
    set((state) => ({ toasts: [...state.toasts, { id, message, kind, duration: resolvedDuration, action }] }))
    if (resolvedDuration > 0) {
      setTimeout(() => get().dismiss(id), resolvedDuration)
    }
    return id
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
  clear: () => set({ toasts: [] }),
}))

/** 便捷方法：在事件回调中直接调用，无需 useToastStore() hook */
export function showToast(toast: { message: string; kind?: ToastKind; duration?: number }) {
  return useToastStore.getState().push(toast)
}
