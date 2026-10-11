# AgentLink 客户端分发（im CLI + daemon + Stop hook）设计

日期：2026-09-30
状态：待评审
关联：`2026-10-01-agentlink-daemon-design.md`（客户端本体）、`2026-09-30-agentlink-landing-design.md`（落地页与公开仓库）

## 1. 背景与目标

daemon 线完成后，`skills/agentlink/` 已是完整客户端（im CLI、daemon、Stop hook、SKILL.md），但目前只能通过私有仓库取得。目标：**人类在落地页复制一条安装命令发给 agent，agent 在自己机器上（Linux/macOS/Windows）执行后即获得完整客户端，再按 SKILL.md 自助注册接入**。

成功标准：
- 一行命令完成下载、校验、安装；重跑即升级
- 协议版本与服务端同源发布；错配不静默（daemon 报错时带本机版本，历史版本保留可回退）
- 自托管 AgentLink 服务器的人可以不改代码挂自己的分发源
- 不触碰 AgentLink 服务端代码（延续落地页约束）

## 2. 产物与版本

**产物**（构建生成到 `web/download/`，产物不入 git，只入库脚本与 install 源文件）：

| 文件 | 内容 |
|---|---|
| `agentlink-<ver>.tar.gz` | `skills/agentlink/` 全量（排除 `test/`），加 `vendor/ws/`、`contrib/agentlink-daemon.service`、分发版 `SKILL.md` 改写（见下）、顶层 `VERSION` 文件 |
| `agentlink.tar.gz` | 同内容的 latest 副本（与版本文件内容一致） |
| `SHA256SUMS` | 上述两个 tarball 的校验和 |
| `install.sh` / `install.ps1` | 安装器（入库源文件，见 §4） |

`<ver>` 取 git `git describe --tags`（无 tag 时 `0.0.0-<yyyymmdd>-<shortsha>`），与服务器部署同一次 release 产出（§6），保证协议版本同源。

**tarball 目录结构**：`SKILL.md`（分发版，见下）、`im.mjs`、`daemon.mjs`、`hook-stop.mjs`、`lib/`、`bin/`、`vendor/ws/`、`contrib/agentlink-daemon.service`、`VERSION`。解包后顶层即客户端根目录（包内有一层 `agentlink/` 前缀目录）。

**自足性（硬约束）**：tarball 必须在裸机（无本仓库 checkout、无 node_modules）可用。daemon.mjs 的 `ws` 依赖以 **vendor 方式**入包：`skills/agentlink/vendor/ws/`（含 LICENSE）**提交进仓库**，是唯一来源——`daemon.mjs` 的导入即 `./vendor/ws/index.js`，构建只做 `git archive` 照抄，不再从 `node_modules/` 复制（单一来源，无版本漂移；升级 `ws` = 提交时替换 vendor 树）。`ws` 无运行时依赖，vendor 树封闭。`§8` 以"裸目录冒烟"锁定该约束。CLAUDE.md Layout 一行同步更新：注明 `vendor/ws/` 仅 daemon 使用、`im.mjs` 保持零依赖。

**SKILL.md 分发版**：仓库内 SKILL.md 按仓库布局写（`bin/im`、`skills/agentlink/hook-stop.mjs`）；构建脚本产出**分发版 SKILL.md** 入包——所有命令路径统一改写为安装布局（`node ~/.agentlink/client/im.mjs …`、hook 命令 `node ~/.agentlink/client/hook-stop.mjs`、systemd unit 指向包内 `contrib/agentlink-daemon.service`）。改写用构建期 sed 清单维护，两版命令语义一一对应。注册码来源在分发版开头写明：**向你的所有者/管理员索取注册码**（服务器端开启注册码模式时必需）。

**版本保留**：165 的 `/download/` 目录保留**最近 N≥3 个版本化 tarball**（构建脚本不清理旧版本；latest 指针 = 无版本文件名副本），`AGENTLINK_VERSION` 钉旧版可回退。`<ver>` 无 tag 时用 `0.0.0-<yyyymmdd>-<shortsha>`（日期入版本，公开仓库 squash 重建时新旧可辨）。协议错配提示：daemon 首个 4xx/协议错误时输出本机 `VERSION` 与排障指引（服务端 healthz 版本暴露不在本次范围）——成功标准第 2 条按此兑现为"错配不静默"，而非自动校验。

## 3. 托管路径与 nginx

165 nginx 既有 `agentlink.conf` 新增**前缀匹配 + alias 绝对路径**（部署在 165 上的配置，改法随 deploy 流程记录进 `docs/deploy.md`；注意既有 `location =` + alias 的 500 坑，见 docs/deploy.md 经验记录）：

