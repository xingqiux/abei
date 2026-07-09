# granary-web 工程方案 v1.0

> 2026-07-09。选型结论 Q8=全面切新前端：停止对 firefly-iii v1 界面的一切美化投入，
> 新建 `granary-web/` 承载全部 Web UI，按阶段替换后 DNS 切换。设计规范见 `ui-design-spec.md`。

## 1. 技术选型

| 层 | 选择 | 理由 |
|---|---|---|
| 构建 | Vite 7 | 生态默认；HMR 快 |
| 框架 | React 19 + TypeScript | 组件生态最全（Radix/shadcn、GSAP React、lottie 封装都一等公民） |
| 样式 | Tailwind CSS 4，**不引成品组件库** | token 用 CSS 变量承接设计规范；观感 100% 自研，避免 shadcn/daisyUI 的"预制脸" |
| 组件行为层 | **React Aria Components**（Adobe，headless 无样式） | Dialog/Menu/ComboBox/DatePicker/Table 的交互与无障碍白拿，样式完全自己写——这是去"AI 味"的关键：行为买现成，皮肤零预制 |
| 路由 | TanStack Router | 类型安全路由 + 搜索参数序列化（日期范围/筛选进 URL 的关键） |
| 数据 | TanStack Query + zod | API 响应 schema 校验；缓存/重试/乐观更新 |
| 图表 | **D3 模块化 + 自绘 SVG**（d3-scale/shape/array，弃 ECharts） | 图表种类少而固定（条形/面积线/日历带/成对条形），SVG 自绘完全贴 token、无 canvas 黑盒，入场动画统一交给 GSAP |
| 动效 | GSAP (core+Flip) + dotlottie-web + **lenis**（限定范围）+ **matter.js**（懒加载） | 见规范 §6；Lottie 素材本地托管 |

组件库结论（回应 shadcn"AI 味"问题）：
- **shadcn/ui 弃用**——默认观感已成 AI 生成应用的标准脸，而我们的规范本来就要求全自定义样式，它的预制层是负担。
- **daisyUI 评估**：确实现代、语义色 CSS 变量设计很好（这点我们直接借鉴到 tokens 命名）；但它是纯 CSS 皮肤——
  ①不解决我们真正缺的行为层（命令面板、组合框、日期范围选择器都要 JS）；②其圆润友好的成品观感是另一套设计语言，
  与高密度专业工具规范会互相打架；③在 MVP/独立开发圈的普及度正在复制 shadcn 的路径。结论：不作为主组件库；
  若后续想加速做次要页面（设置、表单类），可以引入 daisyUI 并把主题变量映射到谷仓 token，与 RAC 不冲突。
| 状态 | Query 为主 + zustand（纯 UI 状态） | 避免双状态源 |
| 日期 | date-fns 4 | 与 firefly-cli 一致 |
| 测试 | Vitest + Testing Library；Playwright（阶段2 起） | |
| i18n | 不引框架，中文硬编码 | 单用户产品；英文名只出现在品牌层 |

字体资产：MiSans 400/500/600 + JetBrains Mono 400/600，fonttools 子集化（GB2312 一级字集）
放 `src/assets/fonts/`，构建脚本 `scripts/subset-fonts.py`。

### 1.1 动效工具边界（lenis / matter.js / D3 的使用纪律）

- **lenis 平滑滚动**：只挂在"阅读型"长页（报表、设置、规范文档页）；
  "操作型"页面（交易列表、收件箱、对账）**禁用**——与虚拟滚动/键盘走行冲突，且数据表要的是即时响应。
- **matter.js 物理**：只允许两个场景——①空状态彩蛋"谷粒落仓"（谷粒受重力落进仓型容器）；
  ②里程碑庆祝（当月对账全部清零/储蓄目标达成时谷粒散落一次）。独立 chunk 懒加载（~90KB 不进首屏），
  `prefers-reduced-motion` 时整个模块不加载。
- **D3**：只用模块化子包（d3-scale/d3-shape/d3-array/d3-interpolate），不引 d3 全家桶；
  DOM 渲染交给 React（D3 只算坐标），入场动画交给 GSAP，保证与全站动效 token 一致。

