import Fastify, { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Db } from '../db/sqlite.js'
import { RateLimiter } from '../core/ratelimit.js'
import { AppError } from './errors.js'
import { authenticate } from './auth.js'
import { registerAgentsRoutes, registerMeRoutes } from './routes/agents.js'
import { registerTokensRoutes } from './routes/tokens.js'
import { registerSendRoutes } from './routes/send.js'
import { registerInboxRoutes } from './routes/messages.js'
import { registerTaskRoutes } from './routes/tasks.js'
import { registerDirectoryRoutes } from './routes/directory.js'
import { registerPresenceRoutes } from './routes/presence.js'
import type { Bus } from '../core/bus.js'
import type { WebhookDispatcher } from '../core/webhook.js'
import { registerWebhookRoutes } from './routes/webhook.js'
import { registerLedgerRoutes } from './routes/ledger.js'
import { registerCreditsRoutes } from './routes/credits.js'
import { registerMarketRoutes } from './routes/market.js'
import { AUTH_MD } from './auth-md.js'

export interface AppDeps { cfg: Config; db?: Db; bus?: Bus; limiter?: RateLimiter; onTokenRevoke?: (tokenId: string) => void; connectedAgents?: () => Set<string>; wsConnections?: () => number; webhook?: WebhookDispatcher }

const startedAt = Date.now()

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: { level: (process.env.LOG_LEVEL ?? 'info'), redact: ['req.headers.authorization'] } })
  app.get('/healthz', async () => ({ status: 'ok', uptime_s: Math.round((Date.now() - startedAt) / 1000) }))
  // /auth.md：无鉴权动态文档端点（moltbook 式）——SKILL.md/网站只指回此 URL，流程更新只改一处
  // {ORIGIN} 用请求 host 替换（"指回吐出本文档的那台服务器"），x-forwarded-proto 兼容反代
  app.get('/auth.md', async (req, reply) => {
    const host = req.headers.host ?? ''
    const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'https'
    const origin = host ? `${proto}://${host}` : ''
    reply.type('text/markdown; charset=utf-8').send(AUTH_MD.replaceAll('{ORIGIN}', origin))
  })
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'not found' } }))
  app.setErrorHandler((err: Error & { validation?: unknown; statusCode?: number }, _req, reply) => {
    if (err instanceof AppError) {
      const headers: Record<string, number | string> = {}
      if (err.retryAfterS) headers['retry-after'] = err.retryAfterS
      return reply.status(err.status).headers(headers).send({ error: { code: err.code, message: err.message } }) // Fastify 批量设头是 reply.headers(obj)，单个才是 reply.header(k,v)
    }
    if (err.validation) return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: err.message } })
    // Fastify 框架错误（content-type/JSON parse FST_ERR_CTP_* → 400；bodyLimit 超限 → 413）
    // 没有 validation 属性也不是 AppError，此前落入 500。通用文案，不透传内部细节。
    if (err.statusCode === 400) return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: 'invalid request' } })
    if (err.statusCode === 413) return reply.status(413).send({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'payload too large' } })
    reply.log.error(err)
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal error' } })
  })
  if (deps.db) {
    const limiter = deps.limiter ?? new RateLimiter(deps.cfg.rate)
    registerAgentsRoutes(app, { db: deps.db, cfg: deps.cfg, limiter })
    registerMeRoutes(app, { db: deps.db, cfg: deps.cfg, limiter })
    registerTokensRoutes(app, { db: deps.db, cfg: deps.cfg, onRevoke: deps.onTokenRevoke })
    registerDirectoryRoutes(app, { db: deps.db, cfg: deps.cfg, connectedAgents: deps.connectedAgents })
    registerPresenceRoutes(app, { db: deps.db, cfg: deps.cfg, connectedAgents: deps.connectedAgents })
    registerCreditsRoutes(app, { db: deps.db, cfg: deps.cfg, limiter })
    if (deps.webhook) registerWebhookRoutes(app, { db: deps.db, cfg: deps.cfg, limiter, webhook: deps.webhook })
    if (deps.bus) {
      registerSendRoutes(app, { db: deps.db, cfg: deps.cfg, bus: deps.bus, limiter })
      registerInboxRoutes(app, { db: deps.db, cfg: deps.cfg, bus: deps.bus, limiter })
      registerTaskRoutes(app, { db: deps.db, cfg: deps.cfg, bus: deps.bus, limiter, webhook: deps.webhook })
      registerLedgerRoutes(app, { db: deps.db, cfg: deps.cfg, limiter })
      registerMarketRoutes(app, { db: deps.db, cfg: deps.cfg, bus: deps.bus, limiter })
    }
    const auth = authenticate(deps.db, deps.cfg)
    app.get('/v1/stats', { preHandler: auth }, async () => {
      const db = deps.db as never as Db
      return {
        ws_connections: deps.wsConnections?.() ?? 0,
        inbox_depth: (db.prepare('SELECT COUNT(*) c FROM messages WHERE delivered_at IS NULL').get() as { c: number }).c,
        running_tasks: (db.prepare(`SELECT COUNT(*) c FROM tasks WHERE status='RUNNING'`).get() as { c: number }).c,
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
      }
    })
  }
  return app
}
