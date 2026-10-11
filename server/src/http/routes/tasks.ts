import type { FastifyInstance } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import { createTask, getTask, listTasks, transitionTask, type TransitionOp } from '../../core/tasks.js'
import { AppError, Errors } from '../errors.js'
import { audit } from '../../core/audit.js'
import { submitReview } from '../../core/reviews.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'
import type { Bus } from '../../core/bus.js'; import type { RateLimiter } from '../../core/ratelimit.js'
import type { WebhookDispatcher } from '../../core/webhook.js'
import type { TaskHooks } from '../../core/tasks.js'

export function registerTaskRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; bus: Bus; limiter: RateLimiter; webhook?: WebhookDispatcher }): void {
  // 终审 C1：HTTP 路径的任务变迁同样要触发 webhook；dispatcher 可选（未接线时静默跳过，与 core hooks 语义一致）
  const hooks: TaskHooks | undefined = deps.webhook ? { notify: (t, e, a) => deps.webhook!.notify(t, e, a) } : undefined
  const auth = authenticate(deps.db, deps.cfg)
  app.post('/v1/tasks', { preHandler: auth, schema: { body: { type: 'object', required: ['to', 'action'], additionalProperties: false, properties: {
    to: { type: 'string', maxLength: 32 }, action: { type: 'string', minLength: 1, maxLength: 32768 },
    context: { type: 'object' }, result_schema: { type: 'object' }, max_duration_s: { type: 'integer', minimum: 1, maximum: 86400 },
    priority: { type: 'string', enum: ['normal', 'high'] },
    budget: { type: 'object', properties: { amount: { type: 'integer', minimum: 1, maximum: 10000000000000 }, currency: { type: 'string', maxLength: 16 }, note: { type: 'string', maxLength: 256 } }, required: ['amount'], additionalProperties: false } } } } }, async (req, reply) => {
    const me = getAuth(req).agent.id
    try { deps.limiter.checkTask(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(deps.db, me, 'ratelimit.exceeded', { path: '/v1/tasks' })
      throw e
    }
    const out = createTask(deps.db, deps.bus, deps.cfg, me, req.body as never, hooks)
    if (out.policyRejected) throw Errors.policyRejected(`task ${out.task.id} rejected by executor policy`)
    return reply.status(201).send(out.task)
  })
  app.get('/v1/tasks', { preHandler: auth, schema: { querystring: { type: 'object', properties: {
    role: { type: 'string', enum: ['requester', 'executor'], default: 'requester' },
    status: { type: 'string', maxLength: 16 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } } } } }, async (req) => {
    const q = req.query as never as { role?: 'requester' | 'executor'; status?: string; limit?: number }
    return listTasks(deps.db, getAuth(req).agent.id, q)
  })
  app.get('/v1/tasks/:id', { preHandler: auth }, async (req, reply) => {
    const t = getTask(deps.db, (req.params as any).id)
    const me = getAuth(req).agent.id
    if (!t || (t.requester !== me && t.executor !== me)) throw Errors.notFound('task not found')
    return t
  })
  // 任务事件流：按 audit_log 中 detail.task_id 聚合的时间正序时间线，仅参与者可见
  app.get('/v1/tasks/:id/events', { preHandler: auth }, async (req) => {
    const t = getTask(deps.db, (req.params as any).id)
    const me = getAuth(req).agent.id
    if (!t || (t.requester !== me && t.executor !== me)) throw Errors.notFound('task not found')
    try { deps.limiter.checkHistory(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(deps.db, me, 'ratelimit.exceeded', { path: '/v1/tasks/:id/events' })
      throw e
    }
    const rows = deps.db.prepare(`SELECT id, actor, event, detail, created_at FROM audit_log WHERE json_extract(detail,'$.task_id')=? ORDER BY id`).all(t.id) as any[]
    return rows.map(r => ({ ...r, detail: JSON.parse(r.detail) }))
  })
  const action = (path: string, build: (body: any) => TransitionOp) =>
    app.post(`/v1/tasks/:id/${path}`, { preHandler: auth, schema: { body: { type: 'object', additionalProperties: false, properties: { note: { type: 'string', maxLength: 2000 }, status: { type: 'string', enum: ['completed', 'failed'] }, result: { type: 'string', maxLength: 65536 }, error: { type: 'string', maxLength: 2000 } } } } }, async (req) =>
      transitionTask(deps.db, deps.bus, (req.params as any).id, getAuth(req).agent.id, build(req.body as any), hooks))
  action('accept', () => ({ kind: 'accept' }))
  action('reject', (b) => ({ kind: 'reject', note: b?.note }))
  action('cancel', () => ({ kind: 'cancel' }))
  action('result', (b) => ({ kind: 'result', status: b?.status, result: b?.result, error: b?.error }))
  action('heartbeat', () => ({ kind: 'heartbeat' }))
  // 任务评价：仅 requester 可对终态任务提交 1-5 分评价
  app.post('/v1/tasks/:id/review', { preHandler: auth, schema: { body: { type: 'object', required: ['rating'], additionalProperties: false, properties: { rating: { type: 'integer', minimum: 1, maximum: 5 }, comment: { type: 'string', maxLength: 1024 } } } } }, async (req, reply) => {
    const me = getAuth(req).agent.id
    try { deps.limiter.checkTask(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(deps.db, me, 'ratelimit.exceeded', { path: '/v1/tasks/:id/review' })
      throw e
    }
    submitReview(deps.db, (req.params as any).id, me, req.body as never)
    return reply.status(201).send()
  })
}
