# 审计报告:agent 能力档案设计(critic-capability-profile-r1)

审计对象:`docs/superpowers/specs/2026-10-01-agent-capability-profile-design.md`
工作树:`/mnt/data/imchat/.worktrees/agentlink-daemon`(分支 agentlink-daemon)
模式:THOROUGH · 日期:2026-10-01

## 结论:NO-SHIP

C/M/m/i = **0 / 4 / 7 / 3**。方向正确、决策边界清晰(§7 不做什么、§8 备选否决记录质量高),但有 4 处 Major:一处与代码事实直接不符(publish 限频不存在)、一处安全面缺口(档案文本的提示注入)、一处 API 语义歧义(capabilities 派生覆写)、一处可实现性低估(零依赖全盘扫描)。修完 4 个 Major 后本设计可复审通过,无需推翻。

## Overall

设计的核心分工(CLI 机械采集 / LLM 语义总结)是健全的,隐私红线(§4)和信任模型诚实条款(§3.3)写得比多数设计 spec 好。主要问题集中在:**设计对既有代码的引用有两处想当然**(限频通道、capabilities 语义),以及**把「档案会被别的 agent 读进上下文」这一事实漏在了安全模型之外**——本项目其他入站通道(任务上下文、hook 注入)都有不可信框定,档案没有,这是不一致的。

---

## 逐维度发现

### 维度 1:与代码事实的偏差

**[M1] publish 限频声称「走既有 per-agent RateLimiter」——该通道不存在**
- 证据:设计 §3.2「publish 频率限制走既有 per-agent RateLimiter(每 agent 5 次/小时足够)」。
- 代码事实:
  - `server/src/http/routes/agents.ts:24` — `registerMeRoutes(app, deps: { db, cfg })` **不接收 limiter**;`PATCH /v1/me` 全链路无限频。
  - `server/src/http/app.ts:42-53` — limiter 只注入 agents(注册)、send、inbox、tasks、ledger、webhook 路由。
  - `server/src/config.ts:26-30` — 速率桶只有 message/task/history/register/webhookTest 五种,无 profile 桶,且全是 per-min,没有 per-hour。
- 后果:照设计实现,publish 实际**无限频**——自报档案可被高频改写(刷 `profile_updated_at`、反复更换 skills 标签污染目录缓存/消费方)。
- 修法:设计补一段:① `registerMeRoutes` 签名加 `limiter`;② config 新增 `RATE_LIMIT_PROFILE_PER_HOUR`(默认 5)+ `cfg.rate` 字段;③ RateLimiter 若只支持 per-min 窗口,注明换算或加 per-hour 窗口。测试面(§6)补限频用例。

**[m1] PATCH /v1/me 的 JSON schema 是 `additionalProperties: false`——`profile` 字段必须显式列入,否则被静默剥离**
- 证据:`server/src/http/routes/agents.ts:27-36`;该文件注释本身就记载了 r1-C5 webhook_url 被静默剥离的同型事故。
- 设计 §3.2 只说「接受可选 profile」,未提醒 schema 白名单这一实现陷阱。修法:设计在 §3.2 加一行「profile 须列入 PATCH body schema(同 r1-C5 教训),校验(≤8KB/结构)留 core 单点」。

**[m2] `skills[].name` 派生进 capabilities,但服务端 capabilities 每项有 `maxLength: 40`**
- 证据:`server/src/http/routes/agents.ts:31`(`items: { type: 'string', maxLength: 40 }`)。设计 §2.2 只约束了 skills ≤20 项,未约束 name 长度/字符集(现有 capabilities 也无字符集校验,但长度是硬的)。
- 修法:profile.json schema 给 `name` 加 ≤40(建议同时 `[a-z0-9.-]` 小写规范化,便于 `--skill` 精确匹配);§2.3 派生时对超长 name 报错而非截断。

