import { describe, it, expect } from 'vitest'
import { openDb, migrate } from '../src/db/sqlite.js'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { loadConfig } from '../src/config.js'

const fresh = () => { const db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db); return db }

describe('migration v2', () => {
  it('fresh db has v2 columns/tables/indexes and user_version=2', () => {
    const db = fresh()
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBeGreaterThanOrEqual(4) // v1.3 迁移后新库为 4(v2 特性由下列断言钉住)
    const agentCols = (db.prepare('PRAGMA table_info(agents)').all() as any[]).map(c => c.name)
    expect(agentCols).toEqual(expect.arrayContaining(['webhook_url', 'webhook_secret']))
    const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as any[]).map(c => c.name)
    expect(taskCols).toEqual(expect.arrayContaining(['result_schema', 'budget_amount', 'budget_currency']))
    for (const t of ['task_reviews', 'ledger_events']) expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(t)).toBeTruthy()
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_messages_thread'`).get()).toBeTruthy()
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_audit_task'`).get()).toBeTruthy()
  })
  it('migrate is idempotent (second run no-throw)', () => { const db = fresh(); expect(() => migrate(db)).not.toThrow() })
  it('v1 INSERT paths unaffected by new columns (explicit column lists)', () => {
    const db = fresh()
    // 简报原版直接插 messages，但 messages 有 FK→agents 且 foreign_keys=ON，先种两个 agent
    db.prepare(`INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES ('a','A','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),('b','B','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run()
    db.prepare(`INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, created_at) VALUES ('m1','c1','a','b','text','{}',NULL,'2026-01-01T00:00:00Z')`).run()
    expect(db.prepare(`SELECT budget_currency FROM tasks LIMIT 1`).all().length).toBe(0) // 空表可查即列在
    expect((db.prepare('SELECT COUNT(*) c FROM messages').get() as any).c).toBe(1)
  })
  it('config reads new envs', () => {
    expect(loadConfig({ WEBHOOK_ALLOW_PRIVATE: 'true' } as never).webhookAllowPrivate).toBe(true)
    expect(loadConfig({} as never).webhookAllowPrivate).toBe(false)
    expect(loadConfig({ RATE_LIMIT_WEBHOOK_TEST_PER_MIN: '3' } as never).rate.webhookTestPerMin).toBe(3)
    expect(loadConfig({} as never).rate.webhookTestPerMin).toBe(6)
  })
})
