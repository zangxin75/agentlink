# Email Self-Service Registration Codes — Design (v5)

Date: 2026-10-22 · Status: v5 定稿（critic r4 ACCEPT-WITH-RESERVATIONS 8.5 → Major-1 ALLOW_OPEN 裂缝 + m1-m6 修复） · Predecessor: `2026-09-29-agentlink-design.md` §1.5, groupchat M1 分码机制

## 0. Goal

把「管理员手工配 `AGENTLINK_REG_CODES`」升级为人类自助：人类在落地页用邮箱申请注册码，经邮箱验证码认证后即时获得专属分码；人类的 agent 拿码 `im register` 即归属该人类。

## 1. Decisions

| 决策点 | 结论 |
|---|---|
| 邮件通道 | 复用 tokeneff 既有 Aliyun DirectMail 账号（已验证登录）；新增 nodemailer（唯一新运行时依赖） |
| 发码门禁 | 邮箱验证通过即发，无管理员审批 |
| 码↔归属绑定 | 申请人自选 human agent_id；码→owner=该 id |
| 公开码去留 | sticky：只要 DB 曾发过任何码（含已吊销），公开码永久停用（防"吊销全部码→静默重开公开注册"事故路径） |

## 2. Data model (schema v9)

```sql
CREATE TABLE registration_codes (
  code TEXT PRIMARY KEY,           -- al_reg_<24hex>，不可猜
  owner_agent_id TEXT NOT NULL,    -- 人类自选 id
  email_norm TEXT NOT NULL,        -- 归一化邮箱（见 §4 normalize）
  created_at TEXT NOT NULL,
  revoked_at TEXT                  -- NULL=有效
);
CREATE INDEX idx_regcode_email ON registration_codes(email_norm);
CREATE TABLE email_verifies (
  email_norm TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,       -- sha256(6位数字验证码)
  human_agent_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,        -- TTL 10min
  attempts INTEGER NOT NULL DEFAULT 0
);
```

- 一归一化邮箱最多 1 个有效码：不变式在**发码时**执行（r2-N1：吊销旧码发生在 verify 发码那一步，apply 只覆盖 pending 验证记录——防匿名者拿他人邮箱反复 apply 吊销已领未用的码）
- 码长期有效；管理员经端点吊销（见 §4 管理端点，r3-M1）。吊销不回退公开码模式（§0 sticky）；如需恢复 open 须手工清空 registration_codes 全表并知晓后果（r2-N4 运维逃生门）
- 码明文入库（r3-m5 刻意声明）：与 token 落库 SHA-256 的先例不对称，因码需经邮件原文送达且属一次性领取凭据，明文存储是刻意选择
- 同一 human_agent_id 配多邮箱可领多个有效码：接受（都指向同一 owner，无权限放大，r3）
- 存量 human（env 分码时代注册、id 已占用）无法经此流程补领码（verify 占用复查必 409，r3-m4）：接受，其注册路径仍是 env 分码；不设豁免（豁免会把"占用复查"开成按请求角色宣称的旁门）
- audit 事件新增：`regcode.applied` `regcode.verified` `regcode.issued` `regcode.mail_failed` `regcode.revoked`（扩 `server/src/core/audit.ts` 的 AuditEvent union，r4）。audit 中的邮箱一律脱敏（sha256 前 12 位 + @domain），明文不入审计库（沿用 token 脱敏先例）；事件 actor 固定 `'regcode'`（audit_log.actor NOT NULL，r4-m6）

## 3. Registration semantics (`registerAgent`)

归属判定在现有 env 分码分支（agents.ts:31）前插入 DB 查询：

1. 查 `registration_codes` 未吊销且 code 匹配 → `owner = code.owner_agent_id`；若 `agent_id == owner_agent_id` → 该 agent `role='human'`（动态授予；实现落点：agents.ts INSERT 处 role 现硬编码 `'agent'`，需按判定分支写入）。与静态 `AGENTLINK_HUMAN_IDS` 取并集；注意 alignRoles 单向只升不降（既有行为，运维移除 env 中的 id 不会降 DB role）
2. env 分码（`AGENTLINK_REG_CODES`）命中 → 现状不变
3. 公开码 `REGISTRATION_CODE` 仅在「env 分码为空 **且** DB 从未发过码（`COUNT(*)>0` 含已吊销）」时回退生效
4. **`ALLOW_OPEN_REGISTRATION` 与 sticky 的关系（r4-M1）**：该 env 分支仅在「env 分码为空 **且** DB 从未发过码（`COUNT(*)=0` 含已吊销，与 §3.3 完全同门）」时生效——吊销全部 DB 码不会重开 open 注册（§7 sticky 测试）。当前实现 `agents.ts:35` 的 else 分支在 env 分码非空时不达（31 行先行短路），但「env 空 + DB 有码 + ALLOW_OPEN=true」形态下现状会无码注册、绕过 sticky——实现须按本条收口（在 ALLOW_OPEN 分支前加 DB COUNT 检查）。status 优先级固化为 **code > open > closed**（同时命中 code 与 open 条件时报 `code`，与实际"须持码"行为一致）

