# AgentLink 客户端分发实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让人类在落地页复制一行安装命令发给 agent，agent 在自己机器上执行后获得完整 im CLI + daemon + Stop hook 客户端（tarball + install.sh/ps1，可自托管分发源）。

**Architecture:** `ws` 以 vendor 树提交进 `skills/agentlink/vendor/ws/`（单一来源，tarball 裸机自足）；`scripts/build-client-dist.sh` 从 `git archive` 产出多版本 tarball（压缩前跑敏感扫描门禁 + 分发版 SKILL.md sed 改写）；`scripts/install.sh`/`install.ps1` 只装文件（下载→SHA256 校验→临时目录→原子改名到 `~/.agentlink/client/`），注册/daemon/hooks 由 agent 按 SKILL.md 自助；落地页 onboard 区新增双平台安装命令区块。

**Tech Stack:** bash / PowerShell 5.1+ / node:test / curl + sha256sum / tar -xzf。无新增 npm 依赖。

**Spec:** `docs/superpowers/specs/2026-09-30-agentlink-client-dist-design.md`（r2 复审通过，行为争议以 spec 为准）

## Global Constraints

- **不修改 AgentLink 服务端代码**（`server/`、`mcp/` 目录零改动；延续落地页 spec 约束）
- **tarball 裸机自足是硬约束**（spec §2）：无 checkout、无 node_modules 时 `node im.mjs --help` 与 `node daemon.mjs` 可运行；`ws` 唯一来源是提交进仓库的 `skills/agentlink/vendor/ws/`，构建**不**从 `node_modules/` 复制
- **敏感扫描门禁清单与 `publish-public.sh` 同源**（spec §6）：`al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117|im.example.com`——扫描必须在 **tar 压缩之前**对解包树执行，命中即 abort
- **install 脚本边界**（spec §4）：只装文件；不碰 sudo、不改 PATH、不写任何 Claude Code 配置；`set -euo pipefail`（ps1 用 `$ErrorActionPreference='Stop'`）；全脚本 <200 行；校验/解压失败 → 明确报错退出、先解到临时目录再原子改名、不留半成品
- **install.ps1 首个可执行语句强制 TLS1.2**（spec §4）：`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`
- **环境变量契约**（spec §4）：`AGENTLINK_DIST_BASE`（默认 `https://im.example.com/download`）、`AGENTLINK_VERSION`（默认 latest）、`AGENTLINK_INSTALL_DIR`（默认 `~/.agentlink/client`）
- **落地页 <60KB**（现状 20.7KB，check.mjs 已断言）；新安装命令 URL 全部 `im.example.com` 自家域（check.mjs external-ref 白名单天然覆盖）
- 产物 `web/download/` 不入 git（.gitignore 追加），只入库脚本与 install 源文件
- commit 端 Co-Authored-By: Claude Code <noreply@anthropic.com>；中文注释、conventional commit（feat:/test:/chore:/docs:）
- skills 套件跑法（Node v24 目录形式不可用，既有 Ruling）：`node --test "skills/agentlink/test/*.test.mjs"`

## Review Focus

spec 未明说、最可能咬人的五类输入/场景（每行后括号 = 钉死它的测试，已并入所属任务）：

1. **裸机无 node_modules 跑 daemon**——`import 'ws'` 直接崩。vendor 树必须封闭（ws 的 lib/ 相对引用、无运行时依赖）→ T3 裸目录冒烟（全新临时目录解包跑 `node im.mjs --help` + `node daemon.mjs` 3 秒可杀）
2. **`curl … | bash` 管道场景变量不可见**——install.sh 若依赖"先 export 再跑"在管道下失效；且管道下 `read` 交互不可用 → T4 测试以管道形式调用（`cat install.sh | AGENTLINK_DIST_BASE=… bash`）验证变量经环境传入可用、脚本零交互
3. **重跑升级时旧 spool/配置被清**——用户本地 `~/.agentlink/` 下有 agents.d、state（daemon 产物），安装器覆盖 `client/` 时绝不能动同级目录 → T4 断言：预置 `~/.agentlink/state/keepme` 文件，安装后仍存在
4. **SHA256SUMS 与实际 tarball 不匹配**（传输截断/镜像被改）——必须硬失败且不留半成品目录 → T4 用篡改过的 SHA256SUMS 断言非零退出 + 目标目录不存在
5. **PS 5.1 默认 TLS 握手失败**——Win10 未启用 TLS1.2 的机器 `irm` 直接连不上 → T5 结构断言：`install.ps1` 第一个非注释可执行语句即 TLS1.2 设置（grep 钉死顺序）

---

### Task 1: vendor `ws` 进仓库 + daemon/测试导入改造

**Files:**
- Create: `skills/agentlink/vendor/ws/`（wrapper.mjs、index.js、lib/ 全部 13 个 .js、package.json、LICENSE，共约 17 个文件）
- Modify: `skills/agentlink/daemon.mjs:6`
- Modify: `skills/agentlink/test/daemon.test.mjs:6`
- Modify: `CLAUDE.md` Layout 一节（npm workspaces 段，约 31 行处）

**Interfaces:**
- Consumes: 根 devDep `ws@^8.18.0`（`npm install` 后 `node_modules/ws/`）
- Produces: `import WebSocket from './vendor/ws/wrapper.mjs'`（daemon.mjs）；`import { WebSocketServer } from '../vendor/ws/wrapper.mjs'`（测试）。vendor 入口统一用 **wrapper.mjs**（ESM 入口，default=WebSocket、named WebSocketServer 均验证可用；不要用 index.js——它是 CJS，`module.exports = WebSocket` 形态下 named import 不可靠）

**背景**：tarball 要在裸机自足（spec §2 硬约束）。ws 8.x 无运行时依赖，vendor 树封闭。**不要复制 browser.js / README.md**（无用体积）。`git archive` 天然带上已提交的 vendor 树——本任务是后续所有构建的地基。

- [ ] **Step 1: 写失败测试（vendor 缺失即红）**

