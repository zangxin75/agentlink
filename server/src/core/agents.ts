import type { Db } from '../db/sqlite.js'
import type { Config } from '../config.js'
import { Errors } from '../http/errors.js'
import { newId, newToken, newRecoveryCode, sha256Hex } from './ids.js'
import { audit } from './audit.js'
import { newWebhookSecret } from './webhook.js'
import { validateProfile } from './profile.js'

export interface TaskPolicy { mode: 'closed' | 'allowlist' | 'confirm' | 'open'; allowlist: string[]; scope: 'read-only' | 'full' }
export interface Agent { id: string; display_name: string; description: string; capabilities: string[]; task_policy: TaskPolicy; created_at: string; last_seen_at: string; profile: any; profile_updated_at: string; role: string; owner: string }

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9.-]{2,31}$/ // allow dots: spec/test ids are e.g. 'alice.dev'
export const defaultPolicy = (): TaskPolicy => ({ mode: 'open', allowlist: [], scope: 'read-only' })

export function rowToAgent(r: any): Agent {
  let profile: any = {}
  try { profile = JSON.parse(r.profile ?? '{}') } catch { profile = {} } // 损坏 JSON 不致整条查询炸
  return { id: r.id, display_name: r.display_name, description: r.description, capabilities: JSON.parse(r.capabilities), task_policy: JSON.parse(r.task_policy), created_at: r.created_at, last_seen_at: r.last_seen_at, profile, profile_updated_at: r.profile_updated_at ?? '', role: r.role ?? 'agent', owner: r.owner ?? '' }
}

export function getAgent(db: Db, id: string): Agent {
  const r = db.prepare('SELECT * FROM agents WHERE id=?').get(id)
  if (!r) throw Errors.notFound(`agent ${id} not found`)
  return rowToAgent(r)
}

