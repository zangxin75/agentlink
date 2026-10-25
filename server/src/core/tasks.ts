import type { Db } from '../db/sqlite.js'
import type { Bus } from './bus.js'
import type { Config } from '../config.js'
import { Errors } from '../http/errors.js'
import { newTaskId } from './ids.js'
import { audit } from './audit.js'
import { getAgent } from './agents.js'
import { insertDerived } from './derive.js'
import { writeLedgerEvent } from './ledger.js'
import { assertSchemaDraft, validateResult } from './resultschema.js'
import type { WebhookEventName } from './webhook.js'

// 任务生命周期 → webhook 出站通知的挂点集合；全部可选，v1 既有调用零改动
export interface TaskHooks {
  notify?: (t: { id: string; requester: string; executor: string; status: string }, e: WebhookEventName, audience?: 'both' | 'requester') => void
}

export interface Task { id: string; requester: string; executor: string; action: string; context: any; result_schema: string | null; priority: 'normal' | 'high'; max_duration_s: number; budget_amount: number | null; budget_currency: string; status: 'REQUESTED' | 'REJECTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'EXPIRED'; result: string | null; error: string | null; created_at: string; accepted_at: string | null; finished_at: string | null; deadline: string | null; expires_at: string; last_heartbeat_at: string | null }
type Row = Record<string, any>
const rowToTask = (r: Row): Task => ({ ...r, context: r.context ? JSON.parse(r.context) : null }) as Task

export function getTask(db: Db, id: string): Task {
  const r = db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Row | undefined
  return r ? rowToTask(r) : (undefined as never)
}

export function createTask(db: Db, bus: Bus, cfg: Config, requester: string, input: { to: string; action: string; context?: unknown; result_schema?: Record<string, unknown>; max_duration_s?: number; priority?: 'normal' | 'high'; budget?: { amount: number; currency?: string; note?: string } }, hooks?: TaskHooks): { task: Task; policyRejected: boolean } {
  const executor = getAgent(db, input.to)
  // 大小上限按字节（Buffer.byteLength）计，防 CJK 载荷按 UTF-16 码元 3 倍绕过（终审 Minor-5）
  if (Buffer.byteLength(input.action ?? '') > 32 * 1024) throw Errors.payloadTooLarge('action too large: max 32KB')
  if (Buffer.byteLength(JSON.stringify(input.context ?? {})) > 64 * 1024) throw Errors.payloadTooLarge('context too large: max 64KB')
  // result_schema：≤8KB 字节计，受限 JSON Schema 子集（assertSchemaDraft 校验），JSON 字符串原样存储
  let resultSchema: string | null = null
  if (input.result_schema !== undefined) {
    if (Buffer.byteLength(JSON.stringify(input.result_schema)) > 8 * 1024) throw Errors.payloadTooLarge('result_schema > 8KB')
    assertSchemaDraft(input.result_schema)
    resultSchema = JSON.stringify(input.result_schema)
  }
  // budget：amount 整数 1..1e13；currency ≤16 默认 credit；note ≤256（仅校验，不落库）
  if (input.budget !== undefined) {
    if (!Number.isInteger(input.budget.amount) || input.budget.amount < 1 || input.budget.amount > 10 ** 13) throw Errors.invalidRequest('budget.amount must be integer 1..1e13')
    if ((input.budget.currency ?? 'credit').length > 16) throw Errors.invalidRequest('budget.currency too long: max 16')
    if ((input.budget.note ?? '').length > 256) throw Errors.invalidRequest('budget.note too long: max 256')
  }
  const maxDuration = Math.max(1, Math.min(86400, input.max_duration_s ?? 600))
  const policy = executor.task_policy
  const rejected = policy.mode === 'closed' || (policy.mode === 'allowlist' && !policy.allowlist.includes(requester))
  const now = new Date().toISOString()
  const task: Task = {
    id: newTaskId(), requester, executor: executor.id, action: input.action, context: (input.context as any) ?? null,
    priority: input.priority === 'high' ? 'high' : 'normal', max_duration_s: maxDuration, result_schema: resultSchema,
    budget_amount: input.budget?.amount ?? null, budget_currency: input.budget?.currency ?? 'credit',
    status: rejected ? 'REJECTED' : 'REQUESTED', result: null,
    error: rejected ? `policy: mode=${policy.mode}` : null,
    created_at: now, accepted_at: null, finished_at: rejected ? now : null, deadline: null,
    expires_at: new Date(Date.now() + cfg.taskRequestTimeoutS * 1000).toISOString(), last_heartbeat_at: null,
  }
  db.prepare('INSERT INTO tasks (id, requester, executor, action, context, result_schema, priority, max_duration_s, status, error, created_at, finished_at, expires_at, budget_amount, budget_currency) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(task.id, requester, executor.id, task.action, task.context ? JSON.stringify(task.context) : null, resultSchema, task.priority, task.max_duration_s, task.status, task.error, now, task.finished_at, task.expires_at, task.budget_amount, task.budget_currency)
  if (rejected) {
    audit(db, requester, 'task.policy_violation', { task_id: task.id, executor: executor.id, mode: policy.mode })
    insertDerived(db, bus, executor.id, requester, 'system', { code: 'POLICY_REJECTED', text: `task ${task.id} rejected by policy mode=${policy.mode}` }, `srv:${task.id}:policy:requester`, task.id)
    insertDerived(db, bus, requester, executor.id, 'task', { task_id: task.id, status: 'REJECTED', reason: 'policy', mode: policy.mode }, `srv:${task.id}:policy:executor`, task.id)
    hooks?.notify?.({ ...task, status: 'REJECTED' }, 'task.policy_rejected', 'requester') // 策略拒绝只通知请求方
  } else {
    audit(db, requester, 'task.created', { task_id: task.id, executor: executor.id, action: task.action })
    insertDerived(db, bus, requester, executor.id, 'task', { task_id: task.id, action: task.action, context: task.context, max_duration_s: task.max_duration_s, priority: task.priority, scope_hint: policy.scope }, `srv:${task.id}:created`, task.id)
  }
  return { task, policyRejected: rejected }
}

export type TransitionOp =
  | { kind: 'accept' }
  | { kind: 'reject'; note?: string }
  | { kind: 'cancel' }
  | { kind: 'result'; status: 'completed' | 'failed'; result?: string; error?: string }
  | { kind: 'heartbeat' }

export function transitionTask(db: Db, bus: Bus, taskId: string, actor: string, op: TransitionOp, hooks?: TaskHooks): Task {
  const t = getTask(db, taskId)
  if (!t || (t.requester !== actor && t.executor !== actor)) throw Errors.notFound('task not found')
  const now = new Date().toISOString()
  const require = (cond: boolean, e: Error) => { if (!cond) throw e }
  const absCap = Date.parse(t.created_at) + 86400_000 // 绝对上限 created_at+24h（spec §7.2）
  let next: Task
  switch (op.kind) {
    case 'accept':
      require(actor === t.executor, Errors.forbidden('forbidden: only executor can accept'))
      require(t.status === 'REQUESTED', Errors.conflict(`conflict: cannot accept from ${t.status}`))
      next = { ...t, status: 'RUNNING', accepted_at: now, deadline: new Date(Math.min(Date.now() + t.max_duration_s * 1000, absCap)).toISOString() }
      db.transaction(() => {
        db.prepare('UPDATE tasks SET status=?, accepted_at=?, deadline=? WHERE id=?').run(next.status, now, next.deadline, t.id)
        writeLedgerEvent(db, next, 'agreed', actor)
        audit(db, actor, 'task.accepted', { task_id: t.id })
      })(); break
    case 'reject':
      require(actor === t.executor, Errors.forbidden('forbidden: only executor can reject'))
      require(t.status === 'REQUESTED', Errors.conflict(`conflict: cannot reject from ${t.status}`))
      next = { ...t, status: 'REJECTED', error: op.note ?? 'rejected', finished_at: now }
      db.prepare('UPDATE tasks SET status=?, error=?, finished_at=? WHERE id=?').run(next.status, next.error, now, t.id)
      audit(db, actor, 'task.rejected', { task_id: t.id, note: op.note })
      notifyMarketBuyer(db, bus, t, 'REJECTED'); break
    case 'cancel':
      require(actor === t.requester, Errors.forbidden('forbidden: only requester can cancel'))
      require(t.status === 'REQUESTED' || t.status === 'RUNNING', Errors.conflict(`conflict: cannot cancel from ${t.status}`))
      next = { ...t, status: 'CANCELLED', finished_at: now }
      db.transaction(() => {
        db.prepare('UPDATE tasks SET status=?, finished_at=? WHERE id=?').run(next.status, now, t.id)
        // 仅 RUNNING 取消才作废预算（pre-accept 取消无 agreed 事件，spec §5.2）
        if (t.status === 'RUNNING') writeLedgerEvent(db, next, 'voided', actor)
        audit(db, actor, 'task.cancelled', { task_id: t.id })
      })(); break
    case 'result':
      require(actor === t.executor, Errors.forbidden('forbidden: only executor can report result'))
      require(t.status === 'RUNNING', Errors.conflict(`conflict: cannot report from ${t.status}`))
      if (Buffer.byteLength(op.result ?? '') > 64 * 1024) throw Errors.payloadTooLarge('result > 64KB')
      // 带 schema 的任务：result 须合法 JSON 且过 schema 校验；失败抛错在 UPDATE 之前，状态保持 RUNNING 可重交
      if (t.result_schema) {
        let parsed: unknown
        try { parsed = JSON.parse(op.result ?? '') } catch { throw Errors.unprocessable('RESULT_SCHEMA_MISMATCH', 'result must be valid JSON for schema tasks: parse error') }
        const errs = validateResult(JSON.parse(t.result_schema), parsed)
        if (errs.length) throw Errors.unprocessable('RESULT_SCHEMA_MISMATCH', `schema mismatch: ${errs.join('; ')}`)
      }
      next = { ...t, status: op.status === 'completed' ? 'COMPLETED' : 'FAILED', result: op.result ?? null, error: op.error ?? null, finished_at: now }
      db.transaction(() => {
        db.prepare('UPDATE tasks SET status=?, result=?, error=?, finished_at=? WHERE id=?').run(next.status, next.result, next.error, now, t.id)
        writeLedgerEvent(db, next, next.status === 'COMPLETED' ? 'settled' : 'voided', actor)
        audit(db, actor, 'task.result', { task_id: t.id, status: op.status, result_summary: (op.result ?? '').slice(0, 200) })
      })(); break
    case 'heartbeat':
      require(actor === t.executor, Errors.forbidden('forbidden: only executor can heartbeat'))
      require(t.status === 'RUNNING', Errors.conflict(`conflict: cannot heartbeat from ${t.status}`))
      db.prepare('UPDATE tasks SET deadline=?, last_heartbeat_at=? WHERE id=?')
        .run(new Date(Math.min(Date.now() + t.max_duration_s * 1000, absCap)).toISOString(), now, t.id)
      return getTask(db, t.id) // heartbeat: no task_update message
  }
  const peer = actor === t.requester ? t.executor : t.requester
  const body = { task_id: t.id, status: next.status, result: next.result ?? undefined, error: next.error ?? undefined }
  for (const target of [t.requester, t.executor])
    insertDerived(db, bus, actor, target, 'task_update', body, `srv:${t.id}:status:${next.status}:${target}`, t.id)
  bus.emit({ type: 'task-update', agentId: peer, taskId: t.id })
  bus.emit({ type: 'task-update', agentId: actor, taskId: t.id })
  // webhook 挂点：accept/reject/cancel/result → 对应事件名（result 统一为 task.result，status 在 payload.task.status 区分）
  const eventByKind: Record<string, WebhookEventName> = { accept: 'task.accepted', reject: 'task.rejected', cancel: 'task.cancelled', result: 'task.result' }
  if (eventByKind[op.kind]) hooks?.notify?.(next, eventByKind[op.kind])
  return next
}

const GRACE_MS = 5_000

// 市场派生 task（context.deal_id）终结（reject/timeout/expired）时提醒买方（spec §2.1 Ruling，RF4）：
// deal 仍处 escrowed 资金未动，买方可自行 cancel 全额退款；task 普通路径不受影响
function notifyMarketBuyer(db: Db, bus: Bus, t: { id: string; requester: string; context: unknown }, status: string): void {
  const dealId = t.context && typeof t.context === 'object' ? (t.context as { deal_id?: string }).deal_id : undefined
  if (!dealId) return
  insertDerived(db, bus, 'server', t.requester, 'system',
    { code: 'MARKET_TASK_ENDED', deal_id: dealId, task_id: t.id, status, hint: 'deal still escrowed; you may cancel for full refund' },
    `srv:mkt:tend:${t.id}`, t.id)
}

function finalize(db: Db, bus: Bus, row: { id: string; requester: string; executor: string; budget_amount: number | null; budget_currency: string; context?: unknown }, status: 'TIMEOUT' | 'EXPIRED', event: 'task.timeout' | 'task.expired', hooks?: TaskHooks): void {
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare('UPDATE tasks SET status=?, finished_at=? WHERE id=? AND status!=?').run(status, now, row.id, status)
    if (status === 'TIMEOUT') writeLedgerEvent(db, row, 'voided', 'server') // EXPIRED 无预算事件（spec §5.2）
    audit(db, 'server', event, { task_id: row.id })
  })()
  const body = { task_id: row.id, status }
  for (const target of [row.requester, row.executor])
    insertDerived(db, bus, 'server', target, 'task_update', body, `srv:${row.id}:status:${status}:${target}`, row.id)
  notifyMarketBuyer(db, bus, { id: row.id, requester: row.requester, context: row.context }, status)
  bus.emit({ type: 'task-update', agentId: row.requester, taskId: row.id })
  bus.emit({ type: 'task-update', agentId: row.executor, taskId: row.id })
  // timeout 双方通知；expired 只有请求方还在等待，通知请求方
  hooks?.notify?.({ ...row, status }, event, event === 'task.expired' ? 'requester' : 'both')
}

