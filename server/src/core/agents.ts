import type { Db } from '../db/sqlite.js'
import type { Config } from '../config.js'
import { Errors } from '../http/errors.js'
import { newId, newToken, sha256Hex } from './ids.js'
import { audit } from './audit.js'
import { newWebhookSecret } from './webhook.js'
import { validateProfile } from './profile.js'

export interface TaskPolicy { mode: 'closed' | 'allowlist' | 'confirm' | 'open'; allowlist: string[]; scope: 'read-only' | 'full' }
export interface Agent { id: string; display_name: string; description: string; capabilities: string[]; task_policy: TaskPolicy; created_at: string; last_seen_at: string; profile: any; profile_updated_at: string }

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9.-]{2,31}$/ // allow dots: spec/test ids are e.g. 'alice.dev'
export const defaultPolicy = (): TaskPolicy => ({ mode: 'open', allowlist: [], scope: 'read-only' })

export function rowToAgent(r: any): Agent {
  let profile: any = {}
  try { profile = JSON.parse(r.profile ?? '{}') } catch { profile = {} } // 损坏 JSON 不致整条查询炸
  return { id: r.id, display_name: r.display_name, description: r.description, capabilities: JSON.parse(r.capabilities), task_policy: JSON.parse(r.task_policy), created_at: r.created_at, last_seen_at: r.last_seen_at, profile, profile_updated_at: r.profile_updated_at ?? '' }
}

export function getAgent(db: Db, id: string): Agent {
  const r = db.prepare('SELECT * FROM agents WHERE id=?').get(id)
  if (!r) throw Errors.notFound(`agent ${id} not found`)
  return rowToAgent(r)
}

export function registerAgent(db: Db, cfg: Config, input: { agent_id: string; display_name?: string; description?: string; capabilities?: string[]; registration_code?: string }): { agent: Agent; token: string } {
  if (!cfg.registrationCode && !cfg.allowOpenRegistration) throw Errors.registrationClosed()
  if (cfg.registrationCode && input.registration_code !== cfg.registrationCode) throw Errors.forbidden('invalid registration code')
  if (!AGENT_ID_RE.test(input.agent_id ?? '')) throw Errors.invalidRequest('agent_id must match ^[a-z0-9][a-z0-9.-]{2,31}$')
  if (db.prepare('SELECT 1 FROM agents WHERE id=?').get(input.agent_id)) throw Errors.invalidRequest('agent_id already taken')
  if ((input.display_name ?? '').length > 64) throw Errors.invalidRequest('display_name too long')
  if ((input.description ?? '').length > 500) throw Errors.invalidRequest('description too long')
  if ((input.capabilities ?? []).length > 20) throw Errors.invalidRequest('too many capabilities')
  const now = new Date().toISOString()
  const agent: Agent = { id: input.agent_id, display_name: input.display_name ?? input.agent_id, description: input.description ?? '', capabilities: input.capabilities ?? [], task_policy: defaultPolicy(), created_at: now, last_seen_at: now, profile: {}, profile_updated_at: '' }
  const token = newToken()
  db.transaction(() => {
    db.prepare('INSERT INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at) VALUES (?,?,?,?,?,?,?)')
      .run(agent.id, agent.display_name, agent.description, JSON.stringify(agent.capabilities), JSON.stringify(agent.task_policy), now, now)
    db.prepare('INSERT INTO tokens (id, agent_id, name, token_hash, created_at) VALUES (?,?,?,?,?)')
      .run(newId('tok'), agent.id, 'default', sha256Hex(token), now)
  })()
  audit(db, agent.id, 'agent.registered', { agent_id: agent.id })
  return { agent, token }
}

export function verifyToken(db: Db, token: string): { agent: Agent; tokenId: string } {
  const row: any = db.prepare('SELECT t.id as tid, t.last_used_at, a.* FROM tokens t JOIN agents a ON a.id=t.agent_id WHERE t.token_hash=? AND t.revoked_at IS NULL').get(sha256Hex(token ?? ''))
  if (!row) { if (token) audit(db, 'unknown', 'auth.failed', {}); throw Errors.unauthorized() }
  const throttle = 60_000
  if (!row.last_used_at || Date.now() - Date.parse(row.last_used_at) > throttle)
    db.prepare('UPDATE tokens SET last_used_at=? WHERE id=?').run(new Date().toISOString(), row.tid)
  return { agent: rowToAgent(row), tokenId: row.tid }
}

