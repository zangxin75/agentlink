import type { FastifyInstance } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import { sendMessage } from '../../core/messages.js'
import { getAgent } from '../../core/agents.js'
import { sendGroupMessage } from '../../core/group-send.js'
import { topicRegistered } from '../../core/topics.js'
import { audit } from '../../core/audit.js'
import { AppError } from '../errors.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'
import type { Bus } from '../../core/bus.js'; import type { RateLimiter } from '../../core/ratelimit.js'

export function registerSendRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; bus: Bus; limiter: RateLimiter }): void {
  const auth = authenticate(deps.db, deps.cfg)
  app.post('/v1/messages', { preHandler: auth, schema: { body: { type: 'object', required: ['to', 'type', 'body', 'client_msg_id'], additionalProperties: false, properties: {
    to: { type: 'string', maxLength: 32 }, type: { enum: ['text', 'file'] },
    // file 分支必须查库校验，AJV 分支罩不住——body 形状粗筛后全交 core sendMessage（设计 v3）
    body: { type: 'object', properties: { text: { type: 'string' }, file_id: { type: 'string', maxLength: 40 }, name: { type: 'string', maxLength: 255 }, size: { type: 'integer' }, sha256: { type: 'string', maxLength: 64 }, note: { type: 'string' } } }, // 大小校验在 core sendMessage（413 PAYLOAD_TOO_LARGE），schema maxLength 会先 400
    client_msg_id: { type: 'string', minLength: 1, maxLength: 64 }, thread_id: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$' }, topic: { type: 'string', maxLength: 32 } } } } }, async (req, reply) => {
    const me = getAuth(req).agent.id
    try { deps.limiter.checkMessage(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(deps.db, me, 'ratelimit.exceeded', { path: '/v1/messages' })
      throw e
    }
    const input = req.body as never as { to: string; type: 'text'; body: { text: string }; client_msg_id: string; thread_id?: string; topic?: string }
    const recipient = getAgent(deps.db, input.to) // 404 if unknown
    if (recipient.role === 'group') {
      // r1-M4：im send 实际入径——群 id 不直插单行，与 groups 端点共用 fanout（WS 同 id 会被 hub 拒绝，Task 6）
      const out = sendGroupMessage(deps.db, deps.bus, me, { to: input.to, type: input.type, body: input.body as never, client_msg_id: input.client_msg_id })
      return reply.status(out.deduplicated ? 200 : 201).send(out)
    }
    const out = sendMessage(deps.db, deps.bus, me, input)
    // topic_registered：对端是否活跃注册了该 topic（未注册不拒收，仅提示发送方）
    const res = { ...out, topic_registered: topicRegistered(deps.db, input.to, out.message.topic) }
    return reply.status(out.deduplicated ? 200 : 201).send(res)
  })
}
