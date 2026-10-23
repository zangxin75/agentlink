# 人类观测台 + 群聊 + 备注 · 设计方案 v4

状态：v4 定稿——r1 REQUEST CHANGES 已修订（见 `.superpowers/reviews/2026-10-22-console-groupchat-critic-r1.md`），r2 复审 **APPROVE**（`…-critic-r2.md`，5 条 Minor N1-N5 已吸收进正文）
前置：本设计扩展 `docs/superpowers/specs/2026-09-29-agentlink-design.md`（下称「主 spec」）；协议与 DDL 冲突处以主 spec 为准，本文件负责增量定义。

## 0. 目标与非目标

**需求**（用户原话归纳）：
1. 人类能实时查看 agent 间的沟通内容，了解协作进度与结果
2. 群聊：拉多个 agent 进群协同；人类可在群里发言让所有成员看到；群名可编辑
3. 人类可给每个 agent 写备注（方便人类记住谁是谁）
4. 呈现方式方便人类在**手机端**操作
5. 历史聊天信息与群历史信息**本地保存**（console 端本地缓存，见 §5.1）

**多所有者裁决**（2026-10-22，用户）：
- 多个主人（human）共存于同一服务器，各自拥有自己建立的 agent
- 主人可以看**有自己的 agent 参与的群**聊；群里可以有不同主人的 agent
- **只能给自己建的 agent 下达指挥任务**
- **agent 一定有归属者**（不存在未归属态）
- **建群人统一拉齐成员**（建群/管理时可拉任意 agent 入群）

**前提定性**：自托管、少数互信主人（当前 kt + zhy）。所有权是权限的根，**在注册时即确定**。

**非目标（v1 明确不做）**：
- 注册审批流 / 所有权转移 API（归属随注册码定死，纠错走部署层）
- 群内 topic 分流（一群一条时间线）
- agent 自建群 / 自助加退群（v1 群操作由人类发起）
- 飞书桥接（已有 market 通知单播；群聊双向桥接留作后续扩展）

## 1. 概念模型

### 1.1 人类角色与所有权

`agents` 表新增两列：

| 列 | 含义 |
|---|---|
| `role TEXT NOT NULL DEFAULT 'agent'` | `agent` / `human` / `group`（伪 agent，见 §1.3） |
| `owner TEXT NOT NULL` | 拥有者的人类 agent id；`human` 行 owner=自身；`group` 行 owner=建群者。**无默认空值——注册时必须给定**（迁移期存量由 v8 迁移统一回填，见 §1.5） |

**人类 = 一个真 agent**：用现有 `im register` 正常注册（有自己的 token、可连 WS、可收发消息），复用全部现有机制。role 解锁人类专属能力；**owner 决定这些能力的边界**。

### 1.2 权限矩阵（本设计的核心）

设 H=某人类，`mine(X)` ≡ `X.owner == H.id`：

| 能力 | 边界 | 服务器强制点 |
|---|---|---|
| **观察 DM** | 只能看 `from` 或 `to` 为 `mine(A)` 的对话对 | observe 端点/WS 过滤 |
| **看群聊** | 群内存在 `mine(A)` 成员，或我是建群者 → 可读**全群**流（含其他主人的 agent 发言——入群即知情） | GET group messages 校验 |
| **群内发言** | 同上可见性条件；发言全员可见 | send 校验 |
| **指挥任务** | **只对 `mine(A)`**：task 创建（requester=H，executor=A）与 human→A 私聊指令 | tasks/messages 校验，违规 403 `NOT_YOURS` |
| **跨所有者沟通** | 必须经**群**（透明：对方主人在群里可见全部）；禁止 human→他人 agent 的私聊 DM | messages 校验 |
| **备注** | per-(human, agent) 私有视角：互不可见不可覆盖 | 独立表 §1.4 |
| **群管理** | **建群者：拉任意 agent 入群（统一拉齐）、改名、解散、移除任意成员**；非建群者主人：只能移出自己的 agent（随时退群） | groups 端点校验 |

**「指挥」与「广播」的界线**：群里 human 的发言是**信息广播**（全员可见，包括别人的 agent）；**指挥任务**（有状态机的 REQUESTED→…→result）走 task API 且只对 own agent 开放。私有 DM 指令只对 own agent。跨主人的 agent 协作中，任何人类意图要么留痕于群（对等透明）、要么只下达给自己的 agent。

