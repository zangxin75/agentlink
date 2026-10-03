# Critic 审计报告：2026-10-01-agentlink-client-dist-plan.md（r1）

**结论：FIX_REQUIRED**

**Overall**：架构方向正确（vendor ws、压缩前门禁、git archive、install 只装文件），现实核对大部分通过（daemon.mjs:6 / daemon.test.mjs:6 导入行号准确、ws lib 恰 13 个 .js、wrapper.mjs 同时导出 default WebSocket 与 named WebSocketServer、SKILL.md 35 行且全部 sed 规则可命中、check.mjs 的 fail()/抽检段存在、index.html 的 hostSwap/copyText/copyBtn 机制与引用行基本准确）。但存在**三类断言与实现输出不匹配导致的永久红灯**（T2/T4/T6 的红→绿不可达），以及**敏感门禁与 install 默认域的代码级自相矛盾**。这些是同一系统性问题的不同表现：断言字符串/正则是"想当然"写的，没有对照计划自己给出的实现代码逐字核对。

**Pre-commitment 预测 vs 实际**：预测问题区 = ①sed 规则与 SKILL.md 实文不匹配（实际：全部命中，通过）；②门禁与默认域冲突（实际：命中，且计划代码与自己的注释矛盾）；③TDD 红绿可达性（实际：命中 3 处）；④任务间产物自举（实际：命中 T3 commit 顺序问题）；⑤接口签名对齐（基本通过）。

---

## Critical

### C1. T2 测试场景永远无法变绿——指定的接入点在该场景下一个都不会触发
- 位置：Task 2 Step 1/Step 3（计划 114-141 行）
- 问题：测试把 `AGENTLINK_SERVER` 指到 `http://127.0.0.1:1` 并断言日志含 `daemon VERSION=`。但 `daemon.mjs` 中连接失败的真实路径是：`new WebSocket()` 构造**不同步抛错**（合法 URL）→ `'error'` 事件被 `ws.on('error', () => {})` 吞掉（`daemon.mjs:78`）→ `'close'` 处理器只做静默退避重连（`daemon.mjs:72-77`），**一行日志都不打**。Step 3 指定的三个接入点：`connect ${agentId}: ${e.message}`（`daemon.mjs:57`，仅捕获同步构造异常）、`backfill` catch（`daemon.mjs:43`，仅在 auth_ok 后调用，本场景永远到不了）、`auth failed`（`daemon.mjs:67`，需收到 AUTH_FAILED error 帧，端口 1 收不到）。计划括注"错误路径与 AUTH_FAILED 共用同一前缀逻辑"是错的。
- 信心：HIGH
- 影响：实施者按计划做完实现，测试仍是红的——要么卡死，要么擅自改测试/实现造成范围漂移。
- 修法：测试复用 `daemon.test.mjs` 既有 WSServer harness，由假服务端主动发 `{op:'error',code:'AUTH_FAILED'}` 帧后 close(4003)——这正好命中 `daemon.mjs:67` 的接入点，且是该文件已有的、可复用的驱动形态。删掉"端口 1"方案与错误括注。

### C2. T4 "重跑打印旧版本"断言与 install.sh 自己的输出字符串不匹配——永久红灯
- 位置：Task 4 Step 1 第 333 行 `grep -q '旧版本\|previous'` vs Step 3 install.sh 输出
- 问题：install.sh 打印的是 `>> 已安装版本: $OLD / 目标: $VERSION` 与 `>> 安装完成: $NEW（旧: $OLD）`——不含"旧版本"也不含"previous"。断言永远 `bad install重跑未打印旧版本`，Step 4 "ALL OK" 不可达。
- 信心：HIGH
- 修法：断言改成 `grep -qE '已安装版本|previous version'`，且 install.sh 输出里保留一个稳定锚点串（如把完成行改成 `>> 安装完成: $NEW（旧版本: $OLD）`，二者取一，保持一致）。

