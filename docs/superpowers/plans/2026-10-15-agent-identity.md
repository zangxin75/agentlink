# Agent 身份持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重装/重注册不再换身份——identity key 自动找回 + 一次性恢复码兜底 + rotate 自愈。

**Architecture:** server 加 `agents.identity_key_hash/recovery_hash`（user_version=6）+ 三个 identity 端点（claim 免注册码、bind 补绑、rotate 轮换），claim/rotate 撤全部旧 token 并逐个 onTokenRevoke 踢 WS。client 加 key 文件与显式 `AGENTLINK_ID`，五处 agentIdFor 调用点收敛到 `agentIdFromEnv`。

**Tech Stack:** Fastify + better-sqlite3（server，vitest）；零依赖 ESM（client，node:test）。

**Spec:** docs/superpowers/specs/2026-10-15-agent-identity-design.md（r2，已过审计）——冲突一律以 spec 为准。

## Global Constraints

- ESM + NodeNext：server 相对导入 `.js` 后缀；中文注释；conventional commits + `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- 凭据无效统一 401（unauthorized 口径），无 410/RECOVERY_USED；新码仅 IDENTITY_MULTI/IDENTITY_EXISTS/IDENTITY_TAKEN（均 409 INVALID_REQUEST 变体，detail 说明）
- 两码只存 sha256；recovery 消费必须 `UPDATE … WHERE recovery_hash=?` 判 changes（原子防双花）
- claim/rotate 免注册码；register（新身份）仍要码；identity 端点独立限流 `claim:${ip}` 10/h
- 服务器运行时依赖不加新包；im.mjs 保持零依赖
- 测试命令：server `cd server && npx vitest run <file>`；client `node --test skills/agentlink/test/<file>`

## Review Focus（spec 未尽、最可能咬人的五类输入）

1. **recovery 并发双花**：两请求同码同时 claim → 只有一方成功（SQL changes 判定），另一方 401。→ Task 1 测试
2. **AGENTLINK_ID 与公式分歧的老 daemon 兼容**：claim 后 env 必须保留原始 NAME/DIR，未升级组件按公式仍得原 id。→ Task 3 测试（agentIdFromEnv 优先 e.id；env 写入器保留原 name/dir）
3. **register 带 key 走注册码限流、claim 免码走 claim 桶**——两桶不可互串（防 claim 端点被拿来免费注册探测）。→ Task 2 测试（claim 不消耗 reg 桶）
4. **claim 后 WS 立即断**：旧连接不能在响应后还发一条消息。→ Task 2 测试（onTokenRevoke 逐 token 被调）
5. **bind 用了别人 key / key 已绑多 agent 的 claim 不带 agent_id**——三种 409 各归各位，客户端文案可分诊。→ Task 1/2 测试

---

### Task 1: server core——迁移 + 身份域函数

**Files:**
- Modify: `server/src/db/schema.ts`（v<6 分支，仿 v<2 形态）
- Create: `server/src/core/identity.ts`
- Modify: `server/src/core/agents.ts`（registerAgent 加 identity_key 参数）
- Test: `server/test/identity-core.test.ts`

**Interfaces:**
- Produces: `bindIdentityKey(db, agentId, identityKey)`（抛 AppError）；`claimAgent(db, { identityKey?, recoveryCode?, agentId? })` → `{ agent, token, recoveryCode, revokedTokenIds }`；`rotateIdentity(db, { identityKey?, recoveryCode?, agentId?, newIdentityKey })` → 同 claim 形状；`newRecoveryCode()`；registerAgent input 增加 `identity_key?`，返回增加 `recovery_code?`，key 冲突抛 `Errors.invalidRequest('IDENTITY_MULTI …')`
- Consumes: `agents.ts` 的 `newToken/sha256Hex/audit/Errors`；token 撤销用 `UPDATE tokens SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL RETURNING id`（better-sqlite3 支持 RETURNING）

- [ ] **Step 1: RED 测试**——canonical 脚手架（仿 messages-search.test.ts：loadConfig/openDb+migrate/Bus/RateLimiter/registerAgent）：
  1. register 带 identity_key → 落 hash + 返回 recovery_code；再次同 key register → AppError INVALID_REQUEST 含 IDENTITY_MULTI 与 agents 列表
  2. claimAgent by key → 原 agent_id 不变、新 token、旧 default token 进 revokedTokenIds；recovery 滚动（旧码再用 → 抛 unauthorized）
  3. recovery 原子消费：直接调 claimAgent 两次同码（第二次 401）；并发用 Promise.all 两线程（better-sqlite3 同步，串行化即验证 changes 判定）
  4. bind：新 key 成功返 recovery；同 agent 换 key → IDENTITY_EXISTS；key 属他人 → IDENTITY_TAKEN
  5. rotate：旧 key 作废（再 claim 401）、新 key 可 claim
  6. multi：两 agent 同 key（手工 UPDATE 落两行模拟历史）→ claim 不带 agentId 抛 IDENTITY_MULTI 列表；带 agentId 成功
  7. 迁移幂等：migrate(db) 跑两遍不炸，user_version=6
- [ ] **Step 2: 跑测确认按预期失败**（identity.ts 不存在）
- [ ] **Step 3: GREEN**——schema v6 分支 + identity.ts（sha256 落库、`UPDATE agents SET recovery_hash=? WHERE id=? AND recovery_hash=?` 判 changes、audit 事件 identity.claimed/bound/rotated + identity.claim_failed 由路由层记）+ registerAgent 扩展
- [ ] **Step 4: 全绿 + `cd server && npx vitest run` 全量**
- [ ] **Step 5: commit** `feat(server): 身份域核心——identity key/recovery 落库、claim/bind/rotate 原子语义`

### Task 2: server 路由——identity 端点 + 限流 + WS 踢线

**Files:**
- Create: `server/src/http/routes/identity.ts`
- Modify: `server/src/http/app.ts`（db 层挂 identity 路由，注入 limiter + onTokenRevoke）、`server/src/http/routes/agents.ts`（register body 加 identity_key 透传）、`server/src/core/ratelimit.ts`（checkClaim(ip)）
- Test: `server/test/identity-routes.test.ts`（`app.inject` + ws-server.ts 真 hub）

**Interfaces:**
- Produces: `registerIdentityRoutes(app, { db, cfg, limiter?, onRevoke? })`；端点契约见 spec §4 表
- Consumes: Task 1 的三个函数；`authenticate`；hub 踢线 = 对 revokedTokenIds 逐个 `onRevoke(tokenId)`

- [ ] **Step 1: RED**——inject 测试：
  1. claim by key 200 形状（agent/token/recovery_code）且**免注册码**（不带 code 成功）；坏码 401；同 IP 第 11 次 429
  2. WS：startWsServer 起真栈，agent A 持 token 连 WS → 用 key claim → 旧连接被 close（4003），新 token 可重连
  3. register 带 key 冲突 → 409 body 含 agents 数组与 hint
  4. bind：bearer + 新 key 201；IDENTITY_TAKEN 409；bind 后 claim by key 成功
  5. claim 不消耗 reg 桶：先打满 reg:${ip}（11 次注册），claim 仍 200
- [ ] **Step 2: 确认 RED**
- [ ] **Step 3: GREEN**——路由 + app.ts 挂载 + ratelimit checkClaim + register 透传；audit identity.claim_failed（含 IP）在凭据失败分支
- [ ] **Step 4: server 全量 vitest 绿；typecheck `npx tsc --noEmit`**
- [ ] **Step 5: commit** `feat(server): /v1/identity claim|bind|rotate——免码找回、逐 token 踢 WS、独立限流`

### Task 3: client 库层——key 文件 + AGENTLINK_ID 收敛

**Files:**
- Modify: `skills/agentlink/lib/identity.mjs`
- Modify: `skills/agentlink/daemon.mjs`、`hook-inject.mjs`、`hook-stop.mjs`、`lib/inbox-local.mjs`、`im.mjs`（五处调用点）
- Test: `skills/agentlink/test/identity-key.test.mjs`

**Interfaces:**
- Produces: `loadOrCreateIdentityKey(file?)`（0600，AGENTLINK_IDENTITY_FILE 重定位）；`agentIdFromEnv(e, hostname)` = `e.id ?? agentIdFor(...)`；parseEnvFile 认 AGENTLINK_ID/AGENTLINK_RECOVERY/AGENTLINK_IDENTITY_FILE；`buildAgentEnv` 增加 id/recovery 参数（保留原 name/dir 原样写入——兼容窗口）
- Consumes: 现有 KEYS/REQUIRED 机制（REQUIRED 不加新键）

- [ ] **Step 1: RED**——1) loadOrCreate 幂等同值、文件 0600；2) agentIdFromEnv：e.id 优先、无 id 回退公式；3) parse env 含三新键不炸且 REQUIRED 语义不变（缺新键不报错）；4) 五处调用点换 agentIdFromEnv（以 daemon/hook 为例的行为级断言：env 带 AGENTLINK_ID 时 spool 目录用显式 id）
- [ ] **Step 2: 确认 RED**
- [ ] **Step 3: GREEN** 实现
- [ ] **Step 4: `node --test skills/agentlink/test/`（全量 client）**
- [ ] **Step 5: commit** `feat(client): identity key 落盘 + AGENTLINK_ID 优先收敛五处调用点`

### Task 4: client CLI——register --claim/--new-identity、identity bind/rotate

**Files:**
- Modify: `skills/agentlink/im.mjs`
- Test: `skills/agentlink/test/identity-cli.test.mjs`（注入 fetch，不起真服）

**Interfaces:**
- Consumes: Task 3 库层 + REST 端点契约
- Produces: USAGE 增补；`im register --claim [agent_id]`、`--new-identity`、`im identity bind|rotate`

- [ ] **Step 1: RED**——1) register 默认带 key；409 MULTI → stderr 列身份 + 两分支指引；2) --claim → POST /v1/identity/claim → env 写 AGENTLINK_ID 原值 + 新 token + AGENTLINK_RECOVERY，stdout 提示「身份已找回，旧设备已下线」；3) --new-identity 用独立 key 文件；4) identity bind/rotate 走对应端点并写回 env；5) recovery 明文只 stderr 提示一次
- [ ] **Step 2: 确认 RED → Step 3: GREEN → Step 4: 全量 client 测试绿**
- [ ] **Step 5: commit** `feat(client): im register --claim/--new-identity 与 im identity bind/rotate`

### Task 5: 文档 + dist + 部署 + dogfood

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-agentlink-v1.1-design.md`（§7 表加 3 端点 + register 扩展）、`docs/superpowers/specs/2026-09-29-agentlink-design.md`（错误码表登记三码）、`skills/agentlink/SKILL.md`（注册节）、`web/onboarding.md`/`web/onboarding.en.md`（恢复说明）、`scripts/test-client-dist.sh`（断言 im.mjs 含 --claim/identity bind）
- Test: 既有 dist 回归 + 全仓 `npm test`

- [ ] **Step 1: 文档更新（对照 spec r2 逐条）**
- [ ] **Step 2: `npm test` 全绿 + `bash scripts/test-client-dist.sh` ALL OK**
- [ ] **Step 3: commit + push + build dist + 部署 165（含 latest-version！）+ 线上验证（claim 端点 401 存在性）**
- [ ] **Step 4: dogfood：本机 `im identity bind`（kt.dev 纳入保护、恢复码入 env）；给 zhy.win11 发信引导其执行 bind**
- [ ] **Step 5: commit 收尾** `docs+chore: 身份持久化上线——文档、dist 断言、dogfood 记录`
