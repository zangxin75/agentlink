# Critic 审计报告：v1.1 实施计划（第二轮 r2 核销审计）

日期：2026-09-30 ｜ 审计人：critic-plan-v11-r2 ｜ 对象：修订版 `2026-09-30-agentlink-v1.1.md`（commit af98c62）｜ 基准：r1 报告 + spec v3 + v1 代码
落盘说明：审计人 Write 被角色禁用，本文件由 team-lead 依审计人回传全文代写（内容未改动）。

## 总裁决：ACCEPT-WITH-RESERVATIONS

核销 19/19（18 全额 + I10 部分/自认降级）。修订引入的新代码逐条推演均可通过其配套测试，未发现照计划执行必挂的错误。保留项仅两条一句话级事项（N1 修法 + post() redirect 分支补测建议），不阻塞执行。

## 核销表

| r1 | 判定 | 证据 |
|---|---|---|
| C1 retry | Addressed | `attempt + 1 < delays.length` + 「delays[i]=第 i 次尝试前等待」语义；[0,10,10]→3 hits、[0]→1 次、默认 [0,5000,25000] 全部与测试断言自洽 |
| C2 pending 轧差 | Addressed | NOT EXISTS 终局事件子查询；100/60 settled + 30 voided → settled 160 / pending 0，与断言一致 |
| C3 注册（含推广自查） | Addressed | 全面扫描所有直接调 core 的用例：T3/T4/T6/T7/T9/T10/T11 引用的 agent 均已 mk；T5 的 other.x/o.x 仅作 notify audience 查询（查不到即跳过，不 throw）——无遗漏 |
| C4 throw listener | Addressed | listener 加 status 参数默认 200；测试传 500，回调不抛 |
| C5 PATCH schema | Addressed | `webhook_url: { type:'string', maxLength:512 }` 入 schema + 静默剥离警示；核对 routes/agents.ts:27-34 |
| I6 SQL 计数 | Addressed | `/GROUP BY executor/` 正则 + `toBe(1)`；busy() N+1 注释排除；ratee 聚合不计入 |
| I7 ALREADY_REVIEWED | Addressed | `new AppError('ALREADY_REVIEWED', 409, ...)`，构造器参数序正确；测试补 error.code 断言 |
| I8 CLI webhook | Addressed | 按 sub 分发 set/off/test；与 im.mjs:15-19 机制吻合 |
| I9 心跳停摆 TIMEOUT | Addressed | stale 第二腿补齐；核对 scanTimeouts 仅按 deadline 判（heartbeat 不参与）→ 第一腿包含式断言实际必然 COMPLETED，稳定通过 |
| I10 重定向复检 | **Partially addressed** | 降级用例在首跳（127.0.0.1）即被拒，post() 的 302 逐跳复检分支仍零覆盖；但 r1 建议原版（可达公网首跳）在本沙箱不可行，降级 + ipIsPrivate 矩阵是环境约束下的合理选择 |
| I11 bodies 共享 | Addressed | beforeEach 清零 + 精确计数 2 |
| M-a..M-h | 全部 Addressed | Files 列表/插入位置/close 记 audit（spec §8）/items 白名单/413 真断言/client fixture/去 bus 逐项核实 |

## Open Questions（unscored）

1. **N1（MEDIUM 置信）** Task 9 `toThrowError(expect.objectContaining(...))` 的不对称匹配器无 vitest 文档承诺，实现正确时可能仍失败。修法：改 try/catch 显式断言 `e?.status === 413` / `e?.code === 'SCHEMA_UNSUPPORTED'`。→ **控制器已采纳**（修订版已改）。
2. post() redirect 逐跳复检分支建议在可起公网端点的环境补测；沙箱内以降级用例为准。→ 已作为执行阶段备注写入计划。

## 结论

计划可进执行（subagent-driven-development）。审计循环：r1 REVISE(5C/6I/8M) → 修订 → r2 ACCEPT-WITH-RESERVATIONS(19/19 核销) → N1 一句话修法采纳 → ALL CLEAR。