### 1.3 群聊（groups）

**群 = 伪 agent**。建群时创建 `agents(id='grp.<8hex>', role='group', display_name=<群名>, owner=<建群 human>)`，`id` 满足现有 `AGENT_ID_RE`，消息外键、目录、presence 全部复用。群伪 agent **不发 token**（无人能以群身份登录）。

**投递模型 = fanout 行**（v1 决策保留，理由 §2.3）：一条群消息落 N 行（N=成员 agent 数，含发送者自持行），每行 `group_id` 指向群、`topic='g-<group短id>'`、`client_msg_id` 后缀化（见 §2 幂等与截断）。成员侧 WS 推送、spool、ack、read、hook 注入、`im inbox/resume/topics` 零改动；agent 群聊零新命令——`im send grp.ab12cd "..."` 即群发。

**群发送的统一入口与拦截点（r1-M4）**：`POST /v1/messages`（im send 实际入径）检测 `to` 解析为 `role='group'` 的 agent → **不直插单行**，改调用与 `POST /v1/groups/:id/messages` **共用的群发内部函数** `sendGroupMessage()`（成员/可见性校验：发送者须为成员 agent 或「有 mine(A) 在群」的人类；非成员/不可见 403；群已解散 410）→ 事务内 fanout 落 N 行 → commit 后发 bus。WS `send` op 对 `to` 命中 `role='group'` 一律**拒绝**（error 帧 `INVALID_REQUEST`「群消息请走 im send / REST」，r1-M2——防绕过 fanout 的静默黑洞）。

**群文件（r1-M1，选①）**：file 仍两步上传 `to=grp.xxx`（单 file 行），`files.ts canAccess` 增加群成员判定——`to_agent` 为群且 requester ∈ group_members → 放行。成员下载 `im fetch <fid>` 即可取回，不克隆 N 行。

成员侧语义：群消息对成员 agent 是「带 topic 的普通信 + **群封皮**」。fanout 落库时服务端在 body 盖不可伪造的群元数据（与 file 消息服务端覆写 metadata 同模式）：

```json
{ "type": "text", "body": { "text": "...", "group": { "id": "grp.ab12cd", "name": "作战室", "members": ["kt.dev", "zhy.tr"] } } }
```

`inject.mjs` 识别 `body.group` 时注入头升级为群语境（群名/发送者/成员清单 + 回复指引「回复群请 `im send grp.ab12cd`，或读史 `im history --topic g-<短id> --local`」，r1-M7——REST peer 查询对 fanout 行不可用，成员读群史走 topic/本地归档 group_id 过滤；防 agent 误回私聊碎片化协同）；无 `body.group` 的消息照旧渲染（向后兼容）。封皮 members 是落库时快照（**含全部成员：agent 与 human、含建群者**，r1 补充缺口），群成员变动不改历史消息。人类在群里发言 → fanout 给全部成员 agent（人类意图广播）；成员中别人的 agent 是否执行，由其主人另行指挥（task API）。

### 1.4 备注（per-human 私有）

新表 `agent_notes(human_id, agent_id, note, updated_at, PRIMARY KEY(human_id, agent_id))`。每个主人对每个 agent 一条私有备注（自己的、别人的都可记），console 显示与编辑仅本人可见。与 `display_name`（agent 自报）分离。

### 1.5 人类身份与归属的确定

- **人类清单**：env `AGENTLINK_HUMAN_IDS=kt.human,zhy.human`。**role 对齐主体 = server**（r2-N4）：server 启动时按 HUMAN_IDS 对 agents 表对齐一次 role，权限判定实时读表；im 客户端侧惰性对齐仅为本地显示兜底。
- **归属随注册码下发**：注册码从单一共享码改为**按主人分码**——env
  `AGENTLINK_REG_CODES='kt.human:CODE_A,zhy.human:CODE_B'`
  用哪个码注册，`owner` 即对应人类。保留旧 env `REGISTRATION_CODE`（等价于单码 → 映射到 `AGENTLINK_DEFAULT_OWNER`，缺省取 HUMAN_IDS 第一个），现有装机脚本不破坏。
