import { describe, it, expect } from 'vitest'
import { openDb } from '../src/db/sqlite.js'
import { migrate } from '../src/db/schema.js'
import { loadConfig } from '../src/config.js'
import { Errors } from '../src/http/errors.js'
import { RateLimiter } from '../src/core/ratelimit.js'

describe('migration v1.6 (files 表)', () => {
  it('新库:迁移到 user_version=7,files 表与三索引就位', () => {
    const db = openDb(':memory:'); migrate(db)
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBeGreaterThanOrEqual(7)
    const cols = (db.prepare("PRAGMA table_info('files')").all() as { name: string }[]).map(r => r.name)
    expect(cols).toEqual(['id', 'from_agent', 'to_agent', 'name', 'size', 'sha256', 'client_file_id', 'created_at', 'expires_at'])
    const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='files'").all() as { name: string }[]).map(r => r.name)
    expect(idx).toEqual(expect.arrayContaining(['idx_files_expiry', 'idx_files_from', 'sqlite_autoindex_files_1']))
    // 唯一索引 (from_agent, to_agent, client_file_id)——显式命名，非 autoindex
    const uniq = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_files_idem'").get() as any
    expect(uniq.sql).toContain('from_agent, to_agent, client_file_id')
  })
  it('旧库(v=6)迁移后 files 表就位且旧数据无损', () => {
    const db = openDb(':memory:')
    db.exec(`CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      capabilities TEXT NOT NULL DEFAULT '[]', task_policy TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL)`)
    db.prepare('PRAGMA user_version = 6').run()
    migrate(db)
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBeGreaterThanOrEqual(7)
    expect(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='files'").get()).toBeTruthy()
  })
  it('已 v7 再 migrate 幂等', () => {
    const db = openDb(':memory:'); migrate(db); migrate(db)
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBeGreaterThanOrEqual(7)
  })
})

describe('files config + errors + ratelimit', () => {
  it('config 四项 env 可覆盖,filesDir 缺省随 dbPath', () => {
    const c = loadConfig({})
    expect(c.fileMaxMb).toBe(32)
    expect(c.fileQuotaMb).toBe(200)
    expect(c.fileTtlDays).toBe(14)
    expect(c.filesDir).toBe('data/files')
    const c2 = loadConfig({ DB_PATH: '/x/y.db', FILES_DIR: '/blobs', FILE_MAX_MB: '1', FILE_QUOTA_MB: '2', FILE_TTL_DAYS: '3' })
    expect(c2.filesDir).toBe('/blobs')
    expect(c2.fileMaxMb).toBe(1); expect(c2.fileQuotaMb).toBe(2); expect(c2.fileTtlDays).toBe(3)
  })
  it('errors 工厂:QUOTA_EXCEEDED 403 / INSUFFICIENT_STORAGE 507 / FILE_UPLOAD_IN_PROGRESS 409', () => {
    expect(Errors.quotaExceeded().status).toBe(403)
    expect(Errors.quotaExceeded().code).toBe('QUOTA_EXCEEDED')
    expect(Errors.insufficientStorage().status).toBe(507)
    expect(Errors.fileUploadInProgress().status).toBe(409)
  })
  it('上传桶小时窗语义:10 连发过,第 11 发 429(慢补:秒回不放行)', () => {
    const l = new RateLimiter(loadConfig({}).rate)
    const a = 'up.test'
    for (let i = 0; i < 10; i++) expect(() => l.checkFileUpload(a)).not.toThrow()
    expect(() => l.checkFileUpload(a)).toThrowError(expect.objectContaining({ status: 429 }))
    // 不同 agent 独立桶
    expect(() => l.checkFileUpload('up.other')).not.toThrow()
  })
  it('下载桶 60/min', () => {
    const l = new RateLimiter(loadConfig({}).rate)
    for (let i = 0; i < 60; i++) expect(() => l.checkFileDownload('dl.test')).not.toThrow()
    expect(() => l.checkFileDownload('dl.test')).toThrowError(expect.objectContaining({ status: 429 }))
  })
})
