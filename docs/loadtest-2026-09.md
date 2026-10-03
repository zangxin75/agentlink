# 压测记录 2026-09（M5 验收）

环境：Docker（`node:20-slim` 单容器，未限 CPU），宿主 64 核 / 125.8 GiB RAM；服务端 `DB_SYNCHRONOUS` 默认 NORMAL；注册限流放宽 `RATE_LIMIT_REGISTER_PER_HOUR=6000`。压测命令均按 README/Task 21 形式执行（本机宿主 8080 端口被占用，宿主端口映射改为 18080，容器内仍为 8080）。

工具：`node scripts/loadtest.mjs`（N 个 agent 环形互发，WS 接收 + REST ack，终局断言零丢失）。

## 结果汇总（全部为实测，无估算）

| 档位 | sent | acked | loss | P50 | P99 | 退出码 |
|---|---|---|---|---|---|---|
| **5000 连接 × 500 msg/s × 600s（M5 验收档）** | 236,028 | 231,597 | **4,431（1.9%）** | 2 ms | **10,603 ms** | 1 |
| 3000 连接 × 500 msg/s × 300s | 138,501 | 138,501 | 0 | 1 ms | 6,145 ms | 0 |
| **2000 连接 × 400 msg/s × 300s** | 117,999 | 117,999 | **0** | 1 ms | **60 ms** | 0 |
| 1000 连接 × 200 msg/s × 300s | 59,000 | 59,000 | 0 | 1 ms | 70 ms | 0 |
| 冒烟档 10 × 5 × 6s（vitest） | 20 | 20 | 0 | 3 ms | 5 ms | 0 |

### M5 验收结论：未达标

目标（spec §15/M5）：5,000 连接 + 500 msg/s × 10 min，P99 < 200 ms，loss = 0。
实测（ping 修复后完整跑满 10 分钟）：loss = 4,431 / 236,028（1.9%），P99 = 10.6 s，**均未达标**。

补充事实：该档服务端实际投递 236,027 / 236,776（99.7%，含冒烟档消息）；客户端统计的 loss 中相当一部分是 ack 尾部延迟（P99 10.6 s）超过脚本固定 5 s drain 窗口所致，但 P99 远超 200 ms 本身已构成不达标。

**满足 loss=0 且 P99<200ms 的最大实测档位：2,000 连接 × 400 msg/s × 300s（P99 60 ms）。**

## 瓶颈分析（供后续优化）

1. 服务端为单 Node 进程：5000 档全程约占满 1 核（~100%），HTTP（500 send/s + 500 ack/s）+ SQLite 同步写 + WS fanout 串行竞争事件循环，投递延迟尾部随连接数恶化。
2. `WsHub.onBus`（server/src/ws/hub.ts）：每个 bus 事件线性扫描全部 session（5000 连接 × 500 事件/s ≈ 250 万次迭代/s），且 `new-message` 时对接收方重发整个未确认收件箱（上限 100 条）——积压超过 100 后 WS 通道无法自行排空。建议改为 agentId→session 索引 + 按消息 ID 增量投递。

## 过程记录（失败尝试，均为真实数据）

- **尝试 1（5000 档，脚本未加固）**：客户端在 burst 阶段因 undici keep-alive 竞态（"other side closed"）未捕获 rejection 崩溃；此时服务端已投递 13,042 条。修复：`post()` 单次重试 + WS 认证后 error 吞掉 + 连接重试 2 次。
- **尝试 2（5000 档，仍未加心跳）**：sent 288,526 / acked 33,828 / loss 254,698。原因：brief 草稿脚本认证后不发 `{op:'ping'}`，spec §9 规定服务端 90 s 无帧即断开——约 90 s 时全部 5000 连接被服务端正确断开，REST 发送继续而 WS 投递停止（inbox_depth 258,659）。修复：每 30 s 心跳。此为计划自审清单中已标注的「压测脚本草稿瑕疵」，已落实修正。
- 尝试 3 即上表的 M5 验收档实测结果。

## 备份恢复演练记录（已执行）

时间：2026-09-30 02:24（CST），数据：压测后库（315,500 条消息 / 6,000 agents，228.7 MB）。

1. `docker compose exec backup sqlite3 /data/agentlink.db ".backup '/tmp/r.db'"` → 成功
2. `docker compose cp backup:/tmp/r.db ./restore.db` → 228,675,584 字节，sqlite 校验 315,500 msgs / 6,000 agents
3. `docker compose stop server` → 停服
4. 换库：`docker compose run --rm -v ./restore.db:/r.db server sh -c 'cp /r.db /data/agentlink.db && rm -f /data/agentlink.db-wal /data/agentlink.db-shm'`
5. `docker compose up -d` 起服 → `GET /healthz` `{"status":"ok"}`
6. 抽查：目录 `GET /v1/agents` 可读到恢复的 agent 数据（返回 3,001 条，含分页上限）；`GET /v1/stats` 正常（ws_connections=0, inbox_depth=0）

结论：**演练通过**。注：旧 WAL/SHM 必须随换库删除（已写入 docs/deploy.md runbook；本次演练实际执行时该删除步骤在恢复后补验，未观察到数据异常，但 runbook 中保留该步骤为正确操作）。

## F3 修复后重测（final fix round，2026-09-30）

本轮为终审后唯一修复轮（WsHub 按 agentId 索引，消灭每事件 O(总连接数) 扫描；ack receipt 合并）之后的 M5 档重测。环境与前述记录不同：**本地 node（tsx）直跑，非 docker 容器**；宿主 64 核 / 125.8 GiB RAM，DB 为全新空库（`/tmp` 临时目录，`DB_SYNCHRONOUS` 默认 NORMAL，注册限流放宽起服），压测命令 `node scripts/loadtest.mjs --connections 5000 --rate 500 --duration 600 --drain-ms 30000`（drain 由脚本新增 `--drain-ms` 参数放宽至 30s）。

| 尝试 | sent | acked | loss | P50 | P99 | 退出码 |
|---|---|---|---|---|---|---|
| 第 1 轮 | 295,000 | 295,000 | **0** | 1 ms | **243 ms** | 0 |
| 第 2 轮 | 295,000 | 295,000 | **0** | 1 ms | **282 ms** | 0 |

### 结论：loss=0 达标，P99<200ms 未达标（两轮为限，如实收口）

- 与修复前（loss 1.9%、P99 10.6s）相比：**丢包归零**（O(N) 扫描消除的直接收益），P99 从 10.6s 降至 243-282ms（约 40 倍改善），但仍高于 200ms 目标。
- 过程注记：第 2 轮首次起跑因复用同一服务实例撞注册限流（首跑已耗 5000/6000 桶）注册 429 中止，未计入上表；换新库放宽注册限流重启后完整跑满。
- 按终审裁定收口：**v1 容量认证档位仍为 2,000 连接 × 400 msg/s（P99 60ms，历史实测）**；5000×500 档 loss=0 但 P99 超标，方案 B（游标/单条增量推送 + 慢消费者背压）立项为后续任务。
- 残余 P99 尾部来源（未验证归因，供后续任务参考）：单进程事件循环上 500 次/秒 WS fanout（每命中重发整箱未确认 inbox，上限 100 条）与 HTTP/SQLite 写串行竞争；积压场景的整箱重发放大正是方案 B 针对的项。
