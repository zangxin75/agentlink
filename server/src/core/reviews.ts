import type { Db } from '../db/sqlite.js'
import { Errors, AppError } from '../http/errors.js'
import { audit } from './audit.js'
import { getTask } from './tasks.js'

// 提交任务评价：仅 requester 可评、任务须为终态、一任务一评、终态后 30 天内有效
export function submitReview(db: Db, taskId: string, rater: string, input: { rating: number; comment?: string }): void {
  const t = getTask(db, taskId)
  if (!t || (t.requester !== rater && t.executor !== rater)) throw Errors.notFound('task not found')
  if (t.requester !== rater) throw Errors.forbidden('only requester can review')
  if (t.status !== 'COMPLETED' && t.status !== 'FAILED') throw Errors.unprocessable('TASK_NOT_FINISHED', 'task not in terminal state')
  // r1-I7：Errors.conflict 的 code 固定 'CONFLICT'，新错误码必须直接 AppError 落地（spec §8 承诺）
  if (db.prepare('SELECT 1 FROM task_reviews WHERE task_id=?').get(taskId)) throw new AppError('ALREADY_REVIEWED', 409, 'task already reviewed')
  if (Date.now() - Date.parse(t.finished_at!) > 30 * 86400_000) throw Errors.unprocessable('REVIEW_WINDOW_CLOSED', 'review window (30d) closed')
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw Errors.invalidRequest('rating must be integer 1-5')
  if (Buffer.byteLength(input.comment ?? '') > 1024) throw Errors.invalidRequest('comment too long: max 1KB')
  db.prepare('INSERT INTO task_reviews (task_id, rater, ratee, rating, comment, created_at) VALUES (?,?,?,?,?,?)')
    .run(taskId, rater, t.executor, input.rating, input.comment ?? null, new Date().toISOString())
  audit(db, rater, 'task.reviewed', { task_id: taskId, rating: input.rating })
}
