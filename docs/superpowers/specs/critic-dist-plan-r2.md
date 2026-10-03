# Critic 审计报告：2026-10-01-agentlink-client-dist-plan.md（r2 复审）

**结论：SHIP（可进实施）**

**Overall**：r1 全部 4C/4M 已实质落实（逐条对照计划正文与源码核验，非看修订说明）。断言串与实现输出逐字对账全部通过：C1 新测试经 `mockServer` 发 AUTH_FAILED error 帧，确实命中 `daemon.mjs:67` 接入点；C2/C3/M2 断言串与输出/HTML 逐字一致；C4 两处代码块统一 PATTERNS_INSTALL 且与 `publish-public.sh:33` 清单同源核对无误；M1 contrib 先 commit 后验证；M3 sh/ps1 均同卷 mktemp；M4 双按钮 + `<details>` + check 断言齐备。新发现仅 3 条 Minor / 2 条 Info，无阻塞项。

## r1 处置核验矩阵

| # | 发现 | 处置 | 核验依据 |
|---|---|---|---|
| C1 | T2 端口不可达方案死路 | **落实** | 计划 Step 1 改用本文件既有 `mockServer` harness，handler 在 auth_ok 后发 `{op:'error',code:'AUTH_FAILED'}` + `close(4003)`——与 `daemon.test.mjs:105-121` 场景 A 同形态，恰好驱动 `daemon.mjs:67`。harness 签名 `mockServer(hand, restHandler)` 与 `{messages:[]}` 用法核对一致；`envFile(dir,name,token,port)` 四参调用正确；`(dev)` 期望与 checkout 无 VERSION 文件的事实一致 |
| C2 | 重跑断言串不匹配 | **落实** | 断言改 `grep '已安装版本'` + `grep '旧版本'`；install.sh 输出 `>> 已安装版本: $OLD / 目标: $VERSION`（首次安装也打印，注释已说明）与 `>> 安装完成: $NEW（旧版本: $OLD）`——两串均逐字存在 |
| C3 | host-swap 正则不匹配 | **落实** | 正则改 `class="host-swap">[^<]*<\/span>\.im.example.com\/download\/install\.(sh\|ps1)`，与计划 HTML `</span>.im.example.com/download/install.sh` 逐字匹配（核对实际 index.html 的 `<span class="host-swap">` 形态，205 行 `hostSwap()` 同构） |
| C4 | 门禁代码自相矛盾 | **落实** | build（Step 3）与 test（第 3 节）两处代码块均定义并使用 `PATTERNS_INSTALL`（无 im.example.com 项）；tarball 树用全量 PATTERNS。全量清单与 `publish-public.sh:33` 逐字一致（已核对）；"由实现收敛"悬空注释已删除 |
| M1 | git archive 不含未提交 contrib | **落实** | Step 4 改为先 `git add skills/agentlink/contrib && git commit` 再跑测试（r1 推荐方案①） |
| M2 | SKILL 注册码断言不匹配 | **落实** | 断言 `注册码向你的 AgentLink 服务器管理员` 与 sed `5i` 插入文本 `> 注册码向你的 AgentLink 服务器管理员（即你的所有者）索取；…` 逐字前缀一致；SKILL.md frontmatter 恰为 1-4 行，`5i` 落点正确 |
| M3 | 跨文件系统 mv 非原子 | **落实** | install.sh：`PARENT=$(dirname …); mkdir -p; UNPACK=$(mktemp -d "$PARENT/.al-install-XXXX")`；install.ps1：`$Unpack` 建在 `$Parent` 下——两者解包目录与目标同卷，下载缓存留系统 tmp |
| M4 | 偏离 spec §5（单按钮/仅注释） | **落实** | 双按钮 `copy-install-sh`/`copy-install-ps1` 各配一命令；保守两步为 `<details>` 折叠块；check.mjs 断言含 `'<details>'` 与两个按钮 id——断言与 HTML 逐字对账通过 |
| m1 | 缺失文件 grep exit 2 静默放行 | **落实**（有意为之） | `grep … -q 2>/dev/null` 直接置于 `if` 中，exit 2 视为跳过；T3 阶段空转通过、T4/T5 后自动生效——计划注释已言明该语义 |
| m2 | 子壳 PID 孤儿 | **落实** | server 改 `cd` 后直接 `python3 … & SRV_PID=$!`（真实 PID）；坏 SUMS server 用 `( … & echo $! > file)` 于子壳内捕获 python PID，`--bind 127.0.0.1` 均有 |
| m3 | 测试钩子污染生产脚本 | **落实** | `AGENTLINK_TEST_CORRUPT_SUMS` 已删，改为第二个 http.server 指向篡改副本目录 |
| m4 | 裸目录冒烟污染 HOME | **落实** | `AGENTLINK_CONFIG="$TMP/smoke-cfg" AGENTLINK_STATE="$TMP/smoke-state"` 前缀 env |
| m5 | CLAUDE.md 行号错 | **落实** | 改为「npm workspaces 段，约 31 行处」——核对无误 |
| m6 | T2 测试未定义符号 | **落实** | 直接复用文件既有 `mockServer/envFile/sleep/HOST`，注释明示照抄样板 |
| m7 | 双 tarball 一致性未验 | **落实** | 改比成员清单（`tar -tzf` diff）+ VERSION 内容 diff，绕开 gzip mtime 字节差，注释解释了原因 |
| m8 | copyText 行号 236 应为 234 | **未落实**（无碍） | 计划 540 行仍写 `index.html:236`；实际 `copyText` 定义在 234 行（本轮复核确认）。意图文字明确，执行不依赖该行号 |

