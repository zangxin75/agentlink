// server/test/register.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig } from '../src/config.js'
import type { Db } from '../src/db/sqlite.js'

let db: Db
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db) })
const cfg = (over: Record<string, string> = {}) => loadConfig({ REGISTRATION_CODE: 'invite123', ...over } as never)

function app(over?: Record<string, string>) { return buildApp({ db, cfg: cfg(over) } as never) }

describe('POST /v1/agents', () => {
  const body = { agent_id: 'alice.dev', display_name: 'Alice', registration_code: 'invite123' }

  it('registers and returns token once', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/agents', payload: body })
    expect(res.statusCode).toBe(201)
    const j = res.json()
    expect(j.agent.id).toBe('alice.dev')
    expect(j.token).toMatch(/^al_[A-Za-z0-9_-]{43}$/)
    expect(db.prepare('SELECT token_hash FROM tokens').all()).toHaveLength(1) // hash only
    expect(db.prepare(`SELECT event FROM audit_log`).all().map((r: any) => r.event)).toContain('agent.registered')
  })
  it('rejects duplicate agent_id with 400', async () => {
    await app().inject({ method: 'POST', url: '/v1/agents', payload: body })
    const res = await app().inject({ method: 'POST', url: '/v1/agents', payload: body })
    expect(res.statusCode).toBe(400)
  })
  it('rejects invalid agent_id format', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/agents', payload: { ...body, agent_id: 'Bad Id!' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('INVALID_REQUEST')
  })
  it('missing/wrong code is 403; closed server is 403 REGISTRATION_CLOSED', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'zed.dev' } })
    expect(res.statusCode).toBe(403) // 服务端配置了注册码但请求未带 → FORBIDDEN
    const closed = buildApp({ db, cfg: loadConfig({} as never) } as never)
    const r2 = await closed.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'zed.dev' } })
    expect(r2.statusCode).toBe(403)
    expect(r2.json().error.code).toBe('REGISTRATION_CLOSED')
  })
  it('wrong registration code is 403', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/agents', payload: { ...body, registration_code: 'nope' } })
    expect(res.statusCode).toBe(403)
  })
})
