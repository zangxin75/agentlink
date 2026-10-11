import type { FastifyInstance } from 'fastify'
import type { Db } from '../../db/sqlite.js'
import type { Config } from '../../config.js'
import type { RateLimiter } from '../../core/ratelimit.js'
import { registerAgent, updateProfile } from '../../core/agents.js'
import { upsertTopics, activeTopics } from '../../core/topics.js'
import { authenticate, getAuth } from '../auth.js'

export function registerAgentsRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; limiter: RateLimiter }): void {
  app.post('/v1/agents', {
    schema: {
      body: { type: 'object', required: ['agent_id'], additionalProperties: false, properties: {
        agent_id: { type: 'string', maxLength: 32 }, display_name: { type: 'string', maxLength: 64 },
        description: { type: 'string', maxLength: 500 }, capabilities: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } },
        registration_code: { type: 'string', maxLength: 128 },
      } },
    },
  }, async (req, reply) => {
    deps.limiter.checkRegister(req.socket.remoteAddress ?? 'unknown')
    const { agent, token } = registerAgent(deps.db, deps.cfg, req.body as never)
    return reply.status(201).send({ agent, token })
  })
}

export function registerMeRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; limiter: RateLimiter }): void {
  const auth = authenticate(deps.db, deps.cfg)
  app.get('/v1/me', { preHandler: auth }, async (req) => ({ agent: getAuth(req).agent, presence: { state: 'online', last_seen_at: getAuth(req).agent.last_seen_at } }))
  app.patch('/v1/me', { preHandler: auth, schema: { body: { type: 'object', additionalProperties: false, properties: {
    // webhook_url 必须列入 schema，否则被 additionalProperties:false 静默剥离（r1-C5）；空串合法=关闭，http(s) 前缀与字节长校验留在 core 单点
    // profile 必须列入 schema，否则同样被静默剥离（r1-C5 同款教训，spec §3.2 m1）；细粒度校验留 core/profile.ts 单点，这里只保字段不被剥
    profile: { type: 'object' },
    webhook_url: { type: 'string', maxLength: 512 },
    display_name: { type: 'string', maxLength: 64 }, description: { type: 'string', maxLength: 500 },
    capabilities: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 40 } },
    task_policy: { type: 'object', required: ['mode', 'allowlist', 'scope'], additionalProperties: false, properties: {
      mode: { type: 'string', enum: ['closed', 'allowlist', 'confirm', 'open'] },
      allowlist: { type: 'array', items: { type: 'string', maxLength: 32 } },
      scope: { type: 'string', enum: ['read-only', 'full'] } } },
  } } } }, async (req) => {
    const body = req.body as { profile?: unknown }
    if (body.profile !== undefined) deps.limiter.checkProfile(getAuth(req).agent.id)
    // webhook_secret 仅在本次响应出现一次（首次设置或重新生成时）；GET /v1/me 永不回显
    const { agent, webhook_secret } = updateProfile(deps.db, getAuth(req).agent.id, req.body as never)
    return { agent, ...(webhook_secret ? { webhook_secret } : {}) }
  })
  // topic 注册表（spec §2）：会话上报本机活跃项目 topic；PUT 不注销列表外项
  app.put('/v1/me/topics', { preHandler: auth, schema: { body: { type: 'object', required: ['topics'], additionalProperties: false, properties: { topics: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 32 } } } } } }, async (req) => {
    const me = getAuth(req).agent.id
    deps.limiter.checkTopics(me)
    upsertTopics(deps.db, me, (req.body as any).topics)
    return { topics: activeTopics(deps.db, me) }
  })
  app.get('/v1/me/topics', { preHandler: auth }, async (req) => ({ topics: activeTopics(deps.db, getAuth(req).agent.id) }))
}
