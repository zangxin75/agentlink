import type { Server as HttpServer } from 'node:http'
import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'
import type { Db } from '../db/sqlite.js'
import type { Config } from '../config.js'
import type { Bus, BusEvent } from '../core/bus.js'
import type { RateLimiter } from '../core/ratelimit.js'
import { verifyToken, touchLastSeen } from '../core/agents.js'
import { sendMessage, getInbox, ackMessages, markRead } from '../core/messages.js'
import type { Agent } from '../core/agents.js'

interface Session { agentId: string; tokenId: string; agent: Agent; socket: WebSocket; subscribed: Set<string>; lastFrame: number }

export class WsHub {
  private wss = new WebSocketServer({ noServer: true })
  // agentId → 该 agent 的全部会话（同 agent 可多连接）。onBus 直查目标 agent 的会话集合，
  // 避免每事件 O(总连接数) 全量扫描（终审 Important-3 / M5 方案 A）
  private sessions = new Map<string, Set<Session>>()
  private offBus: () => void
  private sweeper: NodeJS.Timeout

  constructor(private deps: { db: Db; cfg: Config; bus: Bus; limiter: RateLimiter }) {
    this.offBus = deps.bus.on(e => this.onBus(e))
    this.sweeper = setInterval(() => {
      const now = Date.now()
      for (const s of [...this.allSessions()]) if (now - s.lastFrame > this.deps.cfg.wsIdleTimeoutMs) s.socket.close(1000, 'idle')
    }, 10_000)
    this.sweeper.unref()
  }

