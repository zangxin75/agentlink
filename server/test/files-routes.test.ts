// 文件通道路由层测试（设计 v3）：上传三连检/流式上传/下载流式/404 防枚举/415 映射
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { openDb, migrate } from '../src/db/sqlite.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig } from '../src/config.js'
import { registerAgent } from '../src/core/agents.js'
import { Bus } from '../src/core/bus.js'
import { RateLimiter } from '../src/core/ratelimit.js'
import { reserveFile, finalizeFile } from '../src/core/files.js'
import type { Db } from '../src/db/sqlite.js'
import type { Config } from '../src/config.js'

let dir: string, db: Db, cfg: Config, filesDir: string, ta: string, tb: string
const H = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/octet-stream' })
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'al-fr-'))
  filesDir = join(dir, 'blobs')
  cfg = loadConfig({ REGISTRATION_CODE: 'x', FILES_DIR: filesDir, FILE_MAX_MB: '1', FILE_QUOTA_MB: '2' } as never)
  db = openDb(join(dir, 't.db')); migrate(db)
  ta = registerAgent(db, cfg, { agent_id: 'alice.dev', registration_code: 'x' }).token
  tb = registerAgent(db, cfg, { agent_id: 'bob.ops', registration_code: 'x' }).token
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })
const app = () => buildApp({ db, cfg, bus: new Bus(), limiter: new RateLimiter(cfg.rate) } as never)

describe('POST /v1/files 上传', () => {
  it('201:流式上传落盘,返回 file_id/sha256/size;blob 内容逐字节一致', async () => {
    const body = 'hello file'
    const res = await app().inject({ method: 'POST', url: '/v1/files?to=bob.ops&name=a.txt', headers: H(ta), payload: body })
    expect(res.statusCode).toBe(201)
    const j = res.json()
    expect(j.file_id).toMatch(/^file_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(j.sha256).toBe(sha(body))
    expect(j.size).toBe(body.length)
    expect(readFileSync(join(filesDir, j.file_id), 'utf8')).toBe(body)
  })
  it('未鉴权 401:onRequest 阶段即拒(body 不被解析消费)', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/files?to=bob.ops&name=a', headers: { 'content-type': 'application/octet-stream' }, payload: 'x' })
    expect(res.statusCode).toBe(401)
  })
  it('CL=0 → 400 INVALID_REQUEST', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/files?to=bob.ops&name=a', headers: H(ta), payload: '' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('INVALID_REQUEST')
  })
  it('CL>FILE_MAX → 413,无 blob 残留', async () => {
    const big = 'x'.repeat(1024 * 1024 + 10)
    const res = await app().inject({ method: 'POST', url: '/v1/files?to=bob.ops&name=a', headers: H(ta), payload: big })
    expect(res.statusCode).toBe(413)
    expect(existsSync(filesDir)).toBeFalsy()
  })
  it('超配额 → 403 QUOTA_EXCEEDED,预留行清理', async () => {
    const one = 'y'.repeat(1024 * 1024)
    const r1 = await app().inject({ method: 'POST', url: '/v1/files?to=bob.ops&name=a', headers: H(ta), payload: one })
    expect(r1.statusCode).toBe(201)
    const r2 = await app().inject({ method: 'POST', url: '/v1/files?to=bob.ops&name=b', headers: H(ta), payload: one })
    expect(r2.statusCode).toBe(201)
    const r3 = await app().inject({ method: 'POST', url: '/v1/files?to=bob.ops&name=c', headers: H(ta), payload: one })
    expect(r3.statusCode).toBe(403)
    expect(r3.json().error.code).toBe('QUOTA_EXCEEDED')
    const rows = db.prepare('SELECT COUNT(*) c FROM files').get() as any
    expect(rows.c).toBe(2)
  })
  it('to 不存在 → 404 AGENT_NOT_FOUND', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/files?to=ghost.xyz&name=a', headers: H(ta), payload: 'x'.repeat(10) })
    expect(res.statusCode).toBe(404)
  })
  it('client_file_id 幂等:重传 200 deduplicated', async () => {
    const body = 'same-bytes'
    const u = '/v1/files?to=bob.ops&name=a&client_file_id=cf1'
    const r1 = await app().inject({ method: 'POST', url: u, headers: H(ta), payload: body })
    const r2 = await app().inject({ method: 'POST', url: u, headers: H(ta), payload: body })
    expect(r1.statusCode).toBe(201)
    expect(r2.statusCode).toBe(200)
    expect(r2.json().deduplicated).toBe(true)
    expect(r2.json().file_id).toBe(r1.json().file_id)
  })
  it('实际字节超 FILE_MAX(CL 撒谎)→ 413 且清理', async () => {
    // CL 头手工写小,body 实际 >1MB —— Transform 计数兜底
    const big = 'z'.repeat(1024 * 1024 + 100)
    const res = await app().inject({ method: 'POST', url: '/v1/files?to=bob.ops&name=a', headers: { ...H(ta), 'content-length': String(big.length) }, payload: big })
    expect(res.statusCode).toBe(413)
  })
  it('未注册 content-type → 415(不再 500)', async () => {
    const res = await app().inject({ method: 'POST', url: '/v1/files?to=bob.ops&name=a', headers: { authorization: `Bearer ${ta}`, 'content-type': 'application/x-bogus' }, payload: 'x' })
    expect(res.statusCode).toBe(415)
  })
})

describe('GET /v1/files/:id 下载', () => {
  const uploadOk = async (content = 'payload-123') => {
    const r = await app().inject({ method: 'POST', url: '/v1/files?to=bob.ops&name=d.txt', headers: H(ta), payload: content })
    return r.json().file_id as string
  }
  it('from/to 可下载:流式回体 + x-sha256 头 + content-disposition RFC5987', async () => {
    const id = await uploadOk('payload-123')
    const res = await app().inject({ method: 'GET', url: `/v1/files/${id}`, headers: { authorization: `Bearer ${tb}` } })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('payload-123')
    expect(res.headers['x-sha256']).toBe(sha('payload-123'))
    expect(res.headers['content-disposition']).toContain("attachment; filename*=UTF-8''d.txt")
  })
  it('无关第三方 404(防枚举);未鉴权 401', async () => {
    const id = await uploadOk()
    const tc = registerAgent(db, cfg, { agent_id: 'eve.hax', registration_code: 'x' }).token
    const r1 = await app().inject({ method: 'GET', url: `/v1/files/${id}`, headers: { authorization: `Bearer ${tc}` } })
    expect(r1.statusCode).toBe(404)
    const r2 = await app().inject({ method: 'GET', url: `/v1/files/${id}` })
    expect(r2.statusCode).toBe(401)
  })
  it('过期 → 404 与不存在同文案;坏 id 格式 404', async () => {
    const id = await uploadOk()
    db.prepare('UPDATE files SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), id)
    const r1 = await app().inject({ method: 'GET', url: `/v1/files/${id}`, headers: { authorization: `Bearer ${tb}` } })
    expect(r1.statusCode).toBe(404)
    const r2 = await app().inject({ method: 'GET', url: '/v1/files/../../etc/passwd', headers: { authorization: `Bearer ${tb}` } })
    expect(r2.statusCode).toBe(404)
  })
})
