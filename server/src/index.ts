import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { loadConfig } from './config.js'
import { buildApp } from './http/app.js'
import { openDb, migrate } from './db/sqlite.js'
import { Bus } from './core/bus.js'
import { RateLimiter } from './core/ratelimit.js'
import { WsHub } from './ws/hub.js'
import { startScanner } from './core/tasks.js'
import { scanMarket } from './core/market.js'
import { cleanupFiles, reconcileFiles, filesUsage } from './core/files.js'
import { WebhookDispatcher } from './core/webhook.js'
import { alignRoles } from './core/agents.js'

const cfg = loadConfig()
mkdirSync(dirname(cfg.dbPath), { recursive: true })
const db = openDb(cfg.dbPath, cfg.dbSynchronous)
migrate(db, { defaultOwner: cfg.defaultOwner ?? undefined })
alignRoles(db, cfg.humanIds) // role 对齐主体=server（r2-N4）
const bus = new Bus()
const limiter = new RateLimiter(cfg.rate)
const hub = new WsHub({ db, cfg, bus, limiter })
const webhook = new WebhookDispatcher({ db, cfg })
const app = buildApp({ db, cfg, bus, limiter, connectedAgents: () => hub.connectedAgents(), wsConnections: () => hub.connectionCount(), onTokenRevoke: id => hub.closeToken(id), webhook })
await app.listen({ port: cfg.port, host: '0.0.0.0' })
hub.attach(app.server)
const scanner = startScanner(db, bus, cfg, app.log, { notify: (t, e, a) => webhook.notify(t, e, a) }, now => {
  scanMarket(db, cfg, bus, now)
  cleanupFiles(db, cfg.filesDir, 200) // 文件 TTL 清理挂同一 tick（先 unlink 后删行，LIMIT 200/tick）
})
// 启动对账：files 表 vs blob 目录双向自愈（崩溃窗口/备份恢复兜底）
reconcileFiles(db, cfg.filesDir)
const summary = setInterval(() => app.log.info({ event: 'summary', ws_connections: hub.connectionCount(),
  inbox_depth: (db.prepare('SELECT COUNT(*) c FROM messages WHERE delivered_at IS NULL').get() as { c: number }).c,
  running_tasks: (db.prepare(`SELECT COUNT(*) c FROM tasks WHERE status='RUNNING'`).get() as { c: number }).c,
  files: filesUsage(cfg.filesDir) }), 60_000)
summary.unref()

let shuttingDown = false
const shutdown = async (signal: string) => {
  if (shuttingDown) return; shuttingDown = true
  app.log.info({ event: 'shutdown', signal })
  let code = 0
  try {
    hub.closeAll(1001); scanner.stop(); clearInterval(summary); hub.dispose(); webhook.close()
    await app.close() // fastify close() 无超时参数；关闭时长由在途长轮询（wait≤30s）决定，docker 侧以 stop_grace_period 35s 兜底（docs/deploy.md）
  } catch (e) {
    code = 1
    app.log.error({ event: 'shutdown-error', error: String(e) })
  } finally {
    db.close() // 无论 app.close() 成败必达，避免 WAL 未落盘退出
    process.exit(code)
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