export function updateProfile(db: Db, agentId: string, patch: { display_name?: string; description?: string; capabilities?: string[]; task_policy?: TaskPolicy; webhook_url?: string; profile?: unknown }): { agent: Agent; webhook_secret?: string } {
  // 互斥(spec §3.2 M3):给 profile 即从 skills[].name 派生覆写 capabilities,两事实源不并存
  if (patch.profile !== undefined && patch.capabilities !== undefined) throw Errors.invalidRequest('profile 与 capabilities 互斥:给 profile 时 capabilities 由 skills[].name 派生')
  const cur = getAgent(db, agentId)
  const next = { ...cur, ...patch } as Agent
  // profile 分支:校验单点 + 派生覆写 capabilities({} 即 []);sets/vals 拼接集中在既有循环后
  let profileNorm: ReturnType<typeof validateProfile> | undefined
  if (patch.profile !== undefined) {
    profileNorm = validateProfile(patch.profile)
    next.capabilities = (profileNorm.skills ?? []).map(s => s.name)
  }
  const sets: string[] = []; const vals: unknown[] = []
  for (const k of ['display_name', 'description'] as const) if (patch[k] !== undefined) { sets.push(`${k}=?`); vals.push(next[k]) }
  if (patch.capabilities !== undefined) { sets.push('capabilities=?'); vals.push(JSON.stringify(next.capabilities)) }
  if (patch.task_policy !== undefined) { sets.push('task_policy=?'); vals.push(JSON.stringify(next.task_policy)) }
  // webhook 块须在「无字段可更新」提前 return 之前，否则仅传 webhook_url 时不会落库（r1-M-b）
  let webhookSecret: string | undefined
  if (patch.webhook_url !== undefined) {
    if (patch.webhook_url !== '' && !/^https?:\/\//.test(patch.webhook_url)) throw Errors.invalidRequest('webhook_url must be http(s)')
    if (Buffer.byteLength(patch.webhook_url) > 512) throw Errors.invalidRequest('webhook_url too long')
    sets.push('webhook_url=?'); vals.push(patch.webhook_url)
    const curRow: any = db.prepare('SELECT webhook_secret FROM agents WHERE id=?').get(agentId)
    // 仅设置/更新 URL 时才在无 secret 情况下生成；「关闭」（webhook_url:''）不凭空发新钥匙（终审 M3）。关闭再开沿用旧 secret
    if (patch.webhook_url !== '' && !curRow?.webhook_secret) { webhookSecret = newWebhookSecret(); sets.push('webhook_secret=?'); vals.push(webhookSecret) }
  }
  if (patch.profile !== undefined) {
    sets.push('profile=?', 'profile_updated_at=?', 'capabilities=?')
    vals.push(JSON.stringify(profileNorm), new Date().toISOString(), JSON.stringify(next.capabilities))
  }
  if (!sets.length) return { agent: cur }
  vals.push(agentId)
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id=?`).run(...vals)
  if (patch.task_policy) audit(db, agentId, 'agent.policy_changed', { before: cur.task_policy, after: patch.task_policy })
  else audit(db, agentId, 'agent.profile_updated', { fields: Object.keys(patch) })
  return { agent: getAgent(db, agentId), webhook_secret: webhookSecret }
}

export function createToken(db: Db, agentId: string, name: string): { id: string; token: string } {
  const token = newToken(); const id = newId('tok'); const now = new Date().toISOString()
  db.prepare('INSERT INTO tokens (id, agent_id, name, token_hash, created_at) VALUES (?,?,?,?,?)').run(id, agentId, name || 'default', sha256Hex(token), now)
  audit(db, agentId, 'token.created', { token_id: id, name })
  return { id, token }
}

export function listTokens(db: Db, agentId: string) {
  return db.prepare('SELECT id, name, created_at, last_used_at, revoked_at FROM tokens WHERE agent_id=? ORDER BY created_at').all(agentId)
}

export function revokeToken(db: Db, agentId: string, tokenId: string): void {
  const r = db.prepare('SELECT id FROM tokens WHERE id=? AND agent_id=?').get(tokenId, agentId)
  if (!r) throw Errors.notFound('token not found')
  db.prepare('UPDATE tokens SET revoked_at=? WHERE id=?').run(new Date().toISOString(), tokenId)
  audit(db, agentId, 'token.revoked', { token_id: tokenId })
}

export function searchAgents(db: Db, q: { q?: string; capability?: string; online?: boolean }, onlineIds: Set<string>, presenceWindowMs: number): Agent[] {
  let out = (db.prepare(`SELECT * FROM agents WHERE id != 'server' ORDER BY id`).all() as any[]).map(rowToAgent) // 'server' 为 srv: 派生消息的系统账户，不进目录
  if (q.capability) { const want = q.capability.split(',').map(s => s.trim()).filter(Boolean); out = out.filter(a => want.every(w => a.capabilities.includes(w))) } // 逗号分隔 AND,单值行为不变(spec §3.2)
  if (q.q) out = out.filter(a => {
    const prof = a.profile ?? {}
    const hay = [a.id, a.display_name, a.description, a.capabilities.join(' '), prof.headline ?? '',
      ...(prof.projects ?? []).map((p: any) => `${p.name} ${p.summary ?? ''}`), ...(prof.skills ?? []).map((s: any) => s.name)].join(' ')
    return hay.toLowerCase().includes(q.q!.toLowerCase())
  }) // spec §8：q 匹配 capabilities/id/display/description + profile 全文
  if (q.online) out = out.filter(a => onlineIds.has(a.id) || Date.now() - Date.parse(a.last_seen_at) < presenceWindowMs)
  return out
}

export function touchLastSeen(db: Db, agentId: string, throttleMs: number): void {
  const r: any = db.prepare('SELECT last_seen_at FROM agents WHERE id=?').get(agentId)
  if (!r || Date.now() - Date.parse(r.last_seen_at) > throttleMs)
    db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(new Date().toISOString(), agentId)
}