### C3. T6 host-swap 正则断言与给出的 HTML 片段不匹配——永久红灯
- 位置：Task 6 Step 1（计划 521 行）`/class="host-swap"[^<]*<\/span>\/download\//` vs Step 3 HTML（计划 537 行）
- 问题：实际 HTML 是 `https://<span class="host-swap">agentlink</span>.im.example.com/download/install.sh`——`</span>` 之后是 `.im.example.com/download/`，不是 `/download/`。正则要求 `</span>` 后紧跟 `/download/`，永不匹配，`fail('install cmd host-swap missing')` 恒触发。
- 信心：HIGH
- 修法：改 `/class="host-swap">[^<]*<\/span>\.im.example.com\/download\/install\.(sh|ps1)/`。

### C4. 敏感门禁代码与豁免方案自相矛盾——T4 落地后 build 必然 ABORT
- 位置：Task 3 Step 3 build 脚本第 276 行（`grep -rEn "$PATTERNS" … scripts/install.sh scripts/install.ps1 -q`，PATTERNS 含 `im.example.com`）与 Step 1 测试第 200-201 行（对 `$DL/install.sh` 用全量 PATTERNS）vs 计划 280-284 行的实现者注
- 问题：计划的**可执行代码块**用全量 PATTERNS 扫 install 源文件；T4 落地后 install.sh 含默认域 `https://im.example.com/download` → build 门禁 `exit 1`、测试第 3 节 `bad 敏感串命中`。计划在注释里承认了矛盾并给出收敛方案（install 文件豁免 `im.example.com` 单项），但两处代码块都没有按该方案写——实施者面对的是"代码块 A"与"注释方案 B"两套互相冲突的指令。
- 信心：HIGH
- 修法：把豁免直接写进两处代码：`PATTERNS_INSTALL='al_[A-Za-z0-9]{20,}|wl_[A-Za-z0-9]{20,}|203.0.113.10|203.0.113.20|203.0.113.30|192.0.2.107|192.0.2.117'`（无 im.example.com，附注释"默认域是刻意公开信息"），build 与 test 代码块统一引用；删除 280-283 行那段"由实现收敛"的悬空注释。豁免本身不漏水（tarball 内不含 install 源文件，产物树仍用全量清单扫描）。

## Major

### M1. T3 Step 4 在 commit 之前跑测试必失败——`git archive HEAD` 不含未提交的 contrib/
- 位置：Task 3 接口段（contrib/ 是本任务 Create）+ build 脚本 `git archive HEAD skills/agentlink` + Step 4 在 Step 5 commit 之前
- 问题：`contrib/agentlink-daemon.service` 在 Step 3 创建、Step 5 才提交；`git archive HEAD` 只取已提交内容 → Step 4 跑 test-client-dist.sh 时 tarball 里没有 `agentlink/contrib/…` → `bad 缺contrib`。
- 信心：HIGH
- 修法：三选一并写明：①Step 4 前先 `git add skills/agentlink/contrib && git commit`（把 commit 拆成两次）；②build 改为 `git archive` + 工作树覆盖 contrib；③Step 4 注明"先 commit 后验证"。推荐 ①，最符合"tarball 只含已提交内容"的供应链直觉。

### M2. T3 SKILL.md 断言 `'管理员索取注册码'` 与 sed 插入文本不匹配——永久红灯
- 位置：Task 3 Step 1 第 208 行 vs Step 3 第 270-272 行插入文本
- 问题：插入的是 `注册码向你的 AgentLink 服务器管理员（即你的所有者）索取`——"管理员"与"索取"之间隔着"（即你的所有者）"，连续子串 `管理员索取注册码` 不存在 → `bad SKILL缺注册码来源` 恒触发。
- 信心：HIGH
- 修法：断言改 `grep -q '注册码向你的 AgentLink 服务器管理员'`（与插入文本逐字对齐）。

