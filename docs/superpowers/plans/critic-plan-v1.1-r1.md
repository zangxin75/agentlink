# Critic 审计报告：v1.1 实施计划（第一轮 r1）

审计人：critic-plan-v11-r1 ｜ 对象：`docs/superpowers/plans/2026-09-30-agentlink-v1.1.md`（14 任务）｜ 基准：spec v3（2026-09-30-agentlink-v1.1-design.md）
方法：预判 → 逐文件核对 v1 真实代码（schema/sqlite/config/errors/ratelimit/audit/messages/tasks/agents/derive/hub/app/index/routes×6/ws-server/im.mjs/mcp/skill-doc/cli-smoke）→ 模拟每任务执行 → 缺口分析。

## 总裁决：REVISE

计划结构与 spec 映射扎实（五钉映射表基本属实、任务接口大体闭环），但存在 **5 处「照计划写必跑红」的硬伤**：三处计划内测试与计划内实现自相矛盾（必然 FAIL），一处路由 schema 遗漏致字段被 Fastify 静默剥离，一处测试数据引用未注册 agent。另有多处 spec 钉子测试腿缺失。

## 预测 vs 实际

审计前预判的高发问题区（基于此类「计划内嵌代码」计划的通病）：
1. 计划给的测试代码与计划给的实现代码自相矛盾 → **命中 3 处**（C1 retry 计数、C2 pending 公式、C4 抛异常 listener）。
2. `additionalProperties:false` 的既有路由 schema 会静默剥离新字段而计划忘记改 schema → **命中 1 处**（C5 PATCH /v1/me webhook_url）。
3. SQL 次数断言被无关查询污染 → **命中**（I6 busy() N+1）。
4. 错误码「新增」实际未新增（沿用旧工厂函数）→ **命中**（I7 ALREADY_REVIEWED）。
5. CLI 子命令解析与命令分发错位 → **命中**（I8 im webhook）。

## Critical（照计划执行必然失败）

**C1. Task 5：retry 条件与测试断言矛盾（attempt 计数）**
- 位置：Task 5 Step 3 `deliver()`：`if (attempt + 1 < delays.length + 1 && attempt < 3)`；Step 1 测试：`expect(hits).toBe(3)`（retryDelaysMs `[0,10,10]`）。
- 证据：条件等价于 `attempt < delays.length(=3)`，attempt 0/1/2 均重试 → 共 **4 次** HTTP 尝试；测试钉 3 次 → 必 FAIL。且 `attempt + 1 < delays.length + 1` 与 `attempt < 3` 在默认 delays 下语义重复、冗余。
- 修法（确切）：把 delays 语义定义为「第 i 次尝试前的延迟」，条件改 `if (attempt + 1 < delays.length)`，删除 `&& attempt < 3`。默认 `[0,5000,25000]` = 共 3 次尝试（立即/+5s/+25s），与测试 `hits===3` 一致；`[0]`（test() 用例）= 1 次尝试，仍成立。

**C2. Task 11：ledgerSummary pending 公式错误（voided 未轧差）**
- 位置：Task 11 Step 3 SQL：`SUM(agreed) - SUM(settled) AS pending_total`；注释称「voided 计 0，天然扣除」。
- 证据：voided 行 amount 存 0（Task 10：`voided amount=0`），但其 **agreed 行 amount 原值仍在**。Step 1 测试：100+60 settled、30 failed(voided) → 公式得 pending=30，测试断言 `pending_total: 0` → 必 FAIL。且 spec §5.2「在途 = agreed 未终局」——voided 是终局，30 不应在途。测试期望正确、SQL 错误。
- 修法（确切）：终局判定不能靠 voided 行金额，改按任务是否已有终局事件轧差：
  ```sql
  SUM(CASE WHEN le.type='agreed' AND NOT EXISTS
    (SELECT 1 FROM ledger_events v WHERE v.task_id=le.task_id AND v.type IN ('settled','voided'))
    THEN le.amount ELSE 0 END) AS pending_total
  ```
  （外层需 `FROM ledger_events le`，WHERE 分支同步改别名。）

**C3. Task 10 测试 3：`carol.io` 从未注册，createTask 直接 404 抛错**
- 位置：Task 10 Step 1 第 3 用例：`UPDATE agents SET task_policy=... WHERE id='carol.io'` 后 `createTask(..., { to: 'carol.io', ... })`。
- 证据：该用例只 mk 了默认的 alice/bob（startWsServer 不预注册 carol），UPDATE 影响 0 行；`createTask` 第一行 `getAgent(db, 'carol.io')`（core/tasks.ts:20，agents.ts:17-20 不存在即 throw NotFound）→ 测试在 policy 分支前就崩。
- 修法：用例开头加 `srv.mk('carol.io')`。

