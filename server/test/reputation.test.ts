import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })

describe('reputation', () => {
  it('attribution rules: timeout/failed count against executor, cancelled/rejected neutral', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const mk = (i: number) => { const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: `a${i}` }).task; transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' }); return t }
    const done = mk(0); transitionTask(srv.db, srv.bus, done.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'ok' })
    const failed = mk(1); transitionTask(srv.db, srv.bus, failed.id, 'bob.ops', { kind: 'result', status: 'failed', error: 'e' })
    const timed = mk(2); srv.db.prepare(`UPDATE tasks SET deadline='2020-01-01T00:00:00Z' WHERE id=?`).run(timed.id)
    const { scanTimeouts } = await import('../src/core/tasks.js'); scanTimeouts(srv.db, srv.bus, new Date('2020-01-02T00:00:00Z'))
    const rej = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a3' }).task
    transitionTask(srv.db, srv.bus, rej.id, 'bob.ops', { kind: 'reject', note: 'busy' })
    const can = mk(3); transitionTask(srv.db, srv.bus, can.id, 'alice.dev', { kind: 'cancel' })
    const r = await srv.app.inject({ method: 'GET', url: '/v1/agents/bob.ops', headers: H(a.token) })
    const rep = r.json().reputation
    expect(rep.tasks_completed).toBe(1); expect(rep.tasks_failed).toBe(1); expect(rep.tasks_timeout).toBe(1)
    expect(rep.tasks_cancelled).toBe(1); expect(rep.tasks_rejected).toBe(1)
    expect(rep.completion_rate).toBeCloseTo(1 / 3)
    expect(rep.avg_duration_s).not.toBeNull()
    expect(rep.avg_rating).toBe(null); expect(rep.review_count).toBe(0)
  })
  it('list endpoint uses batch aggregation (one GROUP BY, no N+1)', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev')
    for (let i = 0; i < 8; i++) srv.mk(`agent${i}.x`)
    const orig = srv.db.prepare.bind(srv.db)
    let aggSelects = 0
    // 只数批量聚合查询；busy() 每 agent 的单查（directory.ts 现状 N+1）不在本任务范围，明确排除（r1-I6）
    ;(srv.db as any).prepare = (sql: string, ...rest: unknown[]) => { if (/GROUP BY executor/.test(sql)) aggSelects++; return (orig as any)(sql, ...rest) }
    const r = await srv.app.inject({ method: 'GET', url: '/v1/agents', headers: { authorization: `Bearer ${a.token}` } })
    ;(srv.db as any).prepare = orig
    expect(r.statusCode).toBe(200)
    expect(r.json().every((x: any) => 'reputation' in x)).toBe(true)
    expect(aggSelects).toBe(1) // 无论多少 agent，聚合只发一条 GROUP BY executor
  })
})
