import type { Db } from '../db/sqlite.js'
import type { Bus } from './bus.js'
import { newMsgId } from './ids.js'

export function insertDerived(db: Db, bus: Bus, from: string, to: string, type: 'task' | 'task_update' | 'system', body: Record<string, unknown>, clientMsgId: string, threadId?: string): void {
  try {
    db.prepare('INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(newMsgId(), clientMsgId, from, to, type, JSON.stringify(body), threadId ?? null, new Date().toISOString())
  } catch (e) {
    if (!(e as any)?.code?.startsWith('SQLITE_CONSTRAINT')) throw e // 幂等键唯一索引兜底：冲突视为已写入，静默跳过
  }
  bus.emit({ type: 'new-message', agentId: to })
}
