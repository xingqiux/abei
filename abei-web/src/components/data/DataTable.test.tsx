import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { DataTable, type Column } from './DataTable'

interface Row {
  id: string
  day: string
  desc: string
  amount: string
}

const ROWS: Row[] = [
  { id: '1', day: '2026-07-20', desc: '早饭', amount: '12.00' },
  { id: '2', day: '2026-07-20', desc: '地铁', amount: '4.00' },
  { id: '3', day: '2026-07-19', desc: '房租', amount: '3200.00' },
]

const COLUMNS: Column<Row>[] = [
  { key: 'desc', header: '描述', width: 'minmax(0,1fr)', cell: (row) => <span>{row.desc}</span> },
  { key: 'amount', header: '金额', width: '128px', align: 'end', cell: (row) => <span>¥{row.amount}</span> },
]

const groupByDay = (row: Row, prev: Row | null) =>
  prev && prev.day === row.day ? null : { key: row.day, label: <span>{row.day}</span> }

function renderTable(props: Partial<React.ComponentProps<typeof DataTable<Row>>> = {}) {
  return render(
    <DataTable<Row> rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} {...props} />,
  )
}

/**
 * 表格首行是 sr-only 表头（role=row + 若干 columnheader），数据行从第二行起。
 * 所有按下标取行的断言都走这里，避免表头行把下标顶偏。
 */
function dataRows(container?: HTMLElement): HTMLElement[] {
  const scope = container ? within(container) : screen
  return scope.getAllByRole('row').slice(1)
}

beforeAll(() => {
  // jsdom 压根没这个方法，光标 effect 里的 scrollIntoView 会直接抛
  Element.prototype.scrollIntoView = () => undefined
})

describe('DataTable 渲染', () => {
  it('每行按列定义渲染单元格', () => {
    renderTable()

    const rows = dataRows()
    expect(rows).toHaveLength(3)

    const cells = within(rows[0]).getAllByRole('gridcell')
    expect(cells).toHaveLength(2)
    expect(cells[0]).toHaveTextContent('早饭')
    expect(cells[1]).toHaveTextContent('¥12.00')

    expect(within(rows[2]).getAllByRole('gridcell')[1]).toHaveTextContent('¥3200.00')
  })

  it('列宽与对齐落到单元格上：定宽列吃 width，1fr 列走 flex-1', () => {
    renderTable()

    const [descCell, amountCell] = within(dataRows()[0]).getAllByRole('gridcell')
    expect(descCell).toHaveClass('flex-1')
    expect(descCell.style.width).toBe('')
    expect(amountCell.style.width).toBe('128px')
    expect(amountCell).toHaveClass('justify-end')
  })

  it('挂上 grid 语义：外层 role=grid，每行 role=row，单元格 role=gridcell', () => {
    renderTable()

    const grid = screen.getByRole('grid')
    expect(grid).toBeInTheDocument()
    expect(dataRows(grid)).toHaveLength(3)
    expect(within(grid).getAllByRole('gridcell')).toHaveLength(6)
  })

  it('渲染一行 sr-only 表头，把 Column.header 交给读屏', () => {
    // 视觉上不画表头（列表按日期分组，再加一行列名是噪音），但 role=grid 缺 columnheader
    // 对读屏是残缺的。表头行走 sr-only：不占布局，只进无障碍树。
    renderTable()

    const headers = screen.getAllByRole('columnheader')
    expect(headers.map((h) => h.textContent)).toEqual(['描述', '金额'])
    expect(headers[0].closest('[role="row"]')).toHaveClass('sr-only')
  })

  it('传了 selection 时表头行也多一列', () => {
    renderTable({ selection: { selected: new Set<string>(), onChange: vi.fn() } })

    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['选择', '描述', '金额'])
  })
})

describe('DataTable 分组', () => {
  it('同组连续行只出一次组头', () => {
    renderTable({ groupBy: groupByDay })

    const headers = screen.getAllByRole('rowheader')
    expect(headers).toHaveLength(2)
    expect(headers[0]).toHaveTextContent('2026-07-20')
    expect(headers[1]).toHaveTextContent('2026-07-19')
    expect(dataRows()).toHaveLength(3)
  })

  it('不传 groupBy 时一个组头都不出', () => {
    renderTable()

    expect(screen.queryAllByRole('rowheader')).toHaveLength(0)
  })

  it('组头拿到粘性组头样式，而不是普通数据行样式', () => {
    renderTable({ groupBy: groupByDay })

    const header = screen.getAllByRole('rowheader')[0]
    expect(header).toHaveClass('sticky')
    expect(header).not.toHaveClass('hover:bg-[var(--surface-hover)]')
  })

  it('起新组的那一行仍然是正常行高，不被压成组头高度', () => {
    renderTable({ groupBy: groupByDay })

    // 每行行高都归 --row-h 管，密度开关只改变量；组头自己有 h-7
    for (const row of dataRows()) {
      expect(row).toHaveClass('h-[var(--row-h)]')
    }
  })
})