```js
// skills/agentlink/test/vendor-ws.test.mjs
// T1：vendor ws 树自足——裸导入（不经过 node_modules 解析）即 wrapper.mjs 两个导出可用
import test from 'node:test'; import assert from 'node:assert/strict'
import WebSocket, { WebSocketServer } from '../vendor/ws/wrapper.mjs'
import { readFileSync } from 'node:fs'

test('vendor ws：default=WebSocket 类、named WebSocketServer 可用、LICENSE 在', () => {
  assert.equal(typeof WebSocket, 'function')
  assert.equal(typeof WebSocketServer, 'function')
  assert.ok(WebSocket.prototype.on)                       // 事件 API 形态
  assert.ok(readFileSync(new URL('../vendor/ws/LICENSE', import.meta.url), 'utf8').includes('MIT'))
})
```

- [ ] **Step 2: 跑测试确认失败** → `node --test "skills/agentlink/test/vendor-ws.test.mjs"` FAIL（`Cannot find module …/vendor/ws/wrapper.mjs`）

- [ ] **Step 3: 复制 vendor 树 + 改导入**

```bash
npm install                       # 根 devDep 含 ws（worktree 当前无 node_modules；workspaces 全仓装配，首次较慢，属一次性成本）
mkdir -p skills/agentlink/vendor/ws
# 精确文件集：wrapper.mjs index.js lib/ package.json LICENSE（排除 browser.js README.md）
cp node_modules/ws/wrapper.mjs node_modules/ws/index.js node_modules/ws/package.json node_modules/ws/LICENSE skills/agentlink/vendor/ws/
cp -r node_modules/ws/lib skills/agentlink/vendor/ws/lib
git check-ignore skills/agentlink/vendor/ws/index.js && echo IGNORED-BAD || echo OK-NOT-IGNORED   # 必须输出 OK-NOT-IGNORED
```

- `daemon.mjs:6`：`import WebSocket from 'ws'` → `import WebSocket from './vendor/ws/wrapper.mjs'`
- `daemon.test.mjs:6`：`import { WebSocketServer } from 'ws'` → `import { WebSocketServer } from '../vendor/ws/wrapper.mjs'`
- `CLAUDE.md` Layout 一行末尾追加说明：`skills/agentlink/vendor/ws/`（ws 的 vendored 副本，仅 daemon.mjs 使用；im.mjs 保持零依赖）

- [ ] **Step 4: 全量回归** → `node --test "skills/agentlink/test/*.test.mjs"` 全绿（24 个含新测试）+ `npm test` 全绿（skills 24 / server 124 / mcp 5；mcp 需 `npm -w mcp run build`，既有情况）

- [ ] **Step 5: Commit**

