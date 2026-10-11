#!/usr/bin/env node
// AgentLink daemon：WS 收信→spool 落盘→落盘即 ack；心跳；热加载；REST 补洞（spec §3/§7）
import { readdirSync, readFileSync, writeFileSync, utimesSync, statSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { hostname as osHostname } from 'node:os'
import WebSocket from './vendor/ws/wrapper.mjs'
import { parseEnvFile, agentIdFor, AGENTS_DIR, HEARTBEAT, httpBase, wsUrl } from './lib/identity.mjs'
import { writeMessage, maxCursor, cleanup, clearTmp } from './lib/spool.mjs'
import { autoUpgradeOnce, restartDaemon } from './lib/upgrade.mjs'
import { createWatcher, clampInterval, marketWakeAllowed } from './lib/market-watch.mjs'

const log = (...a) => console.log(new Date().toISOString(), ...a)

const VERSION = (() => { try { return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim() } catch { return '(dev)' } })() // T3 构建脚本写入；checkout 开发态缺失显示 (dev)
const vlog = (...a) => log(`daemon VERSION=${VERSION}:`, ...a) // 协议级失败专用：错配不静默（spec §2）

export function createDaemon({ agentsDir = AGENTS_DIR, hostname = osHostname(), spawn: spawnImpl = spawn, watcher, watchBaseMs = 60_000, loadMs = 10_000 } = {}) {
  const conns = new Map() // agentId -> { ws, envPath, mtime, backoff, entry, authFailed }
  const lastWake = new Map() // agentId -> ms
  let stopped = false

  // 收信唤醒（方案 A）：新信落盘后按 env 配置拉起 headless 会话——cwd=绑定目录，SessionStart hook 自动注入 spool 未读
  // WAKE_CMD 未配置即静默（默认安全档=维持现状）；WAKE_FROM 白名单缺省放行所有发送方；COOLDOWN 合并突发（冷却期内的后续信由被唤醒会话的注入一并带走）
  function maybeWake(agentId, entry, from) {
    if (!entry.wakeCmd || stopped) return
    if (from === 'market' && !marketWakeAllowed(entry)) return // 市场通知默认不唤醒：挂牌标题不可信，白名单显式含 market 才开闸（spec §3 r1-M2）
    if (entry.wakeFrom) {
      const allow = entry.wakeFrom.split(',').map(s => s.trim()).filter(Boolean)
      if (allow.length && !allow.includes(from)) return
    }
    const cooldown = Number(entry.wakeCooldown) > 0 ? Number(entry.wakeCooldown) : 60_000
    const now = Date.now()
    if (now - (lastWake.get(agentId) ?? 0) < cooldown) return
    lastWake.set(agentId, now)
    log(`wake ${agentId}: spawn (from=${from})`)
    try {
      const child = spawnImpl(entry.wakeCmd, { shell: true, cwd: entry.dir, detached: true, stdio: 'ignore' })
      child.unref()
      child.on?.('error', e => log(`wake ${agentId} failed: ${e.message}`))
    } catch (e) { log(`wake ${agentId} failed: ${e.message}`) }
  }

  // 市场守望（spec §3）：tick 内部自 catch；wake 回调走 maybeWake（from='market' 默认不唤醒）
  const mkt = watcher ?? createWatcher({ log, wake: (id, e) => maybeWake(id, e, 'market') })

  function loadAgents() {
    let files = []
    try { files = readdirSync(agentsDir).filter(f => f.endsWith('.env')) } catch { return }
    for (const f of files) {
      const p = join(agentsDir, f)
      let entry
      try { entry = { ...parseEnvFile(readFileSync(p, 'utf8')), mtime: statSync(p).mtimeMs, envPath: p } }
      catch (e) { log(`skip ${f}: ${e.message}`); continue } // RF5：坏文件不炸进程
      const agentId = agentIdFor(entry.name, hostname, entry.dir)
      const old = conns.get(agentId)
      if (old && old.mtime === entry.mtime && !old.authFailed) continue
      if (old) { try { old.ws.close(1000) } catch {} ; conns.delete(agentId); mkt.reset(agentId) } // token 换了或 auth 失败后 env 已改：重连 + 恢复该 agent 守望（401 停止集/缓存清空）
      connect(agentId, entry)
    }
    for (const [id, c] of conns) if (!files.includes(basename(c.envPath))) { try { c.ws.close(1000) } catch {} ; conns.delete(id) } // env 删除：断连留 spool（basename 跨平台：split('/') 在 Windows 反斜杠路径下 pop 出整路径，曾致每轮热加载误删连接→1006 循环，agent18 实测报告）
  }

  async function backfill(entry, agentId) {
    const cursor = maxCursor(agentId)
    const url = `${httpBase(entry.server)}/v1/history?limit=100${cursor ? `&after=${cursor}` : ''}`
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${entry.token}` } })
      if (!res.ok) return log(`backfill ${agentId}: ${res.status}`)
      const j = await res.json()
      const messages = Array.isArray(j) ? j : (j.messages ?? []) // 兼容数组与 {messages} 两种返回形状
      // history 无 peer 时双向返回（我发的+发我的），补洞只取 to=me 的入站——出站消息本机已可读，落盘反而污染 spool
      for (const m of messages) if (m.to === agentId && writeMessage(agentId, m)) { ack(agentId, entry, m.id); maybeWake(agentId, entry, m.from) }
    } catch (e) { vlog(`backfill ${agentId}: ${e.message}（本机客户端版本如上；若持续失败，向服务器管理员核对你的 AgentLink 服务器版本，或用 AGENTLINK_VERSION 回退旧客户端）`) }
  }

  function ack(agentId, entry, id) {
    // 双通道 ack：WS 帧走服务端共享限流桶最省；REST 端点作为持久回执（离线补洞期间的 ack 也走这里）
    const ws = conns.get(agentId)?.ws
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 'ack', ids: [id] }))
    fetch(`${httpBase(entry.server)}/v1/messages/ack`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${entry.token}` }, body: JSON.stringify({ ids: [id] }) }).catch(() => {})
  }

  function connect(agentId, entry) {
    const c = { ws: null, mtime: entry.mtime, envPath: entry.envPath, backoff: 1000, entry, authFailed: false }
    conns.set(agentId, c)
    let ws
    try { ws = new WebSocket(wsUrl(entry.server)) } catch (e) { vlog(`connect ${agentId}: ${e.message}（本机客户端版本如上；若持续失败，向服务器管理员核对你的 AgentLink 服务器版本，或用 AGENTLINK_VERSION 回退旧客户端）`); return }
    c.ws = ws
    ws.on('open', () => { ws.send(JSON.stringify({ op: 'auth', token: entry.token })); c.backoff = 1000 })
    ws.on('message', raw => {
      let f; try { f = JSON.parse(String(raw)) } catch { return }
      if (f.op === 'auth_ok') {
        try { clearTmp(agentId) } catch {}   // 启动/重连期清孤儿 tmp（spec §5）
        backfill(entry, agentId)             // C5：auth_ok 后立即补洞——服务端不推积压
        return
      }
      if (f.op === 'error' && f.code === 'AUTH_FAILED') { c.authFailed = true; vlog(`auth failed ${agentId} (token revoked?) — not reconnecting until env changes（本机客户端版本如上；若持续失败，向服务器管理员核对你的 AgentLink 服务器版本，或用 AGENTLINK_VERSION 回退旧客户端）`); return } // hub.ts:54 真实形状：error 帧先来，close(4003) 随后
      if (f.op !== 'message') return         // receipt/presence/ping 等一律忽略
      const list = Array.isArray(f.message) ? f.message : [f.message] // hub.ts:120 一帧一条；数组形式防御
      for (const m of list) if (writeMessage(agentId, m)) { ack(agentId, entry, m.id); maybeWake(agentId, entry, m.from) } // 落盘成功才 ack；重复/consumed 跳过
    })
    ws.on('close', (code) => {
      if (code === 4003) c.authFailed = true // hub.ts:129 token 撤销走纯 close(4003) 无 error 帧——close code 双保险
      if (stopped || c.authFailed) return // auth 失败：不重连，等 env mtime 变更触发热加载重试
      setTimeout(() => { if (!stopped && conns.get(agentId) === c && !c.authFailed) { connect(agentId, entry); backfill(entry, agentId) } }, c.backoff)
      c.backoff = Math.min(c.backoff * 2, 30000)
    })
    ws.on('error', () => {}) // close 会跟着来
  }

  // 启动期一次性：清各 spool 目录的孤儿 tmp（spec §5 启动时清理）
  try { for (const d of readdirSync(dirname(HEARTBEAT) + '/spool', { withFileTypes: true })) if (d.isDirectory()) { try { clearTmp(d.name) } catch {} } } catch {}
  // state 根目录不存在时自建（用户实测：~/.local/state/agentlink 缺失时心跳静默不落盘）——writeFileSync 不会建父目录，utimesSync/write 的 catch 全静默
  try { mkdirSync(dirname(HEARTBEAT), { recursive: true }) } catch {}

  // 自动升级（默认开，env AGENTLINK_AUTOUPGRADE=0 关闭）：6h 一查 latest-version，dev checkout（无 VERSION）跳过
  // 升级成功后 spawn 新 daemon 再退出——systemd/计划任务的 ExecStart 路径不变，新进程拉起新代码
  async function autoupgradeTick() {
    if (stopped) return
    const entry = conns.values().next().value?.entry
    if (!entry || entry.autoUpgrade === '0') return
    try {
      const v = await autoUpgradeOnce({ server: entry.server, envBase: entry.distBase, autoUpgradeEnabled: true, log })
      if (v) { restartDaemon({ log }); process.exit(0) }
    } catch (e) { log(`autoupgrade: ${e.message}`) }
  }
  const autoupgradeTimer = setInterval(autoupgradeTick, 6 * 3_600_000)

  const timers = [
    setInterval(loadAgents, loadMs),                       // 热加载
    setInterval(() => { try { utimesSync(HEARTBEAT, new Date(), new Date()) } catch { try { writeFileSync(HEARTBEAT, '', { mode: 0o600 }) } catch {} } }, 5_000), // 心跳
    setInterval(() => { for (const id of conns.keys()) cleanup(id, Date.now()) }, 3_600_000), // 描小时清理 consumed>7d
    setInterval(() => { for (const c of conns.values()) if (c.ws?.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ op: 'ping' })) }, 25_000), // 保活，防服务端空闲清扫（25s < wsIdleTimeoutMs 默认 60s 的一半以上，取 1/2 上限以内）
  ]
  // 市场守望调度（spec §3）：watchBaseMs 基础节拍，按 agent clampInterval(entry.marketWatchInterval) 到期 tick；
  // stopped（守护进程停止中）时跳过；tick 内部自 catch，此处再兜一层防 unhandled rejection（守望与 WS 收信解耦）
  const watchNext = new Map() // agentId -> 到期时刻 ms
  timers.push(setInterval(() => {
    if (stopped) return
    const nowMs = Date.now()
    for (const [id, c] of conns) {
      if (nowMs < (watchNext.get(id) ?? 0)) continue
      watchNext.set(id, nowMs + clampInterval(c.entry.marketWatchInterval) * 1000)
      if (mkt.isStopped(id)) continue
      mkt.tick(id, c.entry).catch(() => {})
    }
  }, watchBaseMs))
  timers.push(autoupgradeTimer)
  for (const t of timers) t.unref?.()
  setTimeout(autoupgradeTick, 120_000).unref?.() // 启动 2 分钟后首查（避开启动高峰，失败下轮再试）
  // 启动即 touch 心跳（不等首个 5s interval——im inbox 的心跳判定从进程拉起就成立）
  try { utimesSync(HEARTBEAT, new Date(), new Date()) } catch { try { writeFileSync(HEARTBEAT, '', { mode: 0o600 }) } catch {} }
  loadAgents()
  return {
    stop: async () => { stopped = true; timers.forEach(clearInterval); for (const c of conns.values()) { try { c.ws.close(1000) } catch {} } },
    connected: () => [...conns.values()].filter(c => c.ws?.readyState === WebSocket.OPEN).length,
  }
}
if (process.argv[1]?.endsWith('daemon.mjs')) {
  const d = createDaemon({})
  log('agentlink-daemon up')
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await d.stop(); process.exit(0) })
  setInterval(() => {}, 1 << 30) // 保活
}