describe('DataTable 选择列', () => {
  it('不传 selection 时不渲染选择列', () => {
    renderTable()

    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(within(dataRows()[0]).getAllByRole('gridcell')).toHaveLength(2)
  })

  it('传了 selection 才多出一列复选框，并且读屏能拿到', () => {
    renderTable({ selection: { selected: new Set<string>(), onChange: vi.fn() } })

    expect(screen.getAllByRole('checkbox', { name: '选择此行' })).toHaveLength(3)
    expect(within(dataRows()[0]).getAllByRole('gridcell')).toHaveLength(3)
  })

  it('勾选把新 key 并进已选集合', () => {
    const onChange = vi.fn()
    renderTable({ selection: { selected: new Set(['1']), onChange } })

    const boxes = screen.getAllByRole('checkbox', { name: '选择此行' })
    expect(boxes[0]).toBeChecked()
    expect(boxes[1]).not.toBeChecked()

    fireEvent.click(boxes[1])

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(new Set(['1', '2']))
  })

  it('取消勾选只摘掉自己那一个 key', () => {
    const onChange = vi.fn()
    renderTable({ selection: { selected: new Set(['1', '2']), onChange } })

    fireEvent.click(screen.getAllByRole('checkbox', { name: '选择此行' })[0])

    expect(onChange).toHaveBeenCalledWith(new Set(['2']))
  })

  it('点复选框不触发整行的 onActivate', () => {
    const onActivate = vi.fn()
    renderTable({ onActivate, selection: { selected: new Set<string>(), onChange: vi.fn() } })

    fireEvent.click(screen.getAllByRole('checkbox', { name: '选择此行' })[1])

    expect(onActivate).not.toHaveBeenCalled()
  })
})

describe('DataTable 空态与加载态', () => {
  it('loading 时出骨架行、标记 aria-busy，且不渲染任何数据', () => {
    render(
      <DataTable<Row>
        rows={ROWS}
        columns={COLUMNS}
        rowKey={(row) => row.id}
        loading
        skeletonRows={4}
      />,
    )

    const grid = screen.getByRole('grid')
    expect(grid).toHaveAttribute('aria-busy', 'true')
    // 加载分支不出表头行——骨架行里没有真单元格，标了列名反而误导；
    // aria-busy 已经告诉读屏此处内容待定。所以这里直接取行，不走 dataRows()。
    expect(within(grid).getAllByRole('row')).toHaveLength(4)
    expect(screen.queryAllByRole('columnheader')).toHaveLength(0)
    expect(screen.queryByText('早饭')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('gridcell')).toHaveLength(0)
  })

  it('rows 为空时只渲染 emptyState，连 grid 都不出', () => {
    render(
      <DataTable<Row>
        rows={[]}
        columns={COLUMNS}
        rowKey={(row) => row.id}
        emptyState={<p>所选范围内暂无交易</p>}
      />,
    )

    expect(screen.getByText('所选范围内暂无交易')).toBeInTheDocument()
    expect(screen.queryByRole('grid')).not.toBeInTheDocument()
  })

  it('loading 优先于空态', () => {
    render(
      <DataTable<Row>
        rows={[]}
        columns={COLUMNS}
        rowKey={(row) => row.id}
        loading
        emptyState={<p>所选范围内暂无交易</p>}
      />,
    )

    expect(screen.getByRole('grid')).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText('所选范围内暂无交易')).not.toBeInTheDocument()
  })
})

describe('DataTable 交互', () => {
  it('点整行把该行交给 onActivate', () => {
    const onActivate = vi.fn()
    renderTable({ onActivate })

    fireEvent.click(dataRows()[2])

    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onActivate).toHaveBeenCalledWith(ROWS[2])
  })

  it('键盘 ↓ 后 Enter 打开的是光标所在行', () => {
    const onActivate = vi.fn()
    renderTable({ onActivate })

    fireEvent.keyDown(document.body, { key: 'ArrowDown' })
    fireEvent.keyDown(document.body, { key: 'Enter' })

    expect(onActivate).toHaveBeenCalledWith(ROWS[1])
  })

  it('鼠标移到哪一行，光标就落到哪一行', () => {
    const onActivate = vi.fn()
    renderTable({ onActivate })

    const rows = dataRows()
    fireEvent.mouseEnter(rows[1])

    expect(rows[1]).toHaveAttribute('tabindex', '0')
    expect(rows[0]).toHaveAttribute('tabindex', '-1')
    expect(rows[2]).toHaveAttribute('tabindex', '-1')

    fireEvent.keyDown(document.body, { key: 'Enter' })
    expect(onActivate).toHaveBeenCalledWith(ROWS[1])
  })

  it('rows 为空时键盘层不接管按键', () => {
    const onActivate = vi.fn()
    render(
      <DataTable<Row>
        rows={[]}
        columns={COLUMNS}
        rowKey={(row) => row.id}
        onActivate={onActivate}
        emptyState={<p>空</p>}
      />,
    )

    fireEvent.keyDown(document.body, { key: 'Enter' })

    expect(onActivate).not.toHaveBeenCalled()
  })
})
