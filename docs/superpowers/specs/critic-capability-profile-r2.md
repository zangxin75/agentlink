# 审计报告:agent 能力档案设计 r2 修订版(critic-capability-profile-r2)

审计对象:`docs/superpowers/specs/2026-10-01-agent-capability-profile-design.md`(r2,commit 149dfab)
对照:r1 审计(`critic-capability-profile-r1.md`,NO-SHIP 0C/4M/7m/3i)
模式:THOROUGH · 日期:2026-10-01

## 结论:SHIP

C/M/m/i = **0 / 0 / 1 / 1**。r1 全部 4 Major、7 minor、3 info 均已在正文实质落实(非仅修订说明声明);新发现仅 1 minor(限频窗口实现指引的歧义)与 1 info,不构成阻塞。

## 处置核验矩阵(r1 → r2 正文落点)

| r1 项 | r2 落点(正文) | 代码事实核验 | 判定 |
|---|---|---|---|
| **M1** publish 限频通道不存在 | §3.2「publish 限频」块:`registerMeRoutes` 签名注入 limiter(现 `{db,cfg}` → 加 limiter,与 `routes/agents.ts:24` 事实一致)、`RATE_LIMIT_PROFILE_PER_HOUR`(默认 5)+ `cfg.rate.profilePerHour`、超限走既有 429 | `config.ts:26-30` 现无 profile 桶、全 per-min——设计如实承认并要求新增 per-hour 窗口支持;装配点 `app.ts:42-53` 已列同步 | ✓ 落实 |
| **M2** 入站提示注入面 | §3.3「档案是不可信输入」+ 防护三轨(whois/search 输出框定头、SKILL.md 安全规则明示、服务端黑名单);§2.4 whois 头部框定;§3.2 best-effort 黑名单(命中 400 + 回显片段 + 明示可绕过);§7 补「不做语义级防御」边界 | 与项目既有防护先例(SKILL.md 任务上下文框定、hook 注入不可信头)对齐;三轨分层合理,黑名单定位诚实 | ✓ 落实 |
| **M3** capabilities 派生覆写歧义 | §3.2:profile 与 capabilities 同给 → 400 `INVALID_REQUEST`;给 profile 即派生覆写(超长报错不截断);`profile={}` 清空档案且清空派生标签;§2.3 `--clear` 同步;§6 补 `--clear` 不残留用例 | 互斥分支消除条件歧义,单一事实源语义闭环 | ✓ 落实 |
| **M4** 扫描器契约缺失 | §2.1「目录遍历契约」:dev+ino 去重防环、不跟随目录 symlink、挂载点默认跳过(`/mnt /media /net /private/var/vm`)、墙钟 10min + truncated 标注 + 30s 进度、Windows 盘符 A:-Z: 试探、git 子进程完整参数(`core.hooksPath=/dev/null` `--no-optional-locks` `--date=iso` `--name-only` `-n 500`)+ 10s 超时 + 缺失降级;§2.3 敏感模式机械后检(警告 + `--confirm-sensitive` 双轨) | 后检为「警告不阻断 + 显式确认」——弱于我建议的硬阻断但设计给出了理由(LLM 自觉 + 机械提醒双轨),接受;hooksPath 隔离到位 | ✓ 落实 |
| m1 schema 白名单剥离 | §3.2 首行明示 + §6 回归用例 | 对齐 `routes/agents.ts:27` `additionalProperties:false` | ✓ |
| m2 skills name 规范 | §2.2:name ≤40 字节、`[a-z0-9.-]` 小写;stack 同规范 | 对齐 `routes/agents.ts:31` maxLength:40 | ✓ |
| m3 上位 spec 修订清单 | §3.4:§5/§8/§10/配置默认值表四处 | 覆盖 r1 指出的全部修订点 | ✓ |
| m4 capability/skills 双轨 | §2.4 + §8:capability 升级逗号 AND,单值向后兼容,不新增 skills 参数 | 对齐 `core/agents.ts:99` 现单值实现,升级路径兼容 | ✓ |
| m5 字/字节不一致 | §2.2 全约束改字节,分项+总限均 Buffer.byteLength | 对齐项目惯例(CLAUDE.md) | ✓ |
| m6 测试面缺口 | §6:限频 429、schema 回归、--clear 不残留、mcp 套件、客户端防环/truncated/git 降级/敏感后检 | 全覆盖且超 r1 要求 | ✓ |
| i1 迁移/触点 | §3.1 `if (v < 3)` + Agent 接口/rowToAgent 触点 | 对齐 `db/schema.ts:69` | ✓ |
| i2 whois 数据源 | §2.4 + §3.2 | `routes/directory.ts:20-24` 一致 | ✓ |
| i3 模板移 lib/ | §5:`lib/profile-prompt.md`,SKILL.md 只引用;§4 门禁覆盖说明 | 缩小 sed/敏感扫描面,合理 | ✓ |

## 新发现

**[m1-new] §3.2 限频窗口「二选一」中 per-min 近似会产生病态实现**
- 原文:「新增 per-hour 窗口支持(**或以 `5/60` per-min 近似**并注明)」。RateLimiter 计数窗口是整数语义:5/60 ≈ 0.083 次/min,取整要么 0(等于无限频,M1 复发)要么 1(= 60 次/小时,弱 12 倍且仍可分钟级刷)。两个「近似」结果都不满足「每 agent 5 次/小时」的 spec 语义。
- 修法:删去 per-min 近似分支,指定唯一实现——真 60 分钟滑动/固定窗口桶(或 per-day 兜底);实现时若嫌改 RateLimiter 结构重,可用「分钟桶计数 × 记录最近 60 分钟内 publish 时间戳数组」的轻量法。一句话修订,不阻塞 SHIP。

**[i1-new] §2.2 分项上限加总可超 8KB 总限(非错误)**
- projects ≤30 × (name 80 + role 40 + summary 200 + stack) 名义可达 ~10KB,超过 8KB 总限。总限是绑定约束、分项是其内的自由度,校验器按「分项 + 总限」双层校验即可,无需改数字——仅提示实现者校验顺序(先分项后总限)与错误信息可读性。

## 遗留确认(无新问题)

- 尺寸自洽:8KB ≤ 1MB bodyLimit ✓;错误码统一 INVALID_REQUEST/429 ✓;REST 分层(profile 属 db 层)✓;audit 沿用 `agent.profile_updated` ✓;分发链断言点列全 ✓。