```bash
git add skills/agentlink/vendor skills/agentlink/daemon.mjs skills/agentlink/test/daemon.test.mjs skills/agentlink/test/vendor-ws.test.mjs CLAUDE.md
git commit -m "feat(client): vendor ws 进仓库，daemon 改 vendor 导入（tarball 自足性地基）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: daemon 协议错配不静默——报错带本机 VERSION

**Files:**
- Modify: `skills/agentlink/daemon.mjs`（约 57/67 行附近 connect/auth 失败路径）
- Test: `skills/agentlink/test/daemon.test.mjs`（追加 1 个用例）

**Interfaces:**
- Consumes: 无（本任务独立于 T1 之后的构建链）
- Produces: `readVersion()` 内部函数 + 失败日志格式 `daemon VERSION=<ver>: <原消息>`。`<ver>` 读包内 `VERSION` 文件（`new URL('./VERSION', import.meta.url)`），缺失（checkout 内开发态）显示 `(dev)`。T3 的构建脚本会写入该 VERSION 文件。

**背景**（spec §2 末段）：daemon 首个协议级失败（AUTH_FAILED / backfill HTTP 4xx / connect 异常）时输出本机版本与排障指引——"错配不静默"。服务端版本暴露不在本次范围，所以只做客户端侧。

- [ ] **Step 1: 写失败测试**（daemon.test.mjs 追加；**复用本文件既有 `mockServer` harness**——r1 C1：端口不可达场景一行日志都不打（error 事件被吞、close 只静默退避），唯一可驱动的协议失败路径是假服务端发 AUTH_FAILED error 帧 + close(4003)，正好命中 `daemon.mjs:67` 接入点。测试环境无 VERSION 文件 → 期望 `(dev)`）

```js
test('daemon 协议失败日志带 VERSION（无 VERSION 文件时为 (dev)）', async () => {
  const logs = []; const orig = console.log
  console.log = (...a) => logs.push(a.join(' '))
  const s = mockServer(async (ws) => {   // auth_ok 之后：真实 hub 形状的协议失败（daemon.mjs:67 注释同源）
    ws.send(JSON.stringify({ op: 'error', code: 'AUTH_FAILED', message: 'bad token' }))
    ws.close(4003)
  }, { messages: [] })
  const port = await s.port
  envFile('/wv', 'v', 'badtoken', port)
  const { createDaemon } = await import('../daemon.mjs')
  const d = createDaemon({ hostname: HOST })
  await sleep(300)
  await d.stop(); await s.close(); console.log = orig
  assert.ok(logs.some(l => l.includes('daemon VERSION=')), 'logs: ' + logs.join('|'))
})
```

（`mockServer`/`envFile`/`sleep`/`HOST` 均为本文件既有样板，直接用；`console.log` 捕获在 `finally` 语义上须保证恢复——照上面顺序写死即可。）

- [ ] **Step 2: 跑测试确认失败** → FAIL（日志无 VERSION）

- [ ] **Step 3: 实现**

```js
// daemon.mjs 顶部（import 之后）
const VERSION = (() => { try { return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim() } catch { return '(dev)' } })()
const vlog = (...a) => log(`daemon VERSION=${VERSION}:`, ...a) // 协议级失败专用：错配不静默（spec §2）
```

三处接入（保留原消息语义）：`connect ${agentId}: ${e.message}` → `vlog(\`connect ${agentId}: ${e.message}（本机客户端版本如上；若持续失败，向服务器管理员核对你的 AgentLink 服务器版本，或用 AGENTLINK_VERSION 回退旧客户端）\`)`；`backfill ${agentId}` 的 catch 同改 vlog；`auth failed ${agentId} (token revoked?) — not reconnecting until env changes` 改 vlog（同句尾注保留）。注意 `'error'` 事件吞掉（78 行）与 `close` 退避（72-77 行）**不打日志、不改**——本任务的触发面是这三条既有日志路径。普通 info 日志（spool/ack/heartbeat）**不**加前缀——只标协议失败。

- [ ] **Step 4: 全量回归** → `node --test "skills/agentlink/test/*.test.mjs"` + `npm test` 全绿

- [ ] **Step 5: Commit**

```bash
git add skills/agentlink/daemon.mjs skills/agentlink/test/daemon.test.mjs
git commit -m "feat(client): daemon 协议失败日志带本机 VERSION（错配不静默）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: 构建脚本 + contrib unit + 产物/自足性测试

**Files:**
- Create: `skills/agentlink/contrib/agentlink-daemon.service`（分发版 unit，ExecStart 用安装布局）
- Create: `scripts/build-client-dist.sh`
- Create: `scripts/test-client-dist.sh`
- Modify: `.gitignore`（追加 `web/download/`）
- Test: `scripts/test-client-dist.sh` 自身（node 无依赖，CI 可跑；不新增 node:test 文件——shell 断言即可）

**Interfaces:**
- Consumes: T1 的 vendor 树（git archive 自动携带）；`publish-public.sh` 的 PATTERNS 清单（同源复制，见下）
- Produces: `web/download/agentlink-<ver>.tar.gz`、`web/download/agentlink.tar.gz`（latest 副本，内容与版本文件一致）、`web/download/SHA256SUMS`（两行）、tarball 内顶层目录 `agentlink/`（内含 SKILL.md 分发版、im.mjs、daemon.mjs、hook-stop.mjs、lib/、bin/、vendor/ws/、contrib/、VERSION；**无 test/**）。`<ver>` = `git describe --tags 2>/dev/null || echo "0.0.0-$(date +%Y%m%d)-$(git rev-parse --short HEAD)"`

**注意**：现有 `deploy/agentlink-daemon.service`（仓库布局版）**不动**；分发版 unit 是 `skills/agentlink/contrib/` 下的新文件，两者并存（spec §4 daemon 常驻段）。

- [ ] **Step 1: 写失败测试**（test-client-dist.sh 全文——先写测试后写实现，跑第一遍必然 FAIL 在"build 脚本不存在"）

```bash
#!/usr/bin/env bash
# scripts/test-client-dist.sh — 客户端分发产物测试（spec §8）：构建 → 清单/扫描/SKILL 断言 → 裸目录冒烟
set -euo pipefail
cd "$(dirname "$0")/.."
FAIL=0; ok(){ echo "ok  - $1"; }; bad(){ echo "FAIL: $1"; FAIL=1; }
DL=web/download; TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

bash scripts/build-client-dist.sh >/dev/null || { echo 'FAIL: build 脚本失败'; exit 1; }

# 1. 产物清单（spec §2）
[ -f "$DL/agentlink.tar.gz" ] && ok latest tarball || bad 缺latest
V=$(ls "$DL" | grep -E '^agentlink-.*\.tar\.gz$' | head -1)   # 放宽 tag 形态（r2 m2；排除 agentlink.tar.gz 由 -.* 保证）
[ -n "$V" ] && ok "版本化 tarball: $V" || bad 缺版本化tarball
grep -qE '^[0-9a-f]{64}  agentlink\.tar\.gz$' "$DL/SHA256SUMS" && ok SHA256SUMS-latest || bad SHA256SUMS不含latest
(cd "$DL" && sha256sum -c SHA256SUMS >/dev/null) && ok SHA256SUMS校验通过 || bad SHA256校验失败
# 双 tarball 内容一致（spec §2「latest 副本（与版本文件内容一致）」；r1 m7——gzip 压缩时间戳致字节可差，
# 故比成员清单+VERSION 内容而非 cmp 字节）
diff <(tar -tzf "$DL/agentlink.tar.gz") <(tar -tzf "$DL/$V") >/dev/null && ok 双tarball清单一致 || bad 双tarball清单不一致
diff <(tar -xzOf "$DL/agentlink.tar.gz" agentlink/VERSION) <(tar -xzOf "$DL/$V" agentlink/VERSION) >/dev/null && ok 双tarball版本一致 || bad 双tarball版本不一致
TARBALL="$DL/agentlink.tar.gz"

# 2. tarball 结构：顶层 agentlink/、VERSION 在、test/ 不在、vendor/contrib 在
tar -tzf "$TARBALL" >"$TMP/list"
grep -q '^agentlink/VERSION$' "$TMP/list" && ok VERSION在 || bad 缺VERSION
grep -q '^agentlink/vendor/ws/wrapper.mjs$' "$TMP/list" && ok vendor在 || bad 缺vendor
grep -q '^agentlink/contrib/agentlink-daemon.service$' "$TMP/list" && ok contrib在 || bad 缺contrib
if grep -qE '^agentlink/test/' "$TMP/list"; then bad "test/未被排除"; else ok test已排除; fi
tar -xzf "$TARBALL" -C "$TMP"

# 3. 敏感扫描零命中（tarball 侧全量清单；install 源文件用 INSTALL 清单——其默认域 im.example.com 是刻意公开信息，豁免；
#    token 与内网 IP 项保留。两清单与 build 脚本逐字同源，r1 C4）
PATTERNS='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117|im.example.com'
PATTERNS_INSTALL='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117'
if grep -rEn "$PATTERNS" "$TMP/agentlink" -q; then bad 敏感串命中tarball; else ok 敏感扫描零命中-tarball; fi
if grep -rEn "$PATTERNS_INSTALL" scripts/install.sh scripts/install.ps1 -q 2>/dev/null; then bad 敏感串命中install; else ok 敏感扫描零命中-install; fi

# 4. 分发版 SKILL.md 断言（spec §8）：无仓库布局路径、命令带安装前缀
SK="$TMP/agentlink/SKILL.md"
grep -q 'skills/agentlink' "$SK" && bad SKILL残留仓库路径 || ok SKILL无仓库路径
grep -q 'bin/im ' "$SK" && bad SKILL残留bin/im裸用 || ok SKILL无bin/im裸用
grep -q 'node ~/.agentlink/client/im.mjs' "$SK" && ok SKILL安装前缀 || bad SKILL缺安装前缀
grep -q '注册码向你的 AgentLink 服务器管理员' "$SK" && ok 注册码来源 || bad SKILL缺注册码来源   # 与 sed 插入文本逐字对齐（r1 M2）

# 5. 裸目录冒烟（关键，spec §8）：无 checkout、无 node_modules，锁 vendor 自足性
#    AGENTLINK_CONFIG/STATE 指向 $TMP——不污染真实 HOME（r1 m4；daemon 心跳/spool 默认落 ~/.local/state）
BARE=$TMP/bare; mkdir "$BARE"; tar -xzf "$TARBALL" -C "$BARE"
node "$BARE/agentlink/im.mjs" --help >/dev/null 2>&1 && ok 裸目录im || bad 裸目录im失败
AGENTLINK_CONFIG="$TMP/smoke-cfg" AGENTLINK_STATE="$TMP/smoke-state" \
  node "$BARE/agentlink/daemon.mjs" >/dev/null 2>&1 & DPID=$!
sleep 3; kill "$DPID" 2>/dev/null || bad 裸目录daemon3秒内退出
ok 裸目录daemon可运行

[ "$FAIL" = 0 ] && echo 'ALL OK' || { echo 'CHECK FAILED'; exit 1; }
```

- [ ] **Step 2: 跑测试确认失败** → `bash scripts/test-client-dist.sh` FAIL（`build-client-dist.sh: No such file or directory`）

- [ ] **Step 3: 实现**

`skills/agentlink/contrib/agentlink-daemon.service`（分发版——与 deploy/ 版差异仅 ExecStart 与安装注释）：

```ini
# AgentLink 本地守护（用户级 systemd unit，分发版——随客户端 tarball 安装）
# 安装：cp ~/.agentlink/client/contrib/agentlink-daemon.service ~/.config/systemd/user/
#       systemctl --user daemon-reload && systemctl --user enable --now agentlink-daemon
[Unit]
Description=AgentLink daemon (WS 收信 → spool → Stop hook 注入)

[Service]
Type=simple
ExecStart=/usr/bin/env node %h/.agentlink/client/daemon.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

`scripts/build-client-dist.sh`（核心逻辑全展开）：

```bash
#!/usr/bin/env bash
# 构建客户端分发产物到 web/download/（spec §2/§6）——tarball 自足、压缩前敏感扫描、多版本保留
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=web/download; STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
VER=$(git describe --tags 2>/dev/null || echo "0.0.0-$(date +%Y%m%d)-$(git rev-parse --short HEAD)")

# 1. 干净源：git archive HEAD 取 skills/agentlink（排除 test/），重定层为 agentlink/
mkdir -p "$STAGE/tree"
git archive HEAD skills/agentlink | tar -x -C "$STAGE"
mv "$STAGE/skills/agentlink" "$STAGE/tree/agentlink"
rm -rf "$STAGE/tree/agentlink/test"

# 2. VERSION + 分发版 SKILL.md（sed 改写，两版命令语义一一对应——spec §2）
echo "$VER" > "$STAGE/tree/agentlink/VERSION"
SK="$STAGE/tree/agentlink/SKILL.md"
sed -i -E \
  -e 's#`bin/im #`node ~/.agentlink/client/im.mjs #g' \
  -e 's#`im #`node ~/.agentlink/client/im.mjs #g' \
  -e 's#<abs>/skills/agentlink/hook-stop\.mjs#~/.agentlink/client/hook-stop.mjs#g' \
  -e 's#deploy/agentlink-daemon\.service#~/.agentlink/client/contrib/agentlink-daemon.service#g' \
  -e 's#（ExecStart 路径按实际 checkout 调整）##g' \
  "$SK"
# 注册码来源插到 frontmatter（1-4 行）之后、正文标题之前（spec §2：分发版开头写明来源）
sed -i '5i\
> 注册码向你的 AgentLink 服务器管理员（即你的所有者）索取；其余注册步骤见下文。\
' "$SK"

# 3. 敏感扫描门禁——tar 压缩之前（spec §6；tarball 树用全量清单，与 publish-public.sh 逐字同源）。
#    install 源文件用 INSTALL 清单：其默认域 im.example.com 是刻意公开信息（install 器就是从那下载），豁免
#    im.example.com 单项；token 与内网 IP 项保留。tarball 内不含 install 源文件，产物树始终全量扫描，豁免不漏水（r1 C4）。
PATTERNS='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117|im.example.com'
PATTERNS_INSTALL='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117'
if grep -rEn "$PATTERNS" "$STAGE/tree" -q; then
  echo 'ABORT: 敏感串命中（客户端包是最高敏面）:' >&2
  grep -rEn "$PATTERNS" "$STAGE/tree" | head >&2; exit 1
fi
if grep -rEn "$PATTERNS_INSTALL" scripts/install.sh scripts/install.ps1 -q 2>/dev/null; then
  echo 'ABORT: install 源文件敏感串命中:' >&2
  grep -rEn "$PATTERNS_INSTALL" scripts/install.sh scripts/install.ps1 | head >&2; exit 1
fi
```

```bash
# 4. 打包（同内容两份：版本化 + latest）+ 校验和；不清理旧版本（spec §2 版本保留 N≥3）
mkdir -p "$OUT"
tar -czf "$OUT/agentlink-$VER.tar.gz" -C "$STAGE/tree" agentlink
tar -czf "$OUT/agentlink.tar.gz" -C "$STAGE/tree" agentlink
cd "$OUT" && sha256sum "agentlink-$VER.tar.gz" agentlink.tar.gz > SHA256SUMS
cp scripts/install.sh scripts/install.ps1 "$OUT/" 2>/dev/null || true   # install 源文件随产物放同目录（T4/T5 落地后生效）
echo "built: agentlink-$VER.tar.gz (+latest 副本, SHA256SUMS)"
```

`.gitignore` 追加一行：`web/download/`

- [ ] **Step 4: 先提交 contrib（git archive 只取已提交内容——r1 M1），再验证**

```bash
git add skills/agentlink/contrib
git commit -m "feat(client): 分发版 systemd unit 入 contrib（tarball 内 daemon 常驻路径）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
bash scripts/test-client-dist.sh   # 输出 ALL OK（本任务阶段 install.sh/ps1 尚不存在——对它们的扫描段因文件缺失静默跳过，T4/T5 落地后自动覆盖）
npm test                            # 全量回归绿
```

- [ ] **Step 5: Commit 构建脚本与测试**

```bash
git add scripts/build-client-dist.sh scripts/test-client-dist.sh .gitignore
git commit -m "feat(dist): 客户端 tarball 构建脚本（压缩前敏感门禁+分发版 SKILL.md）与产物测试

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: install.sh（bash，macOS/Linux/Git Bash）

**Files:**
- Create: `scripts/install.sh`
- Test: `scripts/test-client-dist.sh` 追加 install.sh 实装测试段（第 6 节）

**Interfaces:**
- Consumes: T3 的 `web/download/` 产物（测试时 `AGENTLINK_DIST_BASE` 指向本地 `python3 -m http.server` 起的该目录）
- Produces: 安装布局 `~/.agentlink/client/`（默认）——tarball 顶层 `agentlink/` 原子改名落位。环境变量契约见 Global Constraints；幂等重跑 = 升级（覆盖前打印旧 VERSION，完成后打印新 VERSION + 下一步指引）

- [ ] **Step 1: 写失败测试**（test-client-dist.sh 第 5 节后追加；server 固定 18923/18924 端口（重复运行前由脚本尾部 kill 释放；若被占换端口需同步改 BADPORT），注意先跑 build 段产生产物）

```bash
# 6. install.sh 实装（spec §8）：本地 http.server 作 DIST_BASE，INSTALL_DIR 覆盖目标（r1 m2/m3 修法：
#    server 用 --bind + 可捕获 PID；坏 SUMS 场景起第二个 server 指向篡改副本，不向生产 install.sh 塞测试钩子）
cd web/download   # 测试进程工作目录切到产物目录；下文相对路径以此为基准
PORT=18923; python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 & SRV_PID=$!
BADPORT=18924; BADDIR_CONTENT=$TMP/badsums; cp -r . "$BADDIR_CONTENT"
(cd "$BADDIR_CONTENT" && sed -i 's/^[0-9a-f]/0/; s/^[0-9a-f]\{64\}/0000000000000000000000000000000000000000000000000000000000000000/' SHA256SUMS)
(cd "$BADDIR_CONTENT" && python3 -m http.server $BADPORT --bind 127.0.0.1 >/dev/null 2>&1 & echo $! > "$TMP/badpid")
sleep 0.7; cd ../..
INST=$TMP/inst
run_inst(){ bash scripts/install.sh; }   # 直接执行（脚本自身来源无关紧要）；变量经 env 传入——管道形态在下一断言单独验
if env AGENTLINK_DIST_BASE="http://127.0.0.1:$PORT" AGENTLINK_INSTALL_DIR="$INST" run_inst >/dev/null 2>&1 \
   && [ -f "$INST/VERSION" ] && [ -f "$INST/vendor/ws/wrapper.mjs" ] && [ -f "$INST/contrib/agentlink-daemon.service" ]; then
  ok install装毕结构
else bad install装毕结构失败; fi
# curl|bash 管道形态 + 变量经环境传入（Review Focus #2）
if curl -fsSL "file://$PWD/scripts/install.sh" | env AGENTLINK_DIST_BASE="http://127.0.0.1:$PORT" AGENTLINK_INSTALL_DIR="$INST" bash >/dev/null 2>&1; then
  ok install管道形态可用
else bad install管道形态失败; fi
# 重跑=升级：打印新旧版本（断言锚点与脚本输出逐字对齐——「已安装版本」行任何一次安装都打印，r1 C2）
OUT2=$(env AGENTLINK_DIST_BASE="http://127.0.0.1:$PORT" AGENTLINK_INSTALL_DIR="$INST" run_inst 2>&1 || true)
echo "$OUT2" | grep -q '已安装版本' && echo "$OUT2" | grep -q '旧版本' && ok install重跑打印新旧版本 || bad install重跑未打印新旧版本
# 兄弟目录不受影响（spool/config 在 ~/.agentlink 下但 client 之外，Review Focus #3）
mkdir -p "$(dirname "$INST")/state"; echo keep > "$(dirname "$INST")/state/keepme"
env AGENTLINK_DIST_BASE="http://127.0.0.1:$PORT" AGENTLINK_INSTALL_DIR="$INST" run_inst >/dev/null 2>&1
[ -f "$(dirname "$INST")/state/keepme" ] && ok install不动兄弟目录 || bad install动了兄弟目录
# 损坏 SHA256SUMS（篡改服务端副本）→ 失败退出无半成品（Review Focus #4）
BADINST=$TMP/badinst
if env AGENTLINK_DIST_BASE="http://127.0.0.1:$BADPORT" AGENTLINK_INSTALL_DIR="$BADINST" run_inst >/dev/null 2>&1; then
  bad 坏SUMS未失败
else ok 坏SUMS失败退出; fi
[ ! -e "$BADINST" ] && ok 坏SUMS无半成品 || bad 坏SUMS留半成品
kill $SRV_PID "$(cat "$TMP/badpid")" 2>/dev/null || true
```

- [ ] **Step 2: 跑测试确认失败** → FAIL（install.sh 不存在）

- [ ] **Step 3: 实现 install.sh**（<200 行，`set -euo pipefail`，头注释写边界承诺；骨架逐段）

```bash
#!/usr/bin/env bash
# AgentLink 客户端安装器（spec §4）——只装文件：下载 tarball → SHA256 校验 → 原子装到目标目录。
# 边界承诺：不提权(sudo)、不改 PATH、不写任何 Claude Code 配置；hooks/daemon 由 agent 按 SKILL.md 自助。
# 重跑 = 升级（幂等）。可先读再跑：全文 <200 行。
set -euo pipefail
DIST_BASE="${AGENTLINK_DIST_BASE:-https://im.example.com/download}"
VERSION="${AGENTLINK_VERSION:-latest}"
INSTALL_DIR="${AGENTLINK_INSTALL_DIR:-$HOME/.agentlink/client}"
TARBALL="$([ "$VERSION" = latest ] && echo agentlink.tar.gz || echo "agentlink-$VERSION.tar.gz")"

need(){ command -v "$1" >/dev/null || { echo "缺少 $1，请先安装" >&2; exit 1; }; }
need curl; need tar
sum(){ if command -v sha256sum >/dev/null; then sha256sum "$@"; else need shasum; shasum -a 256 "$@"; fi; }

# 已装版本提示（升级路径，spec §4 条 3）
OLD="(未安装)"
[ -f "$INSTALL_DIR/VERSION" ] && OLD=$(cat "$INSTALL_DIR/VERSION")
echo ">> 已安装版本: $OLD / 目标: $VERSION"

# 目标父目录先行创建（解包临时目录须与其同卷，r1 M3）；下载缓存在系统 tmp（中间文件，失败即弃）
PARENT=$(dirname "$INSTALL_DIR"); mkdir -p "$PARENT"
TMPD=$(mktemp -d); UNPACK=$(mktemp -d "$PARENT/.al-install-XXXX")
trap 'rm -rf "$TMPD" "$UNPACK"' EXIT
echo ">> 下载 $DIST_BASE/$TARBALL"
curl -fsSL -o "$TMPD/agentlink.tar.gz" "$DIST_BASE/$TARBALL"
curl -fsSL -o "$TMPD/SHA256SUMS" "$DIST_BASE/SHA256SUMS"
[ -s "$TMPD/agentlink.tar.gz" ] && [ -s "$TMPD/SHA256SUMS" ] || { echo '下载失败（空文件）' >&2; exit 1; }

# SHA256 校验：从 SUMS 中取本 tarball 行（latest 名或版本名），比对失败即退出
WANT=$( (grep -E "  $TARBALL\$" "$TMPD/SHA256SUMS" || grep -E '  agentlink\.tar\.gz$' "$TMPD/SHA256SUMS") | head -1 | cut -d' ' -f1)
[ -n "$WANT" ] || { echo "SHA256SUMS 中无 $TARBALL 条目" >&2; exit 1; }
GOT=$(sum "$TMPD/agentlink.tar.gz" | cut -d' ' -f1)
[ "$GOT" = "$WANT" ] || { echo "SHA256 校验失败: 期望 $WANT 实得 $GOT" >&2; exit 1; }

# 解包到临时目录 → 原子改名（不留半成品，spec §4 条 5；目标已存在且非目录 → 报错）
tar -xzf "$TMPD/agentlink.tar.gz" -C "$UNPACK"
[ -d "$UNPACK/agentlink" ] || { echo 'tarball 结构异常（缺 agentlink/ 顶层）' >&2; exit 1; }
[ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ] && { echo "$INSTALL_DIR 已存在且非目录" >&2; exit 1; }
if [ -d "$INSTALL_DIR" ]; then mv "$INSTALL_DIR" "$UNPACK/old"; fi   # 旧版先挪走（同卷原子），成功后才随 trap 弃
mv "$UNPACK/agentlink" "$INSTALL_DIR"
NEW=$(cat "$INSTALL_DIR/VERSION")
echo ">> 安装完成: $NEW（旧版本: $OLD）"
echo ">> 下一步: 阅读 $INSTALL_DIR/SKILL.md，然后注册："
echo "   node $INSTALL_DIR/im.mjs register <agent_id> --code <向服务器管理员索取的注册码> --dir <绑定目录>"
```

- [ ] **Step 4: 跑测试确认通过** → `bash scripts/test-client-dist.sh` ALL OK（含第 6 节）

- [ ] **Step 5: Commit**

```bash
git add scripts/install.sh scripts/test-client-dist.sh
git commit -m "feat(dist): install.sh——只装文件、SHA256 门禁、原子升级、零交互

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: install.ps1（PowerShell 5.1+，对称版）

**Files:**
- Create: `scripts/install.ps1`
- Test: `scripts/test-client-dist.sh` 追加第 7 节（结构断言；有 pwsh 时加语法检查）

**Interfaces:**
- Consumes: 同 T4 的产物与三变量契约（`$env:AGENTLINK_DIST_BASE/_VERSION/_INSTALL_DIR`）
- Produces: `%USERPROFILE%\.agentlink\client\` 默认安装布局；行为与 install.sh 逐条对称（spec §4 表）

- [ ] **Step 1: 写失败测试**（test-client-dist.sh 追加）

```bash
# 7. install.ps1 结构断言（spec §8：无 Windows CI 时静态核对；有 pwsh 加语法检查）
PS=scripts/install.ps1
# 首个可执行语句 = TLS1.2（Review Focus #5）
FIRST=$(grep -vE '^\s*(#|$)' "$PS" | head -1)
echo "$FIRST" | grep -q 'SecurityProtocol.*Tls12' && ok ps1首语句TLS12 || bad "ps1首语句非TLS12: $FIRST"
grep -q 'AGENTLINK_DIST_BASE' "$PS" && grep -q 'AGENTLINK_VERSION' "$PS" && grep -q 'AGENTLINK_INSTALL_DIR' "$PS" && ok ps1三变量契约 || bad ps1缺变量契约
grep -q 'Get-FileHash' "$PS" && ok ps1-GetFileHash || bad ps1缺Get-FileHash
grep -qE 'tar -xzf|tar.*xzf' "$PS" && ok ps1-tar || bad ps1缺tar解压
grep -q 'ErrorActionPreference' "$PS" && grep -qq 'Stop' <(grep ErrorActionPreference "$PS") && ok ps1-Stop偏好 || bad ps1缺Stop偏好
if command -v pwsh >/dev/null; then
  pwsh -NoProfile -Command "[scriptblock]::Create((Get-Content -Raw '$PS'))" >/dev/null 2>&1 && ok ps1语法检查 || bad ps1语法错误
else echo 'ok  - pwsh 不存在，跳过语法检查（人工核对清单见 spec §8）'; fi
```

（第 5 行 `grep -q 'Stop'` 写法以实现可读为准，可简化为 `grep -q "ErrorActionPreference = 'Stop'" "$PS"`。）

- [ ] **Step 2: 跑测试确认失败** → FAIL（install.ps1 不存在）

- [ ] **Step 3: 实现 install.ps1**（与 install.sh 逐条对称；`$ErrorActionPreference = 'Stop'` 前面**只允许注释与空行**）

```powershell
# AgentLink 客户端安装器，PowerShell 版（spec §4，与 install.sh 逐条对称）
# 边界承诺：不提权、不改 PATH、不写任何配置；重跑=升级。先读再跑：全文 <200 行。
# Win10 1803+ 自带 tar；缺失时报错并给指引。
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = 'Stop'
$DistBase   = if ($env:AGENTLINK_DIST_BASE)   { $env:AGENTLINK_DIST_BASE }   else { 'https://im.example.com/download' }
$Version    = if ($env:AGENTLINK_VERSION)     { $env:AGENTLINK_VERSION }     else { 'latest' }
$InstallDir = if ($env:AGENTLINK_INSTALL_DIR) { $env:AGENTLINK_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.agentlink\client' }
$Tarball = if ($Version -eq 'latest') { 'agentlink.tar.gz' } else { "agentlink-$Version.tar.gz" }

$Old = if (Test-Path (Join-Path $InstallDir 'VERSION')) { Get-Content (Join-Path $InstallDir 'VERSION') -Raw } else { '(未安装)' }
Write-Host ">> 已安装版本: $($Old.Trim()) / 目标: $Version"

# 解包临时目录必须在 $InstallDir 父目录同卷（r1 M3：跨卷 Move-Item 退化为 copy+rm，会留半成品）
# 下载缓存可留系统 temp（中间文件，失败即弃，不在产物面）
$Parent = Split-Path $InstallDir -Parent
New-Item -ItemType Directory -Path $Parent -Force | Out-Null
$Tmp = New-Item -ItemType Directory -Path ([IO.Path]::Combine([IO.Path]::GetTempPath(), [IO.Path]::GetRandomFileName()))
$Unpack = New-Item -ItemType Directory -Path ([IO.Path]::Combine($Parent, '.al-install-' + [IO.Path]::GetRandomFileName()))
try {
  Invoke-WebRequest -Uri "$DistBase/$Tarball"    -OutFile "$Tmp\agentlink.tar.gz" -UseBasicParsing
  Invoke-WebRequest -Uri "$DistBase/SHA256SUMS"  -OutFile "$Tmp\SHA256SUMS"       -UseBasicParsing
  $Wants = (Get-Content "$Tmp\SHA256SUMS") | Where-Object { $_ -match "  $Tarball`$" -or $_ -match '  agentlink\.tar\.gz$' }
  if (-not $Wants) { throw "SHA256SUMS 中无 $Tarball 条目" }
  $Want = ($Wants | Select-Object -First 1) -split ' ' | Select-Object -First 1
  $Got = (Get-FileHash "$Tmp\agentlink.tar.gz" -Algorithm SHA256).Hash.ToLower()
  if ($Got -ne $Want.ToLower()) { throw "SHA256 校验失败: 期望 $Want 实得 $Got" }

  if (-not (Get-Command tar -ErrorAction SilentlyContinue)) { throw '缺少 tar（Win10 1803+ 自带；旧系统请先安装 bsdtar）' }
  tar -xzf "$Tmp\agentlink.tar.gz" -C "$Unpack"
  if (-not (Test-Path "$Unpack\agentlink")) { throw 'tarball 结构异常（缺 agentlink/ 顶层）' }
  if (Test-Path $InstallDir) { Move-Item $InstallDir "$Unpack\old" }   # 旧版先挪走（同卷原子）
  Move-Item "$Unpack\agentlink" $InstallDir
} finally { Remove-Item $Tmp, $Unpack -Recurse -Force -ErrorAction SilentlyContinue }
$New = (Get-Content (Join-Path $InstallDir 'VERSION') -Raw).Trim()
Write-Host ">> 安装完成: $New（旧版本: $($Old.Trim())）"
Write-Host ">> 下一步: 阅读 $InstallDir\SKILL.md，然后注册："
Write-Host "   node $InstallDir\im.mjs register <agent_id> --code <向服务器管理员索取的注册码> --dir <绑定目录>"
```

- [ ] **Step 4: 跑测试确认通过** → `bash scripts/test-client-dist.sh` ALL OK（第 7 节全绿；TLS12 首语句断言过）

- [ ] **Step 5: Commit**

```bash
git add scripts/install.ps1 scripts/test-client-dist.sh
git commit -m "feat(dist): install.ps1 对称版（PS5.1 TLS1.2 首语句、Get-FileHash、原子升级）

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: 落地页安装区块 + check.mjs 断言 + 部署文档

**Files:**
- Modify: `web/landing/index.html`（onboard 区 `<section id="onboard">` 内、现有 `.term` 块之后追加安装区块）
- Modify: `web/landing/check.mjs`（追加安装区块断言）
- Modify: `docs/deploy.md`（追加 §download 分发一节：nginx 前缀匹配 + alias + rsync）

**Interfaces:**
- Consumes: 现有 host-swap 机制（`<span class="host-swap">agentlink</span>` span + `hostSwap()` 函数，index.html:204-205/219-221）、`copyText()` 帮手（index.html:234）、`.term` 终端样式容器、双语 `data-zh/data-en` 机制
- Produces: 公开可见的安装命令区块（不产代码接口）；nginx 配置段（部署侧）：

```nginx
location /download/ {
    alias /var/www/agentlink/download/;
    autoindex off;
}
```

**注意**：安装命令的 host 部分用 `<span class="host-swap">agentlink</span>` span——文字节点会被 `apply()` 统一切换；复制按钮**不能**复用 `onboardUrl()`（那返回 onboarding 路径），新加 `installCmd(platform)` 帮手按当前 hostSwap 拼 `/download/install.sh`/`install.ps1` 全命令后走 `copyText`。命令 URL 是 `im.example.com` 自家域，check.mjs external-ref 白名单天然覆盖。

- [ ] **Step 1: 写失败断言**（check.mjs 文案抽检段后追加；正则与 Step 3 的 HTML 逐字对账——`</span>` 后是 `.im.example.com/download/`，r1 C3）

```js
// 安装区块（dist spec §5）：双平台命令各一、host-swap 复用、双复制按钮、保守两步折叠、自托管与注册码文案
for (const s of ['/download/install.sh', '/download/install.ps1', 'AGENTLINK_DIST_BASE', '管理员索取', 'irm', '<details>']) {
  if (!html.includes(s)) fail('missing install block: ' + s)
}
if (!/class="host-swap">[^<]*<\/span>\.im.example.com\/download\/install\.(sh|ps1)/.test(html)) fail('install cmd host-swap missing')
if (!/id="copy-install-sh"/.test(html) || !/id="copy-install-ps1"/.test(html)) fail('install copy buttons missing')
```

- [ ] **Step 2: 跑断言确认失败** → `node web/landing/check.mjs` FAIL（missing install block: /download/install.sh）

- [ ] **Step 3: 实现落地页区块**

index.html `#onboard` 区现有 `.term` 块后追加（双语对全部配 data-zh/data-en；视觉复用 `.term`/`.copy-url` 既有样式；spec §5 r1 M4 修正：**两行命令各配独立复制按钮**——单按钮按语言选平台会让中文 Windows 用户复制到 macOS 命令；**保守两步用 `<details>` 折叠**，非仅注释）：

```html
<h3 data-zh="agent 直接装（agent 在自己机器上执行）" data-en="Install on the agent's machine">agent 直接装（agent 在自己机器上执行）</h3>
<p data-zh="把命令发给你的 agent，它执行后获得完整客户端（含 daemon 与 Stop hook），注册码向你的 AgentLink 服务器管理员索取。"
   data-en="Send the command to your agent; it gets the full client (daemon + Stop hook). Ask your AgentLink server admin for a registration code.">把命令发给你的 agent，它执行后获得完整客户端（含 daemon 与 Stop hook），注册码向你的 AgentLink 服务器管理员索取。</p>
<div class="term">
  <div class="term-bar"><i></i><i></i><i></i></div>
  <pre><span class="c"># macOS / Linux</span>
<span class="p">$</span> curl -fsSL https://<span class="host-swap">agentlink</span>.im.example.com/download/install.sh | bash</pre>
</div>
<button id="copy-install-sh" data-zh="复制 macOS/Linux 命令" data-en="Copy macOS/Linux command">复制 macOS/Linux 命令</button>
<div class="term">
  <div class="term-bar"><i></i><i></i><i></i></div>
  <pre><span class="c"># Windows（PowerShell）</span>
<span class="p">$</span> irm https://<span class="host-swap">agentlink</span>.im.example.com/download/install.ps1 | iex</pre>
</div>
<button id="copy-install-ps1" data-zh="复制 Windows 命令" data-en="Copy Windows command">复制 Windows 命令</button>
<details>
  <summary data-zh="保守两步：先读再跑" data-en="Cautious two-step: read before running">保守两步：先读再跑</summary>
  <p data-zh="先下载脚本阅读，确认无异议再执行：curl -fsSL -O https://…/download/install.sh 后用编辑器打开，再 bash install.sh。"
     data-en="Download and read the script first: curl -fsSL -O https://…/download/install.sh, open it in an editor, then bash install.sh.">先下载脚本阅读，确认无异议再执行：curl -fsSL -O https://…/download/install.sh 后用编辑器打开，再 bash install.sh。</p>
</details>
<p data-zh="自托管镜像源：curl -fsSL https://…/install.sh | AGENTLINK_DIST_BASE=<你的镜像> bash（Windows 同理设 $env:AGENTLINK_DIST_BASE 后 irm … | iex）"
   data-en="Self-hosted mirror: curl -fsSL https://…/install.sh | AGENTLINK_DIST_BASE=<your-mirror> bash (Windows: set $env:AGENTLINK_DIST_BASE, then irm … | iex)">自托管镜像源：curl -fsSL https://…/install.sh | AGENTLINK_DIST_BASE=<你的镜像> bash（Windows 同理设 $env:AGENTLINK_DIST_BASE 后 irm … | iex）</p>
```

脚本段（IIFE 内、`copyBtn` 注册之后追加）：

```js
  // 安装命令复制（dist spec §5）：每平台一个按钮，按当前 hostSwap 拼全命令，中文态 agentlink.、英文态 im.
  function installCmd(platform) {
    return platform === 'sh'
      ? 'curl -fsSL https://' + hostSwap() + '.im.example.com/download/install.sh | bash'
      : 'irm https://' + hostSwap() + '.im.example.com/download/install.ps1 | iex'
  }
  function bindInstallBtn(id, platform) {
    var btn = document.getElementById(id)
    if (!btn) return
    btn.addEventListener('click', function () {
      copyText(installCmd(platform), function () {
        btn.textContent = cur === ZH ? '已复制 ✓ 粘贴给 agent 即可' : 'Copied ✓ — paste it to your agent'
        setTimeout(function () { btn.textContent = btn.getAttribute(cur === ZH ? 'data-zh' : 'data-en') }, 2200)
      })
    })
  }
  bindInstallBtn('copy-install-sh', 'sh')
  bindInstallBtn('copy-install-ps1', 'ps1')
```

`docs/deploy.md` 追加（服务器部署一节之后）：

````markdown
## 客户端分发（/download/）

`bash scripts/build-client-dist.sh` 产出 `web/download/`（tarball×2 + SHA256SUMS + install 脚本），随服务器部署同步：

```bash
rsync -av web/download/ root@165:/var/www/agentlink/download/   # 不带 --delete：保留历史版本（客户端可 AGENTLINK_VERSION 回退，N≥3）
```

165 nginx `agentlink.conf`（既有 `location =` + alias 有 500 坑，必须前缀匹配 + 绝对路径 alias）：

```nginx
location /download/ {
    alias /var/www/agentlink/download/;
    autoindex off;
}
```

部署后回归：`/download/install.sh`、`/download/agentlink.tar.gz` 200；`/`、`/v1/*`、`/onboarding` 行为不变。
````

- [ ] **Step 4: 跑断言 + 尺寸确认** → `node web/landing/check.mjs` OK（双语对数增加、文件仍 <60KB——预留约 39KB，本区块约 2.5KB）+ `bash scripts/test-client-dist.sh` ALL OK（整体不回归）

- [ ] **Step 5: Commit**

```bash
git add web/landing/index.html web/landing/check.mjs docs/deploy.md
git commit -m "feat(landing): agent 直接装区块（双平台一行命令+自托管镜像说明）与分发部署文档

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## 部署后验证（非本计划任务——165 侧人工/后续）

`bash scripts/test-client-dist.sh` 全绿后：rsync 上 165 → curl 矩阵回归（`/download/*` 200、既有路径不变）→ 落地页真机抽查（中文态复制 `agentlink.`、英文态复制 `im.`）→ 通过后才可考虑 `publish-public.sh --push`（新文件自动纳入导出与扫描，脚本本身不改）。
