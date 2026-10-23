// 文件通道 core（设计 v3 .superpowers/reviews/2026-10-21-files-design-v3.md）
// 上传 = 预留行（同步事务杀 TOCTOU）→ 流式写 tmp → finalize（先 UPDATE 再 rename）
// 清理 = 先 unlink 后删行（幂等）；对账 = 启动双向 + tmp-* 一律删 + sha NULL 行删
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db/sqlite.js'
import type { Config } from '../config.js'
import { Errors } from '../http/errors.js'
import { newId } from './ids.js'
import { audit } from './audit.js'

export const FILE_ID_RE = /^file_[0-9A-HJKMNP-TV-Z]{26}$/

export interface FileRow {
  id: string; from_agent: string; to_agent: string; name: string; size: number
  sha256: string | null; client_file_id: string | null; created_at: string; expires_at: string
}

export function getFile(db: Db, requester: string, id: string): FileRow | undefined {
  const r = db.prepare('SELECT * FROM files WHERE id=?').get(id) as FileRow | undefined
  if (!r) return undefined
  if (r.from_agent === requester || r.to_agent === requester) return r
  // 群文件（r1-M1）：to=群 且 requester 是群成员 → 放行；否则按不存在处理（防枚举）
  if (r.to_agent.startsWith('grp.')) {
    if (db.prepare('SELECT 1 FROM group_members WHERE group_id=? AND agent_id=?').get(r.to_agent, requester)) return r
    const owner = db.prepare('SELECT owner FROM groups WHERE id=?').get(r.to_agent) as { owner: string } | undefined
    if (owner?.owner === requester) return r // 建群者
  }
  return undefined
}

// 配额占用：排除已过期未扫行（scanner 积压不虚占）
export function quotaUsed(db: Db, fromAgent: string, _cfg: Config): number {
  void _cfg
  const r = db.prepare("SELECT COALESCE(SUM(size),0) s FROM files WHERE from_agent=? AND expires_at > ?").get(fromAgent, new Date().toISOString()) as { s: number }
  return r.s
}