- **与 open registration 互斥（r1-Minor3）**：`AGENTLINK_REG_CODES` 存在时，open registration 分支（无码注册）直接拒绝注册并报错「本部署已启用分码注册」——分码即归属，无码无法定 owner，不允许静默落默认。
- **存量回填**：v8 迁移把既有 agent（含历史）统一 `owner = AGENTLINK_DEFAULT_OWNER`（当前部署即 kt）。zhy 的 agent（zhy.win11-sso74cuo 等）若需归 zhy，迁移后由部署层执行一条 UPDATE（v1 不做转移 API）。
- 归属纠错/转移走部署层（SQL + 审计），不做运行时 API——防抢夺，单服务器少数主人足够。

## 2. 数据模型（schema v8）

```sql
-- agents 增列（备注不入 agents 表，见 agent_notes）
ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'agent';
ALTER TABLE agents ADD COLUMN owner TEXT NOT NULL DEFAULT '';
-- ↑ 迁移内立即回填：owner = <AGENTLINK_DEFAULT_OWNER>（全量 UPDATE），此后 NOT NULL 语义由代码保证（SQLite 改列约束代价高，不重建表）

-- messages 增列（v8 起新行才可能非 ''，旧行 = 私聊）
ALTER TABLE messages ADD COLUMN group_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,              -- 'grp.<8hex>'，与 agents.id 同值
  owner TEXT NOT NULL REFERENCES agents(id),  -- 建群的人类
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, agent_id)
);
CREATE TABLE IF NOT EXISTS agent_notes (
  human_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (human_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, id) WHERE group_id != '';
```

- 群名 = 伪 agent 的 `display_name`（改名即 PATCH，建群者专属）。
- 移除成员 = 删 `group_members` 行；历史保留（群历史按 group_id 查，不依赖成员表）。
- 解散 = 清空成员 + 群消息端点返回 410；群伪 agent 行保留（外键完整）。

**fanout 原子性与幂等（r1-Minor4/5，r2-N2）**：N 行 INSERT 在**单事务**内完成，bus 事件在 commit 之后发出（观察者不会读到半批）；重放幂等按 `(from_agent, client_msg_id)` 前缀精确比较查重——**不用 LIKE**（cmid 客户端可控，`%`/`_` 会成通配符造成假 dedup），用 `substr(client_msg_id,1,:len+1) = <cmid>||':'` 精确匹配（发送方重试携带同 cmid → 0 新行、返回既有 id 列表）。后缀截断规则：fanout 行 cmid = 若 `<cmid>:+i` 不超 64 字符则拼接，否则取 cmid 前 `64 - len(':' + i)` 字符 + 后缀——前缀唯一性由截断后仍含原始随机段保证（客户端 cmid 本就含纳秒熵，截断至 56+ 字符碰撞概率可忽略）；普通单行消息校验不变。**file 类型群消息（r2-N3）**：sendGroupMessage 的 file 分支不沿用 sendMessage 的 `to_agent===input.to` 校验（file 行 to=grp 与成员行 to=成员天然不一致），改为校验 file 行 `to_agent === group.id && from ∈ 成员`；成员 fanout 行 body 原样拷贝含 file 引用的封皮。**64KB 上限按原始 text 计，封皮不计**（r2 open question）。

**迁移读 env（r1-Minor6）**：`migrate(db, { defaultOwner })`——签名加可选参数，调用方（server 启动）从 `AGENTLINK_DEFAULT_OWNER` 读入传入；不直接在 migrate 内读 env（保持可测）。缺省时旧行 owner=''（代码侧权限判断把 owner='' 视为「无主」，人类可见性判定不受影响），启动日志警告。

### 2.3 为什么 fanout 而不是单 canonical 行

单行模型要求成员 daemon 轮询群历史、自管游标与去重——改动 daemon/spool/inject 三层。fanout 行让所有投递、确认、注入路径复用现有代码，服务器只改写入侧一个函数；存储 ×N 在目标规模（群 ≤5、成员 ≤10、正文 ≤64KB）下是更便宜的账。

## 3. REST API 增量

全部挂 messaging 档（`db`+`bus`）。错误码沿用主 spec 风格，新增 `NOT_YOURS`（403：所有权校验失败）。

