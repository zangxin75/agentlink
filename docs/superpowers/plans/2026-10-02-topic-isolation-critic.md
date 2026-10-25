# Topic 隔离实施计划 critic 审计报告（r1）

日期：2026-10-03
VERDICT：REVISE（需修改后 SHIP）

## 高

**H1. hook-stop.mjs 漏改——T3 改 claim 签名后 Stop 钩子静默失效**
`hook-stop.mjs:8` import `claim`、`:19` `unreadList(agentId)`、`:25` `claim(agentId, id)`。T3 后 `claim(agentId, topic, msgId)` 三参，旧调用 `topic=id, msgId=undefined`，`renameSync(join(d, 'undefined.json'), ...)` 永远 ENOENT，被 catch 吞掉 → **Stop 注入的信永远不进 consumed，每次 Stop 重复注入同一批**。T3 Files 加 `hook-stop.mjs` + `test/hook-stop.test.mjs` 夹具按新布局修。

**H2. im.mjs `read` 命令漏改——`claim` 旧调用导致本地视图信赖着不消失**
`im.mjs:117-119` `claim(plan.agentId, id)`。T3 后此调用 `topic=id, msgId=undefined`，claim 内 catch 返回 false，无任何报错。`im read` 后信在本地视图赖着。T5 增加 `read` 命令：先 `defaultLocalLookup` 查 topic 再 claim；`lib/topics-cli.mjs` 的 `defaultLocalLookup` 导出复用。

## 中

**M3. spec §5 `im history --topic` 无任务覆盖**。T5 改 im.mjs 但只列 send/inbox/topics。T5 第 3 点扩为 history 也拼 `&topic=`。

**M4. Global Constraints 承诺 `srv:`/webhook → `_default` "验收测试钉住"，但无任何该测试**。承诺与内容脱节。T1 追加一条：走 task 流程（或直接调 derive）断言派生消息 `topic === '_default'`。

**M5. WS 帧带 topic 无测试；WS send op 不支持 topic**。T1 加 WS 推送帧带 topic 测试（`test/ws.test.ts` 夹具直接用）；计划显式决策并写明"WS send op 不支持 topic，属 spec §8 演进项"。

**M6. TTL 25h 过期与 topics 60/min 限频无测试**。T2 追加：UPDATE `expires_at` 为过去后断言 GET 返回空 + 发送 `topic_registered:false`；连续 PUT 61 次断言 429。

**M7. T4 hook-inject `ids` 形状冲突**：代码块 `ids: msgs.map(m => m.id)`，括注又写 `msgs.map(m => [m.topic ?? '_default', m.id])`。删代码块的 ids 行，给出 `claimIds(agentId, pairs)` 完整 3 行实现。

**M8. T5 decideTopic 无绑定 agent 时 `--reply` 栈崩溃**。`defaultLocalLookup(agentId, ...)` 中 `topics(null)` 内部 join 抛 TypeError 未捕获。`defaultLocalLookup` 开头 `if (!agentId) return null`。

**M9. checkTopics 硬编码 60 偏离 cfg.rate + RATE_LIMIT_* 模式**。T2 Files 加 `server/src/config.ts`：加 `topicsPerMin` 字段 + 环境变量 `RATE_LIMIT_TOPICS_PER_MIN`，`checkTopics` 走 `this.rate.topicsPerMin`。

## 低

**L10.** 迁移测试名不副实 + 漏 `()` 的恒真断言。断言改 `.all()`；另加 v3→v4 增量用例。
**L11.** T4 `pushTopics({...force})` 签名无实现，删 force。
**L12.** `unreadListMulti` 沿用 `created_at - created_at` 排序对 ISO 字符串得 NaN。改 `String(...).localeCompare(...)`。
**L13.** `base.register` 不存在（实际是 `mk(id)`）。测试代码改用 `base.mk('...')` + `.agent.id`。
**L14.** T4 localInbox 代码块含 `require_or_dynamic_import` 占位伪函数；T3 测试在非 async 用 `await`。代码块直接顶层 `import { projectTopics } from './topics.mjs'`，删占位。
**L15.** "既有 150 用例"——CLAUDE.md 写 82。改"既有全量用例"。
**L16.** `localInboxPlan.local` T4/T5 后仍 `_default`-only 死值。T5 顺手把 `local` 改同逻辑或删字段。
**L17.** spec §2 "scanner 顺手 DELETE"未覆盖：惰性已够。T2 加一行决策说明。
**L18.** `im inbox --all` 无绑定时路径未定义。明确回退 REST `/inbox` + 提示"--all 需本地 daemon 绑定"。

## 总结

2 高（hook-stop + im read 漏改均为部署即触发、静默、claim 签名破坏）必须修；6 中（M3-M9）强烈建议同批；低随实现顺手处理。架构与依赖链正确，无需重写。