**C4. Task 5 测试 3：listener 内 throw → uncaughtException + 永不响应**
- 位置：`const { url } = await listener(() => { hits++; throw new Error('boom') })`，注释称「500 即失败」。
- 证据：throw 发生在 `req.on('end')` 回调内 → 进程级 uncaughtException（vitest 记为未捕获错误）；且 `res.writeHead(200)` 被跳过 → 客户端 fetch 挂到 5s AbortController 超时，3-4 次尝试 ≈ 15-20s，测试 400ms 等待后 `hits` 与 `webhook.failed` 断言必挂。注释描述的「500」根本不会发生。
- 修法：listener 回调改为 `fn(req, b)` 内不抛、直接 `res.writeHead(500); res.end()`——即测试里 `listener(() => { hits++; })` 配一个写 500 的 listener 变体，或给 `listener` 加 status 参数。

**C5. Task 6：PATCH /v1/me 路由 schema 未加 `webhook_url`，字段被 Fastify 静默剥离**
- 位置：Task 6 Step 3 只改了 core/agents.ts 的 updateProfile 与 routes/agents.ts 的 handler 解构，未提 schema。
- 证据：routes/agents.ts:27-34 PATCH body schema `additionalProperties: false` 且无 `webhook_url` 属性；Fastify 默认 AJV `removeAdditional` 会把 `webhook_url` 从 body 中删掉 → core 收不到 → secret 永不生成 → 测试 `expect(secret).toMatch(/^wl_/)` 必挂；Task 12 cli-smoke `webhook set` 同样挂。
- 修法：PATCH schema properties 增加 `webhook_url: { type: 'string', maxLength: 512 }`（空串合法=关闭；http(s) 与字节长校验留在 core 单点，符合计划双层原则）。

## Important（显著返工 / 钉子测试失效）

**I6. Task 3 测试 2：SQL 次数断言把 busy() 的 N+1 也计入，断言 ≤2 必挂**
- 证据：directory.ts:10 `busy()` 每 agent 一次 `SELECT 1 FROM tasks WHERE executor=? AND status='RUNNING'`，9 个 agent = 9 次 prepare 命中 `/FROM tasks/`，加 reputationOf 1 次 → taskSelects≈10，断言 `toBeLessThanOrEqual(2)` FAIL。测试内注释「busy 单查另计，不计 FROM tasks 聚合」与事实相反——busy 的 SQL 字面含 `FROM tasks`。
- 修法（二选一）：(a) 计数正则改为只匹配批量聚合（如 `sql.includes('GROUP BY executor')`），并把 busy 维持现状写入注释；(b) 顺手把 busy 批量化（一条 `WHERE status='RUNNING' AND executor IN (...)`）。推荐 (a)（计划明确 busy 不属本任务）。

**I7. Task 7：`ALREADY_REVIEWED` 错误码实际未落地**
- 证据：实现用 `Errors.conflict('ALREADY_REVIEWED: task already reviewed')`——errors.ts:11 `conflict` 的 code 固定 `'CONFLICT'`，把新码写进了 message。spec §8 明确「错误码新增 ALREADY_REVIEWED」。测试只断言 409，钉不住该承诺。
- 修法：Task 1 的 Errors 增加通用 `conflictCode(code, m)`（或直接 `new AppError('ALREADY_REVIEWED', 409, m)`），测试补 `expect(r.json().error.code).toBe('ALREADY_REVIEWED')`。同类检查：其余四个新码均经 `unprocessable(code,m)` 正确带出，仅此一处错。

**I8. Task 12：`im webhook` 子命令解析错位，set/off/test 全部失效**
- 证据：im.mjs:18-19 把 `webhook` 加入 sub 判定后，`im webhook off` → sub='off'、rest=[]；计划代码读 `const s = rest[0]`（undefined）→ 落入 `out(api('/me', {PATCH, body:{webhook_url: rest[0]}}))`，off/set 语义全错；`set` 时 rest[0]=undefined → PATCH 空转。cli-smoke `webhook set/off` 用例必挂。
- 修法：按 `sub` 分发：`if (sub === 'off') ...; else if (sub === 'test') ...; else if (sub === 'set') out(await api('/me', {PATCH, body: { webhook_url: rest[0] }})); else die(usage)`。