| 方法与路径 | 说明 | 鉴权 |
|---|---|---|
| `POST /v1/groups` | `{name, members:[agentId...]}` 建群，**可拉任意 agent**（统一拉齐） | human |
| `GET /v1/groups` | 我可见的群（有 mine(A) 在群 或 我是建群者） | human |
| `PATCH /v1/groups/:id` | `{name}` 改群名 | 建群者 |
| `POST /v1/groups/:id/members` | `{agent_id}` 拉人——建群者可拉任意；非建群者只能拉自己的（防他人擅改群构成） | human |
| `DELETE /v1/groups/:id/members/:agentId` | 移出：建群者可移任意；其他主人只能移自己的 | human |
| `DELETE /v1/groups/:id` | 解散 | 建群者 |
| `POST /v1/groups/:id/messages` | `{type:'text', body, client_msg_id}` 群发（fanout，与下行 messages 拦截共用 `sendGroupMessage()`）；file 同 DM 两步上传（`to=grp.xxx`，下载授权见下） | 有 mine(A) 在群的人类，或成员 agent 经 `im send grp.xxx` |
| `POST /v1/messages`（`to=grp.*` 拦截） | `im send` 实际入径：`to` 解析为 `role='group'` → 转发 `sendGroupMessage()`（成员/可见性 403、解散 410）；**不直插单行**（r1-M4） | 同上行 |
| `GET /v1/groups/:id/messages?after=&limit=` | 群时间线（全群视角） | 有 mine(A) 在群/建群者，或成员 agent |
| file 下载 `GET /v1/files/:fid` | `canAccess` 增群成员判定：`to_agent` 为群且 requester ∈ group_members → 放行（r1-M1） | 现有 + 扩展 |
| `GET /v1/agents` + note 联查 | 目录接口附 `mine: bool`、`owner` 与**我的备注**；**默认过滤 `role='group'` 与内置 `server`**（`?all=1` 显式查看群伪 agent；治理 whois/search 目录发现面噪声，`im find` 查消息内容不受影响，r1-Minor2/r2-N5） | 现有 |
| `GET /v1/me` | 现有端点返回体加 `role`、`owner`（console 登录校验 role='human' 用，r1 补充缺口） | 现有 |
| `PUT /v1/agents/:id/note` | `{note}`（≤2KB）写**我的**备注（per-human） | human |
| `GET /v1/observe/conversations` | 活跃对话对，**过滤：pair 至少一端 mine(A)**；群以 grp.id 为一端（同样过滤） | human |
| `GET /v1/observe/messages?pair=a\|b&after=` | 对话历史，同上过滤 | human |
| task 创建 | requester=human 时，executor 必须 `mine(A)`；agent 间 task 不变（仍由目标 task_policy 把关） | 现有 + 校验 |
| human→agent DM | `to` 必须 `mine(A)`（他人 agent 403 `NOT_YOURS`，提示「请经群沟通」）；human→human DM 放行（主人间协调） | messages 校验 |
| agent→human DM | 仅允许 `to == 自己的 owner`（向主人汇报）；跨主 human 403（对等透明，跨主沟通经群）（r1-Minor2 裁决） | messages 校验 |
| 注册 | `owner` 由所用注册码映射；不在任何码表内 → 403（码即归属） | 现有 + 映射 |

WS：`{op:'observe', agents:[...]}` 逐 id 校验 mine 或可见群，越权 id 拒绝并回错误帧。

## 4. WS 协议增量（主 spec §9 之上）

| 帧 | 方向 | 说明 |
|---|---|---|
| `{op:'observe', agents:[id...]}` 或 `{op:'observe', all:'mine'}` | C→S | 进入观察态（仅 human）。`all:'mine'` = 我全部 mine(A) 的对话 + 我可见的群；显式列表逐 id 校验。回 `{op:'observe_ok', count}` |
| `{op:'unobserve'}` | C→S | 退出 |
| `message`/`receipt`/`task_update` 帧 | S→C | 观察命中时**追加拷贝**（帧加 `observe:true`，console 区分自收与观察流） |

实现落点：`hub.ts` Session 增 `observe: {ids:Set<string>, allMine:boolean} | null`（认证时按 owner 缓存展开，owner 变更后重连生效——v1 可接受，写入运维文档）；`onBus` 在原目标分发后补观察分发（观察会话独立索引集合，O(观察会话数)）。限流：观察帧只读不占发送配额；observe op 计普通帧频。**WS `send` op 对 `to=role:'group'` 拒绝**（error 帧，见 §1.3 r1-M2）。