### 1.2 动效图标与背景资产

资产由用户按 `docs/design/asset-collection-guide.md`（搜集指南：场景清单、免登录可直接下载的站点、
改色目标、命名与存放规范、许可检查表）自行搜集整理。硬性纪律：

- 所有 Lottie JSON **下载后本地托管**，禁止运行时外链；颜色统一改为谷仓 token 色再入库。
- 动效图标**只用于状态反馈与空状态**，静态导航/按钮图标一律用静态 SVG（Lucide），同屏最多一个动效图标在播。
- IconScout 需登录且免费层要署名——可用但非首选；优先 useanimations（开源）、LottieFiles 免费区、
  SVG 生成器（fffuel/haikei）等可直接下载的来源，详见指南。

## 2. 目录结构

```
granary-web/
├── src/
│   ├── api/            # firefly API client: fetch 封装、zod schemas、端点模块
│   ├── components/     # ui/(shadcn 定制) + granary/(KPI卡、账本表、金额、chip、徽标…)
│   ├── features/       # dashboard / transactions / bill-inbox / reconciliation /
│   │                   # budgets / accounts / reports / settings（页面+子组件+查询）
│   ├── motion/         # useCountUp / usePageTransition / useStaggerIn / lottie 资产
│   ├── routes/         # TanStack Router 路由树
│   ├── styles/         # tokens.css（设计规范 §2 的 CSS 变量，dark 默认）
│   └── lib/            # 金额格式化、日期范围、快捷键
├── scripts/subset-fonts.py
└── e2e/
```

## 3. 对接 Firefly III

- **认证**：Laravel Passport Personal Access Token；开发期 `.env.local` 注入，
  生产由同域反代避免 CORS（见 §5），token 存 httpOnly cookie 的 BFF 模式**不做**——单用户自托管，
  PAT + localStorage 够用，风险自担并在 README 标注。
- **现成 API**（v1 REST，`/api/v1/...`）：transactions、accounts、budgets、bills、categories、
  piggy-banks、rules、recurrences、summary/basic、charts——覆盖总览/交易/预算/账户/报表主干。
- **API 缺口（阶段 0 要补，都在 firefly-iii 仓库内新增 JSON 端点）**：
  1. `bill-inbox`：渠道列表/计数、条目审阅、行内编辑保存、触发同步、验证码提交
     （现为 Twig 控制器 `app/Http/Controllers/BillInbox*`，抽出 service 后加 `/api/v1/bill-inbox/*`）。
  2. `daily-reconciliation`：某日汇总+交易+差额、标记已对账、生成调整交易
     （同上，加 `/api/v1/daily-reconciliation/*`）。
  3. 偏好项读写（默认日期范围等）走现成 `/api/v1/preferences`。

## 4. 阶段计划

- **阶段 0 · API 补齐**：§3 缺口 1/2；给两组端点补 PHPUnit 测试（注意仓库 memory：
  跑单测要用临时 `-c` 配置而非 `--filter`）。
- **阶段 1 · 核心四页**：脚手架+tokens+组件底座 → 总览 → 交易列表 → 账单收件箱 → 按天对账。
  此阶段结束即可日常使用（记账靠 CLI/收件箱，Web 审阅闭环成立）。
- **阶段 2 · 补全**：记一笔表单、预算与订阅、账户、报表、设置、命令面板、移动端底部 tab。
- **阶段 3 · 切换**：Playwright 冒烟 → 部署 → 域名指向 granary-web，firefly v1 保留在
  `/legacy` 兜底（管理后台、OAuth 授权页等继续用它）。

## 5. 部署

deploy/firefly/docker-compose.yml 增加 `granary-web` 服务：多阶段 Dockerfile
（node build → nginx:alpine 托管 dist），nginx 将 `/api`、`/oauth`、`/legacy` 反代到 firefly 容器，
其余路径回退 `index.html`。同域反代天然规避 CORS。JD 服务器仍是 x86_64，
镜像继续本机 `--platform linux/amd64` 构建推送。
