import type { FastifyRequest } from 'fastify'
import type { Db } from '../db/sqlite.js'
import type { Config } from '../config.js'
import { verifyToken, touchLastSeen, type Agent } from '../core/agents.js'
import { Errors } from './errors.js'

export interface AuthContext { agent: Agent; tokenId: string }

declare module 'fastify' {
  interface FastifyRequest { auth: AuthContext }
}

export function authenticate(db: Db, cfg: Config) {
  return async (req: FastifyRequest) => {
    const h = req.headers.authorization
    if (!h?.startsWith('Bearer ')) throw Errors.unauthorized()
    req.auth = verifyToken(db, h.slice(7))
    touchLastSeen(db, req.auth.agent.id, cfg.lastSeenThrottleMs)
  }
}

export const getAuth = (req: FastifyRequest): AuthContext => req.auth
