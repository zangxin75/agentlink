# 审计报告:能力档案实施计划 r1(critic-profile-plan-r1)

审计对象:`docs/superpowers/plans/2026-10-01-agent-capability-profile.md`
实现 spec:`docs/superpowers/specs/2026-10-01-agent-capability-profile-design.md`(r2 SHIP)
模式:THOROUGH(逐字对账断言串与实现代码/真实源码触点)· 日期:2026-10-01

## 结论:NO-SHIP

C/M/m/i = **0 / 1 / 7 / 3**。计划总体质量高:触点引用准确(行号、签名、sed 目标、装配点全部对上),TDD 结构完整,spec 覆盖自审属实。但存在 1 个会丢数据的计划内缺陷(Windows 多盘 scan 互相覆盖 inventory.json)和 7 个 minor(其中 Review Focus 两条的「后半句」没有测试钉住)。修完 M1 + m2/m3(测试缺口)即可复审通过,其余 minor 可随手带。

---

## ① 计划代码块与仓库真实触点吻合度(逐项核验)

| 计划引用 | 代码事实 | 判定 |
|---|---|---|
| T1: schema.ts v1.1 块 `70-95`,`if (v<3)` 照抄 | `db/schema.ts:69-95` 结构一致;`v` 开头单次读取、两块互斥的说明正确 | ✓ |
| T1: `Agent` 接口(line 9)/`rowToAgent`(14-16) | `core/agents.ts:9,14-16` 行号与内容一致;registerAgent INSERT 不动(profile 吃 DEFAULT)正确 | ✓ |
| T1: 参照 `migration-v2.test.ts` 形态、`loadConfig({REGISTRATION_CODE:'x'})` | `server/test/migration-v2.test.ts` 存在;`config.ts:16` `loadConfig(env)` 签名匹配 | ✓ |
| T2: `updateProfile` 顺序(互斥→getAgent→…→webhook 块→`if(!sets.length)` return) | `core/agents.ts:54-77` 顺序一致;profile 分支放 webhook 块之前、保证 `profile={}` 时 sets 非空的注意事项正确且必要 | ✓ |
| T3: `registerMeRoutes` 现签名 `{db,cfg}`、`app.ts:44` 装配点 | `routes/agents.ts:24`、`app.ts:44`(`registerMeRoutes(app, { db: deps.db, cfg: deps.cfg })`)行号与内容准确;`limiter` 在 `app.ts:42` 已在作用域内,注入可行 | ✓ |
| T3: `Errors.rateLimited(retryAfterS)` → 429 | `http/errors.ts:14` 签名一致 | ✓ |
| T3: config rate 类型加 `profilePerHour` | `config.ts:11` rate 类型 + `:24-30` loadConfig 块,计划改动点吻合 | ✓ |
| T5: `hasSub` 加 `profile` | `im.mjs:20` `hasSub = cmd==='token'||'task'||'webhook'` — 不加则 `im profile scan` 的 sub 会被当业务参数吃掉,计划的改法正确且必要 | ✓ |
| T6: sed 链 `` `bin/im `` 前缀自动改写、无需新增 sed 目标 | `build-client-dist.sh:18` `-e 's#`bin/im #`node ~/.agentlink/client/im.mjs #g'` 属实;`test-client-dist.sh:43` 的「无 bin/im 裸用」断言与该改写配套 | ✓ |
| T6: install.sh 完成语区 `INSTALL_DIR` 变量 | `scripts/install.sh:8,46-47` 变量与完成语位置存在 | ✓ |
| T6: `SK` 变量在 4b 断言处可用 | `test-client-dist.sh:41` `SK="$TMP/agentlink/SKILL.md"`,路径前缀 `$TMP/agentlink/` 与计划一致 | ✓ |

触点核对无一处错引。

## ② T2「capabilities 双落库」段自洽性

**判定:逻辑自洽,无双落库;但写法有缺陷。** 逐支分析:
- profile+capabilities 同给 → 函数开头 400,落不到 sets 拼接;
- 仅 profile → 既有 `if (patch.capabilities !== undefined)`(agents.ts:59)不触发,由计划新增的条件块补写 capabilities 列——**恰好单次写入**;
- 仅 capabilities → profile 分支不进,走既有行。

缺陷:第 333 行 `if (patch.profile !== undefined && patch.capabilities === undefined)` 的 `&& patch.capabilities === undefined` 是**死条件**(互斥检查已排除同给),且与第 329-330 行的 profile 两列 push 分成两段、中间夹注释「上面已 push 两列,这里再 push」——执行者照抄极易拼出顺序混乱或重复 push。

**确切修法**(一段替两段,放既有 for 循环后):
```ts
if (patch.profile !== undefined) {
  sets.push('profile=?', 'profile_updated_at=?', 'capabilities=?')
  vals.push(JSON.stringify(profileNorm), new Date().toISOString(), JSON.stringify(next.capabilities))
}
```
`next.capabilities` 已在函数前段由 profileNorm 派生,`profile={}` 时为 `[]`,清空语义直达。

## ③ T4 测试未 await(处置判定)

**判定:处置足够,但载体错位。**「实现注意」明确「以本条为准,测试代码里四处 `scan(` 前补 `await`」,计数核实:测试中恰 4 处 `scan({` 调用,指引无歧义。问题在 Step 1 的代码块本身是错的——逐字粘贴的执行者会在实现完成后仍得到 TypeError(`r.truncated` on Promise),与「测试通过」步骤冲突,靠文末注意才自愈。建议直接把测试代码块里的 4 处改对,删掉口头修正(见 m6)。

## ④ require$$0dirname 同类问题

`require$$0dirname` 笔误已给修法(✓)。**存在一处同类未处理**:`im profile scan` 的下一步指引用 `import.meta.dirname`(计划 T5 代码块)——该 API 需 Node ≥ 20.11,与计划自述「Node ≥18 globals」及 `im.mjs:2` 头注释「Node 18+」冲突(见 m4)。

## ⑤ Review Focus 五条钉住情况

| # | 声明 | 测试落点 | 判定 |
|---|---|---|---|
| 1 | 8KB/字段超限精确报错 | T2(headline 400/实得字节数)+ T5(8KB) | ✓ 钉住 |
| 2 | profile+capabilities 同给 400 | T2 + T3 各一 | ✓ 钉住 |
| 3 | name 大写/超 40B 400 | T2「name 大写」+ T5;超 40B 未单测但同一校验分支,可接受 | ✓(基本) |
| 4 | 第 6 次 429 **+ 跨小时窗口滑出恢复** | T3 只有第 6 次 429;**滑出恢复无测试**(SlidingWindow 直取 `Date.now()`,无时钟注入点,想测也测不了) | ✗ 半句悬空(m2) |
| 5 | 服务端 400 回显 + **客户端不加 --confirm-sensitive 拒发** | T2 黑名单 ✓;T5 只测 validator 的 warnings,**im.mjs 里 warnings&&!confirm 的 die 拒发路径无测试** | ✗ 半句悬空(m3) |

---

## 逐条发现

**[M1] Windows 多盘 scan 相互覆盖 inventory.json(数据丢失)**
- 位置:计划 T5 `profile` scan 分支:`for (const t of targets) { const r = await scan({ root: t, out }) }` — 每个盘符复用**同一个 `out`**,而 T4 的 `scan` 末尾是无条件 `writeFileSync(out, …)` 覆盖写。
- 后果:Windows(本功能明确支持的平台,spec §2.1 专门写了盘符枚举)多盘机器上,只有最后扫描的盘的清单留存,前面盘的项目全丢;且 `agg.projects` 计数与文件内容不一致,静默错误。CI 是 Linux,测不到。
- 修法(二选一):① `scan` 接受 `roots: string[]` 单次调用、内部合并后一次写出(im.mjs 循环删除);② im.mjs 按盘给 `out` 后缀(`inventory-C.json`)再合并。推荐 ①,顺带把 Windows 分支的聚合逻辑收进 lib 便于测试。

**[m1] T4 骨架导出名 `scanSync` 与全链路 `scan` 不一致**
- 骨架 `export function scanSync(...)`,而 Interfaces/测试/T5 im.mjs 全用 `scan`;「实现注意」口头说改成 async `scan`。代码块本身应直接写 `export async function scan`(gitHistory 本就是 Promise,函数体 `await Promise.all` 需 async)。

**[m2] Review Focus #4 后半(窗口滑出恢复)无测试且不可测**
- `SlidingWindow.tryTake` 硬编码 `Date.now()`。修法:构造函数加 `now: () => Date.now()` 可选注入(默认现值),T3 补一条 `now()` 前拨 61 分钟后恢复 200 的测试;或删掉 Review Focus 该半句。推荐前者——滑动窗口的「滑出」正是这个类唯一的行为卖点,不测等于没实现。

**[m3] Review Focus #5 后半(--confirm-sensitive 拒发)无测试**
- T5 测试止于 validator。修法:profile-cli.test.mjs 补一条:子进程跑 `node im.mjs profile publish --file <含敏感串的临时 profile>`,断言非零退出 + stderr 含「confirm-sensitive」(子进程方式与 cli-smoke.test.ts 同款,零依赖约束不破)。

**[m4] `import.meta.dirname` 需 Node ≥ 20.11,与「Node ≥18」自述冲突(require$$0 同类)**
- 修法:改为 `fileURLToPath(new URL('./lib/profile-prompt.md', import.meta.url))`(Node 18 可用);或把计划 Tech Stack 与 im.mjs 头注释的基线统一为 Node ≥ 20.11 并明示。

**[m5] SlidingWindow 是平行机制,既有代码已示范 per-hour**
- `ratelimit.ts:30-31` `checkRegister` 用 `this.check(key, quota, label, 3600)`(TokenBucket 容量=quota、refill=quota/3600)已实现 per-小时限频,且注释记录了「除以 60 容量<1 永远 429」的坑。计划的 `checkProfile` 一行即可:`checkProfile(id) { this.check('profile:'+id, this.rate.profilePerHour, 'profile', 3600) }` — 免新增类、免第二套窗口语义(严格滑窗 vs 令牌连续补充,行为有差但对该场景无关紧要)、免补 Errors import。若坚持严格滑动窗口(语义更贴近 spec「60 分钟内 5 次」),保留 SlidingWindow 亦可,但须配 m2 的时钟注入。

**[m6] T4 Step 1 测试代码块缺 await,靠「实现注意」事后修正**
- 处置本身足够(见③),但建议把代码块改对、删除口头修正——plan 的执行者是逐字粘贴代码块的,错误代码块+分散的修正注是执行偏差的已知来源。

**[m7] test-client-dist.sh 4b 断言首个 grep 是 no-op**
- `grep -q 'profile-prompt' "$TMP/agentlink/lib/profile-prompt.md"` 对文件自身 grep 文件名,恒真、无断言价值;下行 `[ -f … ] && ok || bad` 才是真断言。删掉首行 grep 即可。

**[i1]** ②段自洽、③处置足够 —— 见上文专节。
**[i2]** T2 `searchAgents` 改动与现 `core/agents.ts:97-103` 结构对齐(全表扫 + filter,规模可接受);capability 逗号 AND 的 `split(',').map(trim).filter(Boolean)` 对单值退化正确。
**[i3]** T7 上位 spec 五处修订与 spec §3.4 清单一一对应;mcp「若白名单剥未知字段属预期」的预判合理(增量字段向后兼容)。

## 修复清单(阻塞项)

1. **M1**:scan 多盘聚合重写(roots[] 或按盘 out+合并),消除 Windows 覆盖丢数据。
2. **m2**:SlidingWindow 时钟注入 + 滑出恢复测试(或降级 Review Focus 措辞)。
3. **m3**:--confirm-sensitive 拒发路径的 CLI 子进程测试。
(其余 minor 建议同批顺手修:m1/m4/m6 直接改代码块文本,m5 二选一,m7 删一行。)
