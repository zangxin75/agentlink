# Critic 审计报告 — AgentLink v1.1 设计（第一轮）

日期：2026-09-30 ｜ 审计人：critic（重派）｜ 对象：`2026-09-30-agentlink-v1.1-design.md`
核对面：v1 spec（`2026-09-29-agentlink-design.md`）+ v1 实现代码（schema/tasks/messages/audit/agents/routes/hub/config/im.mjs/test）。

## 总裁决：REVISE

方案整体方向正确、五个特性边界清晰、非目标论证充分、§12 裁定表多数裁定成立。但存在 **0 Critical / 5 Important**：最严重的一组集中在 Feature E（ledger 写入矩阵不完整 + "transitionTask 单点写入"与代码事实不符 + 无事务性保证）和 Feature B（webhook 事件集漏 EXPIRED、SSRF 与开放注册组合、WS 路径校验缺失预案）。均为设计文档层面可修，不需推翻架构。修订后可直接进入第二轮。

---

## 预测 vs 实际（Pre-commitment）

审计前预测的五个高发问题区，全部命中：
1. 迁移幂等性/ALTER 与全新库路径冲突 → 命中（Minor-2，歧义）
2. ledger 状态覆盖与实际代码路径（sweeper/policy 不走 transitionTask）不符 → 命中（Important-1）
3. SSRF 与开放注册组合 → 命中（Important-4）
4. WS hub 绕过 route schema 的校验缺口（v1 已犯过同类，见 hub.ts:79 注释）→ 命中（Important-5）
5. webhook 事件集完整性 → 命中（Important-3）

---

## Important 发现（造成显著返工）

### I-1. Ledger 写入矩阵不完整，且"单点写入"与代码事实不符
- **位置**：§5.2「写入时机（与任务状态一一对应，由 transitionTask 单点写入）」
- **证据**：
  - v1 代码中 TIMEOUT/EXPIRED 由 `finalize()`/`scanTimeouts()` 写入（`server/src/core/tasks.ts:104-125`），**不经过** `transitionTask`；policy 拒单发生在 `createTask()`（`tasks.ts:59-66`），同样不经过 `transitionTask`。"由 transitionTask 单点写入"在现状代码上是假命题——ledger 钩子至少要挂三处（createTask policy 路径 / transitionTask / finalize），或重构出真正单点。
  - 写入矩阵列举了 `FAILED/TIMEOUT/CANCELLED/REJECTED-after-agreed → voided`，但：
    - **EXPIRED 完全缺席**。EXPIRED 是合法终态（24h 未 accept，`finalize(... 'EXPIRED')`）。pre-accept 无 agreed，照矩阵逻辑不写事件——但方案没有明说，留下二义。
    - **"REJECTED-after-agreed" 是不存在的状态**：v1 状态机 reject 仅允许从 REQUESTED（`tasks.ts:78` `require(t.status === 'REQUESTED')`），accept 后不可能 REJECTED。该短语要么是笔误要么暴露状态机理解偏差。
    - **pre-accept CANCELLED**（REQUESTED 态取消，`tasks.ts:84` 允许）：写 `voided` 则出现无 `agreed` 先行的 voided 事件，与"accept → agreed / 终态 → voided"的配对叙事矛盾（虽然文字不变量"`settled` 前必有 `agreed`"形式上不违反）。pre-accept REJECTED / policy-REJECTED 是否写事件未说明。
- **修改建议**：改为显式矩阵，逐终态列出：REJECTED(pre-accept)、REJECTED(policy)、EXPIRED → **不写事件**；CANCELLED@REQUESTED → 不写；CANCELLED@RUNNING、FAILED、TIMEOUT → voided（必有 agreed）；COMPLETED → settled（必有 agreed）。并把"单点写入"改为"在 createTask policy 路径 / transitionTask / finalize 三处挂同一 ledger 写入函数"或先重构收敛。§11 钉 4 的测试须覆盖 EXPIRED 不产生事件这一格。

### I-2. Ledger 事件与任务状态变更无原子性
- **位置**：§5.2 全节
- **证据**：v1 的任务变迁是裸 UPDATE（`tasks.ts:75` 等），audit/insertDerived 都是独立语句。方案要求 ledger 事件与状态一一对应且"测试钉死"不变量，但未要求 `db.transaction()` 包裹「任务 UPDATE + ledger INSERT + audit INSERT」。better-sqlite3 同步事务可直接用（v1 已有 `db.transaction` 用例，`agents.ts:53`、`messages.ts:66`）。进程崩溃在 UPDATE 与 INSERT 之间 → COMPLETED 任务无 settled 事件，"settled 前必有 agreed"不破坏，但"COMPLETED → settled"对应性被破坏且**无法事后判定是崩溃丢事件还是从未发生**——append-only 账本出现静默缺口。
- **修改建议**：方案明文规定：状态终态变更 + ledger + audit 同事务提交。这是 append-only 证据链的最低要求。