### M3. install.sh/ps1 的"原子改名"在跨文件系统时为假——违反 spec §4 条 5
- 位置：Task 4 Step 3 `TMPD=$(mktemp -d)`（典型在 tmpfs）+ `mv "$TMPD/unpack/agentlink" "$INSTALL_DIR"`
- 问题：mktemp 目录与 `$HOME` 常在不同文件系统，mv 退化为 copy+rm；拷贝中途崩溃在 INSTALL_DIR 留半成品，恰是 spec 明令禁止的场景。install.ps1 的 `Move-Item` 跨卷同理。
- 信心：HIGH（机制确定）/ Realist：触发窗口极窄，但这是 spec 明文合同，不降级。
- 修法：临时解包目录建在目标父目录同卷：`PARENT=$(dirname "$INSTALL_DIR"); mkdir -p "$PARENT"; TMPD=$(mktemp -d "$PARENT/.al-install-XXXX")`（ps1 对称：`New-Item -Path $Parent -Name ('.al-' + [IO.Path]::GetRandomFileName())`），下载缓存仍可留系统 tmp。

### M4. T6 偏离 spec §5 两处（单按钮按语言选命令；保守两步仅是代码注释）
- 位置：Task 6 Step 3
- 问题：spec §5 写"**两行并排，各配复制按钮**"；计划改为单按钮、由 UI 语言决定复制 curl 还是 irm——中文 Windows 用户会复制到 macOS 命令。spec §5 "保守两步（折叠或次级展示）+ 文案明示可以先读再跑"在计划里只体现为 `<pre>` 内一行注释，无折叠/次级展示，check.mjs 也无对应断言。
- 信心：HIGH（偏差事实）/ Realist：功能可用，属 spec 合同偏离而非缺陷，定 MAJOR 因 spec 是权威。
- 修法：两个复制按钮（每命令一个）或单按钮弹出双选；保守两步做成 `<details>` 折叠块并加一条 check 断言（如 `includes('details')` + `-O install.sh` 文案）。

## Minor / Info

- m1. T3 阶段门禁/测试对不存在的 install 文件 grep exit 2 → `if` 静默放行（空转通过）；计划 298 行承认需 `[ -f ]` 守卫但打印的测试代码（201 行）没有它——与 C4 一并修，别再靠"实现者注"兜底。
- m2. T4 `(cd "$DL" && python3 … &) ; SRV_PID=$!`——`$!` 是子壳 PID，python 成孤儿进程，固定端口 18923 下次运行可能被占。改 `python3 -m http.server $PORT --bind 127.0.0.1 >/dev/null 2>&1 & SRV_PID=$!`（在 `cd "$DL"` 后）。
- m3. `AGENTLINK_TEST_CORRUPT_SUMS` 把测试分支塞进生产 install.sh（公开分发面）。更简单且零污染：起第二个 http.server 指向"SUMS 被篡改"的副本目录。若保留钩子，注释必须声明它是测试专用。
- m4. T3 裸目录 daemon 冒烟未设 `AGENTLINK_STATE`/`AGENTLINK_CONFIG`——daemon 心跳/spool 写入真实 `~/.local/state/agentlink`，CI 污染。测试段 export 指向 `$TMP`。
- m5. `CLAUDE.md:59` 行号不对（59 行是 Conventions 的 deps 行；Layout 的 npm workspaces 段在 ~31 行附近）。意图文字明确，低危。
- m6. T2 测试片段用未定义的 `cfg`/`writeFileSync`/`join`（注释部分承认）；修 C1 时直接照抄 daemon.test.mjs 顶部的 env 隔离样板即可。
- m7. spec §8 要求断言"双 tarball 一致"，计划只断言 SHA256SUMS 含两行；同树两次 tar 字节级一致性并未被验证。加一条 `cmp` 或对两 tarball 各取 sha 比相等。
- m8. T6 引用 `copyText`（实际 234 行）写 236；`index.html:204-205/219-221` 基本准确。无碍。

## What's Missing

- T1 `npm install` 在 worktree 首跑会拉全部根 devDeps（含 server/mcp workspaces 依赖？根 package.json workspaces install 是全仓安装）——时间成本未提示；非阻塞。
- install.ps1 的 `Move-Item $InstallDir "$Tmp\old"`：`$InstallDir` 若跨卷同样非原子（并入 M3 修法）。
- `web/download/` 追加 .gitignore 与"产物不入 git"一致 ✓；但 SHA256SUMS 每次 build 全量重写——rsync 不带 --delete 已写明 ✓。

