// server/src/core/ids.ts
import { monotonicFactory } from 'ulid'
import { createHash, randomBytes } from 'node:crypto'

const ulid = monotonicFactory() // 同毫秒内也严格递增：msg/task id 字典序 = 时间序（history 游标分页依赖此性质）

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex')
export const newToken = (): string => 'al_' + randomBytes(32).toString('base64url')
export const newId = (prefix: string): string => `${prefix}_${ulid()}`
export const newMsgId = (): string => newId('msg')
export const newTaskId = (): string => newId('task')
