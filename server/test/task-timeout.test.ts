import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent } from '../src/core/agents.js'
import { Bus } from '../src/core/bus.js'
import { createTask, transitionTask, scanTimeouts, getTask } from '../src/core/tasks.js'
import type { Db } from '../src/db/sqlite.js'

let db: Db, bus: Bus
const cfg = loadConfig({ REGISTRATION_CODE: 'x' } as never)
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db); bus = new Bus(); registerAgent(db, cfg, { agent_id: 'alice.dev', registration_code: 'x' }); registerAgent(db, cfg, { agent_id: 'bob.ops', registration_code: 'x' }) })

describe('scanTimeouts', () => {
  it('RUNNING past deadline+grace becomes TIMEOUT and notifies both', () => {
    const t = createTask(db, bus, cfg, 'alice.dev', { to: 'bob.ops', action: 'x', max_duration_s: 10 }).task
    transitionTask(db, bus, t.id, 'bob.ops', { kind: 'accept' })
    const future = new Date(Date.now() + 5_000)
    expect(scanTimeouts(db, bus, future)).toEqual({ timedOut: [], expired: [] }) // deadline=+10s，未到不触发
    const r = scanTimeouts(db, bus, new Date(Date.now() + 30_000))
    expect(r.timedOut).toEqual([t.id])
    expect(getTask(db, t.id).status).toBe('TIMEOUT')
    const updates: any[] = db.prepare(`SELECT to_agent FROM messages WHERE type='task_update'`).all()
    expect(new Set(updates.map(u => u.to_agent))).toEqual(new Set(['alice.dev', 'bob.ops']))
  })
  it('grace window: deadline just passed is not timed out', () => {
    const t = createTask(db, bus, cfg, 'alice.dev', { to: 'bob.ops', action: 'x', max_duration_s: 10 }).task
    transitionTask(db, bus, t.id, 'bob.ops', { kind: 'accept' })
    const now = new Date(Date.parse(getTask(db, t.id).deadline) + 1000) // 1s past deadline < 5s grace
    expect(scanTimeouts(db, bus, now).timedOut).toEqual([])
  })
  it('REQUESTED past expires_at becomes EXPIRED', () => {
    const cfg2 = loadConfig({ REGISTRATION_CODE: 'x', TASK_REQUEST_TIMEOUT_S: '1' } as never)
    const t = createTask(db, bus, cfg2, 'alice.dev', { to: 'bob.ops', action: 'x' }).task
    expect(scanTimeouts(db, bus, new Date(Date.now() + 2000)).expired).toEqual([t.id])
    expect(getTask(db, t.id).status).toBe('EXPIRED')
    expect(db.prepare(`SELECT 1 FROM audit_log WHERE event='task.expired' AND detail LIKE ?`).get(`%${t.id}%`)).toBeTruthy()
  })
})
