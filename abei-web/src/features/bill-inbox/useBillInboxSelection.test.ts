import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBillInboxSelection } from './useBillInboxSelection'

const IDS = ['a', 'b', 'c', 'd', 'e']

function setup() {
  return renderHook(() => useBillInboxSelection())
}

describe('useBillInboxSelection', () => {
  it('勾选和取消勾选同一行', () => {
    const { result } = setup()
    const toggle = (rowId: string, index: number, shift = false) =>
      act(() => {
        result.current[1]({
          type: 'toggle', rowId, index, shift, selectableIds: IDS, orderedIds: IDS,
        })
      })

    toggle('b', 1)
    expect([...result.current[0].selected]).toEqual(['b'])
    toggle('b', 1)
    expect(result.current[0].selected.size).toBe(0)
  })

  it('shift 区间选只加不减，且尊重不可选的行', () => {
    const { result } = setup()
    const dispatch = result.current[1]
    act(() => {
      dispatch({ type: 'toggle', rowId: 'b', index: 1, shift: false, selectableIds: IDS, orderedIds: IDS })
    })
    act(() => {
      // c 不可选：区间里应当跳过它
      dispatch({
        type: 'toggle', rowId: 'd', index: 3, shift: true,
        selectableIds: ['a', 'b', 'd', 'e'], orderedIds: IDS,
      })
    })
    expect([...result.current[0].selected].sort()).toEqual(['b', 'd'])
  })

  it('反向拖选也能选中区间', () => {
    const { result } = setup()
    const dispatch = result.current[1]
    act(() => {
      dispatch({ type: 'toggle', rowId: 'd', index: 3, shift: false, selectableIds: IDS, orderedIds: IDS })
    })
    act(() => {
      dispatch({ type: 'toggle', rowId: 'b', index: 1, shift: true, selectableIds: IDS, orderedIds: IDS })
    })
    expect([...result.current[0].selected].sort()).toEqual(['b', 'c', 'd'])
  })

  it('全选与再点一次取消全选', () => {
    const { result } = setup()
    const dispatch = result.current[1]
    act(() => dispatch({ type: 'selectAll', selectableIds: IDS }))
    expect(result.current[0].selected.size).toBe(5)
    act(() => dispatch({ type: 'selectAll', selectableIds: IDS }))
    expect(result.current[0].selected.size).toBe(0)
  })

  it('行离开当前 tab 后从勾选里摘掉，其余保留', () => {
    const { result } = setup()
    const dispatch = result.current[1]
    act(() => dispatch({ type: 'selectAll', selectableIds: IDS }))
    act(() => dispatch({ type: 'forget', rowIds: ['a', 'c'] }))
    expect([...result.current[0].selected].sort()).toEqual(['b', 'd', 'e'])
  })

  it('换一屏时勾选、光标、展开、编辑一起清空', () => {
    const { result } = setup()
    const dispatch = result.current[1]
    act(() => dispatch({ type: 'selectAll', selectableIds: IDS }))
    act(() => dispatch({ type: 'cursor', index: 3 }))
    act(() => dispatch({ type: 'expand', rowId: 'b' }))
    act(() => dispatch({ type: 'edit', rowId: 'b' }))

    act(() => dispatch({ type: 'reset' }))
    expect(result.current[0]).toEqual({
      selected: new Set(),
      anchorIndex: null,
      expandedId: null,
      editingId: null,
      cursorIndex: 0,
    })
  })
})
