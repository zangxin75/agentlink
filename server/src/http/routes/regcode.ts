// 邮箱自助注册码路由（spec §4）：apply/verify/status 无鉴权；吊销走 x-admin-token（market.ts 先例，恒 403）
import type { FastifyInstance } from 'fastify'
import type { Db } from '../../db/sqlite.js'
import type { Config } from '../../config.js'
import type { RateLimiter } from '../../core/ratelimit.js'
import { Errors } from '../errors.js'
import { clientIp } from '../client-ip.js'
import { applyRegcode, verifyRegcode, regcodeStatus, revokeRegcode, revokeByOwner, normalizeEmail } from '../../core/regcodes.js'

const adminGuard = (cfg: Config, req: { headers: Record<string, unknown> }): void => {
  const token = req.headers['x-admin-token']
  if (!cfg.adminToken || token !== cfg.adminToken) throw Errors.forbidden('invalid admin token')
}

export function registerRegcodeRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; limiter: RateLimiter }): void {
  app.post('/v1/regcode/apply', { schema: { body: { type: 'object', required: ['email', 'human_agent_id'], additionalProperties: false, properties: {
    email: { type: 'string', maxLength: 254 }, human_agent_id: { type: 'string', maxLength: 32 } } } } }, async (req, reply) => {
    const body = req.body as { email: string; human_agent_id: string }
    // r3-P4（声明为刻意）：限流在 core 形状校验之前——非法形状也耗 IP 桶（自我 DoS 无实害，
    // 且先限流可挡匿名滥用面；与 register 路由"先限流后校验"同序）；email 键仅在可归一化时计
    const norm = normalizeEmail(body.email)
    if (norm) deps.limiter.checkRegcodeApplyEmail(norm)
    deps.limiter.checkRegcodeApplyIp(clientIp(req, deps.cfg.trustedProxies))
    await applyRegcode(deps.db, body, deps.cfg.smtpTransport())
    return reply.status(204).send()
  })
  app.post('/v1/regcode/verify', { schema: { body: { type: 'object', required: ['email', 'verify_code'], additionalProperties: false, properties: {
    email: { type: 'string', maxLength: 254 }, verify_code: { type: 'string', maxLength: 6 } } } } }, async (req) => {
    deps.limiter.checkRegcodeVerifyIp(clientIp(req, deps.cfg.trustedProxies))
    return verifyRegcode(deps.db, req.body as { email: string; verify_code: string }, deps.cfg.smtpTransport())
  })
  app.get('/v1/regcode/status', async () => ({ mode: regcodeStatus(deps.db, deps.cfg) }))
  app.delete('/v1/regcode/:code', async (req, reply) => {
    adminGuard(deps.cfg, req)
    revokeRegcode(deps.db, (req.params as { code: string }).code)
    return reply.status(204).send()
  })
  app.post('/v1/regcode/revoke-by-owner', { schema: { body: { type: 'object', required: ['owner_agent_id'], additionalProperties: false, properties: { owner_agent_id: { type: 'string', maxLength: 32 } } } } }, async (req, reply) => {
    adminGuard(deps.cfg, req)
    revokeByOwner(deps.db, (req.body as { owner_agent_id: string }).owner_agent_id)
    return reply.status(204).send()
  })
}
