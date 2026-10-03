#!/usr/bin/env node
// AgentLink daemon：WS 收信→spool 落盘→落盘即 ack；心跳；热加载；REST 补洞（spec §3/§7）
import { readdirSync, readFileSync, writeFileSync, utimesSync, statSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { hostname as osHostname } from 'node:os'
import WebSocket from './vendor/ws/wrapper.mjs'
import { parseEnvFile, agentIdFor, AGENTS_DIR, HEARTBEAT, httpBase, wsUrl } from './lib/identity.mjs'
import { writeMessage, maxCursor, cleanup, clearTmp } from './lib/spool.mjs'

const log = (...a) => console.log(new Date().toISOString(), ...a)

const VERSION = (() => { try { return readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim() } catch { return '(dev)' } })() // T3 构建脚本写入；checkout 开发态缺失显示 (dev)
const vlog = (...a) => log(`daemon VERSION=${VERSION}:`, ...a) // 协议级失败专用：错配不静默（spec §2）

export function createDaemon({ agentsDir = AGENTS_DIR, hostname = osHostname() } = {}) {
  const conns = new Map() // agentId -> { ws, envPath, mtime, backoff, entry, authFailed }
  let stopped = false

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
      if (old) { try { old.ws.close(1000) } catch {} ; conns.delete(agentId) } // token 换了或 auth 失败后 env 已改：重连
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
      for (const m of messages) if (m.to === agentId && writeMessage(agentId, m)) ack(agentId, entry, m.id)
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
      for (const m of list) if (writeMessage(agentId, m)) ack(agentId, entry, m.id) // 落盘成功才 ack；重复/consumed 跳过
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

  const timers = [
    setInterval(loadAgents, 10_000),                       // 热加载
    setInterval(() => { try { utimesSync(HEARTBEAT, new Date(), new Date()) } catch { try { writeFileSync(HEARTBEAT, '', { mode: 0o600 }) } catch {} } }, 5_000), // 心跳
    setInterval(() => { for (const id of conns.keys()) cleanup(id, Date.now()) }, 3_600_000), // 每小时清理 consumed>7d
    setInterval(() => { for (const c of conns.values()) if (c.ws?.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ op: 'ping' })) }, 25_000), // 保活，防服务端空闲清扫（25s < wsIdleTimeoutMs 默认 60s 的一半以上，取 1/2 上限以内）
  ]
  for (const t of timers) t.unref?.()
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