// 上传预留：同步事务内 SUM+CL 配额检查 + 预留行 INSERT（size 先记 CL，finalize 时按实际补正）
// client_file_id 幂等（镜像 messages idx_messages_idem 范式）：
//  - 命中「已完成且未过期」行 → 返回原行 deduplicated:true
//  - 命中 in-flight 行（sha NULL 未过期）→ 409 FILE_UPLOAD_IN_PROGRESS
//  - 命中已过期行 → 删行+unlink 残留 blob 后作为新上传重插（唯一索引让路）
export function reserveFile(db: Db, filesDir: string, input: { from: string; to: string; name: string; size: number; clientFileId: string | null }, cfg: Config): { id: string; expires_at: string; deduplicated?: boolean } {
  const now = new Date()
  const quotaMb = cfg.fileQuotaMb
  const ttlDays = cfg.fileTtlDays
  const expiresAt = new Date(now.getTime() + ttlDays * 86400_000).toISOString()
  const dupStmt = db.prepare('SELECT * FROM files WHERE from_agent=? AND to_agent=? AND client_file_id=?')

  if (input.clientFileId != null) {
    const dup = dupStmt.get(input.from, input.to, input.clientFileId) as FileRow | undefined
    if (dup && dup.sha256 != null && new Date(dup.expires_at).getTime() > now.getTime()) {
      return { id: dup.id, expires_at: dup.expires_at, deduplicated: true }
    }
  }

  const insert = db.transaction(() => {
    if (input.clientFileId != null) {
      const dup = dupStmt.get(input.from, input.to, input.clientFileId) as FileRow | undefined
      if (dup) {
        if (dup.sha256 == null && new Date(dup.expires_at).getTime() > now.getTime()) throw Errors.fileUploadInProgress()
        // 过期残留行：删行；blob 可能还在盘（scanner 积压）→ 同步 unlink（r3 MINOR-2）
        db.prepare('DELETE FROM files WHERE id=?').run(dup.id)
        if (dup.sha256 != null) { try { unlinkSync(join(filesDir, dup.id)) } catch { /* ENOENT 忽略 */ } }
      }
    }
    const used = (db.prepare("SELECT COALESCE(SUM(size),0) s FROM files WHERE from_agent=? AND expires_at > ?").get(input.from, now.toISOString()) as { s: number }).s
    if (used + input.size > quotaMb * 1024 * 1024) throw Errors.quotaExceeded()
    const id = newId('file')
    db.prepare('INSERT INTO files (id, from_agent, to_agent, name, size, sha256, client_file_id, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, input.from, input.to, input.name, input.size, null, input.clientFileId, now.toISOString(), expiresAt)
    return id
  })
  return { id: insert(), expires_at: expiresAt, deduplicated: false }
}

// 上传完成：先 UPDATE 补实际 size/sha，再 rename tmp → 正式名（R2-5a 调序：崩溃窗口落「行未完成 + tmp 未入位」态，对账天然自愈）
export function finalizeFile(db: Db, filesDir: string, id: string, actualSize: number, sha256: string): void {
  const r = db.prepare('UPDATE files SET size=?, sha256=? WHERE id=? AND sha256 IS NULL').run(actualSize, sha256, id)
  if (!r.changes) { try { unlinkSync(join(filesDir, `tmp-${id}`)) } catch { /* ENOENT 忽略 */ } return }
  mkdirSync(filesDir, { recursive: true })
  renameSync(join(filesDir, `tmp-${id}`), join(filesDir, id))
}

// 上传失败/中断：删行 + unlink tmp（ENOENT 忽略）。清理独立于响应成败。
export function abortFile(db: Db, filesDir: string, id: string): void {
  db.prepare('DELETE FROM files WHERE id=?').run(id)
  try { unlinkSync(join(filesDir, `tmp-${id}`)) } catch { /* ENOENT 忽略 */ }
}

// TTL 清理（scanner tick 挂载）：先 unlink blob 后删行（中途死 → 下轮 unlink ENOENT 忽略 → 删行成功，幂等）。LIMIT 防大批量 unlink 风暴。
export function cleanupFiles(db: Db, filesDir: string, limit: number): number {
  const rows = db.prepare('SELECT id FROM files WHERE expires_at <= ? ORDER BY expires_at LIMIT ?').all(new Date().toISOString(), limit) as { id: string }[]
  let n = 0
  for (const r of rows) {
    try { unlinkSync(join(filesDir, r.id)) } catch { /* ENOENT 忽略 */ }
    db.prepare('DELETE FROM files WHERE id=?').run(r.id)
    n++
  }
  return n
}

// 启动对账（双向）：盘上多余删、行在盘缺删行、tmp-* 一律删、sha NULL 行（未完成上传）删行+删 blob
export function reconcileFiles(db: Db, filesDir: string): void {
  mkdirSync(filesDir, { recursive: true })
  // 1) 未完成行：sha NULL → 删行 + unlink（正式名 blob 与 tmp 都可能存在）
  for (const r of db.prepare('SELECT id FROM files WHERE sha256 IS NULL').all() as { id: string }[]) {
    db.prepare('DELETE FROM files WHERE id=?').run(r.id)
    for (const p of [`tmp-${r.id}`, r.id]) { try { unlinkSync(join(filesDir, p)) } catch { /* 忽略 */ } }
  }
  // 2) 完成行缺 blob → 删行
  const rows = db.prepare('SELECT id FROM files WHERE sha256 IS NOT NULL').all() as { id: string }[]
  const onDisk = new Set(readdirSync(filesDir))
  for (const r of rows) if (!onDisk.has(r.id)) db.prepare('DELETE FROM files WHERE id=?').run(r.id)
  // 3) 盘上多余（含 tmp-*）→ 删
  const known = new Set(rows.filter(r => onDisk.has(r.id)).map(r => r.id))
  for (const f of readdirSync(filesDir)) if (!known.has(f)) { try { rmSync(join(filesDir, f), { recursive: true, force: true }) } catch { /* 忽略 */ } }
}

// 展示名清洗：剥路径分隔符/控制字符(含 ANSI CSI)/RTL 双向控制符，空白即 null（调用方回退 file_id）
const CTRL_RE = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g
const CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g // ANSI CSI 序列先于单字符控制符剥除
export function sanitizeFileName(name: string): string | null {
  // basename 语义：只取最后一段（./.. 全剥掉）
  const base = (name ?? '').split(/[/\\]/).pop() ?? ''
  const s = base.replace(CSI_RE, '').replace(CTRL_RE, '').replace(/\s+/g, ' ').trim()
  const cut = [...s].slice(0, 255).join('') // 按字符截 255，bytes 上限由调用方另验
  return cut.length ? cut : null
}

// files 目录用量（summary log 观测用）
export function filesUsage(filesDir: string): { count: number; bytes: number } {
  if (!existsSync(filesDir)) return { count: 0, bytes: 0 }
  let count = 0, bytes = 0
  for (const f of readdirSync(filesDir)) {
    try { bytes += statSync(join(filesDir, f)).size; count++ } catch { /* 并发删除竞态，忽略 */ }
  }
  return { count, bytes }
}
