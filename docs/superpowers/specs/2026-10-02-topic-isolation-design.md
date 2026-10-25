# 单账号多项目 topic 隔离 — 设计方案

日期：2026-10-02
状态：r2（critic 审计后修订，待用户终审）
前置：`docs/superpowers/specs/2026-09-29-agentlink-design.md`（主 spec，本文只写增量）

## 0. 背景与目标

同一台机器、同一 AgentLink 账号（单 agent_id）下运行多个项目的 Claude 会话时，任一会话会把账号收件箱里的所有信都消费/注入掉，造成跨项目抢信与串扰。

**目标**：单账号不变；每个项目的会话只看到本项目的信 + 显式广播信；错投可见可纠正；不丢信。

**非目标**：传输层硬隔离（升级为服务器路由是后续可平滑演进项，topic 字段保留）；多账号；跨机器联邦。

**范围**：服务器 schema/端点小改 + 客户端 daemon/hook/CLI 改造。开发阶段，无历史兼容负担（现网皆为开发测试账号）。

## 1. 消息模型：topic 字段

- `POST /v1/messages` body 增加可选 `topic: string`，pattern `^(_default|[a-z0-9][a-z0-9._-]{0,31})$`（含保留名 `_default`，其余与 agent_id 风格一致，≤32 字符）；缺省 `_default`。
- `_default` 保留名 = 广播：所有会话可见；线上值与省略等价，schema 允许显式传入。
- `srv:` 派生系统消息与 webhook 通知一律 `_default`（账号级事件，广播语义——写成决策，不留给实现者猜）。
- 存储：`messages` 表增加 `topic TEXT NOT NULL DEFAULT '_default'`（user_version → 4）；历史行不回填，语义即为广播。
- 透传：inbox / history / WS push 帧 / webhook 均原样带出 `topic`。
- **投递不校验 topic 是否注册**：未知 topic 照常接受并投递（落对应 spool 目录等待），响应附 `topic_registered: false` 警示字段。理由：接收方新项目冷启动（配置了 `.agentlink.json` 但会话尚未跑过一次）不能被拒之门外；注册表只是决策辅助，不是准入控制。

## 2. 账号 topic 注册表（服务器）

- 表 `agent_topics(agent_id, topic, refreshed_at, expires_at)`，主键 (agent_id, topic)。
- `PUT /v1/me/topics` body `{topics: string[]}`（≤8 项，逐项过 topic 正则；`_default` 不可注册）：对列表内 topic upsert `expires_at = now + 25h`；**不在列表内的既有 topic 不删除**（会话只知道自己项目，无权注销别人的）。限频：独立桶 60/min。
- `GET /v1/agents/:id/topics` → `{topics: [{topic, refreshed_at}, ...]}`（活跃 = 未过期；目录可见性同 agents 目录）。供发送方 CLI 决策。空列表/无记录 → 返回空数组。topic 名视为公开目录信息（任何已认证 agent 可枚举），勿放敏感项目代号。
- `GET /v1/me/topics`（需 token）：同上，返回自己的活跃 topic，供 `im topics`。
- 过期清理：读取时惰性过滤 + scanner 顺手 DELETE（无新增扫描周期）。
- TTL 25h（与 hook 每小时续期节奏匹配）：任何项目的会话一天内跑过一次 hook（见 §4）即续期；弃用项目次日自然沉没，不会长期阻塞发送方分诊。

## 3. 发送端语义（CLI `im send`）

决策顺序（`--topic` 显式指定则跳过 1-3）：

1. `--reply <msgid>`：从本地 spool/consumed 记录取原信 `topic` 继承（机械，零语义错误，覆盖日常回信）。**本地查不到原信**（consumed 已被 7 天清理、或原信由另一台机器接收）→ 视同无 `--reply`，继续步骤 2-3，不报错。
2. 查 `GET /v1/agents/:to/topics`：
   - 恰 1 个活跃 topic → 自动使用；
   - ≥2 → **报错退出并列出 topic 列表**，提示按内容挑一个重发（强制分诊闸，防退化）；
   - 0 个（对端从未注册）→ 落 `_default`，信头标注广播。
3. 发送结果若带 `topic_registered:false`，stderr 提示"对端暂无活跃会话订阅此 topic，信将等待"。

`im send --topic _default` 显式广播（健康检查等全机呼叫用）。

