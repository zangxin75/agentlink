// server/test/db.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'

describe('db', () => {
  it('creates all tables and indexes idempotently', () => {
    const db = openDb(':memory:')
    migrate(db); migrate(db)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name)
    for (const t of ['agents', 'tokens', 'messages', 'tasks', 'audit_log']) expect(tables).toContain(t)
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").all().map((r: any) => r.name)
    expect(idx).toEqual(expect.arrayContaining(['idx_messages_peer', 'idx_messages_inbox', 'idx_messages_unread', 'idx_tasks_executor', 'idx_tasks_requester', 'idx_tasks_deadline', 'idx_tasks_expires']))
  })
  it('applies pragmas on file db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-'))
    const db = openDb(join(dir, 't.db'))
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000)
    db.close()
  })
})
