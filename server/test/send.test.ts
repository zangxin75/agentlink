// server/test/send.test.ts
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

let db: Db, bus: Bus, ta: string, tb: string
const cfg = loadConfig({ REGISTRATION_CODE: 'x' } as never)
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db); bus = new Bus()
  ta = registerAgent(db, cfg, { agent_id: 'alice.dev', registration_code: 'x' }).token
  tb = registerAgent(db, cfg, { agent_id: 'bob.ops', registration_code: 'x' }).token
})
const app = () => buildApp({ db, cfg, bus, limiter: new RateLimiter(cfg.rate) } as never)

describe('POST /v1/messages', () => {
  const H = (t: string) => ({ authorization: `Bearer ${t}` })
  const payload = (cmid: string) => ({ to: 'bob.ops', type: 'text', body: { text: 'hi' }, client_msg_id: cmid })

  it('201 sends message and emits bus event', async () => {
    const woke = bus.waitFor('bob.ops', ['new-message'], 1000)
    const res = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: payload('c1') })
    expect(res.statusCode).toBe(201)
    const m = res.json().message
    expect(m.id).toMatch(/^msg_/); expect(m.delivered_at).toBeNull()
    expect(await woke).toBe(true)
    expect(db.prepare(`SELECT event FROM audit_log WHERE event='message.sent'`).get()).toBeTruthy()
  })
  it('idempotent resend returns 200 deduplicated with same id', async () => {
    const r1 = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: payload('c1') })
    const r2 = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: payload('c1') })
    expect(r2.statusCode).toBe(200); expect(r2.json().deduplicated).toBe(true)
    expect(r2.json().message.id).toBe(r1.json().message.id)
    expect(db.prepare('SELECT COUNT(*) c FROM messages').get()).toMatchObject({ c: 1 })
  })
  it('concurrent identical client_msg_id: one row, same id both responses', async () => {
    const [r1, r2] = await Promise.all([
      app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: payload('race') }),
      app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: payload('race') }),
    ])
    const ids = [r1.json().message?.id, r2.json().message?.id].filter(Boolean)
    expect(new Set(ids).size).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM messages').get()).toMatchObject({ c: 1 })
  })
  it('core sendMessage duplicate insert returns deduplicated, single row', () => {
    const input = { to: 'bob.ops', type: 'text' as const, body: { text: 'hi' }, client_msg_id: 'core-dup' }
    const a = sendMessage(db, bus, 'alice.dev', input)
    const b = sendMessage(db, bus, 'alice.dev', input)
    expect(a.deduplicated).toBe(false); expect(b.deduplicated).toBe(true)
    expect(b.message.id).toBe(a.message.id)
    expect(db.prepare('SELECT COUNT(*) c FROM messages').get()).toMatchObject({ c: 1 })
  })
  it('constraint race (guard miss) hits catch path: returns deduplicated, no throw', () => {
    const input = { to: 'bob.ops', type: 'text' as const, body: { text: 'hi' }, client_msg_id: 'core-race' }
    const first = sendMessage(db, bus, 'alice.dev', input)
    expect(first.deduplicated).toBe(false)
    // 让幂等预查 SELECT 恰好 miss 一次，逼 INSERT 撞唯一索引 idx_messages_idem，走 catch 分支
    const realPrepare = db.prepare.bind(db)
    let missed = false
    ;(db as any).prepare = (sql: string) => {
      const stmt = realPrepare(sql)
      if (!missed && sql.startsWith('SELECT id FROM messages WHERE from_agent=? AND client_msg_id=?')) {
        return { get: (...a: any[]) => { missed = true; return undefined } } // 仅第一次幂等预查 miss
      }
      return stmt
    }
    try {
      const second = sendMessage(db, bus, 'alice.dev', input)
      expect(second.deduplicated).toBe(true)
      expect(second.message.id).toBe(first.message.id)
    } finally { (db as any).prepare = realPrepare }
    expect(db.prepare('SELECT COUNT(*) c FROM messages').get()).toMatchObject({ c: 1 })
  })
  it('404 unknown recipient', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: { ...payload('c2'), to: 'ghost' } })
    expect(res.statusCode).toBe(404)
  })
  it('413 when text exceeds 64KB', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: { ...payload('c3'), body: { text: 'x'.repeat(65 * 1024) } } })
    expect(res.statusCode).toBe(413)
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE')
  })
  it('413 when text exceeds 64KB counted in BYTES: CJK cannot 3x bypass (终审 Minor-5)', async () => {
    // 65536 个汉字 = 64K UTF-16 码元但 ~192KB 字节，此前 201 落库，现在必须 413
    const res = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: { ...payload('cjk'), body: { text: '汉'.repeat(65536) } } })
    expect(res.statusCode).toBe(413)
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE')
    const ok = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: { ...payload('cjk2'), body: { text: 'x'.repeat(65530) } } })
    expect(ok.statusCode).toBe(201) // ASCII 边界不回归
  })
  it('malformed JSON body → 400 INVALID_REQUEST, not 500 (终审 Important-1)', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/messages', headers: { ...H(ta), 'content-type': 'application/json' }, payload: '{not json' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('INVALID_REQUEST')
  })
  it('body over Fastify 1MB bodyLimit → 413 PAYLOAD_TOO_LARGE, not 500 (终审 Important-1)', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/messages', headers: { ...H(ta), 'content-type': 'application/json' }, payload: JSON.stringify({ ...payload('big'), body: { text: 'x'.repeat(2 * 1024 * 1024) } }) })
    expect(res.statusCode).toBe(413)
    expect(res.json().error.code).toBe('PAYLOAD_TOO_LARGE')
  })
  it('wrong content-type on JSON endpoint stays 400', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/messages', headers: { ...H(ta), 'content-type': 'text/plain' }, payload: 'hello' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('INVALID_REQUEST')
  })
  it('429 beyond rate budget with Retry-After + ratelimit.exceeded audit', async () => {
    const tight = buildApp({ db, cfg: loadConfig({ REGISTRATION_CODE: 'x', RATE_LIMIT_MESSAGE_PER_MIN: '2' } as never), bus, limiter: new RateLimiter(loadConfig({ RATE_LIMIT_MESSAGE_PER_MIN: '2' } as never).rate) } as never)
    for (const c of ['a', 'b']) await tight.inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: payload(c) })
    const res = await tight.inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: payload('d') })
    expect(res.statusCode).toBe(429); expect(res.headers['retry-after']).toBeTruthy()
    const rl: any = db.prepare(`SELECT * FROM audit_log WHERE event='ratelimit.exceeded' AND actor=?`).get('alice.dev')
    expect(rl).toBeTruthy() // spec §10：限流命中必须留审计事件
  })
})
