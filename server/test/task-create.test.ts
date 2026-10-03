import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent, updateProfile } from '../src/core/agents.js'
import { Bus } from '../src/core/bus.js'
import { createTask } from '../src/core/tasks.js'
import { buildApp } from '../src/http/app.js'
import type { Db } from '../src/db/sqlite.js'

let db: Db, bus: Bus
const cfg = loadConfig({ REGISTRATION_CODE: 'x' } as never)
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db); bus = new Bus() })
const mk = (id: string) => registerAgent(db, cfg, { agent_id: id, registration_code: 'x' })
const input = (to: string) => ({ to, action: 'deploy frontend to staging', max_duration_s: 300 })

describe('createTask policy matrix', () => {
  it('open policy: REQUESTED + task message to executor + audit', () => {
    mk('alice.dev'); mk('bob.ops')
    const { task, policyRejected } = createTask(db, bus, cfg, 'alice.dev', input('bob.ops'))
    expect(policyRejected).toBe(false)
    expect(task.status).toBe('REQUESTED')
    expect(task.expires_at).toBeTruthy()
    const msgs: any[] = db.prepare(`SELECT * FROM messages WHERE type='task'`).all()
    expect(msgs).toHaveLength(1)
    expect(JSON.parse(msgs[0].body).task_id).toBe(task.id)
    expect(db.prepare(`SELECT 1 FROM audit_log WHERE event='task.created'`).get()).toBeTruthy()
  })
  it('closed policy: REJECTED record + violation audit + messages to both sides', () => {
    mk('alice.dev'); const bob = mk('bob.ops')
    updateProfile(db, 'bob.ops', { task_policy: { mode: 'closed', allowlist: [], scope: 'read-only' } })
    const { task, policyRejected } = createTask(db, bus, cfg, 'alice.dev', input('bob.ops'))
    expect(policyRejected).toBe(true)
    expect(task.status).toBe('REJECTED')
    expect(task.error).toContain('closed')
    expect(db.prepare(`SELECT 1 FROM audit_log WHERE event='task.policy_violation'`).get()).toBeTruthy()
    const sys: any[] = db.prepare(`SELECT * FROM messages WHERE type='system' AND to_agent='alice.dev'`).all()
    expect(sys).toHaveLength(1)
    const rej: any[] = db.prepare(`SELECT * FROM messages WHERE type='task' AND to_agent='bob.ops'`).all()
    expect(rej).toHaveLength(1) // executor 侧也收到被拒 task 通知（spec §7.2）
    expect(JSON.parse(rej[0].body).status).toBe('REJECTED')
  })
  it('allowlist policy: in-list passes, out-of-list rejected', () => {
    mk('alice.dev'); mk('carol.ai'); mk('bob.ops')
    updateProfile(db, 'bob.ops', { task_policy: { mode: 'allowlist', allowlist: ['carol.ai'], scope: 'full' } })
    expect(createTask(db, bus, cfg, 'carol.ai', input('bob.ops')).policyRejected).toBe(false)
    expect(createTask(db, bus, cfg, 'alice.dev', input('bob.ops')).policyRejected).toBe(true)
  })
  it('max_duration_s clamped to [1, 86400]', () => {
    mk('alice.dev'); mk('bob.ops')
    expect(createTask(db, bus, cfg, 'alice.dev', { ...input('bob.ops'), max_duration_s: 100000 }).task.max_duration_s).toBe(86400)
  })
  it('action > 32KB rejected with 413 semantics', () => {
    mk('alice.dev'); mk('bob.ops')
    expect(() => createTask(db, bus, cfg, 'alice.dev', { ...input('bob.ops'), action: 'x'.repeat(33 * 1024) })).toThrowError(/too large/)
  })
  it('action/context size limits counted in BYTES: CJK cannot 3x bypass (终审 Minor-5)', () => {
    mk('alice.dev'); mk('bob.ops')
    // 33*1024/3 ≈ 11k 个汉字：按码元 <32KB 会放过，按字节 ~33KB 必须 413
    expect(() => createTask(db, bus, cfg, 'alice.dev', { ...input('bob.ops'), action: '汉'.repeat(33 * 1024) })).toThrowError(/too large/)
    expect(() => createTask(db, bus, cfg, 'alice.dev', { ...input('bob.ops'), context: { blob: '汉'.repeat(65536) } })).toThrowError(/too large/)
    expect(() => createTask(db, bus, cfg, 'alice.dev', { ...input('bob.ops'), action: 'x'.repeat(32 * 1024) })).not.toThrow() // ASCII 边界不回归
  })
})

describe('GET /v1/tasks query validation', () => {
  let token: string
  beforeEach(() => { token = mk('alice.dev').token })
  const list = (role: string) => buildApp({ cfg, db, bus } as never).inject({ method: 'GET', url: `/v1/tasks?role=${encodeURIComponent(role)}`, headers: { authorization: `Bearer ${token}` } })

  it('rejects invalid role with 400 (SQL injection surface)', async () => {
    for (const role of ["requester='x' OR requester", 'requester OR 1=1--', 'bogus', ''])
      expect((await list(role)).statusCode).toBe(400)
  })
  it('valid roles and default pass with 200', async () => {
    expect((await list('requester')).statusCode).toBe(200)
    expect((await list('executor')).statusCode).toBe(200)
    expect((await buildApp({ cfg, db, bus } as never).inject({ method: 'GET', url: '/v1/tasks', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200)
  })
  it('out-of-range limit rejected with 400', async () => {
    expect((await buildApp({ cfg, db, bus } as never).inject({ method: 'GET', url: '/v1/tasks?limit=0', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(400)
    expect((await buildApp({ cfg, db, bus } as never).inject({ method: 'GET', url: '/v1/tasks?limit=101', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(400)
  })
})