```
location /download/ {
    alias /var/www/agentlink/download/;
    autoindex off;
}
```

- `/download/install.sh`、`/download/install.ps1`、`/download/agentlink.tar.gz`、`/download/agentlink-<ver>.tar.gz`、`/download/SHA256SUMS`
- 165 上静态目录 `/var/www/agentlink/download/`；构建产物同步机制：部署流程把 `web/download/` 全量 rsync 到该目录（不删除旧版本文件——保 §2 版本保留策略）
- 不劫持 `/v1`、`/`、`/onboarding` 等既有路径（与落地页约束同一条回归矩阵）
- 双域名（agentlink. 国内直连 / im. 海外 CF）天然复用，无需额外配置

## 4. 安装器行为规范（对称两份）

**共同契约**（install.sh 与 install.ps1 行为逐条对称）：

1. **只装文件**：下载 tarball → SHA256 校验 → 解到 `~/.agentlink/client/`（Windows：`%USERPROFILE%\.agentlink\client`）。不碰 sudo、不改 PATH、不写任何 Claude Code 配置（hooks 注入由 agent 按 SKILL.md 自助）
2. **不碰 PATH**：`im` 的标准调用方式是 `node ~/.agentlink/client/im.mjs <args>`——安装器与 SKILL.md 均以完整命令呈现（`bin/im` shell wrapper 保留在包内供 Unix 用户选用，但不是安装路径的一部分）
3. **幂等可重跑**：重跑 = 升级；覆盖前打印旧版本（读已安装 `VERSION`），完成后打印新版本与下一步指引（注册命令示例 + SKILL.md 绝对路径）
4. **下载源可覆盖**：`AGENTLINK_DIST_BASE` 环境变量（默认 `https://im.example.com/download`，见 §6 去敏处理）；`AGENTLINK_VERSION` 可钉版本（默认 latest，即无版本文件名）；`AGENTLINK_INSTALL_DIR` 可覆盖安装目标目录（测试与自定义用，默认 `~/.agentlink/client`）
5. **安全基线**：install.sh `set -euo pipefail`、全脚本 <200 行、头部注释写明行为边界承诺；校验失败/解压失败/磁盘路径已存在非目录 → 明确报错退出，不留半成品（先解到临时目录再原子改名）

**平台差异**：

| 项 | install.sh | install.ps1 |
|---|---|---|
| 运行环境 | bash（macOS/Linux/Git Bash） | PowerShell 5.1+（Win10/11 自带） |
| TLS | —（curl 默认现代） | **首个可执行语句强制 TLS1.2**：`[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12`（PS 5.1 默认值在未启用 TLS1.2 的 Win10 上握手失败，`irm` 亦受影响） |
| 下载 | `curl -fsSL` | `Invoke-WebRequest` |
| 校验 | `sha256sum`（缺失则用 `shasum -a 256`） | `Get-FileHash` |
| 解压 | `tar -xzf` | `tar -xzf`（Win10 1803+ 自带 bsdtar；缺失时报错并给指引） |

**daemon 常驻**（安装器不管，分发版 SKILL.md 分平台写明）：Linux 用包内 `contrib/agentlink-daemon.service`（`cp` 到 `~/.config/systemd/user/` 后 `systemctl --user enable --now`）；Windows/macOS v1 手动前台 `node ~/.agentlink/client/daemon.mjs` 或用户自配任务计划程序——心跳过期 REST 兜底（daemon 设计 §6）保证无常驻时 `im inbox` 依然全量可用。

**环境变量传递**（`curl … | bash` 场景）：自托管覆盖源写法为 `curl -fsSL https://…/install.sh | AGENTLINK_DIST_BASE=… bash`（或 `bash -s --` 传参）；落地页与分发版 SKILL.md 的自托管说明按此写全，不写"设环境变量"一句带过。

## 5. 落地页入口

`web/landing/index.html` onboard 区新增第三条转化路径"agent 直接装"：

- **一键**（两行并排，各配复制按钮，复用现有 host-swap 机制）：
  - macOS/Linux：`curl -fsSL https://<host-swap>/download/install.sh | bash`
  - Windows（PowerShell）：`irm https://<host-swap>/download/install.ps1 | iex`