### I-3. Webhook 事件集漏 `task.expired`（及 policy 拒单）
- **位置**：§2.2「事件集：task.accepted、task.rejected、task.cancelled、task.result、task.timeout」
- **证据**：v1 审计事件全集含 `task.expired` 与 `task.policy_violation`（`audit.ts:5-6`，`tasks.ts:62,111`）。方案事件集不含 expired：requester 派出任务 24h 无人接、EXPIRED 收场，webhook 主人**收不到任何通知**——恰是"人类不用盯屏"最典型场景之一。policy 拒单（403 + REJECTED 记录）同样无推送（audit 事件名是 `task.policy_violation` 不是 `task.rejected`，即使加了 expired 也覆盖不到它）。
- **修改建议**：事件集补 `task.expired`；policy 拒单补 `task.policy_rejected`（或映射到 task.rejected 触发，payload 注明 reason=policy）。

### I-4. SSRF：内网 URL + 开放注册的组合未被约束
- **位置**：§2.2「安全注记：允许内网 URL……SSRF 风险由运营者对 agent 主人的信任覆盖」
- **证据**：v1 注册默认关闭但显式支持 `ALLOW_OPEN_REGISTRATION=true`（`config.ts:11`，`agents.ts:39`）。该模式下**任意自注册者**即可设置 webhook 指向 `http://127.0.0.1:<port>`、`http://169.254.169.254/...`、内网 service；`im webhook test`（POST /v1/webhook/test）配合 5s 超时/成功差异构成**按需端口扫描与内网探测 oracle**；重试 3 次放大请求量。"运营者信任 agent 主人"在开放注册下不成立——信任的对象是互联网任意人。全局并发 ≤50 只护主路径不护目标方。
- **Realist 校准**：自托管单机、默认关闭注册，实际暴露面有限，故不定 Critical。但方案把风险一句"文档写明"带过，防护成本极低却未做。
- **修改建议**：默认拒绝 loopback/link-local/私网/解析到私网的域名；env `WEBHOOK_ALLOW_PRIVATE=true` 显式开启（自托管 NAS 场景照旧）；`/v1/webhook/test` 单独限流（如 6/min/agent）。文档同时写明。

### I-5. WS `send` 帧的 thread_id 校验缺口无预案
- **位置**：§1「实现注记」只提 `sendMessage` 透传与 messages.ts:28
- **证据**：WS 路径绕过 Fastify route schema，`hub.ts:79-91` 的 `send` 分支手工构造 input——v1 正因同类缺口补过 cmid 校验（hub.ts:80 注释「终审 Important-2」）。v1.1 的 thread_id 正则 `^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$` 若只在 REST schema 校验，WS 帧 `thread_id: 任意字符串/数字/对象` 会直插 messages 表，破坏后续过滤与索引选择性。
- **修改建议**：§1 实现注记明确：thread_id 校验放进 `core/messages.ts` 的 `sendMessage`（单点，REST/WS 共享），而非 route schema 独担；WS 分支透传前 `String()` 规整。这也顺带保护派生消息路径。

## Minor 发现

