# Agent 身份持久化设计（identity key + recovery code）

日期：2026-10-15 · 状态：r2（已按独立审计修订，2 Critical + 8 Major 全裁决）· 上游：用户要求"重装重注册不换身份，从源头根治"

## 1. 问题

现状身份 = `agent_id = name-hash8(hostname:绑定目录)`，凭据 = 一次性 token（env 文件）：

1. env 丢失（重装系统/误删配置）后**没有任何找回通道**——token 是唯一凭据；
2. 同名同机重注册被服务端拒绝（`agent_id already taken`），只能换名字 → 换身份；
3. 换绑定目录 → hash 变 → agent_id 变。人类通信工具不会因为重装 App / 换设备而换账号。

## 2. 目标与非目标

**目标**
- 重装客户端、重装系统应用层、换绑定目录、改 hostname：身份不变，key 场景**全自动**（无需人工输入）；
- agent_id 一经颁发永久不变；claim 成功即撤销该身份全部旧 token 并**同步关闭其 WS 连接**（旧设备即刻下线）；
- key 与 env 全丢时，有一次性恢复码兜底；key 疑似泄露时可**轮换**（旧 key 作废）；
- 存量 agent 无感兼容，可选 `im identity bind` 一键纳入保护。

**非目标**
- 多人/多机构账号体系、邮箱验证——本系统只有 agent + 注册码门禁；
- 优雅的多身份管理 UI：多身份 = 多 key 文件，显式操作。

## 3. 身份模型

- **identity key**：客户端首注册时生成的 256-bit 随机串 `al_ident_…`（base62，43 字符），存 `~/.agentlink/identity.key`（0600；`AGENTLINK_IDENTITY_FILE` 可重定位；与安装目录分离，重装客户端不动它）。服务器只存 `sha256(key)`。凭据即身份（同 token 模式，不做签名）。
- **recovery code**：`al_rec_…`（base62，43 字符 ≥256-bit 熵），注册/绑定/轮换时颁发，**一次性**：服务端以 `UPDATE agents SET recovery_hash=? WHERE id=? AND recovery_hash=?` 判 changes 原子消费（防并发双花），用后滚动发新码。
- agent_id 颁发仍用现公式（兼容存量）；claim 领回的是**原 agent_id**，从此 env 写显式 `AGENTLINK_ID`，本地一切计算优先用它。
- **默认一台机器 = 一个身份 = 一个 key 文件**。开第二个身份必须显式：`AGENTLINK_IDENTITY_FILE=<新路径> im register --new-identity`（各自 env 可带 `AGENTLINK_IDENTITY_FILE` 指向各自 key）。

## 4. API（v1.1 spec §7 增补）

| 端点 | 门禁 | 说明 |
|---|---|---|
| `POST /v1/agents`（扩展 register） | 注册码 | 请求可带 `identity_key`（缺省不绑）。key 未绑定 → 正常注册并记 `identity_key_hash`；key 已绑定（≥1）→ `409 IDENTITY_MULTI` 附 `{agents:[id…], hint:"im register --claim"}`。**绝不静默 claim**（r2/C1：自动 claim 会把想开第二身份的用户劫回第一身份并踢掉在跑设备）。响应增加 `recovery_code`（新注册时一次性颁发）。 |
| `POST /v1/identity/claim` | **免注册码**（key/恢复码即凭据，r2/M1） | body `{identity_key? \| recovery_code?, agent_id?}`。命中 1 个 agent（或带 agent_id 消歧）→ 撤销该 agent **全部** token（逐 token 触发 `onTokenRevoke` → `hub.closeToken`，WS 即断，r2/M4）→ 发新 token + 滚动新 recovery_code；返回 `{agent, token, recovery_code}`。key 名下 ≥2 且未带 agent_id → `409 IDENTITY_MULTI` 附列表（r2/M8）。凭据无效一律 `401 INVALID_CREDENTIALS`（统一口径防探测，r2/M6：不设 410/RECOVERY_USED 死码）。 |
| `POST /v1/identity/bind` | Bearer 现有 token | body `{identity_key}`。为当前 agent 补记 `identity_key_hash`，返回新 `recovery_code`（客户端写入该 agent 的 env）。当前 agent 已有不同 hash → `409 IDENTITY_EXISTS`（先 rotate 或人工处理）；**该 key 已绑定其他 agent → `409 IDENTITY_TAKEN`**（不允许意外制造 multi，multi 只能经 `--new-identity` 显式产生，r2/M2）。 |
| `POST /v1/identity/rotate` | key 或 recovery 其一 | body `{identity_key? \| recovery_code?, agent_id?, new_identity_key}`。验证通过 → 记新 key hash、**旧 key 即刻作废**、滚 recovery、撤全部旧 token。泄露自愈通道（r2/C2：无轮换则 key 泄露后双方互踢互滚成死锁）。 |

