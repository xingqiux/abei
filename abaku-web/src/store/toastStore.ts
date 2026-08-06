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

/** push / showToast 的入参。两处必须共用，漏字段会被静默丢掉。 */
export interface ToastInput {
  message: string
  kind?: ToastKind
  duration?: number
  action?: { label: string; to: string }
}

interface ToastState {
  toasts: ToastItem[]
  push: (toast: ToastInput) => number
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

/**
 * 便捷方法：在事件回调中直接调用，无需 useToastStore() hook。
 * 入参类型必须是 ToastInput——这里曾经手写过一份漏掉 action 的窄类型，
 * 于是所有带「查看」入口的提示都被静默丢成普通提示。
 */
export function showToast(toast: ToastInput) {
  return useToastStore.getState().push(toast)
}
