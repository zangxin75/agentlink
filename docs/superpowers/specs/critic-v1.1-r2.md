# Critic 审计报告 — AgentLink v1.1 设计（第二轮）

日期：2026-09-30 ｜ 审计人：critic（r2）｜ 对象：`2026-09-30-agentlink-v1.1-design.md`（v2）
核对面：r1 报告（`critic-v1.1-r1.md`）+ v1 spec + 实现代码（core/tasks.ts、core/messages.ts、core/agents.ts、core/audit.ts、http/routes/{messages,tasks}.ts、ws/hub.ts、db/schema.ts、config.ts、skills/agentlink/im.mjs）。

## 总裁决：ACCEPT-WITH-RESERVATIONS

v2 对 r1 全部 5 项 Important、9 项 Minor、3 项遗漏逐一给出修订且与代码事实相符，核销率 17/17（其中 1 项"已修但留一个收尾缺口"，见新发现 R2-1）。架构、兼容承诺、测试钉子均成立。唯一保留项：SSRF 修复未指明校验时点，静态黑名单可被 DNS rebinding / 重定向绕过——需在 M2 webhook 任务开工前补一句话级设计约束，不构成整体返工。

---

## 预测 vs 实际（Pre-commitment）

预测高发区：1) SSRF 修复只做静态列表不做解析时校验 → 命中（R2-1）；2) ledger 矩阵修订仍与代码路径不符 → 未命中（v2 三挂点与 tasks.ts 实际路径完全一致）；3) peer 可选化破坏 v1 客户端/测试 → 未命中（v1 客户端必传 peer，放宽为可选是单向兼容）；4) 迁移事务内 PRAGMA user_version 有问题 → 未命中（SQLite user_version 是事务性的，事务内 `PRAGMA user_version=2` 随 COMMIT 持久化、随 ROLLBACK 回退，v2 写法合法）；5) reputation 索引与 GROUP BY 路径不匹配 → 部分命中（R2-2，重复索引）。

---

## A. 修复核销表

