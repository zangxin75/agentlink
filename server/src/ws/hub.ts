import type { Server as HttpServer } from 'node:http'
import type { WebSocket } from 'ws'
import { WebSocketServer } from 'ws'
import type { Db } from '../db/sqlite.js'
import type { Config } from '../config.js'
import type { Bus, BusEvent } from '../core/bus.js'
import type { RateLimiter } from '../core/ratelimit.js'
import { verifyToken, touchLastSeen, getAgent, AGENT_ID_RE } from '../core/agents.js'
import { sendMessage, getInbox, ackMessages, markRead } from '../core/messages.js'
import type { Agent } from '../core/agents.js'

interface Session { agentId: string; tokenId: string; agent: Agent; socket: WebSocket; subscribed: Set<string>; lastFrame: number; debt?: boolean }

// 方案 B（docs/loadtest-2026-09.md 瓶颈分析）：new-message 只增量推这一条，
// 全量收件箱补发仅在两处发生——认证成功后一次、背压欠账恢复时一次。
// 背压：socket 缓冲超高水位即停止推送并记 debt，sweeper 周期检查缓冲回落到低水位后整箱补发一次。
const BACKPRESSURE_HIGH = 1_000_000
const BACKPRESSURE_LOW = 250_000

export class WsHub {
  // 审计 2026-10-21：ws 默认 maxPayload 100MiB/帧——未鉴权连接可发大帧打内存；与 REST bodyLimit(1MB) 对齐
  private wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })
  // agentId → 该 agent 的全部会话（同 agent 可多连接）。onBus 直查目标 agent 的会话集合，
  // 避免每事件 O(总连接数) 全量扫描（终审 Important-3 / M5 方案 A）
  private sessions = new Map<string, Set<Session>>()
  private offBus: () => void
  private sweeper: NodeJS.Timeout

  constructor(private deps: { db: Db; cfg: Config; bus: Bus; limiter: RateLimiter }) {
    this.offBus = deps.bus.on(e => this.onBus(e))
    this.sweeper = setInterval(() => {
      const now = Date.now()
      for (const s of [...this.allSessions()]) {
        if (now - s.lastFrame > this.deps.cfg.wsIdleTimeoutMs) s.socket.close(1000, 'idle')
        // 方案 B：背压欠账恢复——缓冲回落到低水位后整箱补发一次
        else if (s.debt && s.socket.bufferedAmount < BACKPRESSURE_LOW) { s.debt = false; this.replayInbox(s) }
      }
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
    // 恶意/异常帧（如超 maxPayload 的大帧）会使 ws 在 socket 上 emit 'error'——EventEmitter
    // 无 'error' 监听即抛 uncaught 击穿整个进程。挂空处理器吞掉即可：ws 随后会自行
    // close(1009)，'close' 钩子照常做会话清理（审计 2026-10-21 的 maxPayload 加固配套）
    socket.on('error', () => {})
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
          // 方案 B：认证成功后一次性补发未确认收件箱（at-least-once 兜底），此后仅增量推送
          this.replayInbox(session)
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
        // 审计 2026-10-21：REST 路径有 getAgent 404 校验，WS 缺失——幽灵收件人会落库永不投递；这里补齐
        const to = String(f.to ?? '')
        let recipient: unknown = null
        if (AGENT_ID_RE.test(to)) { try { recipient = getAgent(this.deps.db, to) } catch { /* 不存在 → error 帧 */ } }
        if (!recipient)
          return s.socket.send(JSON.stringify({ op: 'error', code: 'AGENT_NOT_FOUND', message: 'recipient not found' }))
        if ((recipient as any).role === 'group')
          return s.socket.send(JSON.stringify({ op: 'error', code: 'INVALID_REQUEST', message: 'group messages must go through REST (im send)' })) // r1-M2 防绕过 fanout 黑洞
        try {
          this.deps.limiter.checkMessage(s.agentId) // WS 与 REST 共享同一限流预算（spec §11）
          const th = f.thread_id == null ? null : String(f.thread_id) // WS 免 schema，非字符串规整为字符串；格式仍由 core 单点校验
          // WS send op 显式 text-only（设计 v3）：file 消息只走 REST（两步上传+引用，WS 帧承载不了流）
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

  // 整箱补发（上限 100 条）：认证后兜底与背压恢复共用；中途超水位则记欠账留待下轮 sweeper
  private replayInbox(s: Session): void {
    if (s.socket.bufferedAmount > BACKPRESSURE_HIGH) { s.debt = true; return }
    for (const m of getInbox(this.deps.db, s.agentId, 100)) {
      s.socket.send(JSON.stringify({ op: 'message', message: m }))
      if (s.socket.bufferedAmount > BACKPRESSURE_HIGH) { s.debt = true; return }
    }
  }

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
        // 方案 B：只推这一条新消息；缓冲超水位则记欠账，由 sweeper 恢复时整箱补发
        if (s.socket.bufferedAmount > BACKPRESSURE_HIGH) { s.debt = true; continue }
        s.socket.send(JSON.stringify({ op: 'message', message: e.message }))
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
