import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const finish = () => { const t = createTask(srv!.db, srv!.bus, srv!.cfg, 'alice.dev', { to: 'bob.ops', action: 'a' }).task; transitionTask(srv!.db, srv!.bus, t.id, 'bob.ops', { kind: 'accept' }); transitionTask(srv!.db, srv!.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'ok' }); return t }

describe('review', () => {
  it('requester rates executor; reputation reflects it', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const t = finish()
    const r = await srv.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/review`, headers: H(a.token), payload: { rating: 5, comment: 'great' } })
    expect(r.statusCode).toBe(201)
    const rep = (await srv.app.inject({ method: 'GET', url: '/v1/agents/bob.ops', headers: H(a.token) })).json().reputation
    expect(rep.avg_rating).toBe(5); expect(rep.review_count).toBe(1)
  })
  it('guards: non-requester 403, running 422, duplicate 409, window closed 422', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const running = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a' }).task
    expect((await srv.app.inject({ method: 'POST', url: `/v1/tasks/${running.id}/review`, headers: H(a.token), payload: { rating: 4 } })).statusCode).toBe(422)
    const t = finish()
    expect((await srv.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/review`, headers: H(b.token), payload: { rating: 4 } })).statusCode).toBe(403)
    expect((await srv.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/review`, headers: H(a.token), payload: { rating: 4 } })).statusCode).toBe(201)
    const dup = await srv.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/review`, headers: H(a.token), payload: { rating: 3 } })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('ALREADY_REVIEWED') // r1-I7：钉住新错误码，不只钉 409
    const t2 = finish()
    srv.db.prepare(`UPDATE tasks SET finished_at='2020-01-01T00:00:00Z' WHERE id=?`).run(t2.id)
    expect((await srv.app.inject({ method: 'POST', url: `/v1/tasks/${t2.id}/review`, headers: H(a.token), payload: { rating: 4 } })).statusCode).toBe(422)
  })
})
