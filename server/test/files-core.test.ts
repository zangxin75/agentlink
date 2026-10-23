// 文件通道 core 层测试（设计 v3）：预留/完成/中止/清理/对账/配额
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { createHash } from 'node:crypto'
import { loadConfig } from '../src/config.js'
import {
  reserveFile, finalizeFile, abortFile, cleanupFiles, reconcileFiles, getFile,
  quotaUsed, sanitizeFileName,
} from '../src/core/files.js'
import type { Config } from '../src/config.js'

let dir: string
let db: ReturnType<typeof openDb>
let filesDir: string
let cfg: Config

const insAgents = () => db.prepare(
  `INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES ('alice.dev','A','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),('bob.dev','B','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`
).run()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'al-files-'))
  db = openDb(join(dir, 't.db')); migrate(db); insAgents()
  filesDir = join(dir, 'blobs')
  cfg = loadConfig({ FILES_DIR: filesDir, FILE_QUOTA_MB: '1' }) // 1MB 配额便于测试
  mkdirSync(filesDir, { recursive: true })
})

afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

// 完成一个上传的最小路径：tmp 写盘 → finalize（UPDATE→rename）
const upload = (name: string, to: string, size: number, content = 'x', clientFileId: string | null = null) => {
  const f = reserveFile(db, filesDir, { from: 'alice.dev', to, name, size, clientFileId }, cfg)
  const sha = createHash('sha256').update(content).digest('hex')
  writeFileSync(join(filesDir, `tmp-${f.id}`), content)
  finalizeFile(db, filesDir, f.id, Buffer.byteLength(content), sha)
  return f
}

describe('reserveFile 预留事务', () => {
  it('预留行就位:file_id ULID、sha NULL、expires_at = now+TTL', () => {
    const f = reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'a.txt', size: 10, clientFileId: null }, cfg)
    expect(f.id).toMatch(/^file_[0-9A-HJKMNP-TV-Z]{26}$/)
    const r = getFile(db, 'alice.dev', f.id) as any
    expect(r.sha256).toBeNull()
    expect(new Date(r.expires_at).getTime()).toBeGreaterThan(Date.now() + 13 * 86400_000)
  })
  it('配额超限抛 QUOTA_EXCEEDED 403', () => {
    expect(() => reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'big', size: cfg.fileQuotaMb * 1024 * 1024 + 1, clientFileId: null }, cfg))
      .toThrowError(expect.objectContaining({ code: 'QUOTA_EXCEEDED', status: 403 }))
  })
  it('同步事务杀 TOCTOU:同刻两预留合计超配额,第二个被拒', () => {
    const half = cfg.fileQuotaMb * 1024 * 1024 / 2 + 1
    expect(() => reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'a', size: half, clientFileId: null }, cfg)).not.toThrow()
    expect(() => reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'b', size: half, clientFileId: null }, cfg))
      .toThrowError(expect.objectContaining({ code: 'QUOTA_EXCEEDED' }))
  })
  it('配额排除已过期未扫行', () => {
    const f = reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'a', size: cfg.fileQuotaMb * 1024 * 1024, clientFileId: null }, cfg)
    db.prepare('UPDATE files SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), f.id)
    expect(quotaUsed(db, 'alice.dev', cfg)).toBe(0)
    expect(() => reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'b', size: cfg.fileQuotaMb * 1024 * 1024, clientFileId: null }, cfg)).not.toThrow()
  })
  it('client_file_id 幂等:同 (from,to,cfid) dedup 返回已完成行;sha 不一致 400', () => {
    const f = upload('a.txt', 'bob.dev', 10, 'hello', 'cf-1')
    const again = reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'ignored', size: 99, clientFileId: 'cf-1' }, cfg)
    expect(again.id).toBe(f.id)
    expect(again.deduplicated).toBe(true)
  })
  it('同 client_file_id 不同 to 不互撞(R2-4 死锁消除)', () => {
    insertAgentBob2()
    upload('a.txt', 'bob.dev', 10, 'x', 'cf-1')
    expect(() => reserveFile(db, filesDir, { from: 'alice.dev', to: 'carol.dev', name: 'a.txt', size: 10, clientFileId: 'cf-1' }, cfg)).not.toThrow()
  })
  it('撞 in-flight 预留行(同 cfid sha NULL)→409', () => {
    reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'a', size: 10, clientFileId: 'cf-1' }, cfg)
    expect(() => reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'a', size: 10, clientFileId: 'cf-1' }, cfg))
      .toThrowError(expect.objectContaining({ code: 'FILE_UPLOAD_IN_PROGRESS', status: 409 }))
  })
  it('撞已过期未扫行:删旧行+unlink blob 后重试成功(r3 MINOR-2)', () => {
    const f = reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'a', size: 10, clientFileId: 'cf-1' }, cfg)
    writeFileSync(join(filesDir, f.id), 'old')
    db.prepare('UPDATE files SET sha256=?, expires_at=? WHERE id=?').run('f'.repeat(64), new Date(Date.now() - 1000).toISOString(), f.id)
    const again = reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'a', size: 10, clientFileId: 'cf-1' }, cfg)
    expect(again.deduplicated).toBeFalsy()
    expect(existsSync(join(filesDir, f.id))).toBe(false) // 旧 blob 已 unlink
  })
})

