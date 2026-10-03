import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db/sqlite.js'
import { migrate } from '../src/db/schema.js'
import { getAgent, registerAgent } from '../src/core/agents.js'
import { loadConfig } from '../src/config.js'

describe('migration v1.2 (profile)', () => {
  it('新库:agents 带 profile 两列,默认值正确', () => {
    const db = openDb(':memory:'); migrate(db)
    const { agent, token } = registerAgent(db, loadConfig({ REGISTRATION_CODE: 'x' }), { agent_id: 'alice.dev', registration_code: 'x' })
    void token
    const a = getAgent(db, 'alice.dev')
    expect(a.profile).toEqual({})
    expect(a.profile_updated_at).toBe('')
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBeGreaterThanOrEqual(3)
  })
  it('旧库(v=2,无 profile 列)迁移后旧 agent 行补默认值', () => {
    // 模拟真 v2 旧库:手建无 profile 列的 agents 表后直插旧行(全量 migrate 过的库再降版本会撞 duplicate column,无法降级)
    const db = openDb(':memory:')
    db.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      capabilities TEXT NOT NULL DEFAULT '[]', task_policy TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`)
    db.exec(`INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES ('old.one','old','','')`) // 绕过注册直插
    db.prepare('PRAGMA user_version = 2').run()
    migrate(db) // v<3 门控:补列并提版本
    const a = getAgent(db, 'old.one')
    expect(a.profile).toEqual({})
    expect(a.profile_updated_at).toBe('')
  })
  it('已 v3 再 migrate 不炸(幂等)', () => {
    const db = openDb(':memory:'); migrate(db); migrate(db)
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBeGreaterThanOrEqual(4)
  })
})
