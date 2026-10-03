# Critic 审计报告 — 客户端分发 spec（2026-09-30-agentlink-client-dist-design.md）r1

审计者：critic-dist-r1 ｜ 日期：2026-09-30 ｜ 模式：THOROUGH → ADVERSARIAL（发现 1 Critical + 5 Major 后升级）

## 结论：FIX_REQUIRED

成功标准第 1 条"agent 执行后即获得完整客户端"在当前 spec 下不成立：tarball 内的 daemon.mjs 依赖 npm 包 `ws`，而 tarball 只打包 `skills/agentlink/`，目标机器上无 node_modules。另有多处"spec 假设的文件/机制在安装机上不存在"的对接断裂。

## 预测 vs 实际（Pre-commitment）

预测高发区：① tarball 依赖完整性；② 安装后 SKILL.md 流程闭环；③ nginx 片段可用性；④ PS5.1 兼容坑；⑤ 去敏门禁对二进制产物的盲区。①②③④⑤全部命中——spec 的系统性问题是"以私有仓库 checkout 视角写安装后世界"，未从裸机安装机视角核对其引用的每个路径/依赖。

## Critical（1）

### C1. tarball 不是自足客户端：daemon.mjs 依赖未分发的 npm 包 `ws`
- 位置：spec §2（"skills/agentlink/ 全量……解包后顶层即客户端根目录"）、§1 成功标准；证据 `skills/agentlink/daemon.mjs:6` `import WebSocket from 'ws'`；`skills/agentlink/` 目录无 package.json、无 node_modules（`ws` 来自仓库根 devDependencies，仅 checkout 内可用，见根 `package.json:13`）。CLAUDE.md 明文"skills/agentlink …… 零依赖"约束（im.mjs 层面）。
- 影响：裸机安装后 `node daemon.mjs` 立即 `ERR_MODULE_NOT_FOUND`；§4 的"心跳过期 REST 兜底"也只是兜延迟，daemon 主功能整体不可用。§8 测试在 checkout 内跑（有 hoisted node_modules），测不出此问题——测试策略对"裸机"场景是假阳性。
- 置信度：HIGH（已读源码核实）。
- 修法（三选一，spec 必须明确）：a) daemon 去 `ws` 依赖，改用 Node ≥22 原生 WebSocket（与 im.mjs 零依赖基调一致，但抬高 Node 版本要求，需写入 §4 运行环境）；b) vendor 纯 JS 的 `ws` 进 `skills/agentlink/vendor/ws/`（连带 LICENSE）；c) 打包最小 node_modules。任选其一后 §8 需加"裸目录（无 checkout）冒烟：解 tarball 后 daemon 可启动"断言。

## Major（5）

### M1. systemd unit 不在产物内，SKILL.md 指向不存在的路径
- 位置：spec §4（"Linux 用 systemd unit（`deploy/agentlink-daemon.service`……）"）；`skills/agentlink/SKILL.md:27` 让 agent `cp deploy/agentlink-daemon.service ~/.config/systemd/user/`。但 tarball 只含 `skills/agentlink/`，安装机上没有 `deploy/`（该文件在私有仓库 `deploy/agentlink-daemon.service`，不入产物）。
- 影响：Linux agent 按 SKILL.md 操作直接踩空；§1"一行命令获得完整客户端"+ "daemon 常驻"承诺断裂。
- 修法：unit 模板（路径已指 `~/.agentlink/client`）随 tarball 分发（如 `agentlink/contrib/agentlink-daemon.service`），SKILL.md 同步改路径；或 install.sh 提供 `--systemd-unit` 可选项（仍不改默认"只装文件"契约）。

### M2. SKILL.md 命令路径与安装布局不匹配，注册闭环有断点
- 位置：spec §4 第 2 条称"安装器与 SKILL.md 均以完整命令呈现"；但 tarball 内 `SKILL.md:8` 写 `bin/im register <agent_id> --code <注册码>`（相对路径，仅 cwd 在 client 根时可用），`SKILL.md:28` 写 hook 命令为 `node <abs>/skills/agentlink/hook-stop.mjs`——这是仓库 checkout 布局，安装后实际是 `~/.agentlink/client/hook-stop.mjs`。spec 全文无"tarball 内 SKILL.md 需按安装布局改写/模板化"的任务。
- 影响：agent 装完后照 SKILL.md 自助接入会在两处踩空（register 调用方式、Stop hook 路径），违反 §1"再按 SKILL.md 自助注册接入"闭环。
- 置信度：HIGH。
- 修法：spec 增加一条明确任务——build 时对 SKILL.md 做安装布局适配（构建期 sed 或维护独立的分发版 SKILL.md），所有命令统一 `~/.agentlink/client/` 前缀；§8 增加"装毕按 SKILL.md 首条命令可成功执行"断言。

### M3. nginx 片段按字面不可用：`location = /download/` 精确匹配不会命中子路径
- 位置：spec §3 `location = /download/ { ... root web/download; autoindex off; }`。nginx 语义：`location =` 只精确匹配 `/download/` 本身，`/download/install.sh`、`/download/agentlink.tar.gz` 均落入其他 location（proxy_pass 到后端 → 404/错误）。且 `root web/download` 是相对 nginx prefix 的路径，不是仓库路径；仓库内也不存在 `web/nginx/agentlink.conf`（配置在 165 上，本仓库 `docs/deploy.md:123` 已记录精确 location+alias 的 500 坑）。
- 影响：照抄该片段部署则 §8 的"`/download/*` 200 回归"必失败——至少是返工，最坏是 `/download/...` 被转发进 Fastify 造成混淆。
- 修法：spec 改为前缀匹配 + alias 绝对路径：`location /download/ { alias /var/www/agentlink/download/; autoindex off; }`，并注明部署到 165 上既有 agentlink.conf 的位置；§3 同时说明 `/var/www/agentlink/download/` 与构建产物 `web/download/` 的同步关系（rsync？目前只说"随服务器部署同步上 165"，无机制）。