| r1 编号 | 内容 | v2 判定 | 证据 |
|---|---|---|---|
| I-1 | ledger 矩阵不完整 + 单点写入不实 | **Addressed** | §5.2 矩阵显式逐终态：REJECTED/policy/EXPIRED/CANCELLED@REQUESTED 不写；FAILED/TIMEOUT/CANCELLED@RUNNING→voided；挂点改 `writeLedger()` 三处（createTask/transitionTask/finalize）。与代码核对：reject 仅允许 REQUESTED（tasks.ts:72）、TIMEOUT/EXPIRED 走 finalize（tasks.ts:107-123）、policy 在 createTask（tasks.ts:38-41）——三挂点穷尽全部终态写路径，矩阵各格与状态机一致。v2 还顺带纠正了 v1 稿"REJECTED-after-agreed"错误表述。 |
| I-2 | ledger 与状态变更无原子性 | **Addressed** | §5.2「事务性」：终态 UPDATE + ledger INSERT + audit INSERT 同 `db.transaction()`；v1 确有事务先例（messages.ts:60 ackMessages、agents.ts updateProfile），可行。§11 钉 4 含故障注入验证原子性。 |
| I-3 | webhook 事件集漏 expired/policy | **Addressed** | §2.2 事件集含 `task.expired`、`task.policy_rejected`（独立命名 + payload reason:'policy'，audit 侧沿用 `task.policy_violation` 原名，§8 交代清楚，避免与 audit.ts:7 闭合 union 冲突）。触发条件段明确 expired/policy_rejected 推给 requester。 |
| I-4 | SSRF + 开放注册组合 | **Partially addressed** | §2.2 默认拒绝私网/环回/link-local + `WEBHOOK_ALLOW_PRIVATE` + webhook/test 独立限流桶（6/min）——静态防护到位。但**校验时点未指明**：set 时校验 URL 字符串、投递时重新解析，DNS rebinding 或 HTTP 3xx 重定向到私网即可绕过。见新发现 R2-1。 |
| I-5 | WS 帧 thread_id 校验缺口 | **Addressed** | §1 实现注记：校验放 `core/messages.ts` sendMessage 单点，WS 分支透传前 `String()` 规整——与 hub.ts:72-74 cmid 同型补法，正确。 |
| M1 | im task list 文档失实 | **Addressed** | §2.3 改为「v1 已有（im.mjs:95），v1.1 仅美化输出」。核对 im.mjs:95 `case 'list'` 含 `--status`，属实。 |
| M2 | 迁移歧义 + ALTER 非幂等 | **Addressed** | §6 明确选 (b)：CREATE 保持 v1 形态，新列一律 ALTER，user_version 防重跑，v1.1 分支整体包 transaction。v1 库 user_version 现为 0（schema.ts 无 PRAGMA），0→2 无冲突。事务内 `PRAGMA user_version=2` 在 SQLite 中合法且原子。 |
| M3 | thread 查询索引 | **Addressed** | `idx_messages_thread(thread_id, id) WHERE thread_id IS NOT NULL`，覆盖 from/to 两侧；peer 可选已作为 route schema 变更点在 §1 显式标注（messages.ts:34 现为 required:['peer']，属实）。 |
| M4 | reputation N+1 | **Addressed** | §3.1 GROUP BY executor 批量 + §11 钉 5 断言 SQL 次数。但配套索引与现存索引重复，见 R2-2。 |
| M5 | secret 明文披露 | **Addressed** | §2.2 明文存储权衡 + DB 文件保护要求已写明。 |
| M6 | 互刷无披露 | **Addressed** | §3.4 披露 + P1 路线图（requester 侧交叉验证、同 requester 加权衰减）。 |
| M7 | 签名防重放 | **Addressed** | §2.2 接收方校验 ts ±5min 写入文档要求。 |
| M8 | AuditEvent union | **Addressed** | §8 仅扩 `webhook.failed`；policy 推送事件名与 audit 名分离，不再要求扩 union。 |
| M9 | review 限流归 task 桶 | **无需修改**（r1 自身结论） | §7 照此归属。 |
| 遗漏-1 | webhook 挂点 | **Addressed** | §2.2 `notifyTaskEvent()` 三挂点，与 ledger 同构。 |
| 遗漏-2 | secret 不回显 | **Addressed** | §2.2「仅在本次设置响应返回一次，GET/后续 PATCH 永不回显」。 |
| 遗漏-3 | schema 拒后心跳交互 | **Addressed** | §4.2 心跳不豁免 + §11 钉 3「校验失败后紧邻 deadline」次序用例（含心跳停摆被 TIMEOUT 反例）。 |

---

## B. 独立重审新发现

### R2-1（Important）SSRF 校验时点未指明，静态黑名单可被 DNS rebinding / 重定向绕过
- **位置**：§2.2「默认拒绝 loopback/link-local/私网 IP 及解析到私网的域名」——未说明该校验发生在 URL 设置时（PATCH /v1/me）还是投递时（webhook 出站请求发起前）。
- **攻击路径**：开放注册模式下，攻击者设置 `webhook_url=http://rebind.attacker.com/`（解析到公网 IP，通过设置时校验）；投递时该域名 rebind 到 127.0.0.1 / 169.254.169.254 / 内网 service，静态 set-time 校验形同虚设。同理，公网 URL 返回 302 → `http://10.0.0.1/...` 的重定向跟随是否校验跳转后地址也未说明（fetch 默认跟随重定向）。
- **Realist 校准**：自托管、默认关闭注册、单机场景暴露面有限；修复成本是一句话 + 实现时 IP pinning（解析后直连该 IP，或对每次重定向目标复检）。维持 Important 而非 Critical，与 r1-I4 同级——它是 I-4 修复的收尾，不是新架构缺陷。
- **修复**：§2.2 补一句：「SSRF 判定在**每次出站请求发起时**按当次解析 IP 进行（DNS 解析后以 IP 直连或复检，禁用/复检重定向目标）；set 时校验仅为提前报错，不是安全边界」。§11 钉 2 补一条 rebinding 用例（mock DNS 不可行时以集成测试注释降级为重定向复检用例）。