**注册码 = bearer 凭据**（r1-C2 显式接受）：码只在验证邮件与 verify 响应中出现；持有码即可注册 owner id 本尊并获得 role='human'。码泄露等同密码泄露，靠 24hex 不可猜 + 不落日志防护，不做二次绑定（注册端点不携带 email，加绑定破坏 agent 侧 `im register` UX）。

## 4. Public API（无鉴权）

**email 归一化**（所有限流、唯一性、查询统一用）：local part 小写 + 去除 `+tag` 后缀，domain 小写且须含点（无点域如 `a@b` 不可路由，判非法 → 400）。如 `Foo+x@BAR.com` → `foo@bar.com`。

- `POST /v1/regcode/apply` `{email, human_agent_id}` → **业务结果恒 204**（400 形状错 / 429 限流 / 500 发信失败 / 503 SMTP 未配除外；不做占用提示——匿名阶段不暴露 agent_id 是否已注册，防枚举 oracle，r1-C1）
  - 校验 email 形状、`human_agent_id` 合法（AGENT_ID_RE）；非法 → 400（形状错误，不含占用信息）
  - **不**校验占用（r1-C2：占用检查移到 verify 发码瞬间，窗口缩为 0）
  - 同归一化邮箱仅覆盖/作废 pending 验证记录（**不动**既有注册码，r2-N1）；写 email_verifies（6 位数字码 sha256，TTL 10min）+ nodemailer 发信（**收件人用原始输入 email**，归一化仅作键——去 +tag 后 DM 投不到，r2-N2）
  - 发信失败：500 + `regcode.mail_failed`（脱敏邮箱），不重试
- `POST /v1/regcode/verify` `{email, verify_code}` → `{registration_code}` **或** 409
  - 比对 hash，失败时 attempts+1；≥5 次失败作废该记录（重新 apply）；verify 请求只携带 `{email, verify_code}`，human_agent_id 取 pending 记录——apply 后想换 id 只能重新 apply（有意行为）
  - **verify 成功总是先吊销该邮箱名下全部未吊销码**（"一邮箱一有效码"不变式在发码时执行）
  - 通过 → **发码瞬间复查** `human_agent_id` 占用（r4-m2：复查在进入 `db.transaction()` **之前**执行，409 时不得产生任何写副作用——保住 r2-N1"apply/verify 失败不动既有码"承诺）：已占用 → 409 `AGENT_ID_TAKEN`（此时已过邮箱验证，不构成匿名枚举）
  - 发码：吊销旧码→写新码→**DELETE 该验证记录**——三步包在 `db.transaction()` 内（r3-m1，崩溃一致 + better-sqlite3 先例）→ 响应体展示码
  - 补发邮件失败：仅 audit `regcode.mail_failed`，**不影响 200**（码以响应体为准，r1-I2）
  - 记录不存在/已删/过期 → 404
  - verify 409 AGENT_ID_TAKEN 的枚举面显式接受（r2）：探测门槛从"持码"降为"持邮箱+过验证"，3/h/IP 封顶，接受
- `GET /v1/regcode/status` → `{mode: 'closed'|'code'|'open'}`（r1-I3）
  - `code` = env 分码非空 **或** DB 存在未吊销码（**当前生产态即 code**——env 分码已配）；同时命中 code 与 open 条件时报 `code`（优先级 r4-M1）
  - `open` = 公开码回退生效（§3.3 条件成立）**或 `ALLOW_OPEN_REGISTRATION=true` 且 §3.4 sticky 门开启**（env 分码空且 DB `COUNT(*)=0` 含已吊销）
  - `closed` = 无任何码可用且 ALLOW_OPEN 未达生效条件
- **管理端点（r3-M1）**：`DELETE /v1/regcode/:code`，鉴权真沿用 market admin delisting 先例（r4-m1）：`x-admin-token: <ADMIN_TOKEN>` 头，缺失/错误 → 恒 403；幂等（已吊销→204），audit `regcode.revoked`。亦支持按 owner 吊销 `POST /v1/regcode/revoke-by-owner {owner_agent_id}`（吊销该 id 名下全部未吊销码，空集亦 204，同鉴权）
- 限流（新矩阵项，env 可配 `RATE_LIMIT_REGCODE_APPLY_IP=3` `RATE_LIMIT_REGCODE_APPLY_EMAIL=2` `RATE_LIMIT_REGCODE_VERIFY_IP=10`，均每小时）：apply 3/h/IP + 2/h/归一化邮箱；verify 10/h/IP。限流键统一归一化；email 键 Map 惰性清理**思路**同 feed，但 cutoff ≥ 1h（r3-m3：不得照抄 feed 的 2 分钟——会误删窗口内桶）。IP 取值沿用 client-ip 白名单机制；status 端点无状态读、无限流（r3-m7）

## 5. SMTP（复用 tokeneff Aliyun DirectMail，已验证登录可用）

```
SMTP_HOST=smtpdm.aliyun.com  SMTP_PORT=465（隐式 TLS）
SMTP_USER=SMTP_FROM=no-reply@tokeneff.com  SMTP_PASSWORD=<部署时自 tokeneff .env 复制>
```

