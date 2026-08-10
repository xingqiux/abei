/* 顶层：外壳 + 页面切换器。
   方向已经选定（概况＝时间线、交易＝紧凑表格+右侧面板），所以不再有 A/B/C。
   切换器是原型自己的控件，不属于设计——搬回生产时不要它。 */

const { useState: useAppState, useEffect: useAppEffect } = React

const PAGES = [
  { value: 'today', label: '概况' },
  { value: 'tx', label: '交易' },
]

function Tweaks({ state, set }) {
  const [open, setOpen] = useAppState(true)
  if (!open) {
    return (
      <button type="button" className="tweaks-toggle" onClick={() => setOpen(true)}>
        Tweaks
      </button>
    )
  }
  return (
    <div className="tweaks">
      <span className="tweaks-label">页面</span>
      <Seg label="页面" value={state.page} options={PAGES} onChange={(page) => set({ page })} />
      {state.page === 'today' && (
        <>
          <span className="tweaks-label">本期数据</span>
          <Seg
            label="本期数据"
            value={state.filled ? 'filled' : 'empty'}
            options={[{ value: 'empty', label: '真实（8月空）' }, { value: 'filled', label: '假设有数' }]}
            onChange={(value) => set({ filled: value === 'filled' })}
          />
        </>
      )}
      <span className="tweaks-label">主题</span>
      <Seg
        label="主题"
        value={state.theme}
        options={[{ value: 'light', label: '亮' }, { value: 'dark', label: '暗' }]}
        onChange={(theme) => set({ theme })}
      />
      <button type="button" className="btn btn-ghost btn-xs" onClick={() => setOpen(false)}>收起</button>
    </div>
  )
}

function App() {
  const [state, setState] = useAppState({
    page: 'today',
    filled: false,
    theme: 'light',
  })
  const set = (patch) => setState((prev) => ({ ...prev, ...patch }))

  useAppEffect(() => {
    document.documentElement.setAttribute('data-theme', state.theme)
  }, [state.theme])

  const D = window.DATA
  const rangeLabel = state.page === 'today' ? '本月 · 08-01 → 08-31' : '上月 · 07-01 → 07-31'

  return (
    <div className="app">
      <Sidebar page={state.page} onPage={(page) => (page === 'today' || page === 'tx') && set({ page })} />
      <div className="main">
        <Topbar rangeLabel={rangeLabel} />
        <div className="canvas">
          <div className="canvas-wide">
            {state.page === 'today' ? <Overview D={D} filled={state.filled} /> : <TxTable D={D} />}
          </div>
        </div>
      </div>
      <Tweaks state={state} set={set} />
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