## Spec 覆盖矩阵（§2-§8 × 任务）

| Spec 节 | 要求 | 任务 | 状态 |
|---|---|---|---|
| §2 产物/版本 | tarball×2+SUMS+VERSION+SKILL 分发版 | T3 | 覆盖（M1 commit 顺序坑；m7 一致性断言缺） |
| §2 自足性 | vendor ws 裸机自足 + CLAUDE.md 更新 | T1+T3 冒烟 | 覆盖 |
| §2 错配不静默 | daemon 失败带 VERSION | T2 | 意图覆盖，**执行不可达（C1）** |
| §3 托管/nginx | 前缀匹配+alias、rsync 不 --delete | T6 deploy.md | 覆盖 |
| §4 安装器契约 | 三变量、SHA256、幂等升级、<200 行、TLS1.2 首语句 | T4/T5 | 覆盖（C2 断言坏；M3 原子性破） |
| §5 落地页 | 双平台命令+复制、保守两步、自托管、注册码、双语域 | T6 | 部分覆盖（C3 断言坏；M4 偏差） |
| §6 管线/门禁 | 压缩前扫描、清单同源、公开仓库洗域 | T3 | 清单逐字一致 ✓，但 **C4 自相矛盾** |
| §7 安全 | 无提权、SHA256 必配、签名不做 | T4/T5 + 约束 | 覆盖，无 YAGNI 加戏 |
| §8 测试 | 清单/扫描/裸目录冒烟/SKILL 断言/install 实装/ps1 结构/check.mjs 增补 | T3-T6 | 形态齐备，多处断言坏（C2/C3/M2） |

## Ambiguity Risks

- 计划 276 行代码 vs 280-284 行注释（C4）：解释 A 按代码全量扫 → T4 后 build 必炸；解释 B 按注释豁免 → 两处代码都要改。风险：实施者按 A 抄写，T4 卡死。
- T4 Step 1 括注"或将下载来的 SHA256SUMS 首字符改 0"：两种钩子实现（假 SUMS 文件 vs 改首字符）行为不同但均可测；统一到"篡改服务端 SUMS"即可消歧（m3）。

## Multi-Perspective Notes

- Executor：C1/C2/C3/M2 都是"照计划做完仍然红"的死点——subagent 实施者最易在此擅自改断言（把断言删了求绿），必须先修计划。
- Stakeholder：成功标准（一行命令、错配不静默、可回退）在计划里都有对应物，方向无误。
- Skeptic：vendor ws + git archive 是本计划最稳健的决策，未见更强反案；install 只装文件的边界也守得住。真正的弱点全在"断言与实现互不对账"这一类上。
- Security：门禁清单与 publish-public.sh 逐字一致（已核对第 21 行附近）；豁免方案不漏水（tarball 侧全量、install 侧仅去 im.example.com 项、token/内网 IP 项保留）。

## Verdict Justification

THOROUGH 起审，发现 3 处永久红灯 + 门禁代码自相矛盾（属"断言未对账"的系统性模式，触发 ADVERSARIAL：随后又挖出 M1/M2 同类死点与 M3 跨卷原子性）。Realist check：C2/C3/M2 虽只是断言字符串错误，但它们使 TDD 流程在 subagent 执行模型下必然卡死或诱发断言漂移，且修复成本一行——不降级；M3 触发窗口窄但违反 spec 明文合同，维持 MAJOR；未发现涉及数据丢失/安全事故的升级项。升级到 ACCEPT 需：修 C1-C4、M1-M4（M4 可降为在计划里显式声明偏差理由供 spec 侧裁决）。

## Open Questions（不计分）

- 根 `npm install` 是否会连带装 server/mcp workspace 依赖（耗时）——未验证 package.json workspaces 装配范围。
- tar.gz 两次打包字节一致性（gzip mtime 来源）——m7 修法绕开，无需先答。
