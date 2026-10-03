import type { FastifyInstance } from 'fastify'
import { authenticate, getAuth } from '../auth.js'
import { createToken, listTokens, revokeToken } from '../../core/agents.js'
import type { Db } from '../../db/sqlite.js'; import type { Config } from '../../config.js'

export function registerTokensRoutes(app: FastifyInstance, deps: { db: Db; cfg: Config; onRevoke?: (tokenId: string) => void }): void {
  const auth = authenticate(deps.db, deps.cfg)
  app.get('/v1/tokens', { preHandler: auth }, async (req) => listTokens(deps.db, getAuth(req).agent.id))
  app.post('/v1/tokens', { preHandler: auth, schema: { body: { type: 'object', additionalProperties: false, properties: { name: { type: 'string', maxLength: 40 } } } } }, async (req, reply) => {
    const t = createToken(deps.db, getAuth(req).agent.id, (req.body as any)?.name ?? 'default')
    return reply.status(201).send(t)
  })
  app.delete('/v1/tokens/:id', { preHandler: auth }, async (req, reply) => {
    revokeToken(deps.db, getAuth(req).agent.id, (req.params as any).id)
    deps.onRevoke?.((req.params as any).id)
    return reply.status(204).send()
  })
}