1. **§2.3 文档失实**：`im task list --status` v1 已实现（`skills/agentlink/im.mjs:95`），不是 v1.1 新增。§7 表亦未列该 CLI，仅影响文档准确性。
2. **§6 迁移歧义 + ALTER 非幂等**：「v1 的 CREATE TABLE IF NOT EXISTS 路径保留（全新库一次到位）」两种读法：(a) CREATE TABLE 含新列 → 全新库若 user_version<2 再跑 ALTER 撞 duplicate column（SQLite ALTER ADD COLUMN 无 IF NOT EXISTS）；(b) CREATE 保持 v1 形态一律靠 ALTER。需明确二选一（推荐 b，或 a 且建库即置 user_version=2）。另：多语句 DDL 建议包 `db.transaction`，防部分成功后 user_version 未置位、重启撞列名崩溃。
3. **history 无 peer 的 thread 查询无索引覆盖**：`thread_id` 单独出现时过滤「我参与的全部消息」= `(from=me OR to=me) AND thread_id=?`；`idx_messages_thread(to_agent,...)` 只覆盖 to 侧。且 `/v1/history` 现要求 peer 必填（`routes/messages.ts:36` `required:['peer']`），peer 变可选是 spec 未提的 route schema 变更点。建议索引直接 `(thread_id, id)`（thread_id 本身高选择，标签语义下最简）。
4. **reputation 列表 N+1 聚合**：`searchAgents` 已全表 SELECT *（`agents.ts:90`），再逐 agent 聚合 6 项 → GET /v1/agents 一次请求 = agents×6 条查询。万级任务可忍，但一条 `GROUP BY executor` 即可批量取齐，建议写进实现注记。
5. **webhook_secret 必然明文存储**（HMAC 签名需原钥，无法像 token 存哈希）：DB 泄露可伪造签名。设计上不可避免，但文档应写明该权衡及 DB 文件保护要求。
6. **声誉互刷无缓解亦无披露**：requester-only + 一任务一评挡不住两个合谋 agent 互发任务互评五星；objective 统计同样可自导自演。v1.1 不做反作弊可接受，但 §3 应有一句披露 + 路线图挂 P1（如 requester 侧统计交叉验证）。
7. **签名防重放未设计**：签名覆盖 raw_body（含 ts 字段），但重放整条旧 payload 签名仍有效。任务事件重放危害低，建议接收方文档要求校验 ts 时窗（±5min），spec 一句话即可。
8. **audit.ts AuditEvent 是闭合 union**（`audit.ts:3-7`）：`webhook.failed`、（若采纳 I-3）expired/policy 事件推送的审计需扩类型，实现提醒。
9. **review 限流归 task 桶**（20/min）与派任务共享预算：正常场景够用，刷评场景已被一任务一评约束。可接受，无需改。

## 遗漏与过度设计（Gap Analysis）

- **遗漏**：webhook 触发的实现挂点未指定（与 I-1 同根：accepted/rejected/cancelled/result 在 transitionTask，timeout 在 finalize）。
- **遗漏**：`PATCH /v1/me` 返回体变化（含一次性 secret）对现有 `updateProfile` 返回 Agent 的形状影响未提；须保证 GET /v1/me 与后续 PATCH 不回显 secret。
- **遗漏**：result_schema 校验失败保持 RUNNING 与**心跳的交互**：deadline 照旧正确，但 executor 修 result 期间若心跳停摆会被 scanTimeouts 置 TIMEOUT——spec §11 钉 3 应补一句"重交期间心跳不中断"或测试覆盖"校验失败后紧邻 deadline"的次序。
- **测试设施（F 维度）**：现有 `server/test/helpers/ws-server.ts` + vitest 全套已覆盖双 agent 起服模式；webhook 挂起测试用 node:http 挂起 server 即可，零新依赖。**五个钉子的设施全部已具备**，Pass。
- **过度设计**：未发现。非目标清单（escrow/conversations/DISPUTED/dashboard）划界合理，四条裁定理由成立。

## §12 裁定表逐条意见

| 裁定 | 意见 |
|---|---|
| thread 是标签非实体 | **同意**。与 hub.ts 现实现（message 帧已含 thread_id 字段、null 即 v1 输出）零成本契合 |
| 自研受限 schema 校验器 | **同意，附条件**。红线成立（v1 依赖仅 4 个）；但"全部操作符测试覆盖"目前只落在 §4 一句话，未进 §11 钉子。建议钉 3 扩一句或 §4 明确"校验器操作符矩阵单测为 M3 验收项" |
| accept 即成交无还价 | **同意**。谈判走聊天、重发任务，状态机不扩，代价已正确评估 |
| webhook at-most-once | **同意**。补偿路径（服务端可查询）成立；但事件集漏 expired（I-3）削弱了"甜点"的覆盖面 |
| ledger append-only | **原则同意，前提修 I-1/I-2**。矩阵补全 + 事务性，否则"不可抵赖证据链"名不副实 |
| 货币不透明字符串 | **同意**。per-currency 分组已兜住多币汇总 |
| 任务事件仅参与者可见 | **核实为真**。`routes/tasks.ts:33-35` 即参与者制（404 语义），沿用正确 |

## 结论

修订 I-1～I-5（均为文档层修改，不动架构）后可进第二轮审计。Minor 项可在修订时顺手处理，I-4 的 env 开关与 I-5 的校验单点建议原样写入方案。
