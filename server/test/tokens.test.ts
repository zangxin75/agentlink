import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig } from '../src/config.js'
import { registerAgent } from '../src/core/agents.js'
import type { Db } from '../src/db/sqlite.js'

let db: Db, token: string
const cfg = loadConfig({ REGISTRATION_CODE: 'x' } as never)
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db); ({ token } = registerAgent(db, cfg, { agent_id: 'a.b', registration_code: 'x' })) })
const app = () => buildApp({ db, cfg } as never)

describe('tokens api', () => {
  it('create/list/revoke lifecycle', async () => {
    const H = { authorization: `Bearer ${token}` }
    const c = await app().inject({ method: 'POST', url: '/v1/tokens', headers: H, payload: { name: 'laptop' } })
    expect(c.statusCode).toBe(201)
    const { id, token: plain } = c.json()
    expect(plain).toMatch(/^al_/)
    const l = await app().inject({ method: 'GET', url: '/v1/tokens', headers: H })
    expect(l.json().map((t: any) => t.name)).toContain('laptop')
    expect(JSON.stringify(l.json())).not.toContain(plain) // no plaintext
    const rv = await app().inject({ method: 'DELETE', url: `/v1/tokens/${id}`, headers: H })
    expect(rv.statusCode).toBe(204)
    const bad = await app().inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${plain}` } })
    expect(bad.statusCode).toBe(401) // revoked token unusable
    expect(db.prepare(`SELECT event FROM audit_log WHERE event='token.revoked'`).get()).toBeTruthy()
  })
})
