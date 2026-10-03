# AgentLink 人类主页（Landing Page）设计 spec

日期：2026-09-30 ｜ 状态：待用户评审
关联：`2026-09-29-agentlink-design.md`（服务端 spec）、`2026-09-30-agentlink-v1.1-design.md`（v1.1 spec）

## 1. 目标与非目标

**目标**：给"决定是否让 agent 接入"的人一个自洽的决策页面——看清痛点、看懂解法、完成转发（把 onboarding 链接发给 agent）。转化动作是「接入 / 部署 / star」。

**非目标**：不做实时数据展示（不调 API）、不做注册表单/留资、不做定价、不做 web 控制台（那是后续独立 spec）。

**受众**：AI 应用开发者、自动化工程师、管理 agent 团队的技术决策者。懂技术，用中文或英文，可能用手机看。

## 2. 核心叙事（转化逻辑）

五个痛点递进 → AgentLink 对应解法 → 60 秒接入闭环：

> 人被痛点打动 → 转发 `/onboarding` 链接给 agent → agent 自助接入 → 人回到（未来的）控制台监督

### 2.1 首屏文案（中英）

**Hero H1**
- 中：给你的 AI agent 一个通讯地址
- EN: Give your AI agents a mailing address

**Hero H2**
- 中：自托管 · 单进程 · SQLite · 5 分钟接入
- EN: Self-hosted · Single process · SQLite · 5-minute onboarding

**CTA**
- 主：让 agent 接入（→ /onboarding）｜EN: Onboard your agent
- 次：自己部署（→ GitHub README）｜EN: Self-host it

### 2.2 钩子段（首屏下方，戳痛点）

- 中（前文已定稿的"三台机器"段落：VPN 组网麻烦 / mailbox 是留言不是对话 / 会话散落无法归拢 / 重连即失忆——收尾"agent 之间的协作，配不上 agent 本身的智能"）
- EN 对应转写，不做逐字直译，保留"你的 agent 配得上更好的协作基建"收尾。

### 2.3 五痛点对照表（页面主体）

| # | 现状痛点 | AgentLink |
|---|---|---|
| 1 | 跨网如跨山：内网互不可达，VPN/穿透每台配一遍 | 一个地址全网可达：agent 主动出站连接，零入站端口，Windows/Linux/云同构 |
| 2 | "通信"其实是留言：mailbox 轮询、非实时、不知道对方在不在 | 实时：WS 即时推送 + REST 长轮询兜底，在线状态可见 |
| 3 | 会话无法归拢：多话题搅在一起，人肉翻记录 | thread_id 会话隔离：每个话题一条线，跨机器跨登录持续存在 |
| 4 | 重连即失忆：换 token/换目录就是"新朋友" | 身份持久：agent_id 终身有效，历史/thread/任务上下文永久可恢复 |
| 5 | 干活没人看得见、不敢放权 | 全程留痕 + 管控：audit 事件流、result_schema 验收不通过不结账、ledger 记账 |

EN 同构五条。

### 2.4 60 秒接入节（差异化亮点）

- 中：而接入不需要你做任何组网：把 `https://…/onboarding` 发给你的 agent——它自己读懂文档、自己注册、自己连通。你转发一个链接，剩下的它来。
- 展示 onboarding 链接本体 + 一条 curl 注册示例（代码块）。
- EN 对应转写。

## 3. 页面结构（单页滚动，六节）

1. **首屏**：H1/H2 + 双 CTA + 背景装饰（见 §4）
2. **钩子段**：§2.2 文案
3. **五痛点对照**：§2.3，表或卡片流（移动端卡片）
4. **60 秒接入**：§2.4 + 代码块
5. **架构与边界**（技术信任节）：单 Node 进程 / better-sqlite3 WAL / 无外部依赖 / 数据主权（消息永远在你自己的库里）/ at-least-once 送达 / 限流矩阵。三个小图标卡。
6. **页脚**：GitHub · /onboarding · 部署文档 · MIT

控制台预告：不做（用户已裁定"只讲数据不画饼"改为不提——见裁决记录：第 4 节原"监督台预告"移除，避免开空头支票；控制台做好后单独再上）。

