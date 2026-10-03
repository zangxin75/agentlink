import type { Db } from '../db/sqlite.js'
import type { Bus } from './bus.js'
import { Errors } from '../http/errors.js'
import { newMsgId, sha256Hex } from './ids.js'
import { audit } from './audit.js'

export interface Message { id: string; client_msg_id: string; from: string; to: string; type: string; body: any; thread_id: string | null; topic: string; created_at: string; delivered_at: string | null; read_at: string | null }

const COLS = 'id, client_msg_id, from_agent as `from`, to_agent as `to`, type, body, thread_id, topic, created_at, delivered_at, read_at'
const rowToMsg = (r: any): Message => ({ ...r, body: JSON.parse(r.body) })

export function getMessage(db: Db, id: string): Message {
  const r = db.prepare(`SELECT ${COLS} FROM messages WHERE id=?`).get(id)
  return r ? rowToMsg(r) : undefined as never
}

// thread_id 格式：字母数字开头，最长 64，允许 . _ : -（v1.1 §threads）
export const THREAD_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/

// topic 格式（spec §1）：保留名 _default 或小写风格 ≤32；_default=广播
export const TOPIC_RE = /^(_default|[a-z0-9][a-z0-9._-]{0,31})$/

export function sendMessage(db: Db, bus: Bus, from: string, input: { to: string; type: 'text'; body: { text: string }; client_msg_id: string; thread_id?: string | null; topic?: string }): { message: Message; deduplicated: boolean } {
  // 大小上限按字节（Buffer.byteLength）而非 UTF-16 码元计：CJK 载荷此前可 3 倍绕过（终审 Minor-5）
  if (Buffer.byteLength(JSON.stringify(input.body)) > 256 * 1024) throw Errors.payloadTooLarge('message body > 256KB')
  if (Buffer.byteLength(input.body.text ?? '') > 64 * 1024) throw Errors.payloadTooLarge('text > 64KB')
  // 64 字符限仅约束客户端 cmid；服务端自产 srv: 派生键最长 ~86 字符
  // （srv:task_<26>:status:COMPLETED:<agent_id32>，见 derive.ts），DB 列无长度约束，属设计内（终审 Minor-10）
  if (!input.client_msg_id || input.client_msg_id.length > 64) throw Errors.invalidRequest('client_msg_id required (1-64 chars)')
  const threadId = input.thread_id ?? null
  if (threadId !== null && !THREAD_ID_RE.test(threadId)) throw Errors.invalidRequest('thread_id must match ^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$')
  const topic = input.topic ?? '_default'
  if (!TOPIC_RE.test(topic)) throw Errors.invalidRequest('topic must match ^(_default|[a-z0-9][a-z0-9._-]{0,31})$')
  const dup: any = db.prepare('SELECT id FROM messages WHERE from_agent=? AND client_msg_id=?').get(from, input.client_msg_id)
  if (dup) return { message: getMessage(db, dup.id), deduplicated: true }
  const id = newMsgId(); const now = new Date().toISOString()
  try {
    db.prepare('INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, topic, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, input.client_msg_id, from, input.to, 'text', JSON.stringify(input.body), threadId, topic, now)
  } catch (e) {
    // 并发同 (from, client_msg_id) 撞唯一索引 idx_messages_idem：返回已存在的那条，deduplicated
    if ((e as any)?.code?.startsWith('SQLITE_CONSTRAINT')) {
      const existing: any = db.prepare('SELECT id FROM messages WHERE from_agent=? AND client_msg_id=?').get(from, input.client_msg_id)
      if (existing) return { message: getMessage(db, existing.id), deduplicated: true }
    }
    throw e
  }
  audit(db, from, 'message.sent', { message_id: id, to: input.to, body_sha256: sha256Hex(JSON.stringify(input.body)) })
  bus.emit({ type: 'new-message', agentId: input.to })
  return { message: getMessage(db, id), deduplicated: false }
}

export function getInbox(db: Db, agentId: string, limit: number, threadId?: string, topic?: string): Message[] {
  const th = threadId ? ' AND thread_id=?' : ''
  const tp = topic ? ' AND topic=?' : ''
  return (db.prepare(`SELECT ${COLS} FROM messages WHERE to_agent=? AND delivered_at IS NULL${th}${tp} ORDER BY id LIMIT ?`).all(...(threadId ? [agentId, threadId] : [agentId]), ...(topic ? [topic] : []), limit)).map(rowToMsg)
}

export function history(db: Db, agentId: string, q: { peer?: string; thread_id?: string; topic?: string; before?: string; after?: string; limit: number }): Message[] {
  // peer 存在时限定双向会话；仅 thread 时覆盖该 agent 全部相关消息
  const dir = q.peer ? `((from_agent=? AND to_agent=?) OR (from_agent=? AND to_agent=?))` : '(from_agent=? OR to_agent=?)'
  const dirArgs: unknown[] = q.peer ? [agentId, q.peer, q.peer, agentId] : [agentId, agentId]
  const th = q.thread_id ? ' AND thread_id=?' : ''; const thArgs: unknown[] = q.thread_id ? [q.thread_id] : []
  const tp = q.topic ? ' AND topic=?' : ''; const tpArgs: unknown[] = q.topic ? [q.topic] : []
  if (q.after) {
    const rows = db.prepare(`SELECT ${COLS} FROM messages WHERE ${dir}${th}${tp} AND id > ? ORDER BY id LIMIT ?`).all(...dirArgs, ...thArgs, ...tpArgs, q.after, q.limit)
    return rows.map(rowToMsg) // oldest→newest (incremental)
  }
  const before = q.before ? ' AND id < ?' : ''
  const rows = db.prepare(`SELECT ${COLS} FROM messages WHERE ${dir}${th}${tp}${before} ORDER BY id DESC LIMIT ?`).all(...dirArgs, ...thArgs, ...tpArgs, ...(q.before ? [q.before] : []), q.limit)
  return rows.map(rowToMsg) // newest→oldest
}

export function ackMessages(db: Db, bus: Bus, agentId: string, ids: string[]): { acked: string[] } {
  const now = new Date().toISOString(); const acked: string[] = []
  db.transaction(() => {
    const stmt = db.prepare('UPDATE messages SET delivered_at=? WHERE id=? AND to_agent=? AND delivered_at IS NULL')
    for (const id of ids.slice(0, 100)) if (stmt.run(now, id, agentId).changes) acked.push(id)
  })()
  // 逐 id receipt 合并为单事件：按发件方分组各发一条，本方（收件方）合并为一条（BusEvent.messageIds 本就是数组形）
  const bySender = new Map<string, string[]>()
  for (const id of acked) {
    const r: any = db.prepare('SELECT from_agent FROM messages WHERE id=?').get(id)
    if (r) bySender.set(r.from_agent, [...(bySender.get(r.from_agent) ?? []), id])
  }
  for (const [sender, ids] of bySender) bus.emit({ type: 'receipt', agentId: sender, messageIds: ids })
  if (acked.length) bus.emit({ type: 'receipt', agentId: agentId, messageIds: acked })
  return { acked }
}

export function markRead(db: Db, bus: Bus, agentId: string, msgId: string): void {
  const r = db.prepare('UPDATE messages SET read_at=? WHERE id=? AND to_agent=?').run(new Date().toISOString(), msgId, agentId)
  if (!r.changes) throw Errors.notFound('message not found')
  const m: any = db.prepare('SELECT from_agent FROM messages WHERE id=?').get(msgId)
  bus.emit({ type: 'receipt', agentId: m.from_agent, messageIds: [msgId] })
  bus.emit({ type: 'receipt', agentId: agentId, messageIds: [msgId] })
}

export function unreadCounts(db: Db, agentId: string) {
  return db.prepare('SELECT from_agent as peer, COUNT(*) as count FROM messages WHERE to_agent=? AND read_at IS NULL GROUP BY from_agent').all(agentId)
}

export function receipts(db: Db, agentId: string, ids: string[]) {
  const out: { id: string; delivered_at: string | null; read_at: string | null }[] = []
  for (const id of ids.slice(0, 100)) {
    const r: any = db.prepare('SELECT id, delivered_at, read_at FROM messages WHERE id=? AND (from_agent=? OR to_agent=?)').get(id, agentId, agentId)
    if (r) out.push(r)
  }
  return out
}
