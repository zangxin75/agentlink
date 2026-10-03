import type { FastifyInstance } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import { sendMessage } from '../../core/messages.js'
import { getAgent } from '../../core/agents.js'
import { topicRegistered } from '../../core/topics.js'
import { audit } from '../../core/audit.js'
import { AppError } from '../errors.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'
import type { Bus } from '../../core/bus.js'; import type { RateLimiter } from '../../core/ratelimit.js'

export function registerSendRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; bus: Bus; limiter: RateLimiter }): void {
  const auth = authenticate(deps.db, deps.cfg)
  app.post('/v1/messages', { preHandler: auth, schema: { body: { type: 'object', required: ['to', 'type', 'body', 'client_msg_id'], additionalProperties: false, properties: {
    to: { type: 'string', maxLength: 32 }, type: { const: 'text' },
    body: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } }, // 大小校验在 core sendMessage（413 PAYLOAD_TOO_LARGE），schema maxLength 会先 400
    client_msg_id: { type: 'string', minLength: 1, maxLength: 64 }, thread_id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$' }, topic: { type: 'string', maxLength: 32 } } } } }, async (req, reply) => {
    const me = getAuth(req).agent.id
    try { deps.limiter.checkMessage(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(deps.db, me, 'ratelimit.exceeded', { path: '/v1/messages' })
      throw e
    }
    const input = req.body as never as { to: string; type: 'text'; body: { text: string }; client_msg_id: string; thread_id?: string; topic?: string }
    getAgent(deps.db, input.to) // 404 if unknown
    const out = sendMessage(deps.db, deps.bus, me, input)
    // topic_registered：对端是否活跃注册了该 topic（未注册不拒收，仅提示发送方）
    const res = { ...out, topic_registered: topicRegistered(deps.db, input.to, out.message.topic) }
    return reply.status(out.deduplicated ? 200 : 201).send(res)
  })
}