**I9. 钉 3 缺一条腿：「心跳停摆者被 TIMEOUT」无任何测试**
- 证据：spec §11 钉 3 与 §4.2 明确要求「校验失败后紧邻 deadline：心跳在场者可重交成功；**心跳停摆者被 TIMEOUT**」。Task 9 测试 2 只走了在场者路径（且最终 COMPLETED 使 scanTimeouts 空转）；Task 10 的 TIMEOUT 用例与 schema 重交无交集。
- 修法：Task 9 测试 2 追加第二条任务：result 422 → 不再 heartbeat → 回拨 deadline → scanTimeouts → 断言 TIMEOUT。

**I10. 钉 2 缺重定向复检用例（spec r2-R2-1 点名要求）**
- 证据：spec §11 钉 2「集成测试不可 mock DNS 时以**重定向复检用例替代**」。Task 5 实现有 `post()` 的 manual redirect 复检，但 4 个测试没有一个 302→私网 的用例——该安全路径零覆盖。
- 修法：Task 5 增用例：listenerA 返回 302 Location: http://127.0.0.1:1/x，cfgNoPriv → 断言 0 次到达目标、audit webhook.failed。

**I11. Task 6 测试：模块级 `bodies` 跨用例共享，断言弱化**
- 证据：`const bodies: string[] = []` 顶层声明，测试 1 已 push ≥1，测试 2 的 `expect(bodies.length).toBeGreaterThanOrEqual(2)` 部分被测试 1 的残留满足；顺序/并发变化即 flaky。
- 修法：`beforeEach(() => { bodies.length = 0 })`，断言改为精确计数（policy_rejected=1 + webhook.test=1 → 2）。

## Minor

- M-a. Task 5 说明要求扩 `AuditEvent` union `'webhook.failed'`，但 Task 5 Files 列表没有 `core/audit.ts`——执行者易漏。Files 补上。
- M-b. Task 6 updateProfile 的 webhook 块必须插在 `if (!sets.length) return cur`（agents.ts:60）**之前**，否则仅传 webhook_url 时提前 return。计划未写明位置。
- M-c. Task 5 `close()` 注释称丢弃不补 audit 引 spec §2.2，但 spec §8 横切明写「server 关闭时丢弃队列**并记 audit**」。二者取一：按 §8 补记，或在计划中显式记录该裁量并改引正确条款。
- M-d. Task 8 `assertSchemaDraft` 不校验 `items` 的内容（`items: { type: 'weird' }` 或 `items: {pattern}` 可过 draft），运行期 `typeOk(v,'weird')` 落入 object 分支行为异常。checkProp 应对 items 做与顶层同型的键白名单+类型校验。
- M-e. Task 9 测试 3 标题承诺「oversized 413」但用例无 8KB 超限断言。补一条 `Buffer` 撑大 schema 断言 413。
- M-f. Task 13 测试里 `listTools()` helper 不存在（mcp.test.ts 用 `client.listTools()`），计划括号内已自我说明但代码块本身不可编译/复制。按既有 `client` fixture 改写。
- M-g. Task 3 计划代码保留自引用 import 再口头让执行者删除——直接给干净代码更好（自审清单已认列，可接受）。
- M-h. Task 11 registerLedgerRoutes deps 传了 `bus` 但两个 GET 均不需要（长轮询不在范围）。可去。

## 计划自审清单复核

1. Spec 覆盖映射表：逐条核对 §1-§11 → T1-T14，**映射真实**（含 §7 限流归属、§8 横切、§9 兼容）。缺口仅在钉 2（I10）与钉 3（I9）的测试腿。
2. 占位符：T5 骨架/完整版、T13 helper 复用均自认列，属实；但 T5 完整版测试自身仍有 C1/C4 两处错——「完整版为准确认」的声明不成立。
3. 类型一致性：TaskHooks/WebhookDispatcher.notify/writeLedgerEvent/THREAD_ID_RE 三处签名核对一致 ✓；`Errors.unprocessable` 定义（T1）与消费（T7/T8/T9）一致 ✓。
4. 五钉映射：钉 1 ✓（T2 测试真实钉住）；钉 2 部分（缺 I10）；钉 3 部分（缺 I9）；钉 4 ✓（故障注入 + 四类零事件均有代码）；钉 5 部分（测试在但 I6 使其必挂）。
5. 五条已知裁量：① audit union 扩展、③ CLI peer 可选、④ T9 包含式断言——可接受；② result_schema 原样字符串返回——可接受（避免双重 parse 口径）；⑤ close() 静默丢弃——**不可接受**，与 spec §8 字面冲突（见 M-c）。

## 结论

REVISE。修 C1-C5（均为局部、修法已给，不动架构）+ I6-I8（测试/错误码/CLI 三处返工点）后可进第二轮；I9/I10 是 spec 钉子腿，建议随本轮一并补齐。任务顺序、接口契约、迁移策略（user_version 0→2 事务门控）经核对与 v1 现状严丝合缝，无需重排。
