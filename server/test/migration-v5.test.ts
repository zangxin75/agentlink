import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db/sqlite.js'
import { migrate } from '../src/db/schema.js'

describe('migration v1.4 (credit market)', () => {
  it('新库:迁移到 user_version=5,市场六表存在,credit_pool 单行 balance=0', () => {
    const db = openDb(':memory:'); migrate(db)
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBe(5)
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('credit_accounts','credit_ledger','listings','bids','deals','credit_pool')"
    ).all() as { name: string }[]).map(r => r.name).sort()
    expect(names).toEqual(['bids', 'credit_accounts', 'credit_ledger', 'credit_pool', 'deals', 'listings'])
    const pool = db.prepare('SELECT id, balance FROM credit_pool').all() as any[]
    expect(pool).toEqual([{ id: 1, balance: 0 }])
  })
  it('旧库(v=4)迁移后市场六表就位且旧数据无损', () => {
    // 模拟真 v4 旧库:手建最小 agents 表后直插旧行(全量 migrate 过的库再降版本会撞 duplicate column,无法降级)
    const db = openDb(':memory:')
    db.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      capabilities TEXT NOT NULL DEFAULT '[]', task_policy TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`)
    db.exec(`INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES ('old.one','old','','')`)
    db.prepare('PRAGMA user_version = 4').run()
    migrate(db) // v<5 门控:建六表并提版本
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBe(5)
    // 旧表数据无损
    const a = db.prepare('SELECT id, display_name FROM agents WHERE id = ?').get('old.one') as any
    expect(a.display_name).toBe('old')
    const pool = db.prepare('SELECT id, balance FROM credit_pool').all() as any[]
    expect(pool).toEqual([{ id: 1, balance: 0 }])
  })
  it('已 v5 再 migrate 不炸(幂等)', () => {
    const db = openDb(':memory:'); migrate(db); migrate(db)
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBe(5)
  })
})
