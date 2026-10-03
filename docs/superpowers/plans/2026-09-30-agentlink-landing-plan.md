# AgentLink 人类主页 + 公开仓库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 上线双语 landing page（165 nginx `/`）并以 squash 干净历史建立公开 GitHub 仓库，形成"人看页面 → 转发 onboarding → agent 自助接入"的完整转化闭环。

**Architecture:** 纯静态单文件 HTML（零依赖零构建）托管在 165 nginx 精确 location，不触碰 AgentLink 服务端；公开仓库为当前 main 快照经去敏替换后的 squash 导出，私有仓库保留真实拓扑并新增发布脚本。

**Tech Stack:** 原生 HTML/CSS/JS（单文件）；nginx（既有 agentlink.conf）；git + shell 脚本。

**Spec:** `docs/superpowers/specs/2026-09-30-agentlink-landing-design.md`（文案 §2、结构 §3、视觉 §4、双语 §5、技术 §6、双仓库 §7 均以 spec 为准，本计划不复述文案正文）

## Global Constraints

- landing 单文件 < 60KB（gzip 前），无任何外部资源（无 CDN 字体/图床/统计脚本）
- 源文件入库 `web/landing/index.html`；165 上为部署副本
- 公开导出前扫描零命中（单一模式清单，sed 与门禁共用，spec §7"同源"）：`al_[A-Za-z0-9]{20,}`、`wl_[A-Za-z0-9]{20,}`、真实 IP 段**含裸前缀**（`203.0.113.10`/`203.0.113.20`/`203.0.113.30`/`192.0.2.x`/`192.0.2.x`，无尾随点也算命中——spec/plan 文档自身以裸前缀提及这些段）、`im.example.com`
- 不修改 AgentLink 服务端任何代码；API/WS/onboarding/healthz 路径行为不得变化
- commit 信息 conventional（`feat:`/`chore:`/`docs:`）

## Review Focus（无任务测试覆盖的输入类，钉到 owner 任务）

1. 移动端窄视口（375px）横向溢出 → Task 1 的检查脚本含 320px 无横向滚动断言的静态近似（meta viewport + 无固定宽度断言）
2. 双语切换后 `<html lang>` 与 localStorage 持久 → Task 1 检查脚本断言两份 `data-lang` 文案节点数一致（防漏译）
3. nginx 精确 location 与 API 路由冲突（`/` 被静态劫持、`/v1` 被静态劫持）→ Task 3 回归 curl 矩阵
4. 去敏清单漏网（spec/plan 内嵌的真实 IP）→ Task 2 扫描脚本作为发布门禁，测试钉住"清洗后的导出树零命中"
5. 双仓库误 push 方向（把私有内容推到公开仓库）→ Task 2 脚本内 push 前 re-scan，失败即 abort

---

### Task 1: Landing page 单文件实现

**Files:**
- Create: `web/landing/index.html`
- Test: `web/landing/check.mjs`（node 校验脚本，无依赖）

**Interfaces:**
- Consumes: spec §2（全部文案，中英两份）、§3（六节结构）、§4（视觉规范）、§5（双语策略）
- Produces: `web/landing/index.html`——部署单元；`web/landing/check.mjs`——`node check.mjs` 退出码 0/1

- [ ] **Step 1: 写校验脚本（先于页面）**

