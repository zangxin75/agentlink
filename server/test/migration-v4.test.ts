// v4 迁移:messages.topic 默认 _default;agent_topics 表存在;v3 存量行升级路径
import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db/sqlite.js'
import { migrate } from '../src/db/schema.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('migration v4', () => {
  it('全新库迁移后 messages 有 topic 列、agent_topics 表存在、user_version=4', () => {
    const db = openDb(join(tmpdir(), `v4-${Date.now()}.db`))
    migrate(db)
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBeGreaterThanOrEqual(4)
    const cols = (db.prepare('pragma table_info(messages)').all() as any[]).map(c => c.name)
    expect(cols).toContain('topic')
    const tcols = (db.prepare('pragma table_info(agent_topics)').all() as any[]).map(c => c.name)
    expect(tcols).toEqual(['agent_id', 'topic', 'refreshed_at', 'expires_at'])
  })
  it('v3 存量 messages 行升级后 topic 默认 _default', () => {
    // 手建停在 v3 的库（全量 migrate 过再降版本会撞 duplicate column,无法降级——migration-v3.test.ts 同款手法）
    const db = openDb(':memory:')
    db.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      capabilities TEXT NOT NULL DEFAULT '[]', task_policy TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
      profile TEXT NOT NULL DEFAULT '{}', profile_updated_at TEXT NOT NULL DEFAULT '')`)
    db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, client_msg_id TEXT NOT NULL, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
      type TEXT NOT NULL, body TEXT NOT NULL, thread_id TEXT, created_at TEXT NOT NULL, delivered_at TEXT, read_at TEXT)`)
    db.prepare(`INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES ('a1','A','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run()
    db.prepare(`INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, created_at) VALUES ('m1','c1','a1','a1','text','{}','2026-01-01T00:00:00Z')`).run()
    db.prepare('PRAGMA user_version = 3').run()
    migrate(db) // v3→v4 增量
    expect((db.prepare('SELECT topic FROM messages WHERE id=?').get('m1') as any).topic).toBe('_default')
  })
})
