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
beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db)
  t = registerAgent(db, cfg, { agent_id: 'alice.dev', registration_code: 'x', capabilities: ['deploy', 'review'] }).token
  registerAgent(db, cfg, { agent_id: 'bob.ops', registration_code: 'x', description: 'frontend deploy expert' })
})
const app = () => buildApp({ db, cfg, bus: new Bus(), limiter: new RateLimiter(cfg.rate) } as never)

describe('directory', () => {
  it('search by capability and free text', async () => {
    const H = { authorization: `Bearer ${t}` }
    const r1 = await app().inject({ method: 'GET', url: '/v1/agents?capability=deploy', headers: H })
    expect(r1.json().map((x: any) => x.agent.id)).toEqual(['alice.dev'])
    const r2 = await app().inject({ method: 'GET', url: '/v1/agents?q=frontend', headers: H })
    expect(r2.json().map((x: any) => x.agent.id)).toEqual(['bob.ops'])
    const r2b = await app().inject({ method: 'GET', url: '/v1/agents?q=review', headers: H })
    expect(r2b.json().map((x: any) => x.agent.id)).toEqual(['alice.dev']) // q 命中 capabilities（spec §8）
    const r3 = await app().inject({ method: 'GET', url: '/v1/agents/bob.ops', headers: H })
    expect(r3.json().agent.description).toContain('frontend')
    expect(r3.json().agent.created_at).toBeTruthy()
  })
  it('?online=true filters to online only; ?online=false and absent do NOT filter (终审 Minor-4)', async () => {
    const H = { authorization: `Bearer ${t}` }
    // bob 注册后无任何活动，把 last_seen 拉出在线窗口 → 离线；alice（请求方）注册即新，视为在线
    db.prepare(`UPDATE agents SET last_seen_at=? WHERE id='bob.ops'`).run(new Date(Date.now() - 10 * 60_000).toISOString())
    const on = await app().inject({ method: 'GET', url: '/v1/agents?online=true', headers: H })
    expect(on.json().map((x: any) => x.agent.id)).toEqual(['alice.dev'])
    // online=false 此前因字符串 'false' 真值被当 true：必须不过滤、返回含离线 agent
    const off = await app().inject({ method: 'GET', url: '/v1/agents?online=false', headers: H })
    expect(off.json().map((x: any) => x.agent.id).sort()).toEqual(['alice.dev', 'bob.ops'])
    const none = await app().inject({ method: 'GET', url: '/v1/agents', headers: H })
    expect(none.json().map((x: any) => x.agent.id).sort()).toEqual(['alice.dev', 'bob.ops'])
  })
  it('requires auth', async () => {
    expect((await app().inject({ method: 'GET', url: '/v1/agents' })).statusCode).toBe(401)
  })
})