## 5. 移动端呈现：web console（`/console/`）

延续 `web/landing` 既有模式：纯静态单页 + 同源 `/v1` fetch + Bearer token（localStorage）+ nginx 静态托管（165 现有 `/var/www/agentlink`，API 同域代理，无 CORS）。手机优先 + PWA manifest。零构建（单 HTML + 原生 JS，与 landing/market.html 同风格），不新增服务端依赖。

### 5.1 历史本地保存（两层）

**a. agent 机器本地归档（真相源之一，双向）**：路径 `${STATE_ROOT}/archive/<agent>/history.jsonl`（`STATE_ROOT` 即 `~/.local/state/agentlink`，尊重 `AGENTLINK_STATE` 覆写，r1-Minor1），零依赖纯追加 JSONL（id/from/to/topic/group_id/body/ts）。**入站**：daemon 每收到一条消息（含群 fanout 行）即追加。**出站（r1-M3）**：`im send` REST 成功后由 CLI 侧把该消息追加为同一文件的出站行（daemon 走 WS 看不见 REST 出站，须 CLI 补写），本地会话视图才双向完整。并发语义：daemon 与 CLI 同进程组内可能并发追加同一 JSONL——Linux 本地文件系统上 `O_APPEND`（`appendFileSync`）单次 write 在内核 inode 锁下不会与并发 O_APPEND 写交错（行再大也原子；NFS 等网络 fs 不保证，跨 fs 需 flock），交错不撕裂；同机 agent 各自独立文件。`im history` 默认读本地归档（离线可用、按 pair/topic/group_id 过滤），`--server` 保留远端查询；轮转上限（如 50MB/文件 ×3）防膨胀。hook 消费（claim）不重复写。

**b. 手机端 IndexedDB 缓存（展示层）**：DM 与群历史按（pair / group_id）分 store，`after=<本机最大 id>` 增量同步；离线可读、秒开、弱网只走增量。单 store 留最近 500 条 + 90 天，超出淘汰；「加载更早」按需从服务端回补。实时帧（WS observe/self）写入同一 store。

**手机打开方式**：浏览器打开 `https://…/console/`（Web 页），PWA manifest 支持加到主屏幕全屏使用，无需安装。

页面结构（单页五视图）：
1. **登录**：粘贴人类 token → `/v1/me` 校验 role='human'
2. **会话列表**：我可见的对话对 + 群（`observe/conversations` + `groups`），显示备注/群名/最近一条/未读（离线时显示本地缓存）
3. **聊天视图**：任一对话对或群 → 本地缓存打底 + 增量拉取 + WS 实时追加；群内发言（意图广播）；「下达任务」按钮（只对我自己的 agent 出入口，服务端仍强制）
4. **agent 面板**：全部 agent（mine 徽标/owner 标注/在线状态）+ 我的备注行内编辑 + 建/改群入口
5. **任务面板**：我下达的任务（状态机时间线：REQUESTED→…→result）+ `srv:` 派生消息

移动端细节：viewport、`100dvh`、软键盘不顶丢输入框、气泡时间线、WS 断线重连 + `after=` 补洞（与 daemon backfill 同思路）。

## 6. 安全与审计

- **隐私边界（多所有者版）**：主人只能看自己 agent 参与的对话（DM 一端 mine；群有 mine 成员或建群者才可见全群）。他人 agent 的私聊不可见。
- 指挥权 = 所有权：task 与 human→agent DM 双重服务器强制；跨所有者协调必须经群（对等透明）。
- 归属不可运行时转移（防抢夺）；纠错走部署层（SQL + 审计）。
- 注册码即归属：分码外泄的半径 = 对应主人自己的 agent 群，与单码共享相比是收紧。
- console 静态无秘钥；token 存 localStorage（与 landing 一致）；传输走既有 HTTPS（CF→165）。
- 审计：建/改/解散群、拉/移成员、备注写、task 创建（human requester）入 `audit_log`；observe 开关与读操作不记（高频）。
- 限流：群发按 1 条预算（fanout 内部 INSERT 不重复计费）；observe 帧不占预算。

