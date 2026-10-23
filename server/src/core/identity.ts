// server/src/core/identity.ts — agent 身份持久化核心：identity key / recovery code 绑定、claim、rotate
// 两码（identity key、recovery code）明文只在返回值中出现一次，库中只存 sha256；
// recovery 消费必须走「带旧值条件的 UPDATE 判 changes」，原子防双花（brief 约束）。
import type { Db } from '../db/sqlite.js'
import { Errors } from '../http/errors.js'
import { sha256Hex, newToken, newId, newRecoveryCode } from './ids.js'
import { audit } from './audit.js'
import { getAgent, rowToAgent, type Agent } from './agents.js'

export { newRecoveryCode } // 生成逻辑在 ids.ts（避免与 agents.ts 循环初始化），此处仅再导出供路由层使用

export interface ClaimInput { identityKey?: string; recoveryCode?: string; agentId?: string }
export interface ClaimResult { agent: Agent; token: string; recoveryCode: string; revokedTokenIds: string[] }

/** 统一的歧义错误：detail JSON 含 agents 列表与 hint 字段（brief 约束） */
function multiError(agentIds: string[]): never {
  const detail = JSON.stringify({
    code: 'IDENTITY_MULTI',
    agents: agentIds,
    hint: 'identity key 命中多个 agent，请携带 agent_id 指定要认领的账号',
  })
  throw Errors.invalidRequest(`IDENTITY_MULTI ${detail}`)
}

/** 撤销 agent 全部有效 token，返回被撤 id 列表（供路由层逐个 onRevoke 关 WS） */
function revokeAllTokens(db: Db, agentId: string): string[] {
  const rows = db.prepare(
    'UPDATE tokens SET revoked_at=? WHERE agent_id=? AND revoked_at IS NULL RETURNING id'
  ).all(new Date().toISOString(), agentId) as { id: string }[]
  return rows.map(r => r.id)
}

/** 滚动 recovery：新码落库并返回明文。原子条件更新防双花——changes=0 说明旧码已被并发消费 */
function rollRecovery(db: Db, agentId: string, oldHash: string | null): string {
  const code = newRecoveryCode()
  if (oldHash === null) {
    db.prepare('UPDATE agents SET recovery_hash=? WHERE id=?').run(sha256Hex(code), agentId)
  } else {
    const r = db.prepare('UPDATE agents SET recovery_hash=? WHERE id=? AND recovery_hash=?')
      .run(sha256Hex(code), agentId, oldHash)
    if (!r.changes) throw Errors.unauthorized() // 旧码已被消费/更换
  }
  return code
}

/** 凭 identityKey / recoveryCode 定位 agent。命中多个且未带 agentId → IDENTITY_MULTI */
function resolveAgent(db: Db, input: ClaimInput, column: 'identity_key_hash' | 'recovery_hash', value: string): { agent: Agent; hash: string } {
  const hash = sha256Hex(value)
  const rows = db.prepare(`SELECT * FROM agents WHERE ${column}=?`).all(hash) as any[]
  if (!rows.length) throw Errors.unauthorized()
  if (rows.length > 1) {
    if (!input.agentId) multiError(rows.map(r => r.id))
    const hit = rows.find(r => r.id === input.agentId)
    if (!hit) throw Errors.unauthorized() // 指定的 agentId 不在命中集合中
    return { agent: rowToAgent(hit), hash }
  }
  return { agent: rowToAgent(rows[0]), hash }
}

/** 认领：验证身份 → 撤全部旧 token → 发新 token + 滚动 recovery。by=key|recovery 记入 audit */
export function claimAgent(db: Db, input: ClaimInput): ClaimResult {
  if (!input.identityKey && !input.recoveryCode) throw Errors.unauthorized()
  const { agent, hash } = input.identityKey
    ? resolveAgent(db, input, 'identity_key_hash', input.identityKey)
    : resolveAgent(db, input, 'recovery_hash', input.recoveryCode!)
  // 原子性关键路径：消费 recovery（可能 401）→ 撤旧 token → 发新 token，三者同事务，
  // 任一步失败整体回滚——失败路径绝不留下「旧 token 已撤又无新 token」的砖号状态
  let recoveryCode = ''
  let revokedTokenIds: string[] = []
  const token = newToken()
  db.transaction(() => {
    recoveryCode = rollRecovery(db, agent.id, input.identityKey ? null : hash)
    revokedTokenIds = revokeAllTokens(db, agent.id)
    db.prepare('INSERT INTO tokens (id, agent_id, name, token_hash, created_at) VALUES (?,?,?,?,?)')
      .run(newId('tok'), agent.id, 'default', sha256Hex(token), new Date().toISOString())
    for (const tid of revokedTokenIds) audit(db, agent.id, 'token.revoked', { token_id: tid })
  })()
  audit(db, agent.id, 'identity.claimed', { by: input.identityKey ? 'key' : 'recovery' })
  return { agent: getAgent(db, agent.id), token, recoveryCode, revokedTokenIds }
}

