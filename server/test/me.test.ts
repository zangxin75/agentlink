import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig } from '../src/config.js'
import { registerAgent } from '../src/core/agents.js'
import type { Db } from '../src/db/sqlite.js'

let db: Db, token: string
const cfg = loadConfig({ REGISTRATION_CODE: 'x' } as never)
beforeEach(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db)
  ;({ token } = registerAgent(db, cfg, { agent_id: 'alice.dev', registration_code: 'x' }))
})
const app = () => buildApp({ db, cfg } as never)
const H = { get authorization() { return `Bearer ${token}` } }

describe('auth + /me', () => {
  it('401 without/with-bad token', async () => {
    expect((await app().inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401)
    expect((await app().inject({ method: 'GET', url: '/v1/me', headers: { authorization: 'Bearer al_bogus' } })).statusCode).toBe(401)
  })
  it('GET /me returns agent and offline presence', async () => {
    const res = await app().inject({ method: 'GET', url: '/v1/me', headers: H })
    expect(res.statusCode).toBe(200)
    expect(res.json().agent.id).toBe('alice.dev')
    expect(res.json().agent.task_policy).toEqual({ mode: 'open', allowlist: [], scope: 'read-only' })
  })
  it('PATCH /me updates policy with before/after audit', async () => {
    const policy = { mode: 'allowlist', allowlist: ['bob.ops'], scope: 'full' }
    const res = await app().inject({ method: 'PATCH', url: '/v1/me', headers: H, payload: { task_policy: policy } })
    expect(res.statusCode).toBe(200)
    expect(res.json().agent.task_policy).toEqual(policy)
    const row: any = db.prepare(`SELECT detail FROM audit_log WHERE event='agent.policy_changed'`).get()
    expect(JSON.parse(row.detail)).toMatchObject({ before: { mode: 'open' }, after: { mode: 'allowlist' } })
  })
  it('PATCH /me rejects invalid policy mode with 400', async () => {
    const res = await app().inject({ method: 'PATCH', url: '/v1/me', headers: H, payload: { task_policy: { mode: 'sloppy', allowlist: [], scope: 'full' } } })
    expect(res.statusCode).toBe(400)
  })
})

// 终审 M3：从未设置过 secret 的 agent「关闭」webhook（webhook_url:''）不应凭空生成并返回新 secret
describe('webhook secret lifecycle edge', () => {
  it('clearing webhook_url with no prior secret generates nothing', async () => {
    const res = await app().inject({ method: 'PATCH', url: '/v1/me', headers: H, payload: { webhook_url: '' } })
    expect(res.statusCode).toBe(200)
    expect(res.json().webhook_secret).toBeUndefined()
    expect((db.prepare('SELECT webhook_secret FROM agents WHERE id=?').get('alice.dev') as any).webhook_secret).toBeNull()
  })
})