export function registerAgent(db: Db, cfg: Config, input: { agent_id: string; display_name?: string; description?: string; capabilities?: string[]; registration_code?: string; identity_key?: string }): { agent: Agent; token: string; recovery_code?: string } {
  // 归属判定（spec §1.5 + regcode v9 §3）：DB 未吊销码优先——码即归属，agent_id==owner 则该 agent 是 human；
  // 次选 env 分码；公开码回退与 ALLOW_OPEN 共用 sticky 门（env 分码空 且 DB 从未发过码，COUNT(*) 含已吊销，r4-M1）
  let owner: string
  let role: string = 'agent'
  const dbCode = input.registration_code
    ? db.prepare('SELECT owner_agent_id FROM registration_codes WHERE code=? AND revoked_at IS NULL').get(input.registration_code) as { owner_agent_id: string } | undefined
    : undefined
  if (dbCode) {
    owner = dbCode.owner_agent_id
    if (input.agent_id === owner) role = 'human'
  } else if (cfg.regCodes.size) {
    owner = cfg.regCodes.get(input.registration_code ?? '') ?? ''
    if (!owner) throw Errors.forbidden('invalid registration code') // 分码即归属，无码无归属
  } else {
    const issued = (db.prepare('SELECT COUNT(*) c FROM registration_codes').get() as { c: number }).c > 0
    if (cfg.registrationCode && !issued) {
      if (input.registration_code !== cfg.registrationCode) throw Errors.forbidden('invalid registration code')
      owner = cfg.defaultOwner ?? ''
    } else if (cfg.allowOpenRegistration && !issued) {
      owner = cfg.defaultOwner ?? ''
    } else throw Errors.registrationClosed()
  }
  if (!AGENT_ID_RE.test(input.agent_id ?? '')) throw Errors.invalidRequest('agent_id must match ^[a-z0-9][a-z0-9.-]{2,31}$')
  if (db.prepare('SELECT 1 FROM agents WHERE id=?').get(input.agent_id)) throw Errors.invalidRequest('agent_id already taken')
  // identity key 冲突：已有 agent 绑定同 key → IDENTITY_MULTI（detail JSON 含 agents 列表与 hint）
  let recovery_code: string | undefined
  let identityHash: string | undefined
  if (input.identity_key) {
    identityHash = sha256Hex(input.identity_key)
    const holders = db.prepare('SELECT id FROM agents WHERE identity_key_hash=?').all(identityHash) as { id: string }[]
    if (holders.length) {
      const detail = JSON.stringify({ code: 'IDENTITY_MULTI', agents: holders.map(h => h.id), hint: 'identity key 已绑定，请用其 claim 找回原账号，或换新 key 注册' })
      throw Errors.invalidRequest(`IDENTITY_MULTI ${detail}`)
    }
    recovery_code = newRecoveryCode()
  }
  if ((input.display_name ?? '').length > 64) throw Errors.invalidRequest('display_name too long')
  if ((input.description ?? '').length > 500) throw Errors.invalidRequest('description too long')
  if ((input.capabilities ?? []).length > 20) throw Errors.invalidRequest('too many capabilities')
  const now = new Date().toISOString()
  const agent: Agent = { id: input.agent_id, display_name: input.display_name ?? input.agent_id, description: input.description ?? '', capabilities: input.capabilities ?? [], task_policy: defaultPolicy(), created_at: now, last_seen_at: now, profile: {}, profile_updated_at: '', role, owner }
  const token = newToken()
  db.transaction(() => {
    db.prepare('INSERT INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at, identity_key_hash, recovery_hash, role, owner) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(agent.id, agent.display_name, agent.description, JSON.stringify(agent.capabilities), JSON.stringify(agent.task_policy), now, now, identityHash ?? null, recovery_code ? sha256Hex(recovery_code) : null, role, owner)
    db.prepare('INSERT INTO tokens (id, agent_id, name, token_hash, created_at) VALUES (?,?,?,?,?)')
      .run(newId('tok'), agent.id, 'default', sha256Hex(token), now)
  })()
  audit(db, agent.id, 'agent.registered', { agent_id: agent.id })
  return { agent, token, recovery_code }
}

// role 对齐主体=server（r2-N4）：启动时按 HUMAN_IDS 置 human；幂等；客户端惰性仅显示兜底
export function alignRoles(db: Db, humanIds: string[]): void {
  for (const id of humanIds) db.prepare(`UPDATE agents SET role='human' WHERE id=?`).run(id)
}

const authFailedThrottle = new Map<string, number>() // token-hash 前缀 → 上次落 audit 时刻（进程内采样窗）

export function verifyToken(db: Db, token: string): { agent: Agent; tokenId: string } {
  const row: any = db.prepare('SELECT t.id as tid, t.last_used_at, a.* FROM tokens t JOIN agents a ON a.id=t.agent_id WHERE t.token_hash=? AND t.revoked_at IS NULL').get(sha256Hex(token ?? ''))
  if (!row) {
    // 审计 2026-10-21：未鉴权即可触发 auth.failed 写放大——同一 token 前缀 60s 窗采样合并，只落首条
    if (token) {
      const key = sha256Hex(token).slice(0, 12)
      const now = Date.now()
      if (!authFailedThrottle.has(key) || now - (authFailedThrottle.get(key) as number) > 60_000) {
        authFailedThrottle.set(key, now)
        if (authFailedThrottle.size > 1024) authFailedThrottle.clear() // 防键空间被随机 token 撑爆
        audit(db, 'unknown', 'auth.failed', { token_prefix: key })
      }
    }
    throw Errors.unauthorized()
  }
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

export function searchAgents(db: Db, q: { q?: string; capability?: string; online?: boolean; all?: boolean }, onlineIds: Set<string>, presenceWindowMs: number): Agent[] {
  // 默认滤群伪 agent（role='group'）——目录面向"可对话对象"；?all=true 列出（console 建群选择用）
  let out = (db.prepare(q.all ? `SELECT * FROM agents WHERE id != 'server' ORDER BY id` : `SELECT * FROM agents WHERE id != 'server' AND role != 'group' ORDER BY id`).all() as any[]).map(rowToAgent) // 'server' 为 srv: 派生消息的系统账户，不进目录
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
