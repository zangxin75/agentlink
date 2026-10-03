import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const lifecycle = (budget: { amount: number; currency?: string }, result: 'completed' | 'failed' = 'completed') => {
  const t = createTask(srv!.db, srv!.bus, srv!.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', budget }).task
  transitionTask(srv!.db, srv!.bus, t.id, 'bob.ops', { kind: 'accept' })
  transitionTask(srv!.db, srv!.bus, t.id, 'bob.ops', { kind: 'result', status: result, result: 'ok' })
  return t
}

describe('ledger query', () => {
  it('role filter + cursor style (id desc)', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    lifecycle({ amount: 100 }); lifecycle({ amount: 50 }, 'failed'); lifecycle({ amount: 70 })
    const payer = (await srv.app.inject({ method: 'GET', url: '/v1/ledger?role=payer', headers: H(a.token) })).json()
    expect(payer.length).toBe(6); expect(payer[0].type).toBe('settled') // 最新任务的事件在前
    const earner = (await srv.app.inject({ method: 'GET', url: '/v1/ledger?role=earner&limit=2', headers: H(b.token) })).json()
    expect(earner.length).toBe(2)
    const page2 = (await srv.app.inject({ method: 'GET', url: `/v1/ledger?role=earner&limit=2&before=${earner[1].id}`, headers: H(b.token) })).json()
    expect(page2.length).toBe(2); expect(page2[0].id).toBeLessThan(earner[1].id)
  })
  it('summary aggregates per counterparty and currency', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'); srv.mk('bob.ops')
    lifecycle({ amount: 100 }); lifecycle({ amount: 60 }); lifecycle({ amount: 30 }, 'failed'); lifecycle({ amount: 5, currency: 'usd-cent' })
    const s = (await srv.app.inject({ method: 'GET', url: '/v1/ledger/summary', headers: H(a.token) })).json()
    const credit = s.find((x: any) => x.currency === 'credit')
    expect(credit).toMatchObject({ counterparty: 'bob.ops', settled_total: 160, pending_total: 0 }) // 30 的 voided 不算在途（r1-C2）
    expect(s.find((x: any) => x.currency === 'usd-cent').settled_total).toBe(5)
  })
})
