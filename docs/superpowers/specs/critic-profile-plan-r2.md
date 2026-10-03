# 审计报告:能力档案实施计划 r2(critic-profile-plan-r2)

审计对象:`docs/superpowers/plans/2026-10-01-agent-capability-profile.md`(r2,commit d1de343)
对照:r1 审计(`critic-profile-plan-r1.md`,NO-SHIP 0C/1M/7m/3i)
模式:THOROUGH(修订后代码块与测试断言逐字对账)· 日期:2026-10-01

## 结论:NO-SHIP

C/M/m/i = **1 / 0 / 2 / 1**。r1 全部处置已实质落实(M1 多根单写、m1-m7 逐条核验通过,见处置矩阵);但修订在 T5 的 `profile scan` 代码块里**新引入一个 Critical**:`const out = …` 局部变量遮蔽了 im.mjs 的全局输出函数 `out()`,扫描完成后 `out(…)` 会抛 TypeError——照抄即炸。一行改名即修,修后本计划可 SHIP。

---

## r1 处置核验矩阵

| r1 项 | r2 落点 | 逐字核验 | 判定 |
|---|---|---|---|
| **M1** 多盘覆盖 | T4 `scan({roots,…})`:多根共享 `seen`/上限/预算(`for (const root of roots) walk(root)`),库内单次 `writeFileSync`;im.mjs 循环删除、一次传 `roots`(win32 → `windowsDrives()`,否则 `['/']`);T4 新增「多根合并单写」测试 | 骨架 703-708 行与 Interfaces/测试/im.mjs 调用四方签名一致(`roots` 数组、单次写、返回 `{projects,truncated,path}`);合并测试断言 `r.projects===2` 且两项目俱在 | ✓ |
| m1 scanSync 命名 | `export async function scan` | 全链路统一 | ✓ |
| m2 滑出恢复不可测 | `SlidingWindow` 构造器 `now: () => number = Date.now` 注入 + T3 直测 | 测试逻辑手工推演:hits=[t,t],第三拒;t+=3600_000 后 `t-h < windowMs` 为假 → 两条滑出 → 放行 ✓ | ✓ |
| m3 --confirm-sensitive 拒发无测试 | T5 子进程用例(execFile im.mjs,断言非零退出 + stderr 含 confirm-sensitive) | 用例本身正确:die 消息「…加 --confirm-sensitive 重跑」含关键字;die 发生在 api() 之前,无需服务器 | ✓(位置问题见 m1-new) |
| m4 import.meta.dirname | 改 `fileURLToPath(new URL('./lib/profile-prompt.md', import.meta.url))` + 注释说明 Node 18 基线;require$$0dirname 及其修正注一并删除 | Node 18 可用;`node:url` 动态 import 不破零依赖 | ✓ |
| m5 SlidingWindow 保留 | Self-Review #5 记录理由:spec r2 明文「真 60 分钟滑动窗口」为权威 | 接受——语义差异(严格滑窗 vs 令牌连续补充)确实存在,且时钟注入后可测性已补 | ✓ |
| m6 测试缺 await | 测试代码块 5 处 `await scan({…})` 直改;「实现注意」口头修正删除 | 逐字核对:5 个 test 块全部 await | ✓ |
| m7 no-op grep | 4b 断言删去该行,仅留 `[ -f … ]` 真断言 | ✓ | ✓ |

r1 ②③④ 专项复核(非阻塞项):② updateProfile 骨架的两段式 push 与死条件 `&& patch.capabilities === undefined` **原样保留**(互斥 400 使该条件恒真),逻辑仍自洽、无双落库——r1 已给合并单块的修法建议,r2 未采纳,继续作为 minor 记录(m2-new);③ T4 await 问题已消;④ require$$0 之外无新增同类。

## 新发现

**[C1] `profile scan` 代码块:局部 `out` 遮蔽全局输出函数 `out()`(T5,计划 837-840 行)**
```js
const out = flags.out ? resolve(flags.out) : join(config().dir, 'inventory.json')   // ← 遮蔽 im.mjs:53 的 out = (v) => console.log(...)
mkdirSync(config().dir, { recursive: true })
const r = await scan({ roots, out })
out(`inventory 写入 ${r.path}(projects=…)`)   // ← TypeError: out is not a function
```
- im.mjs:53 定义了模块级 `const out = (v) => console.log(…)`;scan 分支内的 `const out` 在函数作用域遮蔽它,扫描完成回显处必然抛 `TypeError: out is not a function`(未捕获,CLI 以非零码崩退;inventory.json 已写出但用户看到的是崩溃)。
- 修法:局部变量改名 `outPath`(三行同步:`const outPath = …`、`scan({ roots, out: outPath })`、回显行不动)。注意 publish 分支无此问题(未定义同名局部)。
- 这是计划自审「占位符扫描」的盲区类型:变量遮蔽冲突。建议执行者在落位 im.mjs 新命令块时统一用 `outPath`/`filePath` 类不与全局(`out`/`die`/`api`/`config`)冲突的名字。

**[m1-new] r1-m3 子进程测试放在 Step 3(实现)而非 Step 1(失败测试)**
- 该用例出现在「im.mjs 改动」代码块之后(计划 868-885 行),Step 1 的测试文件块里没有它 → Step 2「跑测试确认失败」不覆盖它,TDD 顺序倒置。修法:把该 test 块移入 Step 1 测试文件末尾(文字已说「在测试文件末尾追加」,移过去即可,零改动内容)。

**[m2-new] r1 ②的修法建议(合并单块、删死条件)未被采纳**
- T2 骨架 329-333 行仍是两段式 push + 恒真条件 `&& patch.capabilities === undefined` + 「上面已 push 两列,这里再 push」注释。逻辑自洽、无双落库(r1 已验证三分支),但照抄易错。建议随 C1 一并按 r1 报告的单块修法改写(非阻塞,执行者按注释也能写对)。

**[i1] 残留自指指令文本**
- 计划 868 行「(实现时:删除本注——上块已是最终代码。)」——上块确实是最终代码,该注本身要求删除自己,语义绕但无害;执行者照做即可,建议下次修订顺手清掉。

## 修复清单(阻塞项)

1. **C1**:T5 scan 分支 `out` → `outPath`(3 行),消除对全局输出函数的遮蔽。
(m1-new 建议同批:子进程测试移入 Step 1;m2-new/i1 可选。)

---

## r3 终审补充(d56e629 后,2026-10-01)

三处修复逐字核验:
1. **C1 已修**:scan 分支 `outPath`(851/853 行)+ 注释标注 r2-C1 教训;回显行 `out(...)`(854 行)不再被遮蔽。T4 测试文件内的 `const out = join(TMP,…)`(586/603/620 行)是独立测试模块的局部变量,该文件无全局 `out()`,不构成同类问题。
2. **m1-new 已修**:拒发子进程用例已并入 Step 1 测试块(含 r1-m3 标注),TDD 顺序恢复;用例内容与 r2 版本一致。
3. **m2-new 已修**:两段式 push + 死条件已删,替换为单块三列 push(`profile/profile_updated_at/capabilities`),与 r1 报告修法逐字一致。

残留:i1 自指指令注仍在(无害,执行者照做)。**改判:SHIP**(C/M/m/i = 0/0/0/1)。
