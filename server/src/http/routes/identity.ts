// server/src/http/routes/identity.ts — /v1/identity claim|bind|rotate 路由
// claim/rotate 免注册码（key/恢复码即凭据），独立限流 claim:${ip}；
// core 层身份冲突以 INVALID_REQUEST(400) + detail 抛出，此处统一映射为 409（brief 错误口径）。
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { Db } from '../../db/sqlite.js'
import type { Config } from '../../config.js'
import type { RateLimiter } from '../../core/ratelimit.js'
import { AppError } from '../errors.js'
import { authenticate, getAuth } from '../auth.js'
import { audit } from '../../core/audit.js'
import { bindIdentityKey, claimAgent, rotateIdentity } from '../../core/identity.js'
import { clientIp } from '../client-ip.js'

/** core 抛出的 IDENTITY_* 冲突（400）→ 409 变体：error 里附 detail JSON（agents/hint 等） */
export function mapIdentityConflict(err: unknown, reply: FastifyReply): FastifyReply | void {
  if (!(err instanceof AppError) || err.status !== 400) return
  const m = /^(IDENTITY_[A-Z]+)[: ](.*)$/.exec(err.message)
  if (!m) return
  let detail: Record<string, unknown> = {}
  try { detail = JSON.parse(m[2]) } catch { detail = { detail: m[2] } }
  return reply.status(409).send({ error: { code: m[1], message: err.message, ...detail } })
}

export function registerIdentityRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; limiter: RateLimiter; onRevoke?: (tokenId: string) => void }): void {
  const ip = (req: any) => clientIp(req, deps.cfg.trustedProxies) // 限流来源 IP：仅可信代理来源采信 XFF 末段（审计 2026-10-20/2026-10-21）
  // HTTP 侧 snake_case → core ClaimInput camelCase（Task 1 契约）
  const toCore = (b: { identity_key?: string; recovery_code?: string; agent_id?: string; new_identity_key?: string }) => ({
    identityKey: b.identity_key, recoveryCode: b.recovery_code, agentId: b.agent_id, newIdentityKey: b.new_identity_key,
  })

  // claim：凭 key/恢复码认领原 agent → 撤全部旧 token（逐个踢 WS）→ 发新 token + 滚 recovery
  app.post('/v1/identity/claim', {
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      identity_key: { type: 'string', maxLength: 128 }, recovery_code: { type: 'string', maxLength: 128 }, agent_id: { type: 'string', maxLength: 32 },
    } } },
  }, async (req, reply) => {
    deps.limiter.checkClaim(ip(req))
    try {
      const r = claimAgent(deps.db, toCore(req.body as never))
      for (const tid of r.revokedTokenIds) deps.onRevoke?.(tid)
      return reply.status(200).send({ agent: r.agent, token: r.token, recovery_code: r.recoveryCode })
    } catch (err) {
      // 凭据失败也落 audit（actor=unknown，含 IP）——爆破告警数据源（spec §7）
      if (err instanceof AppError && err.status === 401)
        audit(deps.db, 'unknown', 'identity.claim_failed', { ip: ip(req) })
      const mapped = mapIdentityConflict(err, reply)
      if (mapped) return mapped
      throw err
    }
  })

  // bind：bearer 现有 token 为当前 agent 补绑 key，颁发一次性 recovery_code
  const auth = authenticate(deps.db, deps.cfg)
  app.post('/v1/identity/bind', { preHandler: auth, schema: { body: { type: 'object', required: ['identity_key'], additionalProperties: false, properties: { identity_key: { type: 'string', maxLength: 128 } } } } }, async (req, reply) => {
    // spec §4：/v1/identity/* 全部吃 claim:${ip} 独立桶（bind 虽需 bearer，仍计入）
    deps.limiter.checkClaim(ip(req))
    try {
      const r = bindIdentityKey(deps.db, getAuth(req).agent.id, (req.body as any).identity_key)
      return reply.status(201).send({ recovery_code: r.recoveryCode })
    } catch (err) {
      const mapped = mapIdentityConflict(err, reply)
      if (mapped) return mapped
      throw err
    }
  })

  // rotate：旧凭据认证 → 换绑新 key（旧 key 即刻作废）+ 滚 recovery + 撤全部旧 token
  app.post('/v1/identity/rotate', {
    schema: { body: { type: 'object', required: ['new_identity_key'], additionalProperties: false, properties: {
      identity_key: { type: 'string', maxLength: 128 }, recovery_code: { type: 'string', maxLength: 128 }, agent_id: { type: 'string', maxLength: 32 },
      new_identity_key: { type: 'string', maxLength: 128 },
    } } },
  }, async (req, reply) => {
    deps.limiter.checkClaim(ip(req))
    try {
      const r = rotateIdentity(deps.db, toCore(req.body as never) as never)
      for (const tid of r.revokedTokenIds) deps.onRevoke?.(tid)
      return reply.status(200).send({ agent: r.agent, token: r.token, recovery_code: r.recoveryCode })
    } catch (err) {
      if (err instanceof AppError && err.status === 401)
        audit(deps.db, 'unknown', 'identity.claim_failed', { ip: ip(req) })
      const mapped = mapIdentityConflict(err, reply)
      if (mapped) return mapped
      throw err
    }
  })
}