### R2-2（Minor）`idx_tasks_executor_status` 与现存 `idx_tasks_executor` 完全重复
- v1 schema.ts:54 已有 `CREATE INDEX idx_tasks_executor ON tasks(executor, status)`。§6 再建 `idx_tasks_executor_status ON tasks(executor, status)` 是同列序同集合的重复索引——白付一份写放大与存储，无查询收益。修复：删掉该行，§3.1 注明复用现有 `idx_tasks_executor`（GROUP BY executor 的聚合路径已被其覆盖）。

### R2-3（Minor）`peer` 可选化后 `getAgent(peer)` 的存在性校验语义未交代
- routes/messages.ts:40 对 peer 必做 `getAgent`（不存在即 404）。peer 变可选后：仅 thread_id 查询时跳过该校验无碍；但 `peer + thread_id` 组合是否保留"peer 不存在 → 404"未写明。两种解释都无害（差异只是 404 vs 空数组），属歧义非缺陷。建议一句话钉死（保留 404，行为与 v1 一致）。

### R2-4（Minor）webhook/test 与 SSRF 默认拒绝的交互留了一个内网自托管死角
- `WEBHOOK_ALLOW_PRIVATE=true` 放开后，`POST /v1/webhook/test` 仍是按需触发服务端向任意已 set URL 发请求的端点——此时限流桶（6/min）是唯一护栏。可接受（该 env 本身就是显式信任声明），但建议文档随 env 说明一并写明"放开后 webhook/test 同样失去私网防护"。零代码成本。

### 已核查无恙的交叉点（对应派单关注项）
- **SSRF × webhook.test**：见 R2-1/R2-4。
- **history peer 可选 × v1 兼容**：v1 客户端始终传 peer（旧 schema required），可选化是放宽，REST/WS 旧行为零变化；`after`/`before` 游标语义未动。无回归。
- **reputation 索引 × GROUP BY**：批量聚合单条 `GROUP BY executor` 与索引 (executor,status) 前缀匹配，一致性成立；仅重复索引问题（R2-2）。
- **migration 事务内 PRAGMA user_version**：SQLite `user_version` 写入是事务性语句，随 COMMIT 持久、随 ROLLBACK 回退；v2「DDL + user_version=2 原子提交」合法。
- **§2.1 可见性声明**：tasks.ts:34 确为参与者制（非参与者 404），events 端点沿用属实。
- **§5.2 矩阵 × 状态机**：reject/cancel/accept/result 的前置状态断言（tasks.ts:66/72/78/84）与矩阵各格逐一吻合；finalize 的 `WHERE status!=?` 守卫使 TIMEOUT/EXPIRED 幂等，ledger 挂点不会双写。
- **hub.ts:119 message 帧已含 thread_id**（messages.ts COLS 含 thread_id），§9 兼容承诺第 2 条与现状一致。

---

## 结论

v2 是一次高质量的修订：17 项核销中 16 项完全到位、证据可查，且修订本身引出了正确的实现注记（三挂点、单点校验、事务性）。保留项 R2-1 是 I-4 的收尾缺口，一句话设计补充即可关闭，不动架构、不阻塞 M1/M3/M4 开工，仅要求在 M2（webhook）实现前落入 spec。R2-2~R2-4 顺手处理。

**裁决：ACCEPT-WITH-RESERVATIONS** — 保留条件：R2-1 的投递时校验约束写入 §2.2 后即可全量放行；R2-2 删除重复索引行。