  attach(server: HttpServer): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x')
      if (url.pathname !== '/ws') return socket.destroy()
      this.wss.handleUpgrade(req, socket as never, head, ws => this.onConnection(ws))
    })
  }

  private onConnection(socket: WebSocket): void {
    let session: Session | null = null
    const authTimer = setTimeout(() => { if (!session) socket.close(4001, 'auth timeout') }, 10_000)
    socket.on('message', raw => {
      let frame: any
      try { frame = JSON.parse(String(raw)) } catch { return socket.send(JSON.stringify({ op: 'error', code: 'INVALID_REQUEST', message: 'bad json' })) }
      if (!session) {
        if (frame?.op !== 'auth') return
        try {
          const { agent, tokenId } = verifyToken(this.deps.db, String(frame.token ?? ''))
          session = { agentId: agent.id, tokenId, agent, socket, subscribed: new Set(), lastFrame: Date.now() }
          this.addSession(session)
          clearTimeout(authTimer)
          socket.send(JSON.stringify({ op: 'auth_ok', agent: { id: agent.id } }))
          this.deps.bus.emit({ type: 'presence', agentId: agent.id })
        } catch { socket.send(JSON.stringify({ op: 'error', code: 'AUTH_FAILED', message: 'invalid token' })); socket.close(4003, 'unauthorized') } // spec §9
        return
      }
      session.lastFrame = Date.now()
      touchLastSeen(this.deps.db, session.agentId, this.deps.cfg.lastSeenThrottleMs)
      this.handleFrame(session, frame)
    })
    socket.on('close', () => {
      clearTimeout(authTimer)
      // 仅当该 agent 最后一连接断开才发 presence（多连接 agent 关其一仍在线，不发噪声事件——终审 Minor-9）
      if (session && this.removeSession(session)) this.deps.bus.emit({ type: 'presence', agentId: session.agentId })
    })
  }

  private handleFrame(s: Session, f: any): void {
    switch (f.op) {
      case 'ping': return s.socket.send(JSON.stringify({ op: 'pong' }))
      case 'send': {
        // WS 路径绕过路由 schema，这里补上 cmid 校验：空 cmid 会被幂等去重静默吞消息（终审 Important-2）
        const cmid = String(f.client_msg_id ?? '')
        if (!cmid || cmid.length > 64) return s.socket.send(JSON.stringify({ op: 'error', code: 'INVALID_REQUEST', message: 'client_msg_id required (1-64 chars)' }))
        try {
          this.deps.limiter.checkMessage(s.agentId) // WS 与 REST 共享同一限流预算（spec §11）
          const th = f.thread_id == null ? null : String(f.thread_id) // WS 免 schema，非字符串规整为字符串；格式仍由 core 单点校验
          const { message, deduplicated } = sendMessage(this.deps.db, this.deps.bus, s.agentId, { to: f.to, type: 'text', body: { text: String(f.body?.text ?? '') }, client_msg_id: cmid, thread_id: th })
          return s.socket.send(JSON.stringify({ op: 'sent', message, deduplicated }))
        } catch (e: any) { return s.socket.send(JSON.stringify({ op: 'error', code: e.code ?? 'INTERNAL', message: e.message })) }
      }
      case 'ack': {
        const { acked } = ackMessages(this.deps.db, this.deps.bus, s.agentId, Array.isArray(f.ids) ? f.ids : [])
        return s.socket.send(JSON.stringify({ op: 'ack_ok', acked }))
      }
      case 'read': try { markRead(this.deps.db, this.deps.bus, s.agentId, String(f.id)) } catch { /* 404 over ws: ignore */ } return
      case 'subscribe_presence': {
        s.subscribed = new Set((Array.isArray(f.ids) ? f.ids : []).slice(0, 100).map(String))
        return s.socket.send(JSON.stringify({ op: 'subscribed_presence', count: s.subscribed.size }))
      }
      default: return s.socket.send(JSON.stringify({ op: 'error', code: 'INVALID_REQUEST', message: `unknown op ${f.op}` }))
    }
  }

  // agentId 索引的增删：removeSession 返回 true 表示该 agent 已无任何连接
  private addSession(s: Session): void {
    let set = this.sessions.get(s.agentId)
    if (!set) { set = new Set(); this.sessions.set(s.agentId, set) }
    set.add(s)
  }
  private removeSession(s: Session): boolean {
    const set = this.sessions.get(s.agentId)
    if (!set) return true
    set.delete(s)
    if (set.size === 0) { this.sessions.delete(s.agentId); return true }
    return false
  }
  private *allSessions(): IterableIterator<Session> { for (const set of this.sessions.values()) for (const s of set) yield s }

  private onBus(e: BusEvent): void {
    if (e.type === 'presence') {
      // presence 发给订阅了该 agent 的会话（与目标 agent 自身连接数无关）
      for (const s of this.allSessions()) if (s.subscribed.has(e.agentId)) s.socket.send(JSON.stringify({ op: 'presence', agent_id: e.agentId }))
      return
    }
    const targets = this.sessions.get(e.agentId)
    if (!targets) return
    for (const s of targets) {
      if (e.type === 'new-message') {
        for (const m of getInbox(this.deps.db, s.agentId, 100)) s.socket.send(JSON.stringify({ op: 'message', message: m }))
      } else if (e.type === 'receipt') {
        s.socket.send(JSON.stringify({ op: 'receipt', message_ids: e.messageIds }))
      } else if (e.type === 'task-update') {
        s.socket.send(JSON.stringify({ op: 'task_update', task_id: e.taskId }))
      } else if (e.type === 'market') {
        // 市场轻量信号帧（task-7）：只带 evt+ref，详情走 srv:market 派生消息 / REST 查询
        s.socket.send(JSON.stringify({ op: 'market', evt: e.evt, ref: e.ref }))
      }
    }
  }

  closeToken(tokenId: string): void { for (const s of [...this.allSessions()]) if (s.tokenId === tokenId) s.socket.close(4003, 'token revoked') }
  closeAll(code = 1001): void { for (const s of [...this.allSessions()]) s.socket.close(code, 'server shutdown') }
  connectedAgents(): Set<string> { return new Set(this.sessions.keys()) }
  connectionCount(): number { let n = 0; for (const set of this.sessions.values()) n += set.size; return n }
  dispose(): void { this.offBus(); clearInterval(this.sweeper) }
}