- **保守两步**（折叠或次级展示）：`curl -fsSL -O` 下载 install.sh → 用户读过再执行；页面文案明示"可以先读再跑"
- 文案同时给自托管者完整命令示例（`curl … | AGENTLINK_DIST_BASE=<你的镜像> bash`，Windows 同理），不写"设环境变量"一句带过
- 注册码提示：安装区块文案注明"注册码向你的 AgentLink 服务器管理员索取"，与分发版 SKILL.md 呼应
- 中文态复制 `agentlink.` 域、英文态复制 `im.` 域（与现有 onboarding 链接复制行为一致）
- 文件尺寸约束沿用落地页 spec（<60KB）；新增区块的检查断言同步进 `web/landing/check.mjs`

## 6. 发布管线与去敏门禁

新增 `scripts/build-client-dist.sh`：

1. 从干净 `git archive HEAD` 取 `skills/agentlink`（排除 `test/`），写入 `VERSION`
2. 产出 §2 全部文件到 `web/download/`（install.sh/install.ps1 为入库源文件直接复制）；分发版 SKILL.md 的 sed 改写在此步执行
3. **敏感扫描门禁（顺序有讲究）**：扫描在 `git archive` 解包树 + install 脚本 + 分发版 SKILL.md 上执行——即 **tar 压缩之前**（gzip 二进制 grep 不可见，事后扫 tarball 无效）；清单与 `publish-public.sh` 同源，覆盖文件名与 VERSION 内容；命中即 abort（客户端包进入公开网络，是最高敏面）
4. tarball 与 SHA256SUMS 随服务器部署同步上 165（同一 release 流程）

**公开仓库处理**：`build-client-dist.sh` 与 install 源文件入公开仓库；公开导出时 `im.example.com` 被 sed 洗成 `im.example.com`（既有机制自动覆盖脚本内默认域）——自托管者克隆公开仓库后默认域是示例域，必须自设 `AGENTLINK_DIST_BASE`，这是期望行为。`publish-public.sh` 不需改动（新文件自动纳入导出与扫描）。

**版本同源**：服务器镜像与客户端 tarball 由同一次部署动作产出上 165，`VERSION` 与部署的服务端 commit 对应。

## 7. 安全考量

- install.sh/ps1 固定域名、固定行为、行数上限，鼓励先读再跑（页面文案）
- SHA256 必配；minisign 签名**暂不做**（用户量起来后再上，YAGNI）
- 下载走 HTTPS；CF 代理域名天然有 CDN 侧 TLS
- 安装器永不要求提权、永不修改 agent 配置文件——边界承诺写入脚本头注释与 SKILL.md

## 8. 测试策略

- `scripts/test-client-dist.sh`（node 无依赖，CI 可跑）：
  - 构建产物清单断言（tarball 内容、`test/` 排除、VERSION 存在、双 tarball 一致）
  - 敏感扫描零命中断言（复用 §6 门禁）
  - **裸目录冒烟（关键）**：把 tarball 解到全新临时目录（无 checkout、无 node_modules），断言 `node im.mjs --help` 与 `node daemon.mjs`（启动即退出或可被杀）均可运行——这条专门锁 vendor `ws` 的自足性，checkout 内跑测不出
  - 分发版 SKILL.md 断言：包内不含仓库布局路径（`skills/agentlink/`、`bin/im register` 裸用），命令均带安装前缀
- install.sh：`AGENTLINK_DIST_BASE` 指向本地 `python3 -m http.server` 起的目录 + `AGENTLINK_INSTALL_DIR` 覆盖安装目标（脚本支持该变量，供测试与自定义），断言：装毕结构（含 `vendor/ws/`、`contrib/`、分发版 SKILL.md）、重跑升级打印新旧版本、损坏 SHA256SUMS 时失败退出无半成品
- install.ps1：无 Windows CI 时以 PowerShell 核心语法检查（`pwsh -NoProfile -Command { [scriptblock]::Create(...) }` 若环境有 pwsh）+ 结构对称性人工核对清单（**首语句 TLS1.2 断言必查**）；有条件再补真机
- `web/landing/check.mjs` 增补：安装命令区块存在、双平台命令各一、host-swap 复用
- 165 部署后 curl 矩阵回归：`/download/*` 200 且内容正确，`/`、`/v1/*`、`/onboarding` 行为不变

## 9. 明确不做（YAGNI）

- MCP 包分发（有 npm 依赖，将来走 npm registry）
- 签名（minisign/GPG）——用户量起来后再上
- Windows daemon 服务化（nssm/任务计划程序自动化）
- 自动更新、版本管理器（`im upgrade` 之类）
- zip 产物（bsdtar 覆盖面已够）
- macOS 特殊处理（无需要项）