## 新发现（r2）

**Critical**：无。

**Major**：无。

**Minor**：
1. **[m] T6 Step 3 deploy.md 代码块围栏冲突**（计划 619-638 行）：外层 ```markdown 块内嵌 ```bash 与 ```nginx 围栏，markdown 渲染会在第一个内层 ``` 处截断外层块。执行者按文本复制无碍，但计划文档可读性受损。修法：外层改四反引号 ````markdown 或缩进内层。
2. **[m] 版本化 tarball 断言对 tag 命名脆弱**：`V=$(ls "$DL" | grep -E '^agentlink-[0-9].*\.tar\.gz$' …)` 要求版本号以数字开头。当前仓库零 tag（已核对 `git tag` 为空，VER 走 `0.0.0-…` 回退，可通过）；一旦将来打 `v1.0.0` 形态 tag，`git describe` 产出 `agentlink-v1.0.0.tar.gz`，断言恒 `缺版本化tarball`。修法：正则放宽为 `^agentlink-.+\.tar\.gz$` 且排除 `^agentlink\.tar\.gz$`（如 `grep -E '^agentlink-.*\.tar\.gz$'`）。
3. **[m] T4 Step 1 说明与代码不一致**：说明文字「server 起在 8000 附近空闲端口」，代码固定 18923/18924。固定端口在重复运行/并行运行时可能被占（脚本尾部有 kill，窗口小）。修法：说明改「固定 18923/18924」或改用 `python3 -c` 选空闲端口；至少消文字歧义。

**Info**：
1. install.sh 两次 mv 之间的失败窗口：旧版挪到 `$UNPACK/old` 后若 `mv "$UNPACK/agentlink" "$INSTALL_DIR"` 失败，trap 会连带删除 `$UNPACK/old`（含旧安装）。同卷 mv 失败概率极低，且非用户数据（可重装），不构成阻塞；实施时可把第二次 mv 失败时先回挪 old 写进注释。
2. check.mjs `fail()`/60KB/external-ref 白名单均已核对存在（check.mjs:3-9），T6 断言追加位置（文案抽检段后）可行；landing 现状 20732B，+2.5KB 余量充足。
3. r1 m8（copyText 行号）未修，随下次顺手更正即可。

## 现实核对（本轮独立复核）

- `daemon.mjs:6` `import WebSocket from 'ws'`、`:57` connect 同步 catch、`:67` AUTH_FAILED 日志、`:72-78` close 退避/error 吞——与计划 T2 描述全部一致。
- `daemon.test.mjs` harness（19-35 行）：签名、auth_ok 先行、`port` Promise、`close()`——T2 新用例可直接复用。
- `SKILL.md`：5 条 sed 目标串（`bin/im `×2、`` `im ``、`<abs>/skills/agentlink/hook-stop.mjs`、`deploy/agentlink-daemon.service`、`（ExecStart 路径按实际 checkout 调整）`）全部在原文命中；`skills/agentlink` 残留仅 28 行一处且被 sed 覆盖——「SKILL无仓库路径」断言可达。
- `publish-public.sh:33` PATTERNS 与计划全量清单逐字一致。
- `node_modules/ws/wrapper.mjs` 存在且 named 导出 WebSocketServer（已读文件头）；vendor 文件集与包内容吻合（browser.js/README.md 排除合理）。
- `deploy/agentlink-daemon.service` 存在（contrib 新文件不冲突）；`web/landing/index.html` 的 `cur/ZH/hostSwap/copyText/copyBtn`（201-251 行）与 T6 脚本段引用的标识符全部存在、IIFE 内追加位置正确。

## Verdict Justification

THOROUGH 模式（未触发升级条件：零 Critical、零 Major）。16 条 r1 发现中 15 条实质落实、1 条（m8 行号）未修但无执行影响；逐字对账未再发现「断言与实现不匹配」类死点——r1 的系统性问题已被修订消除。新发现 3 Minor 均 1-3 行可修且不阻塞 TDD 流程（m1 围栏仅影响计划渲染、m2 是未来 tag 才触发的潜伏项、m3 是文字/代码口径不一），按「不因吹毛求疵扣船」原则给 SHIP；建议实施时顺手带上三条 Minor 修正。

## Open Questions（不计分）

- 根 `npm install` 首跑耗时（workspaces 全仓装配）——r1 已提，计划已注明一次性成本，closed。
