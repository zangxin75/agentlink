import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig } from '../src/config.js'
import { registerAgent } from '../src/core/agents.js'
import { Bus } from '../src/core/bus.js'; import { RateLimiter } from '../src/core/ratelimit.js'
import type { Db } from '../src/db/sqlite.js'

let db: Db, t: string
const cfg = loadConfig({ REGISTRATION_CODE: 'x' } as never)
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db); t = registerAgent(db, cfg, { agent_id: 'a.b', registration_code: 'x' }).token })

describe('GET /v1/stats', () => {
  it('returns counters for authed caller; 401 otherwise', async () => {
    const app = buildApp({ db, cfg, bus: new Bus(), limiter: new RateLimiter(cfg.rate), wsConnections: () => 3 } as never)
    const ok = await app.inject({ method: 'GET', url: '/v1/stats', headers: { authorization: `Bearer ${t}` } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ ws_connections: 3, inbox_depth: 0, running_tasks: 0 })
    expect((await app.inject({ method: 'GET', url: '/v1/stats' })).statusCode).toBe(401)
  })
})