describe('finalize / abort', () => {
  it('finalize 先 UPDATE 再 rename:完成后 tmp 消失、正式 blob 在位', () => {
    const f = reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'a', size: 5, clientFileId: null }, cfg)
    writeFileSync(join(filesDir, `tmp-${f.id}`), 'hello')
    finalizeFile(db, filesDir, f.id, 5, 'abc')
    expect(existsSync(join(filesDir, `tmp-${f.id}`))).toBe(false)
    expect(existsSync(join(filesDir, f.id))).toBe(true)
    expect((getFile(db, 'alice.dev', f.id) as any).sha256).toBe('abc')
  })
  it('abort:删行+unlink tmp(ENOENT 忽略)', () => {
    const f = reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'a', size: 5, clientFileId: null }, cfg)
    abortFile(db, filesDir, f.id)
    expect(getFile(db, 'alice.dev', f.id)).toBeUndefined()
    writeFileSync(join(filesDir, `tmp-${f.id}`), 'x')
    const g = reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'b', size: 5, clientFileId: null }, cfg)
    writeFileSync(join(filesDir, `tmp-${g.id}`), 'x')
    abortFile(db, filesDir, g.id)
    expect(existsSync(join(filesDir, `tmp-${g.id}`))).toBe(false)
  })
})

describe('cleanupFiles tick 清理', () => {
  it('过期行:先 unlink blob 后删行;未过期保留;LIMIT 生效', () => {
    const f1 = upload('a', 'bob.dev', 5, 'aaa')
    db.prepare('UPDATE files SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), f1.id)
    const n = cleanupFiles(db, filesDir, 200)
    expect(n).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(filesDir, f1.id))).toBe(false)
    expect(getFile(db, 'alice.dev', f1.id)).toBeUndefined()
  })
  it('blob 已被外部删(ENOENT)仍删行——幂等', () => {
    const f1 = upload('a', 'bob.dev', 5, 'aaa')
    unlinkSync(join(filesDir, f1.id))
    db.prepare('UPDATE files SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), f1.id)
    expect(() => cleanupFiles(db, filesDir, 200)).not.toThrow()
    expect(getFile(db, 'alice.dev', f1.id)).toBeUndefined()
  })
})

describe('reconcileFiles 启动对账', () => {
  it('盘上多余删、行在盘缺删行、tmp-* 一律删、sha NULL 行删', () => {
    const ok = upload('ok', 'bob.dev', 5, 'aaa')          // 正常:保留
    const f2 = upload('ghost', 'bob.dev', 5, 'bbb')        // 行在盘缺:删行
    unlinkSync(join(filesDir, f2.id))
    writeFileSync(join(filesDir, 'file_orphan'), 'x')      // 盘上多余:删
    writeFileSync(join(filesDir, 'tmp-abandoned'), 'x')    // tmp:删
    const f5 = reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.dev', name: 'inflight', size: 5, clientFileId: null }, cfg)
    writeFileSync(join(filesDir, f5.id), 'half')           // sha NULL 行:删行+删 blob
    reconcileFiles(db, filesDir)
    expect(existsSync(join(filesDir, ok.id))).toBe(true)
    expect(getFile(db, 'alice.dev', ok.id)).toBeTruthy()
    expect(getFile(db, 'alice.dev', f2.id)).toBeUndefined()
    expect(existsSync(join(filesDir, 'file_orphan'))).toBe(false)
    expect(existsSync(join(filesDir, 'tmp-abandoned'))).toBe(false)
    expect(getFile(db, 'alice.dev', f5.id)).toBeUndefined()
    expect(readdirSync(filesDir)).toEqual([ok.id])
  })
})

describe('sanitizeFileName', () => {
  it('剥路径/控制字符/RTL,空回退 null', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFileName('a\x1b[31mb')).toBe('ab')
    expect(sanitizeFileName('a‮b')).toBe('ab')
    expect(sanitizeFileName('  ')).toBeNull()
    expect(sanitizeFileName('normal.txt')).toBe('normal.txt')
  })
})

// 供 to=carol 用
function insertAgentBob2() {
  db.prepare(`INSERT INTO agents (id, display_name, created_at, last_seen_at) VALUES ('carol.dev','C','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`).run()
}
