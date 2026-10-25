// 群发 core（spec §1.3/§2 fanout 决策，r1-M4/r2-N2/N3）
// 单事务 N 行 → commit 后 bus；幂等前缀精确比较（不走 LIKE）；64KB 按原文计封皮不计
import type { Db } from '../db/sqlite.js'
import type { Bus } from './bus.js'
import { Errors } from '../http/errors.js'
import { getAgent } from './agents.js'
import { newMsgId, sha256Hex } from './ids.js'
import { FILE_ID_RE } from './files.js'
import { audit } from './audit.js'
import { membersOf, isDissolved, visibleTo } from './groups.js'

interface FanoutMessage { id: string; client_msg_id: string; from: string; to: string; type: string; body: any; topic: string; created_at: string }

// fanout 行 cmid：一律基于截断基（cmid 本身，或 >62 时取前 62）拼 ':<i>'——查重与写入共用同一截断基（r1-M1）
function cmidBase(cmid: string): string { return cmid.length + 2 <= 64 ? cmid : cmid.slice(0, 62) }
function fanoutCmid(cmid: string, i: number): string { return cmidBase(cmid) + ':' + i }

export function sendGroupMessage(db: Db, bus: Bus, from: string, input: { to: string; type: 'text' | 'file'; body: { text?: string; file_id?: string; note?: string }; client_msg_id: string }): { group_id: string; delivered: number; messages: FanoutMessage[]; deduplicated: boolean } {
  if (!input.client_msg_id || input.client_msg_id.length > 64) throw Errors.invalidRequest('client_msg_id required (1-64 chars)')
  // 幂等：精确前缀比较（substr，非 LIKE——cmid 可含 %/_ 通配符，r2-N2）；
  // 前缀 = 截断基+':'，且后缀首字符必须是数字（防 'abc:' 误吞 'abc:xyz' 同前缀行）；
  // 按 (from_agent, group_id) 过滤（r1-M1：跨群复用不误 dedup）
  const prefix = cmidBase(input.client_msg_id) + ':'
  const findExisting = (): FanoutMessage[] =>
    (db.prepare(`SELECT * FROM messages WHERE from_agent=? AND group_id=? AND substr(client_msg_id,1,?)=? AND substr(client_msg_id,?,1) BETWEEN '0' AND '9' ORDER BY id`)
      .all(from, input.to, prefix.length, prefix, prefix.length + 1) as any[]).map(rowToOut)
  const existing = findExisting()
  if (existing.length) return { group_id: input.to, delivered: existing.length, messages: existing, deduplicated: true }
  // 裁决（r1-Minor3）：幂等优先于可见性/解散——向已解散群重放旧 cmid 返回 dedup 而非 410
  if (!visibleTo(db, input.to, from)) throw Errors.forbidden('group not visible')
  if (isDissolved(db, input.to)) throw Errors.gone('group dissolved')

  let baseBody: Record<string, unknown>
  if (input.type === 'file') {
    const fid = input.body.file_id
    if (typeof fid !== 'string' || !FILE_ID_RE.test(fid)) throw Errors.invalidRequest('body.file_id required')
    const row = db.prepare('SELECT * FROM files WHERE id=?').get(fid) as { from_agent: string; to_agent: string; name: string; size: number; sha256: string | null; expires_at: string } | undefined
    if (!row || row.sha256 == null || new Date(row.expires_at).getTime() <= Date.now()) throw Errors.invalidRequest('file not found / not ready / expired')
    if (row.from_agent !== from || row.to_agent !== input.to) throw Errors.badRequest('FILE_RECIPIENT_MISMATCH', 'file recipient must be the group') // r2-N3：群 file 行 to=群
    baseBody = { file_id: fid, name: row.name, size: row.size, sha256: row.sha256 }
  } else {
    if (Buffer.byteLength(input.body.text ?? '') > 64 * 1024) throw Errors.payloadTooLarge('text > 64KB') // 按原文，封皮不计
    baseBody = { text: input.body.text }
  }

  const members = membersOf(db, input.to)           // 成员快照（agent+human，spec §1.3）
  const groupAgent = getAgent(db, input.to)          // display_name=群名
  const envelope = { id: input.to, name: groupAgent.display_name, members }
  const body = JSON.stringify({ ...baseBody, group: envelope })
  const topic = 'g-' + input.to.slice(4)
  const now = new Date().toISOString()
  const out: FanoutMessage[] = []
  try {
    db.transaction(() => {
      members.forEach((m, i) => {
        const id = newMsgId()
        db.prepare(`INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, topic, created_at, group_id) VALUES (?,?,?,?,?, ?, NULL, ?, ?, ?)`)
          .run(id, fanoutCmid(input.client_msg_id, i), from, m, input.type, body, topic, now, input.to)
        out.push({ id, client_msg_id: fanoutCmid(input.client_msg_id, i), from, to: m, type: input.type, body: JSON.parse(body), topic, created_at: now })
      })
    })() // 事务提交后 bus（观察者不读半批，spec §2）
  } catch (e: any) {
    // r1-M1 / Review Focus #5：并发同 cmid 撞 idx_messages_idem（UNIQUE(from,cmid) 全局）必须落兜底——
    // 重查本群命中 → dedup；仍无本群行 → 同 (from,cmid) 在别群 → 409 拒（跨群复用）
    if (!String(e?.code ?? '').startsWith('SQLITE_CONSTRAINT')) throw e
    const again = findExisting()
    if (again.length) return { group_id: input.to, delivered: again.length, messages: again, deduplicated: true }
    throw Errors.badRequest('CLIENT_MSG_ID_REUSED', 'client_msg_id already used in another group')
  }
  audit(db, from, 'group.message_sent', { group_id: input.to, delivered: out.length, body_sha256: sha256Hex(JSON.stringify(input.body)) })
  for (const msg of out) bus.emit({ type: 'new-message', agentId: msg.to, message: msg as never })
  return { group_id: input.to, delivered: out.length, messages: out, deduplicated: false }
}

const rowToOut = (r: any): FanoutMessage => ({ id: r.id, client_msg_id: r.client_msg_id, from: r.from_agent, to: r.to_agent, type: r.type, body: JSON.parse(r.body), topic: r.topic, created_at: r.created_at })
