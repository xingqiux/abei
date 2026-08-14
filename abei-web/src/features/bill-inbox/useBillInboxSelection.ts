import { useReducer } from 'react'

/**
 * 收件箱列表里「我正在看哪一行、勾了哪几行」这一摊状态。
 *
 * 这些值必须一起变：换了 tab 或渠道，勾选、光标、展开、编辑全都指向已经不在
 * 屏幕上的行，留着只会误伤。原来它们是六个独立的 useState，靠一条 useEffect
 * 逐个纠正——每加一个筛选维度就要多记得清一次，漏一个就是一个交互 bug。
 * 收成一个 reducer 之后，「换一屏」是一个动作，不是六个赋值。
 */
export type BillInboxSelection = {
  /** 勾选的行 id */
  selected: Set<string>
  /** shift 区间选的锚点，按屏幕顺序的下标 */
  anchorIndex: number | null
  /** 展开看详情的行 */
  expandedId: string | null
  /** 正在编辑的行 */
  editingId: string | null
  /** j/k 光标落在第几行 */
  cursorIndex: number
}

export type BillInboxSelectionAction =
  /** 换 tab / 换渠道 / 换邮件：整屏重来 */
  | { type: 'reset' }
  | { type: 'toggle'; rowId: string; index: number; shift: boolean; selectableIds: string[]; orderedIds: string[] }
  | { type: 'selectAll'; selectableIds: string[] }
  | { type: 'clearSelection' }
  | { type: 'forget'; rowIds: string[] }
  | { type: 'expand'; rowId: string | null }
  | { type: 'edit'; rowId: string | null }
  | { type: 'cursor'; index: number }

const EMPTY: BillInboxSelection = {
  selected: new Set(),
  anchorIndex: null,
  expandedId: null,
  editingId: null,
  cursorIndex: 0,
}

function reduce(state: BillInboxSelection, action: BillInboxSelectionAction): BillInboxSelection {
  switch (action.type) {
    case 'reset':
      return EMPTY

    case 'toggle': {
      const next = new Set(state.selected)
      if (action.shift && state.anchorIndex !== null) {
        const [from, to] =
          state.anchorIndex <= action.index
            ? [state.anchorIndex, action.index]
            : [action.index, state.anchorIndex]
        // 区间选统一改成「选上」，不做逐行反转：反转出来的结果没人能预期
        const selectable = new Set(action.selectableIds)
        for (let i = from; i <= to; i += 1) {
          const id = action.orderedIds[i]
          if (id && selectable.has(id)) next.add(id)
        }
        return { ...state, selected: next, anchorIndex: action.index }
      }
      if (next.has(action.rowId)) next.delete(action.rowId)
      else next.add(action.rowId)
      return { ...state, selected: next, anchorIndex: action.index }
    }

    case 'selectAll': {
      const allOn =
        action.selectableIds.length > 0 && action.selectableIds.every((id) => state.selected.has(id))
      return {
        ...state,
        selected: allOn ? new Set() : new Set(action.selectableIds),
        anchorIndex: null,
      }
    }

    case 'clearSelection':
      return { ...state, selected: new Set(), anchorIndex: null }

    /** 行已经离开这个 tab（忽略掉了、入账了），把它从勾选里摘掉 */
    case 'forget': {
      if (action.rowIds.length === 0) return state
      const next = new Set(state.selected)
      let touched = false
      for (const id of action.rowIds) touched = next.delete(id) || touched
      return touched ? { ...state, selected: next } : state
    }

    case 'expand':
      return { ...state, expandedId: action.rowId }

    case 'edit':
      return { ...state, editingId: action.rowId }

    case 'cursor':
      return { ...state, cursorIndex: action.index }
  }
}

export function useBillInboxSelection() {
  return useReducer(reduce, EMPTY)
}
