// schema v8 迁移：agents.role/owner、messages.group_id、groups/group_members/agent_notes 表
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'

const db0 = () => openDb(join(mkdtempSync(join(tmpdir(), 'sv8-')), 't.db'))

describe('schema v8', () => {
  it('全新库一次迁移到位：列/表/索引/版本号', () => {
    const db = db0(); migrate(db, { defaultOwner: 'kt.human' })
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBe(9) // v9 起为终态版本号
    expect((db.prepare(`SELECT role FROM agents WHERE id='server'`).get() as any).role).toBe('agent')
    for (const t of ['groups', 'group_members', 'agent_notes']) {
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t)).toBeTruthy()
    }
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_group'`).get()).toBeTruthy()
  })
  it('存量 agent 回填 owner=defaultOwner，role 缺省 agent，server 行也在内', () => {
    // migrate 首跑即完成全部版本块（含 v8 列）；回填在版本门之外按 WHERE owner='' 幂等执行，
    // 所以「先迁移→后插行→再迁移」也能回填（r1-C1：原设计把回填放版本门内则此路径必挂）
    const db = db0(); migrate(db)
    db.prepare(`INSERT INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at) VALUES ('old.a','a','','[]','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run()
    migrate(db, { defaultOwner: 'kt.human' })
    expect((db.prepare(`SELECT owner FROM agents WHERE id='old.a'`).get() as any).owner).toBe('kt.human')
    expect((db.prepare(`SELECT role FROM agents WHERE id='old.a'`).get() as any).role).toBe('agent')
    expect((db.prepare(`SELECT owner FROM agents WHERE id='server'`).get() as any).owner).toBe('kt.human')
  })
  it('不传 defaultOwner：owner 留空串不炸；回填幂等且不覆盖非空 owner', () => {
    const db = db0(); migrate(db)
    expect((db.prepare(`SELECT owner FROM agents WHERE id='server'`).get() as any).owner).toBe('')
    db.prepare(`UPDATE agents SET owner='someone.else' WHERE id='server'`).run()
    migrate(db, { defaultOwner: 'kt.human' }) // 非空 owner 不覆盖
    expect((db.prepare(`SELECT owner FROM agents WHERE id='server'`).get() as any).owner).toBe('someone.else')
    db.prepare(`INSERT INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at) VALUES ('old.b','b','','[]','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run()
    migrate(db, { defaultOwner: 'kt.human' }) // 新增的空 owner 行照样回填（版本门外）
    expect((db.prepare(`SELECT owner FROM agents WHERE id='old.b'`).get() as any).owner).toBe('kt.human')
  })
})
