// 邮箱自助注册码 core（spec 2026-10-22-email-regcode-design.md §2/§3/§4，r1-r4 收敛）
// apply 零占用提示（防枚举）；verify 占用复查在事务外（409 零副作用）；sticky 门含已吊销
import { randomBytes, randomInt } from 'node:crypto'
import type { Db } from '../db/sqlite.js'
import { Errors } from '../http/errors.js'
import { sha256Hex } from './ids.js'
import { audit } from './audit.js'
import { AGENT_ID_RE } from './agents.js'

export interface MailTransport { sendMail(opts: { to: string; subject: string; text: string }): Promise<unknown> }

export function normalizeEmail(email: string): string | null {
  const m = /^([^@]+)@([^@]+)$/.exec((email ?? '').trim())
  if (!m || !m[2].includes('.')) return null
  return `${m[1].toLowerCase().replace(/\+.*$/, '')}@${m[2].toLowerCase()}`
}

export const maskEmail = (emailNorm: string): string => sha256Hex(emailNorm).slice(0, 12) + '@' + emailNorm.split('@')[1]
const aud = (db: Db, event: 'regcode.applied' | 'regcode.verified' | 'regcode.issued' | 'regcode.mail_failed' | 'regcode.revoked', detail: Record<string, unknown>) =>
  audit(db, 'regcode', event, detail) // actor 固定 'regcode'（r4-m6）；邮箱一律 maskEmail 后入 detail

const newRegCode = (): string => 'al_reg_' + randomBytes(12).toString('hex')

export async function applyRegcode(db: Db, input: { email: string; human_agent_id: string }, transport: MailTransport | null): Promise<void> {
  // r1-C2：形状校验先行——形状非法时即使 SMTP 未配也回 400（信息更准），503 不得吞 400
  const norm = normalizeEmail(input.email)
  if (!norm) throw Errors.invalidRequest('email invalid')
  if (!AGENT_ID_RE.test(input.human_agent_id ?? '')) throw Errors.invalidRequest('human_agent_id must match ^[a-z0-9][a-z0-9.-]{2,31}$')
  if (!transport) throw Errors.smtpNotConfigured() // 503 短路仍在写库之前（r4-m4）
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const expires = new Date(Date.now() + 10 * 60_000).toISOString()
  try {
    await transport.sendMail({ to: input.email.trim(), subject: 'AgentLink 注册验证码', text: `你的验证码是 ${code}，10 分钟内有效。用它确认申请注册码，注册码将归属 ${input.human_agent_id}。` })
  } catch (e) {
    aud(db, 'regcode.mail_failed', { stage: 'apply', email: maskEmail(norm) })
    throw Errors.internal('mail send failed')
  }
  db.prepare(`INSERT INTO email_verifies (email_norm, secret_hash, human_agent_id, expires_at, attempts) VALUES (?,?,?,?,0)
    ON CONFLICT(email_norm) DO UPDATE SET secret_hash=excluded.secret_hash, human_agent_id=excluded.human_agent_id, expires_at=excluded.expires_at, attempts=0`)
    .run(norm, sha256Hex(code), input.human_agent_id, expires)
  aud(db, 'regcode.applied', { email: maskEmail(norm), human_agent_id: input.human_agent_id })
}

export async function verifyRegcode(db: Db, input: { email: string; verify_code: string }, transport: MailTransport | null): Promise<{ registration_code: string }> {
  const norm = normalizeEmail(input.email)
  const row = norm ? db.prepare('SELECT * FROM email_verifies WHERE email_norm=?').get(norm) as { secret_hash: string; human_agent_id: string; expires_at: string; attempts: number } | undefined : undefined
  const gone = () => Errors.notFound('verify record not found / expired')
  if (!row || Date.parse(row.expires_at) <= Date.now()) throw gone()
  if (sha256Hex(input.verify_code ?? '') !== row.secret_hash) {
    if (row.attempts + 1 >= 5) db.prepare('DELETE FROM email_verifies WHERE email_norm=?').run(norm!)
    else db.prepare('UPDATE email_verifies SET attempts=attempts+1 WHERE email_norm=?').run(norm!)
    throw gone()
  }
  // 占用复查在事务外（r4-m2）：409 时零写副作用（含 audit——verified 事件移到 409 之后，r1 minor）
  if (db.prepare('SELECT 1 FROM agents WHERE id=?').get(row.human_agent_id)) throw Errors.agentIdTaken()
  aud(db, 'regcode.verified', { email: maskEmail(norm!) })
  const code = newRegCode()
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare('UPDATE registration_codes SET revoked_at=? WHERE email_norm=? AND revoked_at IS NULL').run(now, norm) // 一归一化邮箱一有效码，发码时执行（spec §2，r2-N1；同 id 多邮箱可各领，不按 owner 吊销）
    db.prepare('INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES (?,?,?,?)').run(code, row.human_agent_id, norm, now)
    db.prepare('DELETE FROM email_verifies WHERE email_norm=?').run(norm) // 一次性防重放（r1-I1）
  })()
  aud(db, 'regcode.issued', { email: maskEmail(norm!), human_agent_id: row.human_agent_id })
  if (transport) {
    try { await transport.sendMail({ to: input.email.trim(), subject: 'AgentLink 注册码', text: `你的注册码：${code}\nagent 注册命令：im register <agent_id> --code ${code}\n该码注册的 agent 将归属 ${row.human_agent_id}。` }) }
    catch { aud(db, 'regcode.mail_failed', { stage: 'issue', email: maskEmail(norm!) }) } // 补发失败不影响发码（r1-I2）
  }
  return { registration_code: code }
}

// 三态（§4，r4-M1 优先级 code > open > closed）；sticky 门 = env 分码空 且 DB 从未发过码（COUNT(*) 含已吊销）
export function regcodeStatus(db: Db, cfg: { regCodes: Map<string, string>; registrationCode: string | null; allowOpenRegistration: boolean }): 'closed' | 'code' | 'open' {
  const anyCode = (db.prepare('SELECT COUNT(*) c FROM registration_codes').get() as { c: number }).c
  const unrevoked = (db.prepare('SELECT COUNT(*) c FROM registration_codes WHERE revoked_at IS NULL').get() as { c: number }).c
  if (cfg.regCodes.size || unrevoked > 0) return 'code'
  if ((cfg.registrationCode || cfg.allowOpenRegistration) && anyCode === 0) return 'open'
  return 'closed'
}

export function revokeRegcode(db: Db, code: string): void {
  const r = db.prepare('UPDATE registration_codes SET revoked_at=? WHERE code=? AND revoked_at IS NULL').run(new Date().toISOString(), code)
  if (r.changes) aud(db, 'regcode.revoked', { code_prefix: code.slice(0, 12) }) // r1-M2：幂等重吊不重复 audit
}

export function revokeByOwner(db: Db, ownerAgentId: string): number {
  const r = db.prepare('UPDATE registration_codes SET revoked_at=? WHERE owner_agent_id=? AND revoked_at IS NULL').run(new Date().toISOString(), ownerAgentId)
  if (r.changes) aud(db, 'regcode.revoked', { owner_agent_id: ownerAgentId, count: r.changes })
  return r.changes
}
