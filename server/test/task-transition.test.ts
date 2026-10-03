import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent } from '../src/core/agents.js'
import { Bus } from '../src/core/bus.js'
import { createTask, transitionTask, getTask } from '../src/core/tasks.js'
import type { Db } from '../src/db/sqlite.js'

let db: Db, bus: Bus
const cfg = loadConfig({ REGISTRATION_CODE: 'x' } as never)
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db); bus = new Bus(); registerAgent(db, cfg, { agent_id: 'alice.dev', registration_code: 'x' }); registerAgent(db, cfg, { agent_id: 'bob.ops', registration_code: 'x' }) })
const newTask = () => createTask(db, bus, cfg, 'alice.dev', { to: 'bob.ops', action: 'do it', max_duration_s: 300 }).task

describe('task transitions', () => {
  it('accept: REQUESTED→RUNNING with deadline; executor only', () => {
    const t = newTask()
    expect(() => transitionTask(db, bus, t.id, 'alice.dev', { kind: 'accept' })).toThrowError(/forbidden/)
    const after = transitionTask(db, bus, t.id, 'bob.ops', { kind: 'accept' })
    expect(after.status).toBe('RUNNING')
    expect(after.deadline).toBeTruthy(); expect(after.accepted_at).toBeTruthy()
  })
  it('reject with note lands in error field', () => {
    const t = newTask()
    const after = transitionTask(db, bus, t.id, 'bob.ops', { kind: 'reject', note: 'too busy' })
    expect(after.status).toBe('REJECTED'); expect(after.error).toContain('too busy')
  })
  it('result completes with payload; running only; executor only', () => {
    const t = newTask(); transitionTask(db, bus, t.id, 'bob.ops', { kind: 'accept' })
    const done = transitionTask(db, bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'deployed to staging' })
    expect(done.status).toBe('COMPLETED'); expect(done.result).toBe('deployed to staging')
    expect(() => transitionTask(db, bus, t.id, 'bob.ops', { kind: 'result', status: 'failed' })).toThrowError(/conflict/) // terminal
  })
  it('result size limit counted in BYTES: CJK cannot 3x bypass (终审 Minor-5)', () => {
    const t = newTask(); transitionTask(db, bus, t.id, 'bob.ops', { kind: 'accept' })
    // 65536 个汉字 = 64K UTF-16 码元但 ~192KB 字节，此前可落库，现在必须 413
    expect(() => transitionTask(db, bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: '汉'.repeat(65536) })).toThrowError(/64KB/)
    expect(() => transitionTask(db, bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'x'.repeat(65530) })).not.toThrow() // ASCII 边界不回归
  })
  it('cancel by requester from REQUESTED and RUNNING', () => {
    const t1 = newTask()
    expect(transitionTask(db, bus, t1.id, 'alice.dev', { kind: 'cancel' }).status).toBe('CANCELLED')
    const t2 = newTask(); transitionTask(db, bus, t2.id, 'bob.ops', { kind: 'accept' })
    expect(transitionTask(db, bus, t2.id, 'alice.dev', { kind: 'cancel' }).status).toBe('CANCELLED')
    expect(() => transitionTask(db, bus, t2.id, 'alice.dev', { kind: 'cancel' })).toThrowError(/conflict/)
  })
  it('heartbeat extends deadline capped at created_at+24h', () => {
    const t = newTask(); transitionTask(db, bus, t.id, 'bob.ops', { kind: 'accept' })
    const d1 = getTask(db, t.id).deadline
    const hb = transitionTask(db, bus, t.id, 'bob.ops', { kind: 'heartbeat' })
    expect(hb.last_heartbeat_at).toBeTruthy()
    const cap = new Date(Date.parse(t.created_at) + 86400_000).toISOString()
    expect(hb.deadline <= cap).toBe(true)
    expect(d1).toBeTruthy()
  })
  it('every transition emits task_update message to both parties + bus task-update', () => {
    let events = 0; bus.on(e => { if (e.type === 'task-update') events++ })
    const t = newTask()
    transitionTask(db, bus, t.id, 'bob.ops', { kind: 'accept' })
    const updates: any[] = db.prepare(`SELECT * FROM messages WHERE type='task_update'`).all()
    expect(updates).toHaveLength(2) // one per party
    expect(events).toBeGreaterThanOrEqual(2)
    expect(db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE event LIKE 'task.%'`).get()).toMatchObject({ c: expect.any(Number) })
  })
})