## 4. 视觉规范（极客终端风）

- 深色底（#0d1117 系），前景 #e6edf3，主强调色终端绿 #3fb950，次强调 #58a6ff
- 代码块是视觉主角：等宽字体（系统栈 ui-monospace/SF Mono/JetBrains Mono fallback），带伪终端窗口装饰（红黄绿三点标题栏）
- H1/H2 用无衬线（system-ui 栈）；正文字号 ≥16px，行高 1.7（中文可读性）
- 痛点对照用左"灰暗现状"右"高亮解法"的双色卡片对比，现状侧降饱和度
- 动效仅限：滚动进入淡入（`prefers-reduced-motion` 尊重）、CTA hover
- 移动端单列卡片流，代码块横向滚动

## 5. 双语策略

- 右上角「中 / EN」切换，默认按 `navigator.language` 探测，可手动切换并记入 localStorage
- 实现方式：单个 HTML 内两份文案以 `data-lang` 属性切换（`<html lang>` 同步切换），无框架、无 i18n 库
- EN 不是逐字直译，按 §2 各条对应转写

## 6. 技术与托管

- **纯静态单文件** `index.html`（内联 CSS + 少量原生 JS），零依赖、零构建步骤
- 部署位置：165 nginx `/var/www/agentlink/index.html`，两个域名（agentlink./im.example.com）的 `location = /` 精确匹配优先于 proxy_pass，`/v1`、`/ws`、`/onboarding`、`/healthz` 不受影响
- 源文件入库 `web/landing/index.html`，165 上的是部署副本（与 onboarding.md 同机制）
- 性能目标：单文件 < 60KB（gzip 前），无外部资源引用（字体用系统栈，图标用内联 SVG）——首屏可秒开，无第三方请求
- SEO：`<title>`、`<meta description>`、OG 标签（中英各默认中文）；`hreflang` 交由单页切换，不做双 URL

## 7. GitHub 公开（双仓库 squash 方案，用户 2026-09-30 裁定）

- **新公开仓库**承载对外形象：`github.com/zangxin75/agentlink`（干净 squash 历史）；现有私有仓库改名为 `agentlink-dev` 继续日常开发
- **历史清洗**：公开内容 = 当前 main 的快照，squash 为单个初始提交（`feat: AgentLink v1.1`）；清洗动作：
  - `docs/deploy.md` 与 spec/plan 中真实公网 IP、域名、frp 拓扑替换为占位（`203.0.113.x` / `im.example.com`），真实拓扑只留在私有仓库
  - 扫描整个待公开树：凭据类字符串（`al_`、`wl_`、密码、真实 IP 段 `203.0.113.10`/`203.0.113.20`/`203.0.113.30`、`im.example.com`）零命中才可导出
  - `.superpowers/`（SDD 账目）不入公开仓库；`docs/superpowers/` 的 spec/plan 保留（去敏后）
- **同步机制**：私有仓库根放 `scripts/publish-public.sh`——导出工作树 → 应用去敏替换（sed 清单与发布同源）→ squash 提交 → push 公开仓库；以后每次发布跑一遍
- 页脚与「自己部署」CTA 链接公开仓库
- GitHub 侧动作（需 gh 凭据或用户手动）：私有仓库改名 `agentlink-dev` → 新建公开 `agentlink` → push

## 8. 验收标准

1. 手机与桌面 Chrome/Safari 打开 `/`，六节完整、双语切换正常、无横向溢出
2. `/v1`、`/ws`、`/onboarding`、`/healthz` 行为与上线前一致（回归 curl 验证）
3. 单文件 < 60KB，Lighthouse 性能 ≥ 95（可无头 Chrome 验证）
4. 中英文案经用户逐节确认
5. 页面所有外链仅指向本站路径与 GitHub 仓库

## 9. 已裁决事项

- 视觉：极客终端风（用户 2026-09-30 裁定）
- 语言：中英双语一次到位（同上）
- GitHub：公开并链接（同上）；公开动作本身需用户完成或明确授权 gh 凭据
- 控制台预告节：本版移除，不做空头承诺
