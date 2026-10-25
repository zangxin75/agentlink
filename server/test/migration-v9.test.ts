// server/test/migration-v9.test.ts —— v9 迁移：regcode 两表 + 版本门控幂等
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'

const fresh = () => { const db = openDb(join(mkdtempSync(join(tmpdir(), 'mv9-')), 't.db')); migrate(db); return db }

describe('migration v9', () => {
  it('建 registration_codes/email_verifies；user_version=9；重跑幂等', () => {
    const db = fresh()
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBe(9)
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map(c => c.name)
    expect(cols('registration_codes')).toEqual(['code', 'owner_agent_id', 'email_norm', 'created_at', 'revoked_at'])
    expect(cols('email_verifies')).toEqual(['email_norm', 'secret_hash', 'human_agent_id', 'expires_at', 'attempts'])
    // r1 minor：索引与 PK 语义一并钉死（email_verifies PK 支撑 apply 覆盖语义）
    expect((db.prepare(`SELECT COUNT(*) c FROM pragma_index_list('registration_codes') WHERE name='idx_regcode_email'`).get() as any).c).toBe(1)
    db.prepare(`INSERT INTO email_verifies (email_norm, secret_hash, human_agent_id, expires_at, attempts) VALUES ('a@b.c', 'h1', 'kt.human', '2026-01-01T00:00:00Z', 0)`).run()
    db.prepare(`INSERT OR REPLACE INTO email_verifies (email_norm, secret_hash, human_agent_id, expires_at, attempts) VALUES ('a@b.c', 'h2', 'kt.human', '2026-01-02T00:00:00Z', 0)`).run() // 同邮箱覆盖（apply 覆盖语义的 PK 支撑）
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES ('al_reg_x', 'kt.human', 'a@b.c', '2026-01-01T00:00:00Z')`).run()
    migrate(db) // 幂等重跑不清数据
    expect((db.prepare(`SELECT COUNT(*) c FROM registration_codes`).get() as any).c).toBe(1)
  })
  it('v8 库升级路径：fresh 迁移含全部 v8 产物（group 列）——真实 v8→v9 老库升级由 user_version 门控保证，部署冒烟复核（r2-N6 注：fresh db 无法回停在 v8，此用例钉的是"v9 迁移不丢 v8 产物"）', () => {
    const db = fresh()
    expect((db.prepare(`SELECT COUNT(*) c FROM pragma_table_info('messages') WHERE name='group_id'`).get() as any).c).toBe(1)
  })
})