```js
// web/landing/check.mjs — node check.mjs；全部通过 exit 0
import { readFileSync, statSync } from 'node:fs'
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
if (statSync(new URL('./index.html', import.meta.url)).size > 60 * 1024) fail('file > 60KB')
// 外部资源零引用（仅允许指向本站与 GitHub 的锚点 href）
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const v = m[1]
  if (/^https?:\/\//i.test(v) && !/im.example.com|github\.com/.test(v)) fail('external ref: ' + v)
}
// 禁固定宽度（Review Focus #1 静态近似）
if (/width:\s*\d{4,}px/.test(html)) fail('fixed-width CSS')
// 六节齐备（按 spec §3 的节 id）
for (const id of ['hero', 'hook', 'pains', 'onboard', 'arch', 'footer']) {
  if (!html.includes(`id="${id}"`)) fail('missing section ' + id)
}
// 双语节点数一致：每个 data-zh 必有配对 data-en（或 lang 块对称，按实际实现）
const zh = [...html.matchAll(/data-zh="/g)].length, en = [...html.matchAll(/data-en="/g)].length
if (zh === 0 || zh !== en) fail(`zh/en mismatch: ${zh}/${en}`)
// 文案抽检（spec §2 逐字）
for (const s of ['给你的 AI agent 一个通讯地址', 'Give your AI agents a mailing address', '自托管', 'thread_id']) {
  if (!html.includes(s)) fail('missing copy: ' + s)
}
// 视觉规范要素
if (!/#0d1117/.test(html)) fail('dark bg missing')
if (!/prefers-reduced-motion/.test(html)) fail('reduced-motion missing')
if (!/name="viewport"/.test(html)) fail('viewport meta missing')
if (!/<html lang="/.test(html)) fail('html lang missing')
console.log(process.exitCode ? 'CHECK FAILED' : `OK (${zh} bilingual pairs)`)
```

（实现者可按最终双语实现机制调整配对断言的写法，但必须保住"每条中文有对应英文"这一不变量。）

- [ ] **Step 2: 跑红** — Run: `cd web/landing && node check.mjs`  Expected: FAIL（index.html 不存在）

- [ ] **Step 3: 实现 index.html**

按 spec §2-§5 全量落地。结构骨架（文案从 spec 逐字取，EN 按转写）：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentLink — 给你的 AI agent 一个通讯地址</title>
  <meta name="description" content="自托管的 AI agent 消息与任务协作服务器：一个地址全网可达、实时会话隔离、全程留痕、schema 验收与预算记账。">
  <meta property="og:title" content="AgentLink">
  <meta property="og:description" content="Give your AI agents a mailing address. Self-hosted, single process, SQLite.">
  <style>/* 内联：§4 视觉规范——#0d1117 底/#3fb950 强调/等宽代码块伪终端窗/移动端单列 */</style>