/** 绑定 identity key：未绑过才允许；同 agent 已绑 → IDENTITY_EXISTS；key 属他人 → IDENTITY_TAKEN */
export function bindIdentityKey(db: Db, agentId: string, identityKey: string): { recoveryCode: string } {
  if (!identityKey) throw Errors.invalidRequest('identity_key required')
  const hash = sha256Hex(identityKey)
  const cur: any = db.prepare('SELECT id, identity_key_hash FROM agents WHERE id=?').get(agentId)
  if (!cur) throw Errors.notFound(`agent ${agentId} not found`)
  if (cur.identity_key_hash) throw Errors.invalidRequest('IDENTITY_EXISTS: agent 已绑定 identity key，请走 rotate')
  const other: any = db.prepare('SELECT id FROM agents WHERE identity_key_hash=?').get(hash)
  if (other) throw Errors.invalidRequest(`IDENTITY_TAKEN: identity key 已被 agent ${other.id} 绑定`)
  // check 与 UPDATE 收进同事务（审计 MEDIUM 2026-10-20：与 claim/rotate 纪律对齐，未来引入异步即 TOCTOU，可造出 spec 禁止的隐式 multi）
  const recoveryCode = newRecoveryCode()
  const ret = db.transaction(() => {
    db.prepare('UPDATE agents SET identity_key_hash=?, recovery_hash=? WHERE id=? AND identity_key_hash IS NULL')
      .run(hash, sha256Hex(recoveryCode), agentId)
    if ((db.prepare("SELECT changes() AS c").get() as { c: number }).c !== 1) throw Errors.invalidRequest('IDENTITY_EXISTS: agent 已绑定 identity key，请走 rotate')
    audit(db, agentId, 'identity.bound', { agent_id: agentId })
    return { recoveryCode }
  })()
  return ret
}

/** 换绑 identity key：先以旧凭据认证（同 claim），再落新 key；旧 key 即刻作废 */
export function rotateIdentity(db: Db, input: ClaimInput & { newIdentityKey: string }): ClaimResult {
  if (!input.newIdentityKey) throw Errors.invalidRequest('new_identity_key required')
  // 同 claim：凭据缺失/无效统一 401（spec §4），避免 undefined 流入 sha256 变 500
  if (!input.identityKey && !input.recoveryCode) throw Errors.unauthorized()
  const { agent, hash } = input.identityKey
    ? resolveAgent(db, input, 'identity_key_hash', input.identityKey)
    : resolveAgent(db, input, 'recovery_hash', input.recoveryCode!)
  const newHash = sha256Hex(input.newIdentityKey)
  const holder: any = db.prepare('SELECT id FROM agents WHERE identity_key_hash=?').get(newHash)
  if (holder) throw Errors.invalidRequest(holder.id === agent.id
    ? 'IDENTITY_TAKEN: new_identity_key 与当前 key 相同'
    : `IDENTITY_TAKEN: identity key 已被 agent ${holder.id} 绑定`)
  // 同 claim：消费 recovery + 换绑 key + 撤旧 token + 发新 token 同事务，失败整体回滚
  let recoveryCode = ''
  let revokedTokenIds: string[] = []
  const token = newToken()
  db.transaction(() => {
    recoveryCode = rollRecovery(db, agent.id, input.identityKey ? null : hash)
    db.prepare('UPDATE agents SET identity_key_hash=? WHERE id=?').run(newHash, agent.id)
    revokedTokenIds = revokeAllTokens(db, agent.id)
    db.prepare('INSERT INTO tokens (id, agent_id, name, token_hash, created_at) VALUES (?,?,?,?,?)')
      .run(newId('tok'), agent.id, 'default', sha256Hex(token), new Date().toISOString())
    for (const tid of revokedTokenIds) audit(db, agent.id, 'token.revoked', { token_id: tid })
  })()
  audit(db, agent.id, 'identity.rotated', { by: input.identityKey ? 'key' : 'recovery' })
  return { agent: getAgent(db, agent.id), token, recoveryCode, revokedTokenIds }
}
