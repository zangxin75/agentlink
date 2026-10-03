# Critic 复审报告 — 客户端分发 spec r2

审计者：critic-dist-r2 ｜ 日期：2026-09-30 ｜ 对象：r1 修订后的 2026-09-30-agentlink-client-dist-design.md

## 结论：REVISE（小修一轮即可，非阻塞级）

## r1 十二条处置判定：全部落实（12/12）

- **C1** vendor ws：落实（§2 自足性硬约束 + §8 裸目录冒烟）
- **M1** systemd unit：落实（contrib/ 入包）
- **M2** 分发版 SKILL.md：落实（构建期改写 + §8 断言）
- **M3** nginx：落实（前缀匹配 + alias 绝对路径 + rsync 不删旧版）
- **M4** TLS1.2：落实（平台表 + §8 必查项）
- **M5** 版本保留/错配提示：落实（N≥3 + daemon 报错带版本，成功标准诚实改弱）
- **m1** 管道传变量写法：落实（§4 + §5）
- **m2** 扫描顺序：落实（tar 前扫解包树）
- **m3** 注册码来源：落实（分发版 SKILL.md + 落地页）
- **m4** 日期入版本：落实
- **i1/i2** 无需动作

## 新问题（2 条）

- **[MAJOR]** §2 vendor 来源双轨矛盾："构建脚本把仓库 node_modules/ws/ 复制到包内 vendor/ws/" 与 "daemon.mjs 导入 ./vendor/ws/index.js（本仓库源码即如此提交）" 并存——若 vendor 已提交在 skills/agentlink/vendor/ws，git archive 自带，再从 node_modules 复制冗余且有版本漂移风险；且本 worktree 实测无 node_modules（需 npm install，spec 未写构建前置）。修法：删"从 node_modules 复制"句，单一来源 = 已提交的 vendor 树。（main 已修：§2 改为 vendor 树提交进仓库、构建照抄。）
- **[MINOR]** CLAUDE.md Layout 行 "zero-dependency CLI im.mjs + SKILL.md" 未随 vendor 方案更新。修法：spec 加一条更新 CLAUDE.md，注明 vendor/ws 仅 daemon 使用、im.mjs 保持零依赖。（main 已并入 §2 同段。）

## 升级路径

修 MAJOR 一段文字后可直接 Ready。

*（本文件由 main 会话代为落盘——critic agent Write 被禁用；两条新问题的处置已按修法改入 spec。）*