### M4. install.ps1 未处理 PowerShell 5.1 的 TLS 默认值
- 位置：spec §4 平台表（"PowerShell 5.1+（Win10/11 自带）"、下载用 `Invoke-WebRequest`）。PS 5.1 下 `Invoke-WebRequest`/`irm` 默认 SystemDefault，在未启用 TLS 1.2 的 Win10 早期构建上对 CF/HTTPS-only 端点握手失败，是 Windows 一键脚本最常见的翻车点；spec 未要求脚本设置 `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`。
- 影响：相当比例 Win10 目标机器上 `irm ... | iex` 直接失败，§1"Windows 执行后即获得客户端"不成立；§8 对 ps1 只有"若环境有 pwsh 才语法检查"，覆盖不到。
- 修法：§4 平台表与安装器规范加一条：ps1 首个语句强制 TLS1.2（或干脆要求 PowerShell (Core) 7+ 并在页面上注明）；§8 人工核对清单加该断言。

### M5. "协议版本同源"无校验机制，且升级无回滚/多版本保留策略
- 位置：spec §2（"`<ver>` 取 git describe……与服务器部署同一次 release 产出，保证协议版本同源"）、§6、§9（明确不做 `im upgrade`/版本管理）。"同源"只是发布流程约定，客户端无任何运行时校验（不读服务端 `/healthz` 版本、VERSION 只用于打印新旧版本），协议错配仍是静默的——成功标准第 2 条"不出现客户端/服务端静默错配"没有落点。另外：钉版本依赖 `AGENTLINK_VERSION`，但服务器端是否保留历史版本 tarball 未定义（若部署即覆盖 latest+单版本，钉旧版=404，重跑即升级=不可回退）。
- 置信度：MEDIUM-HIGH（流程主张存在，机制缺失）。
- 修法：最低成本：a) spec 写明 165 保留最近 N 个版本化 tarball（N≥3），保证 `AGENTLINK_VERSION` 可回退；b) im/daemon 在握手或首个 4xx/协议错时输出"本机 VERSION vs 服务端版本"提示（服务端 healthz 暴露版本属服务端改动，可退化为仅打印本机 VERSION 与排障指引）。若两条都不做，请把成功标准第 2 条改弱，不要保留无法兑现的承诺。

## Minor（4）

- m1. §4 完成提示与 §5 落地页文案未覆盖"一行命令如何传环境变量"：`curl … | bash` 下设 `AGENTLINK_DIST_BASE`/`AGENTLINK_VERSION` 需写成 `curl … | AGENTLINK_DIST_BASE=… bash` 或 `bash -s --`，自托管者照抄会踩坑（§5 只有一句"设 AGENTLINK_DIST_BASE 指向自己的镜像"）。
- m2. 敏感扫描顺序盲区：§6 步骤 3"对产物树跑 PATTERNS"扫的是 `web/download/` 平面文件；`*.tar.gz` 是 gzip 二进制，grep 不可见，等于 tarball 内容未被直接扫描（靠"源自已扫描 git 树"间接兜底）。建议 spec 明确：扫描在 `git archive` 解包后、`tar -czf` 之前对解包树执行（对 `VERSION`、文件名、以及 git archive 写入 pax header 的 commit id 一并覆盖）。
- m3. 注册码来源未闭环：§4"完成后打印……注册命令示例"，但 registration code 从哪来（人类从 onboarding/管理员获取）在 dist spec 与 SKILL.md 均未写明；新装 agent 会在此停下问人。建议完成提示与落地页文案补一句"向你的所有者要注册码"。
- m4. §2 说 `<ver>` 无 tag 时为 `0.0.0-<shortsha>`：公开仓库（无 tag、squash 单提交）自建产物 VERSION 恒为 `0.0.0-<sha>`，升级"打印新旧版本"对自托管者无信息量；建议公开构建注入日期或 git 时间替代。

## Info（2）

- i1. §8 测试策略总体可自动化：本地 `python3 -m http.server` + `AGENTLINK_INSTALL_DIR` 方案成立（前提是 §4 的变量契约真被实现）；check.mjs 已有 60KB 断言（`web/landing/check.mjs:5`），增补安装区块断言可行。ps1 的 pwsh 条件检查是合理折中，但见 M4——语法检查测不出 TLS 问题。
- i2. host-swap 机制真实存在且可复用：`web/landing/index.html:204-220`（`hostSwap()` + `.host-swap` span + 中文 agentlink./英文 im. 复制行为），§5 的主张核对无误。`/v1/history` 签名（`server/src/http/routes/messages.ts:34`，limit≤100、after 游标）与 daemon backfill 用法一致，协议面对接成立。

## 多视角备注

- 执行者（照 spec 干活的工程师）：会在 C1/M1/M2 三处"按 spec 写完、测试全绿、真机失败"；M3 会让部署工程师在 165 上现场改 nginx。
- 利益相关者：§1 四条成功标准中第 1 条被 C1/M2/M4 破坏，第 2 条被 M5 架空——一半成功标准当前不可验证。
- 怀疑者：spec 最强的主张"与服务器部署同一次 release 产出"依赖一个未写明的发布流程（§6 步骤 4 只有一句话），而发布动作本身（谁触发、165 上放哪、如何原子替换 latest）在两份 spec 里都没有 owner。

## 升级路径

修 C1 + M1–M4（M5 二选一落地）后可复评；预估一轮修订即可到 Ready。
