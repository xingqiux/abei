# abaku-web

Abaku 的界面。React 19 + TypeScript + Vite，直接调 Firefly III 的 `/api/v1`，没有自己的后端。

设计上的决定写在 `../docs/design/redesign-decisions.md`，Firefly 接口的取舍对照在
`../docs/design/feature-inventory.md`。

## 跑起来

日常开发从仓库根目录走（`make dev-web` 会把 Firefly 放容器里，只在本机起 vite）。
单独在这个目录里跑：

```bash
npm install
npm run dev        # http://localhost:5173，API 请求由 vite proxy 转给 Firefly
```

proxy 目标写在 `vite.config.ts`，跟着根目录 `.env` 的 `FIREFLY_PORT` 走，改端口要两边一起改。

## 令牌

构建产物里不含令牌。第一次打开会挡在 TokenGate，要粘贴一个 Firefly 个人访问令牌，
存进 sessionStorage——关掉标签页就没了，不落磁盘。

开发期嫌麻烦可以在 `.env.local` 里放 `VITE_FIREFLY_TOKEN` 兜底。e2e 会强制忽略它，
好让登录这一步真的走一遍 TokenGate。

令牌可以在设置页里列出和撤销，也可以从顶栏（手机上在「我的」里）换掉。

## 目录

```
src/
  api/         Firefly 接口封装（firefly.ts）与 React Query hooks（queries.ts）
  routes/      TanStack Router 的路由表与导航徽标
  features/    按页分：today / transactions / accounts / budgets / analysis /
               bill-inbox / reconciliation / settings / record-transaction / command-palette
  components/
    ui/        通用控件：Button、Card、Field、Badge、Tabs、SegmentedControl、Dropdown
    abaku/     业务件：Modal、Combobox、TransactionRow、图表、Toast、空态错误态
    layout/    壳层：Sidebar、Topbar、BottomTabBar、MoreSheet
    data/      DataTable
  store/       zustand：日期范围、隐私模式、弹层开关、toast
  lib/         纯函数：金额格式化、汇总计算、查询语言拼装
  motion/      GSAP 动效与 reduced-motion 判断
e2e/           Playwright 主路径
scripts/       check-contrast.mjs
```

服务端状态一律走 React Query，zustand 只放界面状态。两者不互相塞数据。

## 颜色

所有颜色走 `src/index.css` 里的 CSS 变量，组件里不写 Tailwind 调色板类
（`text-gray-500` 这类），`npm run check:colors` 会把它们挡下来。

几个容易用错的：

- `--brand` 是实心底的颜色，`--brand-text` 才是页面上当文字用的。深色主题下拿
  `--brand` 当文字色对比度只有 2.x:1，基本看不见。
- `--danger` 只给删除类操作。支出金额不算危险，走 `semanticColorClass()`。
- 金额颜色只有一个来源：`lib/format.ts` 的 `semanticColorClass()`。收入红、转账蓝、
  支出和中性用正文色（红涨绿跌，跟国内习惯一致）。

`npm run check:contrast` 按 WCAG 校验：正文 4.5:1，控件边界 3.0:1，浅深两套主题都算。

## 提交前

五条都要过，缺一条不算完：

```bash
npm run typecheck     # tsc -b --force。不要用 npx tsc --noEmit，它读不到项目引用配置，是假绿灯
npm run test:run
npm run lint
npm run check:colors
npm run check:contrast
npm run build
```

CI 跑的是 `lint && test:run && check:colors && check:contrast && build`，
`build` 里带 `tsc -b`，所以类型也在 CI 的覆盖范围内。

## e2e

```bash
make test-e2e         # 从仓库根目录跑，会带上 db/mail/app 容器
```

打的是真的 Firefly，不 mock。数据由 `php artisan system:seed-e2e` 重建，
每次都重播，因为主路径会写数据。细节见根目录 README。
