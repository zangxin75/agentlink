import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../../src/db/sqlite.js'
import { buildApp } from '../../src/http/app.js'
import { loadConfig } from '../../src/config.js'
import { registerAgent, alignRoles } from '../../src/core/agents.js'
import { Bus } from '../../src/core/bus.js'
import { RateLimiter } from '../../src/core/ratelimit.js'
import { WsHub } from '../../src/ws/hub.js'
import { WebhookDispatcher } from '../../src/core/webhook.js'
import type { FastifyInstance } from 'fastify'
import type { MailTransport } from '../../src/core/regcodes.js'

export async function startWsServer(env: Record<string, string> = {}, opts: { smtpTransport?: MailTransport | null } = {}) {
  const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0', ...env } as never)
  // 测试可注入假 SMTP transport（真工厂在缺 SMTP_* env 时返回 null）
  if (opts.smtpTransport !== undefined) cfg.smtpTransport = () => opts.smtpTransport!
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db, { defaultOwner: cfg.defaultOwner ?? undefined }); alignRoles(db, cfg.humanIds) // r1-C2：测试路径与 index.ts 同接线，否则 human 角色断言全挂
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
  // mk 幂等缓存（r1-C2）：同一 id 二次 register 会 400，且 token 只显一次无法重取
  const made = new Map<string, ReturnType<typeof registerAgent>>()
  const mk = (id: string) => { if (!made.has(id)) { made.set(id, registerAgent(db, cfg, { agent_id: id, registration_code: 'x' })); alignRoles(db, cfg.humanIds) } return made.get(id)! } // 注册后即时对齐 human 角色（启动时一次罩不住后注册）
  return { app, db, bus, cfg, hub, url, mk, webhook, hooks: { notify: (t: any, e: any, a?: any) => webhook.notify(t, e, a) }, close: async () => { hub.closeAll(); webhook.close(); await app.close() } }
}