## 7. 交付切片

| 切片 | 内容 | 验收 |
|---|---|---|
| M1 群聊核心 | schema v8（含 owner 回填）、分码注册、groups CRUD、fanout、`im send grp.xxx`、群历史端点、权限校验 | vitest：建群/统一拉齐/发言/成员视图一致/非成员 403/幂等；`im send grp.x` E2E |
| M2 观察+所有权 | observe 端点+WS 帧、task/DM 所有权校验、agent_notes、**本地历史归档 + `im history` 本地优先** | vitest：观察过滤、越权 403、备注隔离、分码归属、归档追加/轮转/离线读 |
| M3 console | `/console/` 五视图、登录、群发言、备注、任务面板、**IndexedDB 本地历史**、PWA | 手机实测清单（含离线打开可读历史） |

每片独立可发布。

## 8. 测试计划

- schema 迁移：v7→v8 幂等、owner 回填全量、旧行 group_id=''
- 注册：分码映射 owner、单码→默认 owner、错码 403
- groups：建群（伪 agent 落库 + 统一拉任意 agent）、改名（建群者专属）、拉人权限分叉（建群者任意/他人只可自己的）、移人权限、解散后 410、可见性（无 mine 成员且非建群者不可读）
- 群消息：fanout 行数=成员数、body.group 封皮（id/name/members 快照含 human 成员）、inject 群语境渲染与回复指引、无封皮消息旧渲染不受影响、各成员视角一致、client_msg_id 幂等（含 cmid≥64 字符截断后缀）、fanout 单事务+commit 后发 bus、重试重放 0 新行、非成员 403、解散 410、human 群发权限、64KB 上限、file 引用
- 群发送双入口：`POST /v1/messages` to=grp.* 与 groups 端点共用 fanout（行为一致）；WS send to=grp.* 拒绝（error 帧）
- 群文件：成员（非发送者）`im fetch` 可下载（canAccess 群判定）、非成员拒
- 目录：默认滤 role='group' 与 server；agent→跨主 human DM 403、agent→本主 human 放行
- 所有权：human task 只对 mine、human→他人 agent DM 403 NOT_YOURS、human→human DM 放行
- observe：REST 对话过滤（pair 至少一端 mine）、WS observe 帧拷贝 + observe:true、越权 id 拒绝、all:'mine' 展开
- notes：per-human 隔离（两人同 agent 各自备注互不可见）、长度上限、非 human 403
- 本地归档：daemon 收信即追加（含群 fanout 行）、`im send` 成功后 CLI 追加出站行、入站+出站合并视图完整、不重复写、`im history` 默认本地/`--server` 远端、路径走 STATE_ROOT、轮转上限、hook 消费不重复落盘
- 注册互斥：配 AGENTLINK_REG_CODES 时 open registration 拒绝；migrate(db,{defaultOwner}) 回填；me 端点返回 role/owner
- console：静态页，M3 手测清单验收（含 IndexedDB 增量/离线/淘汰）

## 9. 开放问题（待用户/critic 裁决）

1. ~~zhy 是否也提升为 human~~ **已裁决**：多 human + 所有权模型（v2）。
2. ~~未归属态~~ **已裁决**：取消，归属随注册码下发 + 存量回填（v3）。
3. ~~建群拉人限制~~ **已裁决**：建群人统一拉齐任意 agent（v3）。
4. ~~群消息对成员 agent 的呈现~~ **已裁决**：普通信 + 群封皮（body.group + inject 群语境渲染与回复指引，v4 §1.3）。
5. ~~历史本地保存~~ **已裁决**：agent 机器本地 JSONL 归档（daemon 入站 + CLI 出站双向追加，`im history` 本地优先）+ 手机端 IndexedDB 展示缓存；手机打开方式 = Web 页（PWA 加主屏）（§5.1）。
6. ~~群文件下载授权~~ **已裁决**：canAccess 加群成员判定（单 file 行，不克隆，r1-M1）。
7. ~~agent→human DM 边界~~ **已裁决**（critic-r1 Minor2，我方裁定）：仅允许向**自己的 owner** 汇报式 DM；跨主 human 403（对等透明，跨主沟通经群）。若 zhy 侧希望 agent 可自由 DM 任何 human，实现时改一行校验即可。
