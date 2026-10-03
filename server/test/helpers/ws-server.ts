import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../../src/db/sqlite.js'
import { buildApp } from '../../src/http/app.js'
import { loadConfig } from '../../src/config.js'
import { registerAgent } from '../../src/core/agents.js'
import { Bus } from '../../src/core/bus.js'
import { RateLimiter } from '../../src/core/ratelimit.js'
import { WsHub } from '../../src/ws/hub.js'
import { WebhookDispatcher } from '../../src/core/webhook.js'
import type { FastifyInstance } from 'fastify'

export async function startWsServer(env: Record<string, string> = {}) {
  const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0', ...env } as never)
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db)
  const bus = new Bus()
  const limiter = new RateLimiter(cfg.rate)
  let hub!: WsHub
  const connectedAgents = () => hub.connectedAgents()
  const webhook = new WebhookDispatcher({ db, cfg })
  // onTokenRevoke 必须接到 hub.closeToken，否则撤销 token 不会踢掉在线连接（T15 用例5 依赖）
  const app: FastifyInstance = buildApp({ db, cfg, bus, limiter, onTokenRevoke: (id: string) => hub.closeToken(id), connectedAgents, webhook } as never)
  hub = new WsHub({ db, cfg, bus, limiter })
  await app.listen({ port: 0, host: '127.0.0.1' })
  hub.attach(app.server)
  const url = `ws://127.0.0.1:${(app.server.address() as any).port}/ws`
  const mk = (id: string) => registerAgent(db, cfg, { agent_id: id, registration_code: 'x' })
  return { app, db, bus, cfg, hub, url, mk, webhook, hooks: { notify: (t: any, e: any, a?: any) => webhook.notify(t, e, a) }, close: async () => { hub.closeAll(); webhook.close(); await app.close() } }
}
