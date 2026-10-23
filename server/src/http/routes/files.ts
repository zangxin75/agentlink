// 文件通道路由（设计 v3 .superpowers/reviews/2026-10-21-files-design-v3.md）
// 挂 db+limiter 层（与 bus 解耦）。上传：onRequest 鉴权（body 解析先于 preHandler，未鉴权流不得被消费）
// + CL 三连检 + statfs 低水位 + 同步事务预留 + 流式落盘。下载：from/to 404 防枚举 + open fd 先行 + 流式回体。
import type { FastifyInstance } from 'fastify'
import { createWriteStream, mkdirSync, openSync, statfsSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { authenticate, getAuth } from '../auth.js'
import { Errors, AppError } from '../errors.js'
import { getAgent, AGENT_ID_RE } from '../../core/agents.js'
import { reserveFile, finalizeFile, abortFile, getFile, FILE_ID_RE, sanitizeFileName } from '../../core/files.js'
import { audit } from '../../core/audit.js'
import type { Db } from '../../db/sqlite.js'
import type { Config } from '../../config.js'
import type { RateLimiter } from '../../core/ratelimit.js'

// 每 agent 并发上传软上限（内存计数，进程级）
const inflight = new Map<string, number>()

// RFC5987 filename* 编码（encodeURIComponent 已灭 CRLF/引号/百分号转义足够）
const rfc5987 = (s: string) => encodeURIComponent(s)

export function registerFileRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; limiter: RateLimiter }): void {
  const { db, cfg, limiter } = deps
  const auth = authenticate(db, cfg)
  const maxBytes = cfg.fileMaxMb * 1024 * 1024

  // 上传：octet-stream 直通 parser（app.ts 注册，无 parseAs —— v5 parseAs 仅 string/buffer）
  app.post('/v1/files', { onRequest: auth }, async (req, reply) => {
    const me = getAuth(req).agent.id
    try { limiter.checkFileUpload(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(db, me, 'ratelimit.exceeded', { path: '/v1/files' })
      throw e
    }
    const q = req.query as { to?: string; name?: string; client_file_id?: string }
    const to = q.to ?? ''
    if (!AGENT_ID_RE.test(to)) throw Errors.invalidRequest('to must be a valid agent_id')
    getAgent(db, to) // 404 if unknown
    const name = sanitizeFileName(q.name ?? '') ?? 'file'
    if (Buffer.byteLength(name) > 255) throw Errors.invalidRequest('name too long')
    const clientFileId = q.client_file_id ? q.client_file_id.slice(0, 128) : null

    // CL 三连检（前置两条；第三条在事务内）：CL 是配额预留依据，必须存在
    const te = req.headers['transfer-encoding']
    const clHeader = req.headers['content-length']
    const cl = Number(clHeader)
    if (te || clHeader == null || !Number.isFinite(cl) || cl <= 0) throw Errors.invalidRequest('Content-Length required (chunked not supported)')
    if (cl > maxBytes) throw Errors.payloadTooLarge(`file > ${cfg.fileMaxMb}MB`)

    // statfs 低水位（事务外、解析前）：剩余 < 2×FILE_MAX 拒传，防 blob 写满连坐 SQLite 主流程
    mkdirSync(cfg.filesDir, { recursive: true })
    const st = statfsSync(cfg.filesDir)
    if (st.bsize * Number(st.bavail) < 2 * maxBytes) throw Errors.insufficientStorage()

    // 并发软上限 2
    const cur = inflight.get(me) ?? 0
    if (cur >= 2) throw Errors.rateLimited(1)
    inflight.set(me, cur + 1)

    const res = reserveFile(db, cfg.filesDir, { from: me, to, name, size: cl, clientFileId }, cfg)
    if (res.deduplicated) {
      inflight.set(me, (inflight.get(me) ?? 1) - 1)
      const row = getFile(db, me, res.id)!
      return reply.status(200).send({ file_id: row.id, sha256: row.sha256, size: row.size, expires_at: row.expires_at, deduplicated: true })
    }

    const tmpPath = join(cfg.filesDir, `tmp-${res.id}`)
    const hash = createHash('sha256')
    let actual = 0
    // 逐 chunk 计数 + 哈希：CL 撒谎/无界流的兜底断流
    const guard = new Transform({ transform(chunk: Buffer, _enc, cb) {
      actual += chunk.length
      if (actual > maxBytes) { cb(Errors.payloadTooLarge(`file > ${cfg.fileMaxMb}MB`)); return }
      hash.update(chunk); cb(null, chunk)
    } })
    try {
      await pipeline(req.body as NodeJS.ReadableStream, guard, createWriteStream(tmpPath))
      const shaHex = hash.digest('hex')
      finalizeFile(db, cfg.filesDir, res.id, actual, shaHex)
      audit(db, me, 'file.uploaded', { file_id: res.id, to, size: actual })
      return reply.status(201).send({ file_id: res.id, sha256: shaHex, size: actual, expires_at: res.expires_at })
    } catch (e) {
      abortFile(db, cfg.filesDir, res.id) // 清理独立于响应成败（socket 断 reply 不可达也要删）
      const msg = String((e as Error)?.message ?? e)
      if (e instanceof AppError) throw e // 限额类(413/403/409)原样
      if ((e as any)?.code === 'ENOSPC') { audit(db, me, 'file.upload_failed', { file_id: res.id, error: msg }); throw Errors.insufficientStorage() }
      if (/premature close|ECONNRESET|aborted/i.test(msg)) { audit(db, me, 'file.upload_aborted', { file_id: res.id }); return } // 断流：socket 已断，静默
      audit(db, me, 'file.upload_failed', { file_id: res.id, error: msg }) // default → 500（r3 MINOR-1）
      throw Errors.internal()
    } finally {
      const n = (inflight.get(me) ?? 1) - 1
      if (n > 0) inflight.set(me, n); else inflight.delete(me)
    }
  })

  // 下载：仅 from/to 本人；过期/缺 blob/坏 id 一律 404 同文案（防枚举）。先 open fd 再回体（scanner unlink 竞态安全）
  app.get('/v1/files/:id', { preHandler: auth }, async (req, reply) => {
    const me = getAuth(req).agent.id
    const { id } = req.params as { id: string }
    try { limiter.checkFileDownload(me) } catch (e) {
      if (e instanceof AppError && e.code === 'RATE_LIMITED') audit(db, me, 'ratelimit.exceeded', { path: `/v1/files/${id}` })
      throw e
    }
    if (!FILE_ID_RE.test(id)) throw Errors.notFound('文件不存在或已过期（TTL 14 天）')
    const row = getFile(db, me, id)
    if (!row || row.sha256 == null || new Date(row.expires_at).getTime() <= Date.now()) throw Errors.notFound('文件不存在或已过期（TTL 14 天）')
    let fd: number
    try { fd = openSync(join(cfg.filesDir, id), 'r') } catch { throw Errors.notFound('文件不存在或已过期（TTL 14 天）') } // ENOENT(竞态) 与缺失同文案
    audit(db, me, 'file.downloaded', { file_id: id })
    reply.header('content-type', 'application/octet-stream')
    reply.header('x-sha256', row.sha256)
    reply.header('content-length', String(row.size))
    reply.header('content-disposition', `attachment; filename*=UTF-8''${rfc5987(row.name)}`)
    return reply.send(createReadStream(join(cfg.filesDir, id), { fd }))
  })
}