## 4. 客户端：会话声明与注入过滤

### 4.1 项目声明文件 `.agentlink.json`

项目根（hook 从 cwd 向上找到 git root 或含此文件的最近目录）：

```json
{ "topics": ["imchat"] }
```

- 无此文件/无 topics 字段 → 会话 topics = `['_default']`（行为=现状：只见广播）。
- 每个 .agentlink.json 建议只声明 1 个 topic（多项目目录可声明多个，如 monorepo）。

### 4.2 daemon.mjs：分拣落盘

- spool 布局改为 `spool/<agentId>/topics/<topic>/{pending,consumed}/`（旧平铺布局废弃，不迁移——开发阶段约定）。
- 入信（WS push 或 REST 补洞）按信自带 `topic` 落对应目录；落盘即 ack，ack 语义不变。
- **spool.mjs 全部路径函数（spoolDir / unreadList / claim / maxCursor / cleanup / clearTmp）改为接受 `(agentId, topic)` 双参**（或内部遍历 `topics/*`）——尤其 `maxCursor`：补洞游标若仍按平铺目录取值，会漏补或无限重 ack。daemon 启动清理遍历 `spool/<agentId>/topics/*`。

### 4.3 hook-inject.mjs：门口过滤

- 每次触发：解析 cwd → `.agentlink.json` → 本会话 topics T。
- **上报续期**：读 `.local/state/agentlink/topic-push-<agentId>.json` 缓存（按 agent 区分，一机多账号不串号），若 T 变化或距上次推送 >1h，`PUT /v1/me/topics`（用机器全局 token）。
- **注入**：只列 `T ∪ {_default}` 各 topic 目录的 pending 信注入；信头格式含 `topic: <t>`，`_default` 额外标注（广播）。注入后移 consumed（同项目多会话先读先得，协作语义，同现状）。
- **错投可见性**：注入时若发现 `T ∪ {_default}` 之外的 topic 目录存在 pending 信，注入块尾部追加警告：`⚠ 存在 N 封落在 topic「X」的待处理信（本会话未订阅），用 im inbox --all 查看`。pending 不设 TTL，由该警告承担可见性。
- `im inbox --all`（CLI 逃生口）：任何会话可看全部 topic 的 pending（人/调试用，不走注入）。

## 5. CLI 其余命令

- `im inbox [--topic X | --all]`：服务器 inbox 查询带 topic 过滤（`GET /v1/inbox?topic=`），`--all` 看本地全 topic spool。
- `im history --peer X [--topic X]`：history 查询带过滤参数。
- `im topics`：列本账号已注册 topic（GET /v1/me/topics，需 token）。

## 6. 错误与边界

| 场景 | 行为 |
|---|---|
| topic 非法字符/超长 | 400 INVALID_REQUEST（schema 层） |
| 发往未注册 topic | 接受+投递，响应 `topic_registered:false`，CLI stderr 提示 |
| 同 topic 多会话同时在线 | 共享 pending，先注入先消费（协作，同现状） |
| 项目会话长期不开 | 信在 spool pending 等待，不丢；下次会话启动全量注入 |
| 广播信泛滥（都不标 topic） | 退化为现状，无害；SKILL.md 规范要求回信用 --reply |
| 注册表与实际项目漂移 | TTL 25h 自然回收（弃用项目次日沉没），陈旧项存活不过一天，不会长期阻塞发送方分诊 |
| 发送方选错 topic（信落错项目目录） | 接收方 hook-inject 注入块尾警告（见 §4.3），`im inbox --all` 可见可转发，不丢信 |

## 7. 测试要点

- 服务器：topic schema 合法/非法（含 `_default` 显式可传）；默认 `_default` 落库；inbox/history/WS 帧带 topic；registry PUT/GET/TTL 25h 过期/`_default` 拒绝；v4 迁移。
- 客户端：daemon 按 topic 分目录落盘；补洞带 topic（maxCursor 按 topic 取值）；hook 过滤（T∪_default、.agentlink.json 缺失回退、错投警告行）；--reply 继承及查不到回退；单 topic 自动；多 topic 报错列列表；`im inbox --all`。

## 8. 升级路径

A（本方案，客户端分拣）→ 未来 B（服务器按连接订阅路由）：topic 字段与注册表原样复用，仅把分拣点从 hook 上移到服务器连接层，属平滑演进。