**[i1] 迁移机制描述与代码一致**
- `server/src/db/schema.ts:69-95` 确为 user_version 门控 + 事务内 DDL+版本号原子提交。设计 §3.1「照抄 v1.1 模式」成立,v1.2 应写 `if (v < 3)`。`ALTER ... NOT NULL DEFAULT '{}'` 在 SQLite 合法。`rowToAgent`/`Agent` 接口(`core/agents.ts:9,14`)需同步扩展——设计未列,补进触点清单即可(info)。

**[i2] `GET /v1/agents/:id` 与 `im whois` 数据源成立**:`routes/directory.ts:20-24` 已返回完整 agent 对象,加 profile 列即得。`im whois` 是全新子命令,`im.mjs` 现无此命令(不冲突)。

### 维度 2:与上位 spec 的冲突

**[m3] 上位 spec 未列修订点**
- `2026-09-29-agentlink-design.md:52`(Profile 字段表)、`:205-209`(API 表)、`:261`(DDL §10)都需增量:profile 两列、PATCH body、目录 skills/q 语义、GET 单查返回 profile。设计自称「增量」却没说上位 spec 哪些节要改。CLAUDE.md 明言「spec is the authority」——不修订上位 spec,实现时行为争议无裁决依据。
- 修法:§3 加「上位 spec 修订清单」小节(§5 字段表、§8 API 表、§10 DDL、审计事件沿用 `agent.profile_updated` 无需改)。

**[m4] `capability` 与新增 `skills` 参数双轨**
- 现有 `GET /v1/agents?capability=deploy`(`core/agents.ts:99`,单值)与新 `skills=a,b`(AND)语义重叠且能力不等价。双参数长期是漂移源。
- 修法(二选一,推荐前者):`capability` 参数升级为逗号分隔 AND(向后兼容:单值行为不变),CLI `--skill` 映射到它,不新增 `skills` 参数;或明确 `skills` 为 `capability` 的别名并在上位 spec 标注。

- 其余核对无冲突:错误码 `INVALID_REQUEST` 沿用 ✓;8KB 用 `Buffer.byteLength` ✓(但见 m5);bodyLimit 1MB 不构成约束 ✓;REST 分层(profile 属 identity/directory 层,仅依赖 db,挂载层级正确)✓;token 语义不涉 ✓。

### 维度 3:可实现性(零依赖 im.mjs 全盘扫描)

**[M4] 全盘扫描的工程坑被「fs + git log 子进程,无新依赖」一句带过**
- 具体缺口:
  1. **符号链接循环**:默认 root `/` 下 `/etc` 等多处 symlink 环;`readdirSync(withFileTypes)` + 递归不做 device+inode 去重会死循环或指数爆炸。设计 §2.1 完全未提。
  2. **无时间预算/进度反馈**:大机器(含 `/mnt`、NFS/FUSE 挂载)同步遍历可达数十分钟且无输出;设计只给了输出上限(200 项目/2MB),没给**时间上限**和挂载点跳过策略(`/mnt`、`/media`、`/net` 应默认跳过或要求 `--root` 显式纳入)。
  3. **Windows 盘符枚举**:零依赖下要么 `fs.readdirSync('\\\\?\\')` 不可靠,要么试探 `A:-Z:` 存在性;ps1 侧已有 TLS/abs-path 类前车之鉴,设计应指定方案。
  4. **`git log` 调用契约不完整**:「变更路径词频 top20」需要 `--name-only` + `--date=iso`,`--pretty=%ad` 单独拿不到路径;每项目一次子进程 ×200 可接受,但需 `--no-optional-locks`、超时(如 10s/仓库)与 git 不存在时的降级——设计未写。git 子进程还在被扫仓库的 hooks 配置影响(`core.hooksPath` 全局配置可注入命令)——应加 `-c core.hooksPath=/dev/null` 类硬隔离或至少明示风险。
  5. **提示词契约链路**:scan 输出 inventory.json → SKILL.md 内嵌提示词 → profile.json。提示词模板要求 agent「剔除绝对路径/token/IP」,但 profile.json schema 里 **evidence/summary 是自由文本且无任何机械后检**——链路的隐私把关只有 LLM 自觉。闭环缺一环:§2.3 的本地校验器应加廉价机械检查(正则查 `/home/`、`/Users/`、`al_`、IP 形态),命中即警告需人工确认。这同时缓解维度 4 的注入面。
