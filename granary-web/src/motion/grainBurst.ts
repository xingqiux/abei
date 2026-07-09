import { prefersReducedMotion } from './reducedMotion'

// 独立文件、只在函数体内 `import('matter-js')`：保证 matter-js 被 Vite 分进独立 chunk，
// 不随首屏主 bundle 一起加载（规范 §6：matter.js 独立 chunk 懒加载，~90KB 不进首屏）。

const GRAIN_COLORS = ['#FCA311', '#E8C15A', '#C9873B']

/** 模块级防重入：同一时间只允许一次谷粒动效在播放（对齐"单页最多一个大动效"原则） */
let isPlaying = false

function pickColor(): string {
  return GRAIN_COLORS[Math.floor(Math.random() * GRAIN_COLORS.length)]
}

/**
 * 在 `container` 内播放一次"谷粒撒落"物理动效：40~70（或 opts.count）颗琥珀色小谷粒
 * 从容器顶部上方随机水平速度落下，重力下落、底部有地面与左右墙体互相堆叠碰撞，
 * 1.2s 后整体淡出并销毁引擎与 canvas，总时长 ≤2.2s。
 *
 * - 防重入：正在播放时调用直接忽略
 * - prefers-reduced-motion：直接 return，不触发 matter-js 的动态 import
 */
export async function playGrainBurst(container: HTMLElement, opts: { count?: number } = {}): Promise<void> {
  if (isPlaying) return
  if (prefersReducedMotion()) return
  isPlaying = true

  try {
    const Matter = await import('matter-js')
    const { Engine, Runner, Bodies, Composite, Body } = Matter

    const rect = container.getBoundingClientRect()
    const width = Math.max(Math.round(rect.width), 1)
    const height = Math.max(Math.round(rect.height), 1)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.setAttribute('data-grain-burst', 'true')
    Object.assign(canvas.style, {
      position: 'absolute',
      inset: '0',
      width: `${width}px`,
      height: `${height}px`,
      pointerEvents: 'none',
      zIndex: '30',
      opacity: '1',
      transition: 'opacity 0.4s ease',
    })

    const computedPosition = getComputedStyle(container).position
    const shouldRestorePosition = computedPosition === 'static'
    if (shouldRestorePosition) container.style.position = 'relative'
    container.appendChild(canvas)

    const ctx = canvas.getContext('2d')

    const engine = Engine.create()
    engine.gravity.y = 1.1

    const count = opts.count ?? 55
    const grains: { body: InstanceType<typeof Body>; color: string; alpha: number; w: number; h: number }[] = []

    for (let i = 0; i < count; i++) {
      const w = 4 + Math.random() * 3
      const h = 4 + Math.random() * 3
      const x = Math.random() * width
      const y = -20 - Math.random() * height * 0.6
      const body = Bodies.rectangle(x, y, w, h, {
        chamfer: { radius: Math.min(w, h) / 2 },
        restitution: 0.25,
        friction: 0.65,
        frictionAir: 0.012,
      })
      Body.setVelocity(body, { x: (Math.random() - 0.5) * 4, y: 2 + Math.random() * 2 })
      Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.2)
      grains.push({ body, color: pickColor(), alpha: 0.85 + Math.random() * 0.15, w, h })
    }

    const ground = Bodies.rectangle(width / 2, height + 10, width * 2, 20, { isStatic: true })
    const leftWall = Bodies.rectangle(-10, height / 2, 20, height * 2, { isStatic: true })
    const rightWall = Bodies.rectangle(width + 10, height / 2, 20, height * 2, { isStatic: true })

    Composite.add(engine.world, [...grains.map((g) => g.body), ground, leftWall, rightWall])

    const runner = Runner.create()
    Runner.run(runner, engine)

    let rafId = 0
    function render() {
      if (!ctx) return
      ctx.clearRect(0, 0, width, height)
      for (const g of grains) {
        const { position, angle } = g.body
        ctx.save()
        ctx.translate(position.x, position.y)
        ctx.rotate(angle)
        ctx.globalAlpha = g.alpha
        ctx.fillStyle = g.color
        const r = Math.min(g.w, g.h) / 2
        ctx.beginPath()
        if (typeof ctx.roundRect === 'function') {
          ctx.roundRect(-g.w / 2, -g.h / 2, g.w, g.h, r)
        } else {
          ctx.ellipse(0, 0, g.w / 2, g.h / 2, 0, 0, Math.PI * 2)
        }
        ctx.fill()
        ctx.restore()
      }
      rafId = requestAnimationFrame(render)
    }
    render()

    const cleanup = () => {
      cancelAnimationFrame(rafId)
      Runner.stop(runner)
      Composite.clear(engine.world, false)
      Engine.clear(engine)
      canvas.remove()
      if (shouldRestorePosition) container.style.position = ''
      isPlaying = false
    }

    window.setTimeout(() => {
      canvas.style.opacity = '0'
      window.setTimeout(cleanup, 400)
    }, 1200)
  } catch {
    isPlaying = false
  }
}