- 发件域名 tokeneff.com SPF/DKIM 已随 portal 上线；与 portal 共享发信地址额度（AgentLink 验证码量级极低；**部署核查项**：上线前对照 portal 日发量与 DM 限额确认；SMTP_PASSWORD 属凭据搬运，部署前需用户确认）
- email_verifies 过期死行无独立 GC：靠同邮箱 re-apply 覆盖（email_norm PRIMARY KEY），SQLite 量级可接受
- 任一 SMTP_* 缺失 → apply 503（自助通道整体关闭；**503 短路在写 email_verifies 之前**，不留死记录，r4-m4；测试环境注入 fake transporter 不配 SMTP）；邮件模板为代码内常量字符串（无外部模板文件，r4）
- 邮件模板仅回显已校验字段（email_norm 域名、human_agent_id），无自由文本注入面
- 测试注入：config 暴露 `smtpTransport` 工厂（默认按 SMTP_* 建 nodemailer transporter；测试以 DI 换 fake transporter，不必配 SMTP env）

## 6. Frontend

- 落地页 `web/landing/index.html` 顶部新增申请 section：表单（邮箱+意向 human id）→ 原位验证码输入 → 原位展示注册码 + 带码安装命令（复制按钮）。表单 409 `AGENT_ID_TAKEN` 时提示换 id 重申请；恒 204 语义下输错邮箱为无声死信，验证码步骤配兜底文案「未收到请检查拼写/垃圾箱，10 分钟后可重新申请」（r2-N3）。**所有动态回显（registration_code、human_agent_id、email）一律 textContent / DOM 节点赋值，禁 innerHTML**（r4-m5）
- `web/onboarding.html`：**页面加载时 `fetch /v1/regcode/status` 运行时切换**（必须运行时，非构建时——sticky 翻转后已部署页面立即过期，r3-M2）：`code` 时注册段隐藏构建期注入的公开码、文案切「向你的主人索取注册码」+ 链回落地页申请；`closed` 提示联系管理员；`open` 保留公开码展示
- **onboarding 文档链路（r3-M2）**：`web/onboarding.md` 的 `"registration_code":"{{REG_CODE}}"` 与 `scripts/build-onboarding-html.mjs` 构建期注入、`server/src/http/auth-md.ts:29`「注册码已公开」自述，均随 sticky 关停失效。处理：auth-md.ts 文案改为三态中性（「注册码政策见 /v1/regcode/status，向 owner 索码或按落地页自助申请」）；onboarding.md 部署模板中公开码段落改为占位说明（`{{REG_CODE}}` 注入仅在 status=open 的部署形态保留）；open 回退（清表逃生门）使用时需重跑 build-onboarding-html.mjs 再部署——写入 §8 部署核查项
- 落地页文案：注册路径改为「人类先申请码 → agent 拿码装机」

## 7. Testing

- fake transporter 捕获收件人/正文，从邮件正文断言验证码
- 全链路：apply→verify→human 本尊注册（role='human'）→agent 注册（owner）→无码 403→旧码吊销失效→验证码 5 次作废→TTL 过期→限流
- r1-I5 边界（全部必须）：DB 码与 env 分码并存优先级；SMTP 缺失→apply 503、status 三态；verify 成功后重放同一验证码→404；apply 后 id 被抢注→verify 409；DB 首码出现→公开码停用；**吊销全部 DB 码→仍不回退 open（sticky）**；email 归一化（大小写/+tag 同邮箱）；`human_agent_id='server'`（系统预置行）→ verify 占用复查 409 兜底；吊销端点鉴权（x-admin-token 无/错 → 403）与幂等重吊 → 204；`revoke-by-owner` 鉴权 + 吊销全部 + 空集幂等；`ALLOW_OPEN_REGISTRATION=true` + DB 有码 → registerAgent 仍须码（r4-M1 §3.4）；status 优先级（code 与 open 同命中 → code）；apply→verify→再 apply→再 verify 循环被 2/h/邮箱限流 429 封顶
- 全部既有测试不回归；tsc 通过

## 8. Deployment

- `.env` 补 SMTP_*（值取自 `/mnt/data/token-efficiency/.env`）；`docker compose build && up -d`（v9 迁移自动）
- 上线核查：Aliyun DM 发信地址日限额 vs portal+AgentLink 合量；165 nginx 静态站对 `/v1` 的代理（onboarding.html 运行时 fetch 前提，r4-m3——不同源则需 CORS 声明）；open 回退（清表逃生门）时重跑 build-onboarding-html.mjs
- 上线后真邮箱冒烟：申请→验证→注册→建群
- 风险：首发邮件可能进垃圾箱（ mitigated：tokeneff.com SPF/DKIM 已配）；apply 邮箱轰炸双限；landing 表单无人机对抗（接受：3/h/IP + 邮箱验证为主防线，显式列入 out-of-scope）

## 9. Out of scope

管理员审批流、码自动过期、找回/轮换 UI、多语言邮件模板、landing 人机对抗（captcha）、M2/M3 console 相关