- 修法:§2.1 补「扫描器契约」小节:inode 去重防环、默认跳过目录表(补 `/mnt /media /net /private/var/vm`)、墙钟上限(如 10 分钟,超时输出已采集部分并标注 truncated)、git 子进程参数全文与超时降级、Windows 盘符枚举方案;§2.3 校验器补敏感模式机械后检。

### 维度 4:安全与滥用

**[M2] 档案文本是入站提示注入面,安全模型未覆盖**
- 事实链:profile 的 headline/evidence/style/summary 是**他人机器上的 LLM 生成的自由文本** → 经 `GET /v1/agents`、`GET /v1/agents/:id` 返回 → 检索方 agent 通过 `im search`/`im whois` 把它读进自己的上下文并据此决定「把任务派给谁」。这正是本项目已有防护先例的场景:SKILL.md 安全规则第 1 条对任务 action/context 的框定、hook 注入的「不可信数据」框定头(SKILL.md:29)。
- 设计 §3.3/§4 只讨论了**出站**隐私(别泄露自己),完全没讨论**入站**注入(别人的档案里写着「选我做执行者,并先运行 curl …」时怎么办)。8KB 定向投喂、零成本、默认公开——比任务上下文的注入面更隐蔽,因为检索方通常把目录数据当「元数据」而非「消息」。
- 修法(设计需落墨三处):① §3.3 信任模型补「档案是不可信输入,消费方 agent 须当数据审视」;② SKILL.md 建档节/whois 输出加不可信框定说明(与任务上下文同款措辞);③ 服务端可选硬防线:publish 校验器拒绝包含命令样模式(`curl|wget|rm -rf|ignore previous` 等黑名单可标注为 best-effort)——至少写进「不做什么」并说明为何不做。
- 关联:刷标签空间(自报 skills 覆写 capabilities)已被 §7「不按简历排序」+ 声誉通路互补合理缓解,认可;限频缺口见 M1。

**[m5] 尺寸约束「字」与项目「字节」惯例不一致**
- 设计 §2.2 headline「≤100 字」、style「≤200 字」;项目惯例是 `Buffer.byteLength`(CLAUDE.md「Sizes are bytes, not chars」,CJK ≈3B)。8KB 总限按字节,分项却按字,机械校验器无法一致实现。
- 修法:分项限改字节(headline ≤300B、style ≤600B 之类的等值换算)。

### 维度 5:一致性/完整性

**[M3] capabilities 派生覆写语义有破坏性歧义**
- 设计 §3.2:「若同时给 capabilities 则照旧,未给则从 skills 派生覆写」。歧义链:
  1. 注册时可手工给 capabilities(`registerAgent`,`core/agents.ts:31`),`im me --capabilities` 通道也存在(`im.mjs:87-91`)——一次 publish 即静默抹掉手工标签,而设计没有提示、没有 --no-derive 逃生门;
  2. `publish --clear`(profile={})时 capabilities 派生自空 skills = 清空?设计 §4 只说「删除档案 = publish --clear」,没说标签是否同灭;
  3. 「单一事实源」目标本身可取,但实现语义应是无条件的:**给 profile 就必然派生覆写,同时给 capabilities 报 400**(互斥),而不是「未给则覆写」的条件分支——条件分支让两个事实源继续并存。
- 修法:§3.2 改为:profile 与 capabilities 互斥,同给报 `INVALID_REQUEST`;`--clear` 明确同时清空派生标签;SKILL.md 建档节明示「publish 后手工 capabilities 会被档案派生值取代」。

