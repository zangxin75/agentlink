// Webhook 测试端点：手动触发一次 webhook.test 投递（auth + 限流）
import type { FastifyInstance } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import type { Db } from '../../db/sqlite.js'
import type { Config } from '../../config.js'
import type { RateLimiter } from '../../core/ratelimit.js'
import type { WebhookDispatcher } from '../../core/webhook.js'

export function registerWebhookRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; limiter: RateLimiter; webhook: WebhookDispatcher }): void {
  const auth = authenticate(deps.db, deps.cfg)
  app.post('/v1/webhook/test', { preHandler: auth }, async (req, reply) => {
    deps.limiter.checkWebhookTest(getAuth(req).agent.id)
    deps.webhook.test(getAuth(req).agent.id)
    return reply.status(204).send()
  })
}
