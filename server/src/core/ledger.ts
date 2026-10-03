import type { Db } from '../db/sqlite.js'
import { audit } from './audit.js'

// append-only：事件只插入不更新；调用方必须把本函数与任务终态 UPDATE 放同一事务（spec §5.2 r1-I2）
export function writeLedgerEvent(db: Db, task: { id: string; requester: string; executor: string; budget_amount: number | null; budget_currency: string }, type: 'agreed' | 'settled' | 'voided', actor: string): void {
  if (task.budget_amount == null) return // 无预算任务零记账
  const amount = type === 'voided' ? 0 : task.budget_amount
  db.prepare('INSERT INTO ledger_events (task_id, type, payer, payee, amount, currency, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(task.id, type, task.requester, task.executor, amount, task.budget_currency, new Date().toISOString())
  audit(db, actor, `task.budget_${type}` as never, { task_id: task.id, amount, currency: task.budget_currency })
}

// 账本事件查询视图：id 倒序，before 为游标（不含）
export interface LedgerEvent { id: number; task_id: string; type: 'agreed' | 'settled' | 'voided'; payer: string; payee: string; amount: number; currency: string; created_at: string }

export function listLedger(db: Db, me: string, q: { role?: 'payer' | 'earner'; limit?: number; before?: string }): LedgerEvent[] {
  const col = q.role === 'earner' ? 'payee' : 'payer'
  const where = `${col}=?${q.before ? ' AND id < ?' : ''}`
  const args = q.before ? [me, q.before, q.limit ?? 50] : [me, q.limit ?? 50]
  return db.prepare(`SELECT * FROM ledger_events WHERE ${where} ORDER BY id DESC LIMIT ?`).all(...args) as LedgerEvent[]
}

export function ledgerSummary(db: Db, me: string) {
  // r1-C2：voided 行金额为 0 但其 agreed 行仍是原值，不能靠金额轧差——在途 = agreed 且该任务尚无终局事件（settled/voided）
  return db.prepare(`SELECT CASE WHEN payer=? THEN payee ELSE payer END AS counterparty, currency,
    SUM(CASE WHEN le.type='settled' THEN le.amount ELSE 0 END) AS settled_total,
    SUM(CASE WHEN le.type='agreed' AND NOT EXISTS (SELECT 1 FROM ledger_events v WHERE v.task_id=le.task_id AND v.type IN ('settled','voided')) THEN le.amount ELSE 0 END) AS pending_total
    FROM ledger_events le WHERE payer=? OR payee=? GROUP BY 1, 2 ORDER BY counterparty`).all(me, me, me)
}