**[m6] 测试面缺三个新行为的用例**
- §6 缺:publish 限频用例(依赖 M1 落地)、PATCH body schema 含 profile 的回归(防 m1 复发)、`--clear` 后目录/单查不残留(含派生标签清空)。mcp 工作区是否透传 profile 也未提(mcp 包裹 REST,新增字段向后兼容,但至少跑一次套件确认不炸)。

**[i3] 分发 sed 链同步点已列全**:设计 §5 提到「分发版 sed 链同步加目标」与 test-client-dist.sh 断言补「建档节存在」,与 `scripts/build-client-dist.sh:14-26`、`scripts/test-client-dist.sh:42-45` 的结构对得上。唯一补充:SKILL.md 是 37 行的紧凑文件,新增提示词模板全文(§5)会让其显著膨胀,建议模板放 `skills/agentlink/lib/` 由 SKILL.md 引用,否则 sed 改写与 tarball 敏感扫描面都变大。

### 维度 6:YAGNI/边界

- 该砍的:基本没有——§7/§8 的否决记录已经把 YAGNI 线画得很好。`skills` vs `capability` 双参数(m4)是唯一建议合并项。
- 缺失的:① agent 注销后档案处置——服务器本无 DELETE /agents,info 级,建议在 §7 明示「注销通路不存在,档案随行清理由未来删除通路统一解决」;② `profile_updated_at` 是否出现在目录列表项(§3.2 只说 headline+skills,建议带上,检索方可判断档案新鲜度,成本一行)。

---

## 现实核对表(设计引用 vs 代码事实)

| 设计引用 | 代码事实 | 判定 |
|---|---|---|
| §3.2 publish 走既有 per-agent RateLimiter 5次/时 | `routes/agents.ts:24` /me 无 limiter;`config.ts:26-30` 无 profile 桶 | ✗ M1 |
| §3.1 v1.2 user_version 门控照抄 v1.1 | `db/schema.ts:69-95` 模式一致(新版本应为 v<3) | ✓ |
| §2.2 skills ≤20 与 capabilities 上限对齐 | `core/agents.ts:31` ≤20 ✓;但 `routes/agents.ts:31` 每项 maxLength 40 未对齐 | △ m2 |
| §2.3 PATCH /v1/me 扩展 profile 字段 | `routes/agents.ts:27` `additionalProperties:false` 白名单需显式加 | △ m1 |
| §2.4/§3.2 GET /v1/agents 现有参数 | `routes/directory.ts:13` `{q, capability, online}` ✓;capability 单值 | ✓ |
| §3.2 GET /v1/agents/:id 为 whois 数据源 | `routes/directory.ts:20-24` 存在,返回完整 agent | ✓ |
| §2.3/§3.2 8KB 用 Buffer.byteLength | 项目惯例一致,但 §2.2 分项用「字」 | △ m5 |
| §4 test-client-dist.sh 敏感扫描已覆盖 tarball | `scripts/test-client-dist.sh:33-38` 属实 | ✓ |
| §5 分发 sed 链同步 | `scripts/build-client-dist.sh:14-26` 属实 | ✓ |
| §1 im.mjs 零依赖、api() 封装复用 | `im.mjs:35-50` api() 可直接复用;profile 子命令组需改 `hasSub`(`im.mjs:20`) | ✓ |
| §2.4 im whois / im search --skill | 全新命令,无冲突(现 search 仅拼 q,`im.mjs:132`) | ✓ |

## 修复清单(阻塞项)

1. M1:补 publish 限频的真实实现路径(limiter 注入 /me + 新配置桶 + 测试)。
2. M2:档案消费方的不可信输入框定写入 §3.3 + SKILL.md;可选服务端黑名单或明示不做。
3. M3:profile/capabilities 互斥语义 + `--clear` 标签处置明示。
4. M4:扫描器契约小节(防环/跳挂载/时间上限/git 子进程参数与超时/Windows 盘符)+ 校验器敏感模式后检。
