import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig } from '../src/config.js'
import { registerAgent } from '../src/core/agents.js'
import { Bus } from '../src/core/bus.js'
import { RateLimiter } from '../src/core/ratelimit.js'
import { sendMessage } from '../src/core/messages.js'
import type { Db } from '../src/db/sqlite.js'

let db: Db, bus: Bus, a: string, b: string
const cfg = loadConfig({ REGISTRATION_CODE: 'x' } as never)
const mk = (id: string) => registerAgent(db, cfg, { agent_id: id, registration_code: 'x' }).token
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db); bus = new Bus()
  a = mk('alice.dev'); b = mk('bob.ops')
})
const app = () => buildApp({ db, cfg, bus, limiter: new RateLimiter(cfg.rate) } as never)
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const send = (from: string, cmid: string, text = 'hi') => sendMessage(db, bus, from, { to: from === 'alice.dev' ? 'bob.ops' : 'alice.dev', type: 'text', body: { text }, client_msg_id: cmid })

describe('inbox semantics', () => {
  it('inbox is read-only: same message returns until acked', async () => {
    const m = send('alice.dev', 'c1')
    const r1 = await app().inject({ method: 'GET', url: '/v1/inbox?wait=0', headers: H(b) })
    const r2 = await app().inject({ method: 'GET', url: '/v1/inbox?wait=0', headers: H(b) })
    expect(r1.json()).toHaveLength(1); expect(r2.json()[0].id).toBe(m.message.id) // still there
  })
  it('ack removes from inbox, stamps delivered, receipt visible to sender', async () => {
    const m = send('alice.dev', 'c1')
    const ack = await app().inject({ method: 'POST', url: '/v1/messages/ack', headers: H(b), payload: { ids: [m.message.id] } })
    expect(ack.json().acked).toEqual([m.message.id])
    const inbox = await app().inject({ method: 'GET', url: '/v1/inbox?wait=0', headers: H(b) })
    expect(inbox.json()).toHaveLength(0)
    const rc = await app().inject({ method: 'GET', url: `/v1/messages/receipts?ids=${m.message.id}`, headers: H(a) })
    expect(rc.json()[0].delivered_at).toBeTruthy()
  })
  it('long-poll wakes on new message', async () => {
    const p = app().inject({ method: 'GET', url: '/v1/inbox?wait=5', headers: H(b) })
    await new Promise(r => setTimeout(r, 50))
    send('alice.dev', 'c9')
    const res = await p
    expect(res.statusCode).toBe(200); expect(res.json()).toHaveLength(1)
  })
  it('read marks read_at and unread counts group by peer', async () => {
    const m = send('alice.dev', 'c1'); send('alice.dev', 'c2')
    await app().inject({ method: 'POST', url: '/v1/messages/ack', headers: H(b), payload: { ids: [m.message.id] } }) // 只确认 c1；c2 留在收件箱
    // ack only first; unread counts both until read
    let u = await app().inject({ method: 'GET', url: '/v1/unread', headers: H(b) })
    expect(u.json()).toEqual([{ peer: 'alice.dev', count: 2 }])
    await app().inject({ method: 'POST', url: `/v1/messages/${m.message.id}/read`, headers: H(b) })
    u = await app().inject({ method: 'GET', url: '/v1/unread', headers: H(b) })
    expect(u.json()).toEqual([{ peer: 'alice.dev', count: 1 }])
  })
  it('crash-restart durability: acked rows persist, unacked stay in inbox after reopen', async () => {
    const m1 = send('alice.dev', 'c1'), m2 = send('alice.dev', 'c2')
    db.prepare('UPDATE messages SET delivered_at=? WHERE id=?').run(new Date().toISOString(), m1.message.id) // acked m1
    const path = db.name; db.close()               // abrupt: no checkpoint
    const db2 = openDb(path); migrate(db2)
    const inbox = await buildApp({ db: db2, cfg, bus, limiter: new RateLimiter(cfg.rate) } as never).inject({ method: 'GET', url: '/v1/inbox?wait=0', headers: H(b) })
    expect(inbox.json().map((x: any) => x.id)).toEqual([m2.message.id]) // m2 still pending, m1 delivered
    db = db2
  })
})
