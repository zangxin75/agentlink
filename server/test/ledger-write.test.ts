import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask, getTask, scanTimeouts } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const events = () => srv!.db.prepare('SELECT * FROM ledger_events ORDER BY id').all() as any[]
const budget = { amount: 1000, currency: 'credit' }

describe('ledger write matrix', () => {
  it('accept→agreed; completed→settled (preceded by agreed)', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    expect(t.budget_amount).toBe(1000); expect(t.budget_currency).toBe('credit')
    expect(events()).toEqual([]) // REQUESTED 无事件
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'ok' })
    expect(events().map(e => e.type)).toEqual(['agreed', 'settled'])
    expect(events()[1].payer).toBe('alice.dev'); expect(events()[1].payee).toBe('bob.ops'); expect(events()[1].amount).toBe(1000)
  })
  it('failed/timeout/cancel@running → voided (amount 0); settled/voided mutually exclusive', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    const f = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, f.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, f.id, 'bob.ops', { kind: 'result', status: 'failed', error: 'e' })
    const t2 = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, t2.id, 'bob.ops', { kind: 'accept' })
    srv.db.prepare(`UPDATE tasks SET deadline='2020-01-01T00:00:00Z' WHERE id=?`).run(t2.id)
    scanTimeouts(srv.db, srv.bus, new Date('2020-01-02T00:00:00Z'))
    const c = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, c.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, c.id, 'alice.dev', { kind: 'cancel' })
    for (const id of [f.id, t2.id, c.id]) {
      const evs = events().filter(e => e.task_id === id)
      expect(evs.map(e => e.type)).toEqual(['agreed', 'voided'])
      expect(evs[1].amount).toBe(0)
    }
  })
  it('REJECTED / policy / EXPIRED / cancel@REQUESTED / no-budget produce zero events', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops'); srv.mk('carol.io') // r1-C3：carol.io 必须先注册，否则 createTask 在 getAgent 处 404
    const rej = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, rej.id, 'bob.ops', { kind: 'reject', note: 'x' })
    srv.db.prepare(`UPDATE agents SET task_policy='{"mode":"closed","allowlist":[],"scope":"read-only"}' WHERE id='carol.io'`).run()
    createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'carol.io', action: 'a', budget })
    const exp = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    srv.db.prepare(`UPDATE tasks SET expires_at='2020-01-01T00:00:00Z' WHERE id=?`).run(exp.id)
    scanTimeouts(srv.db, srv.bus, new Date('2020-01-02T00:00:00Z'))
    const cr = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, cr.id, 'alice.dev', { kind: 'cancel' })
    const nb = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a' }).task
    transitionTask(srv.db, srv.bus, nb.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, nb.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'ok' })
    expect(events()).toEqual([])
  })
  it('atomicity: ledger failure rolls back task status (fault injection)', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' })
    const orig = srv.db.prepare.bind(srv.db)
    ;(srv.db as any).prepare = (sql: string, ...rest: unknown[]) => { if (sql.includes('ledger_events')) throw new Error('inject') ; return (orig as any)(sql, ...rest) }
    expect(() => transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'ok' })).toThrow('inject')
    ;(srv.db as any).prepare = orig
    expect(getTask(srv.db, t.id).status).toBe('RUNNING') // 回滚，无 settled 也无状态变更
  })
  it('budget validation: amount bounds, currency length', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    expect(() => createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget: { amount: 0 } })).toThrow()
    expect(() => createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget: { amount: 10 ** 13 + 1 } })).toThrow()
    expect(() => createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget: { amount: 5, currency: 'x'.repeat(17) } })).toThrow()
    const ok = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget: { amount: 5 } }).task
    expect(ok.budget_currency).toBe('credit')
  })
})
