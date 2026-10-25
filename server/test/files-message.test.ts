// file 消息引用测试（设计 v3）：schema 放宽 + core file 分支校验/覆写/to 匹配
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openDb, migrate } from '../src/db/sqlite.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig } from '../src/config.js'
import { registerAgent } from '../src/core/agents.js'
import { Bus } from '../src/core/bus.js'
import { RateLimiter } from '../src/core/ratelimit.js'
import { reserveFile, finalizeFile } from '../src/core/files.js'
import { sendMessage } from '../src/core/messages.js'
import type { Db } from '../src/db/sqlite.js'

let dir: string, db: Db, cfg: any, filesDir: string, ta: string, tb: string, tc: string
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'al-fm-'))
  filesDir = join(dir, 'blobs')
  cfg = loadConfig({ REGISTRATION_CODE: 'x', FILES_DIR: filesDir } as never)
  db = openDb(join(dir, 't.db')); migrate(db)
  mkdirSync(filesDir, { recursive: true })
  ta = registerAgent(db, cfg, { agent_id: 'alice.dev', registration_code: 'x' }).token
  tb = registerAgent(db, cfg, { agent_id: 'bob.ops', registration_code: 'x' }).token
  tc = registerAgent(db, cfg, { agent_id: 'carol.io', registration_code: 'x' }).token
})
const app = () => buildApp({ db, cfg, bus: new Bus(), limiter: new RateLimiter(cfg.rate) } as never)
const H = (t: string) => ({ authorization: `Bearer ${t}` })

// 造一个已完成上传
const mkFile = (from: string, to: string, name = 'doc.txt', content = 'DATA') => {
  const f = reserveFile(db, filesDir, { from, to, name, size: content.length, clientFileId: null }, cfg)
  writeFileSync(join(filesDir, `tmp-${f.id}`), content)
  finalizeFile(db, filesDir, f.id, content.length, sha(content))
  return f.id
}

describe('POST /v1/messages type:file', () => {
  it('201:body 以 files 行覆写 name/size/sha256(自报伪造被杀)', async () => {
    const fid = mkFile('alice.dev', 'bob.ops')
    const res = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: {
      to: 'bob.ops', type: 'file', body: { file_id: fid, name: '伪造.pdf', size: 999999, sha256: 'deadbeef', note: '见附件' }, client_msg_id: 'f1' } })
    expect(res.statusCode).toBe(201)
    const m = res.json().message
    expect(m.type).toBe('file')
    expect(m.body.name).toBe('doc.txt')
    expect(m.body.size).toBe(4)
    expect(m.body.sha256).toBe(sha('DATA'))
    expect(m.body.note).toBe('见附件')
  })
  it('上传给 A 发给 B → 400 FILE_RECIPIENT_MISMATCH', async () => {
    const fid = mkFile('alice.dev', 'bob.ops')
    const res = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: {
      to: 'carol.io', type: 'file', body: { file_id: fid, name: 'x', size: 1, sha256: 'x' }, client_msg_id: 'f2' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('FILE_RECIPIENT_MISMATCH')
  })
  it('引用他人上传的文件 → 400;文件不存在 → 400;in-flight(sha NULL) → 400;过期 → 400', async () => {
    const ok = mkFile('alice.dev', 'bob.ops')
    const other = mkFile('bob.ops', 'alice.dev') // bob 上传的
    const inflight = reserveFile(db, filesDir, { from: 'alice.dev', to: 'bob.ops', name: 'i', size: 1, clientFileId: null }, cfg).id
    const expired = mkFile('alice.dev', 'bob.ops', 'e')
    db.prepare('UPDATE files SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1).toISOString(), expired)
    const base = (fid: string, cmid: string) => app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: {
      to: 'bob.ops', type: 'file', body: { file_id: fid, name: 'x', size: 1, sha256: 'x' }, client_msg_id: cmid } })
    expect((await base(ok, 'ok1')).statusCode).toBe(201)
    expect((await base(other, 'o1')).json().error.code).toBe('FILE_RECIPIENT_MISMATCH')
    expect((await base('file_01HZZZZZZZZZZZZZZZZZZZZZZZZ', 'o2')).json().error.code).toBe('INVALID_REQUEST')
    expect((await base(inflight, 'o3')).json().error.code).toBe('INVALID_REQUEST')
    expect((await base(expired, 'o4')).json().error.code).toBe('INVALID_REQUEST')
  })
  it('note >4KB 字节 → 413;text 消息照旧(text-only 回归)', async () => {
    const fid = mkFile('alice.dev', 'bob.ops')
    const big = '汉'.repeat(1366) // 4098 字节
    const r1 = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: {
      to: 'bob.ops', type: 'file', body: { file_id: fid, name: 'x', size: 1, sha256: 'x', note: big }, client_msg_id: 'n1' } })
    expect(r1.statusCode).toBe(413)
    const r2 = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: {
      to: 'bob.ops', type: 'text', body: { text: 'plain' }, client_msg_id: 't1' } })
    expect(r2.statusCode).toBe(201)
  })
  it('type 未知值 → 400(schema enum)', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/messages', headers: H(ta), payload: {
      to: 'bob.ops', type: 'video', body: { text: 'x' }, client_msg_id: 'v1' } })
    expect(res.statusCode).toBe(400)
  })
  it('core sendMessage file 分支直接可用(签名泛化)', () => {
    const fid = mkFile('alice.dev', 'bob.ops')
    const out = sendMessage(db, new Bus(), 'alice.dev', { to: 'bob.ops', type: 'file', body: { file_id: fid, name: 'a', size: 1, sha256: 'b', note: 'n' }, client_msg_id: 'c1' })
    expect(out.message.body.file_id).toBe(fid)
  })
})
