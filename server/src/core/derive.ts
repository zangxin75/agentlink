import type { Db } from '../db/sqlite.js'
import type { Bus } from './bus.js'
import { newMsgId } from './ids.js'

export function insertDerived(db: Db, bus: Bus, from: string, to: string, type: 'task' | 'task_update' | 'system', body: Record<string, unknown>, clientMsgId: string, threadId?: string): void {
  const id = newMsgId()
  const createdAt = new Date().toISOString()
  try {
    db.prepare('INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, clientMsgId, from, to, type, JSON.stringify(body), threadId ?? null, createdAt)
    // 仅在真实写入后才携带完整消息行发事件（方案 B）：冲突跳过时不发，避免推送库里不存在的幻影消息
    bus.emit({ type: 'new-message', agentId: to, message: { id, client_msg_id: clientMsgId, from, to, type, body, thread_id: threadId ?? null, topic: '_default', created_at: createdAt, delivered_at: null, read_at: null } })
  } catch (e) {
    if (!(e as any)?.code?.startsWith('SQLITE_CONSTRAINT')) throw e // 幂等键唯一索引兜底：冲突视为已写入，静默跳过
  }
}