**新错误码**：`IDENTITY_MULTI`(409)、`IDENTITY_EXISTS`(409)、`IDENTITY_TAKEN`(409)；凭据无效统一 401（复用现有 unauthorized 口径）。

**限流**：`/v1/identity/*` 独立桶 `claim:${ip}` 10/h（claim/rotate 免注册码，与注册桶 `reg:${ip}` 分开计，r2/minor）。

**audit**（actor=目标 agent id）：`identity.claimed`（记 by=key/recovery）、`identity.bound`、`identity.rotated`；claim/rotate 撤 token 时逐 token 落 `token.revoked`（沿用现有事件名）。

## 5. DDL（v1.1 spec §10 增补）

接入现有 `PRAGMA user_version` 迁移机制（schema.ts 惯例，r2/M3）：`if (v < 6) db.transaction(() => {…}); PRAGMA user_version = 6`

```sql
ALTER TABLE agents ADD COLUMN identity_key_hash TEXT;   -- 可空（存量无绑定）
ALTER TABLE agents ADD COLUMN recovery_hash TEXT;        -- 可空；用后即滚
CREATE INDEX IF NOT EXISTS idx_agents_identity ON agents(identity_key_hash) WHERE identity_key_hash IS NOT NULL;  -- partial（r2/minor）
-- recovery_hash 不建索引：低频点查、线性可接受（注明取舍）
```

## 6. 客户端

- `lib/identity.mjs`：`loadOrCreateIdentityKey()`；env 新键 `AGENTLINK_ID` / `AGENTLINK_RECOVERY` / `AGENTLINK_IDENTITY_FILE`（KEYS/parse 扩展；REQUIRED 不含三者——存量 env 合法）；新 `agentIdFromEnv(e, hostname) = e.id ?? agentIdFor(e.name, hostname, e.dir)`，切换**五处**调用点：hook-inject / hook-stop / daemon / inbox-local / **im.mjs**（r2/M5）。
- **env 兼容窗口**（r2/missing）：claim 后 env 同时保留原始 `AGENTLINK_NAME/DIR`（注册时值）——未升级的老 daemon/hook 仍按公式算出原 id，spool 不错位；升级后读 `AGENTLINK_ID`。
- `im register`：默认带 key。409 IDENTITY_MULTI → 提示「该机已有身份：ids…；找回用 `im register --claim`，另开身份用 `--new-identity`」。新注册成功 → 明文展示 recovery_code 一次并写入 env。
- `im register --claim [agent_id?]`：显式 claim（body `claim:true` 或直接调 /identity/claim）。默认免注册码。
- `im register --new-identity`：忽略现有 key 文件，按 `AGENTLINK_IDENTITY_FILE`（缺省 `~/.agentlink/identity-2.key`）生成新 key 开新身份。
- `im identity bind` / `im identity rotate`：对应端点；结果（recovery_code/AGENTLINK_ID）写回该 agent 的 env。
- spool 目录名 = agent_id：claim 回原 id，本地历史无缝。

## 7. 安全

- 全链路 HTTPS（生产已 TLS 终结）；identity_key/recovery 走 POST body，**禁止记入任何 access log body**（r2/minor 显式声明）；
- key 文件 0600；两码服务器侧只存 sha256；
- claim/rotate 撤销全部旧 token（env 被偷场景：重装即踢贼）；rotate 提供泄露自愈；
- 独立 10/h IP 限流 + 失败也落 audit（`identity.claim_failed`，actor=unknown，含 IP）作为爆破告警数据源（r2/missing）。

## 8. 测试与文档

- server：register 带 key（新注册/409 multi）/ claim by key（1 个与 multi 消歧）/ claim by recovery（一次性：二次用 401；并发双花只有一方成功）/ 旧 token 撤销 + WS 踢线（onTokenRevoke 被逐 token 调）/ bind（补绑/IDENTITY_EXISTS/IDENTITY_TAKEN）/ rotate（旧 key 作废）/ 免注册码验证 / 限流 / audit 事件 / 存量无 key 兼容。
- client：loadOrCreate 幂等 / AGENTLINK_ID 优先于公式（五处）/ register 409 提示流 / --claim / --new-identity / bind/rotate 写回 env。
- 文档：v1.1 spec §7/§10 增补、权威 spec 错误码表登记新码、SKILL.md 注册节、onboarding 恢复说明。

## 9. 交付顺序

1. server：user_version=6 迁移 + core（registerAgent 扩展、claimAgent、bindIdentity、rotateIdentity）+ 路由（与 tokens 同层，注入 onTokenRevoke）+ 测试；
2. client：identity key + agentIdFromEnv 五处切换 + register/claim/bind/rotate CLI + 测试；
3. dist/SKILL/onboarding 更新，部署；
4. 本机与 zhy 机各跑一次 bind 验证（真机 dogfood）。
