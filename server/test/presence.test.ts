import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import WebSocket from 'ws'
import { createTask, transitionTask } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })

describe('presence', () => {
  it('rest activity marks online within window; busy derived from running task', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    await srv.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${b.token}` } }) // rest touch
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'x' }).task
    const p = await srv.app.inject({ method: 'GET', url: '/v1/presence?ids=bob.ops,alice.dev', headers: { authorization: `Bearer ${a.token}` } })
    const by = Object.fromEntries(p.json().map((x: any) => [x.agent_id, x]))
    expect(by['bob.ops'].state).toBe('online'); expect(by['bob.ops'].busy).toBe(false) // REQUESTED ≠ busy（agent_id 含点号，必须方括号取值）
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' })
    const p2 = await srv.app.inject({ method: 'GET', url: '/v1/presence?ids=bob.ops', headers: { authorization: `Bearer ${a.token}` } })
    expect(p2.json()[0].busy).toBe(true)
  })
  it('ws connect/disconnect toggles online via directory', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const ws = new WebSocket(srv.url)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ op: 'auth', token: b.token }))
    await new Promise(r => ws.on('message', r))
    await new Promise(r => setTimeout(r, 50))
    const online = await srv.app.inject({ method: 'GET', url: '/v1/agents/bob.ops', headers: { authorization: `Bearer ${a.token}` } })
    expect(online.json().presence.state).toBe('online')
    ws.close()
    await new Promise(r => setTimeout(r, 100))
    srv.db.prepare(`UPDATE agents SET last_seen_at=? WHERE id='bob.ops'`).run(new Date(Date.now() - 10 * 60_000).toISOString()) // 置为窗口外，断言可判定
    const off = await srv.app.inject({ method: 'GET', url: '/v1/agents/bob.ops', headers: { authorization: `Bearer ${a.token}` } })
    expect(off.json().presence.state).toBe('offline') // last_seen 超出窗口 → offline
  })
})