export function scanTimeouts(db: Db, bus: Bus, now: Date = new Date(), hooks?: TaskHooks): { timedOut: string[]; expired: string[] } {
  const timeoutRows = db.prepare(`SELECT id, requester, executor, budget_amount, budget_currency, context FROM tasks WHERE status='RUNNING' AND deadline < ?`).all(new Date(now.getTime() - GRACE_MS).toISOString()) as { id: string; requester: string; executor: string; budget_amount: number | null; budget_currency: string; context: string | null }[]
  const expiredRows = db.prepare(`SELECT id, requester, executor, budget_amount, budget_currency, context FROM tasks WHERE status='REQUESTED' AND expires_at < ?`).all(now.toISOString()) as { id: string; requester: string; executor: string; budget_amount: number | null; budget_currency: string; context: string | null }[]
  for (const r of timeoutRows) finalize(db, bus, { ...r, context: r.context ? JSON.parse(r.context) : null }, 'TIMEOUT', 'task.timeout', hooks)
  for (const r of expiredRows) finalize(db, bus, { ...r, context: r.context ? JSON.parse(r.context) : null }, 'EXPIRED', 'task.expired', hooks)
  return { timedOut: timeoutRows.map(r => r.id), expired: expiredRows.map(r => r.id) }
}

export function startScanner(db: Db, bus: Bus, cfg: { scanIntervalMs: number }, log?: { info: (o: object) => void }, hooks?: TaskHooks, marketScan?: (now: Date) => void): { stop(): void } {
  const tick = () => {
    try { const r = scanTimeouts(db, bus, new Date(), hooks); if (r.timedOut.length || r.expired.length) log?.info({ event: 'scan', ...r }) } catch (e) { log?.info({ event: 'scan-error', error: String(e) }) }
    // 市场扫描独立 try/catch：market 异常不吞掉 task 扫描（H4c）
    if (marketScan) { try { marketScan(new Date()) } catch (e) { log?.info({ event: 'market-scan-error', error: String(e) }) } }
  }
  tick()
  const timer = setInterval(tick, cfg.scanIntervalMs)
  return { stop: () => clearInterval(timer) }
}

export function listTasks(db: Db, agentId: string, q: { role?: 'requester' | 'executor'; status?: string; limit?: number }): Task[] {
  const role = q.role ?? 'requester'
  const cond = q.status ? ' AND status=?' : ''
  const args: unknown[] = q.status ? [agentId, q.status, q.limit ?? 50] : [agentId, q.limit ?? 50]
  return (db.prepare(`SELECT * FROM tasks WHERE ${role}=?${cond} ORDER BY id DESC LIMIT ?`).all(...args) as Row[]).map(rowToTask)
}