</head>
<body>
  <header><nav>…<button id="lang-toggle">EN</button></nav></header>
  <section id="hero">H1/H2 + CTA(→ /onboarding, → https://github.com/zangxin75/agentlink)</section>
  <section id="hook">钩子段（spec §2.2）</section>
  <section id="pains">五痛点对照（§2.3 双色卡片）</section>
  <section id="onboard">60 秒接入 + curl 代码块（§2.4）</section>
  <section id="arch">三卡：单进程零依赖 / 数据主权 / at-least-once+限流</section>
  <footer id="footer">GitHub · /onboarding · deploy · MIT</footer>
  <script>/* 内联：语言切换（navigator.language 探测 + localStorage）+ IntersectionObserver 淡入（尊重 prefers-reduced-motion）*/</script>
</body>
</html>
```

- [ ] **Step 4: 跑绿** — Run: `cd web/landing && node check.mjs`  Expected: `OK (N bilingual pairs)`
- [ ] **Step 5: Commit** — `git add web/landing && git commit -m "feat: bilingual terminal-style landing page"`

---

### Task 2: 公开仓库导出与去敏脚本

**Files:**
- Create: `scripts/publish-public.sh`
- Test: `scripts/test-publish-scrub.sh`（对临时导出树断言零命中，不真 push）

**Interfaces:**
- Consumes: Task 1 的 `web/landing/`（在导出树内）
- Produces: `scripts/publish-public.sh`——用法 `bash scripts/publish-public.sh [--push]`；默认只导出到 `/tmp/agentlink-public-export` 并跑扫描，`--push` 才推 `git@github.com:zangxin75/agentlink.git`

- [ ] **Step 1: 写失败测试**

```bash
#!/usr/bin/env bash
# scripts/test-publish-scrub.sh — 验证导出树去敏零命中
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/publish-public.sh || { echo "publish script failed"; exit 1; }
TREE=/tmp/agentlink-public-export
FAIL=0
# 门禁清单（spec §7）：真实凭据与拓扑零命中——与 publish-public.sh 共用同一清单（下方以变量复制保持同步）
PATTERNS='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117|im.example.com'
if grep -rEn "$PATTERNS" "$TREE" --exclude-dir=.git -q; then
  echo "LEAK FOUND:"; grep -rEn "$PATTERNS" "$TREE" --exclude-dir=.git | head -20; FAIL=1
fi
# 关键文件必须在
for f in README.md web/landing/index.html docs/deploy.md server/src/index.ts mcp/src/index.ts; do
  [ -f "$TREE/$f" ] || { echo "missing $f"; FAIL=1; }
done
# SDD 台账不入公开
[ ! -e "$TREE/.superpowers" ] || { echo ".superpowers leaked"; FAIL=1; }
# squash 单提交
[ "$(git -C "$TREE" rev-list --count HEAD)" = "1" ] || { echo "history not squashed"; FAIL=1; }
exit $FAIL
```

- [ ] **Step 2: 跑红** — Run: `bash scripts/test-publish-scrub.sh`  Expected: FAIL（publish-public.sh 不存在）

- [ ] **Step 3: 实现 publish-public.sh**

```bash
#!/usr/bin/env bash
# 导出干净快照到公开仓库：去敏替换 → squash 单提交 → （--push 时）推送
set -euo pipefail
cd "$(dirname "$0")/.."
EXPORT=/tmp/agentlink-public-export
REMOTE_PUBLIC="${REMOTE_PUBLIC:-git@github.com:zangxin75/agentlink.git}"

rm -rf "$EXPORT" && mkdir -p "$EXPORT"
git archive HEAD | tar -x -C "$EXPORT"
# 排除运营性文件
rm -rf "$EXPORT/.superpowers"
# 去敏替换（sed 清单——真实拓扑仅存于本私有仓库与 165）
# 去敏替换（sed 清单与门禁同源——裸前缀也算命中，覆盖 spec/plan 文档中的裸段提及）
grep -rlE '203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117|im.example.com' "$EXPORT" --exclude-dir=.git |
  xargs -r sed -i -E \
    -e 's/203.0.113.10(\.[0-9.]+)?/203.0.113.10/g' \
    -e 's/203.0.113.20(\.[0-9.]+)?/203.0.113.20/g' \
    -e 's/203.0.113.30(\.[0-9.]+)?/203.0.113.30/g' \
    -e 's/100\.(107|117)(\.[0-9.]+)?/192.0.2.x/g' \
    -e 's/[a-z0-9-]+\.im.example.com/im.example.com/g'
# 推送前自检（同一清单；失败即 abort，防误推）
PATTERNS='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117|im.example.com'
if grep -rEn "$PATTERNS" "$EXPORT" --exclude-dir=.git -q; then
  echo "ABORT: sensitive strings remain:" >&2
  grep -rEn "$PATTERNS" "$EXPORT" --exclude-dir=.git | head >&2
  rm -rf "$EXPORT"
  exit 1
fi
git -C "$EXPORT" init -q && git -C "$EXPORT" add -A
git -C "$EXPORT" -c user.name=kt -c user.email=kt@localhost commit -qm "feat: AgentLink v1.1 — self-hosted messaging & task server for AI agents

Co-Authored-By: Claude Code <noreply@anthropic.com>"
if [ "${1:-}" = "--push" ]; then
  git -C "$EXPORT" remote add origin "$REMOTE_PUBLIC"
  git -C "$EXPORT" push -f origin HEAD:main
else
  echo "dry-run OK: $EXPORT (1 commit, scrubbed). Re-run with --push to publish."
fi
```

- [ ] **Step 4: 跑绿** — Run: `bash scripts/test-publish-scrub.sh`  Expected: exit 0
- [ ] **Step 5: Commit** — `git add scripts/publish-public.sh scripts/test-publish-scrub.sh && git commit -m "chore: public-repo export script with scrub gate"`

注意：本任务**不执行 `--push`**——GitHub 侧建仓/私有仓库改名/推送是用户门禁动作（见 Task 3 后的上线清单）。

---

### Task 3: 165 部署与全量回归

**Files:**
- Modify: 165 `/etc/nginx/sites-enabled/agentlink.conf`（加 `location = /`）
- Test: 本地 curl 回归矩阵（无新测试文件）

**Interfaces:**
- Consumes: Task 1 的 `web/landing/index.html`
- Produces: `https://im.example.com/` 与 `https://im.example.com/` 返回 landing 页

- [ ] **Step 1: 上传页面** — `scp web/landing/index.html server165:/tmp/` 后 `ssh server165 'sudo install -m 644 /tmp/index.html /var/www/agentlink/index.html'`
- [ ] **Step 2: nginx 加精确 location** — 仅在 **443** server 块 `location = /onboarding` 旁加（80 块保持 `location / { return 301 … }` 不动——精确匹配优先于前缀匹配，若在 80 块也加会劫持 HTTPS 重定向，明文直接出页）：

```nginx
    location = / { alias /var/www/agentlink/index.html; }
```

（精确匹配 `= /` 优先级最高，不影响 `/v1`、`/ws`、`/onboarding` 的既有 location；http:// 入口仍统一 301 到 https://。）

- [ ] **Step 3: 回归矩阵** — Run（两域名各跑一遍）：

```bash
for host in agentlink im; do
  u="https://$im.example.com"
  curl -sf "$u/healthz" >/dev/null && echo "$u healthz OK" || echo "$u healthz FAIL"
  curl -sf "$u/onboarding" | head -1 | grep -q AgentLink && echo "$u onboarding OK" || echo "$u onboarding FAIL"
  curl -sf "$u/" | grep -q '通讯地址' && echo "$u landing OK" || echo "$u landing FAIL"
  curl -s -o /dev/null -w '%{http_code}\n' "$u/v1/agents" | grep -q 401 && echo "$u api-guard OK" || echo "$u api-guard FAIL"
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$u/ws" | grep -q 101 && echo "$u ws OK" || echo "$u ws FAIL"
done
```

Expected: 十行全 OK。任一 FAIL 即回滚 nginx location 并排查。
- [ ] **Step 4: 记录部署** — 无代码提交（165 侧变更）；在私有仓库 `docs/deploy.md` 追加一行"landing 页部署于 165 `/var/www/agentlink/`"，`git commit -m "docs: landing deployment note"`

---

## 上线清单（用户门禁，非任务）

1. GitHub：私有仓库改名 `agentlink-dev`（已完成 2026-09-30）→ 新建空公开仓库 `agentlink` → 告知助手 → 助手跑 `bash scripts/publish-public.sh --push`
2. 推送后人工抽查公开仓库 README/deploy 无敏感信息
3. spec §8.3 Lighthouse ≥ 95 与 §8.4 人工核对中英翻译——用户浏览器手动验收（计划不派 headless Chrome）

## 自审记录

- Spec 覆盖：§2-§5→Task 1、§6→Task 1+3、§7→Task 2、§8.1/8.2/8.5→各任务步骤+回归矩阵、§8.3/8.4→上线清单人工验收 ✔
- 占位符：无 TBD；文案以 spec 为唯一来源（spec 随计划 travels）✔
- 类型/接口一致：check.mjs 断言的节 id 与骨架一致；publish 脚本与测试脚本共用同一 PATTERNS 清单（含裸前缀）✔
- Review Focus 五条均有归属 ✔

## Critic r1 修订记录（2026-09-30）

C1 sed 量化符 `+`→`(\.[0-9.]+)?`（裸前缀 `203.0.113.10.` 反引号相邻处不替换→门禁必 abort）；I2 门禁与 sed 扩到裸前缀；I3 push 前门禁补 192.0.2.x/192.0.2.x 并与测试共用清单、abort 时清导出树；I4 nginx 仅 443 块加 location（80 块重定向保持）；M dead cdn-ref 断言删除、补固定宽度禁令；缺失项 §8.3/§8.4 归入上线清单人工验收。
