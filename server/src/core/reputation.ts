import type { Db } from '../db/sqlite.js'

/** 代理声誉统计：任务归责 + 完成率 + 平均耗时 + 评价（v1.1） */
export interface Reputation {
  tasks_completed: number; tasks_failed: number; tasks_timeout: number; tasks_cancelled: number; tasks_rejected: number
  completion_rate: number | null; avg_duration_s: number | null; active_30d: number; avg_rating: number | null; review_count: number
}
export const emptyReputation = (): Reputation => ({ tasks_completed: 0, tasks_failed: 0, tasks_timeout: 0, tasks_cancelled: 0, tasks_rejected: 0, completion_rate: null, avg_duration_s: null, active_30d: 0, avg_rating: null, review_count: 0 })

/** 批量聚合：单条 GROUP BY executor + 单条 GROUP BY ratee，禁止列表接口 N+1 */
export function reputationOf(db: Db, ids: string[]): Map<string, Reputation> {
  const out = new Map<string, Reputation>()
  if (!ids.length) return out
  const ph = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT executor,
    COUNT(*) FILTER (WHERE status='COMPLETED') AS tasks_completed,
    COUNT(*) FILTER (WHERE status='FAILED') AS tasks_failed,
    COUNT(*) FILTER (WHERE status='TIMEOUT') AS tasks_timeout,
    COUNT(*) FILTER (WHERE status='CANCELLED') AS tasks_cancelled,
    COUNT(*) FILTER (WHERE status='REJECTED') AS tasks_rejected,
    AVG(CASE WHEN status='COMPLETED' THEN (julianday(finished_at) - julianday(accepted_at)) * 86400 END) AS avg_duration_s,
    COUNT(*) FILTER (WHERE status='COMPLETED' AND finished_at > ?) AS active_30d
    FROM tasks WHERE executor IN (${ph}) GROUP BY executor`).all(new Date(Date.now() - 30 * 86400_000).toISOString(), ...ids) as any[]
  const ratings = db.prepare(`SELECT ratee, AVG(rating) AS avg_rating, COUNT(*) AS review_count FROM task_reviews WHERE ratee IN (${ph}) GROUP BY ratee`).all(...ids) as any[]
  const rmap = new Map(ratings.map(r => [r.ratee, r]))
  const seen = new Set([...ids])
  for (const id of seen) {
    const r = rows.find(x => x.executor === id)
    const c = r?.tasks_completed ?? 0, f = r?.tasks_failed ?? 0, t = r?.tasks_timeout ?? 0
    const denom = c + f + t
    const rv = rmap.get(id)
    out.set(id, {
      tasks_completed: c, tasks_failed: f, tasks_timeout: t, tasks_cancelled: r?.tasks_cancelled ?? 0, tasks_rejected: r?.tasks_rejected ?? 0,
      // 分母 0（无终态任务）时完成率为 null，避免 0/0 误报
      completion_rate: denom ? c / denom : null,
      avg_duration_s: r?.avg_duration_s ?? null,
      active_30d: r?.active_30d ?? 0,
      avg_rating: rv?.avg_rating ?? null, review_count: rv?.review_count ?? 0,
    })
  }
  return out
}
