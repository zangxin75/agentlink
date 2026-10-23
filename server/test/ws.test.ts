import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { startWsServer } from './helpers/ws-server.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })

const open = (url: string, token: string) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(url)
  ws.on('open', () => { ws.send(JSON.stringify({ op: 'auth', token })); resolve(ws) })
  ws.on('error', reject)
})
const next = (ws: WebSocket, pred: (f: any) => boolean, ms = 3000) => new Promise<any>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('frame timeout')), ms)
  const h = (raw: any) => { const f = JSON.parse(String(raw)); if (pred(f)) { clearTimeout(t); ws.off('message', h); resolve(f) } }
  ws.on('message', h)
})

describe('ws hub', () => {
  it('auth_ok then ping/pong', async () => {
    srv = await startWsServer()
    const { token } = srv.mk('alice.dev')
    const ws = await open(srv.url, token)
    expect(await next(ws, f => f.op === 'auth_ok')).toBeTruthy()
    ws.send(JSON.stringify({ op: 'ping' }))
    expect((await next(ws, f => f.op === 'pong')).op).toBe('pong')
    ws.close()
  })
  it('bad token: error frame then close', async () => {
    srv = await startWsServer()
    const ws = new WebSocket(srv.url)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ op: 'auth', token: 'al_bogus' }))
    expect((await next(ws, f => f.op === 'error')).code).toBe('AUTH_FAILED') // spec §9
    await new Promise(r => ws.on('close', r))
  })
  it('审计 2026-10-21：auth.failed 写放大——同一坏 token 重复失败只落首条 audit（60s 窗采样合并）', async () => {
    srv = await startWsServer()
    const n = (srv.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE event='auth.failed'`).get() as any).n
    for (let i = 0; i < 5; i++) await srv.app.inject({ method: 'GET', url: '/v1/inbox', headers: { authorization: 'Bearer al_bogus_repeat' } })
    const after = (srv.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE event='auth.failed'`).get() as any).n
    expect(after - n).toBe(1) // 同 token 采样合并，不逐请求写库
    await srv.app.inject({ method: 'GET', url: '/v1/inbox', headers: { authorization: 'Bearer al_bogus_other' } })
    const after2 = (srv.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE event='auth.failed'`).get() as any).n
    expect(after2 - after).toBe(1) // 不同 token 首次仍记录
  })
  it('审计 2026-10-21：WS send 向不存在的 agent → AGENT_NOT_FOUND error 帧，不落库', async () => {
    srv = await startWsServer()
    const { token } = srv.mk('alice.dev')
    const ws = await open(srv.url, token)
    await next(ws, f => f.op === 'auth_ok')
    const before = (srv.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as any).n
    ws.send(JSON.stringify({ op: 'send', to: 'nobody.here', body: { text: 'hi' }, client_msg_id: 'cmid-ghost-1' }))
    expect((await next(ws, f => f.op === 'error' && f.code === 'AGENT_NOT_FOUND')).code).toBe('AGENT_NOT_FOUND')
    const after = (srv.db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as any).n
    expect(after).toBe(before) // 未投递目标不落垃圾行
    ws.close()
  })
  it('审计 2026-10-21：WS 帧超 maxPayload(1MiB) → 服务端关闭连接', async () => {
    srv = await startWsServer()
    const { token } = srv.mk('alice.dev')
    const ws = await open(srv.url, token)
    await next(ws, f => f.op === 'auth_ok')
    ws.send('x'.repeat(2 * 1024 * 1024)) // 超限帧：ws 库按 maxPayload 拒收并 close(1009)
    await new Promise(r => ws.on('close', r))
  })
  it('方案B：认证后一次性补发离线期间的未确认收件箱', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    // bob 离线时 alice 发两条
    const send = (text: string, cid: string) => srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${a.token}` }, payload: { to: 'bob.ops', type: 'text', body: { text }, client_msg_id: cid } })
    await send('offline-1', 'b1'); await send('offline-2', 'b2')
    // bob 上线：auth_ok 后应恰好各收到一次（先挂收集器，避免逐帧等待的监听空窗）
    const ws = await open(srv.url, b.token)
    const frames: any[] = []
    const seen = new Promise<void>(resolve => ws.on('message', function h(raw) { const f = JSON.parse(String(raw)); if (f.op === 'message') { frames.push(f); if (frames.length === 2) { ws.off('message', h); resolve() } } }))
    await next(ws, f => f.op === 'auth_ok')
    await seen
    expect(frames.map(f => f.message.body.text).sort()).toEqual(['offline-1', 'offline-2'])
    // 不应再有第三个 message 帧追加重发（等 300ms 无新帧）
    await expect(next(ws, f => f.op === 'message', 300)).rejects.toThrow('frame timeout')
    ws.close()
  })
  it('方案B：在线时只增量推新消息，不重发未确认积压', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const ws = await open(srv.url, b.token)
    await next(ws, f => f.op === 'auth_ok')
    const frames: any[] = []
    ws.on('message', raw => { const f = JSON.parse(String(raw)); if (f.op === 'message') frames.push(f) })
    // 连发 3 条且全程不 ack——旧行为会整箱重发（1+2+3=6 帧），增量后应恰 3 帧
    const send = (cid: string) => srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${a.token}` }, payload: { to: 'bob.ops', type: 'text', body: { text: cid }, client_msg_id: cid } })
    for (const cid of ['inc-1', 'inc-2', 'inc-3']) { await send(cid); await next(ws, f => f.op === 'message' && f.message.body.text === cid) }
    await new Promise(r => setTimeout(r, 200))
    expect(frames.map(f => f.message.body.text)).toEqual(['inc-1', 'inc-2', 'inc-3'])
    ws.close()
  })
  it('push on new message; delivered only after ws ack; both channels deliver same id', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const wsB = await open(srv.url, b.token)
    await next(wsB, f => f.op === 'auth_ok')
    // REST send from alice
    const res = await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${a.token}` }, payload: { to: 'bob.ops', type: 'text', body: { text: 'via-rest' }, client_msg_id: 'w1' } })
    const mid = res.json().message.id
    const frame = await next(wsB, f => f.op === 'message' && f.message.id === mid)
    expect(frame.message.body.text).toBe('via-rest')
    // NOT delivered yet (no ack) — REST inbox still contains it (same id)
    const inbox = await srv.app.inject({ method: 'GET', url: '/v1/inbox?wait=0', headers: { authorization: `Bearer ${b.token}` } })
    expect(inbox.json().map((m: any) => m.id)).toContain(mid)
    // ack over WS → delivered
    wsB.send(JSON.stringify({ op: 'ack', ids: [mid] }))
    await next(wsB, f => f.op === 'receipt' && f.message_ids.includes(mid))
    const inbox2 = await srv.app.inject({ method: 'GET', url: '/v1/inbox?wait=0', headers: { authorization: `Bearer ${b.token}` } })
    expect(inbox2.json().map((m: any) => m.id)).not.toContain(mid)
    wsB.close()
  })
  it('multi-connection: both sockets of same agent get the message', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    // authenticate each socket fully before opening the next: ws1's auth_ok arrives
    // while awaiting ws2's open, with no listener attached, and would be lost otherwise
    const conn = async (token: string) => { const ws = await open(srv.url, token); await next(ws, f => f.op === 'auth_ok'); return ws }
    const ws1 = await conn(b.token), ws2 = await conn(b.token)
    // attach listeners before sending: server pushes synchronously during inject, so
    // post-inject attachment races the client 'message' events and can miss them
    const p1 = next(ws1, f => f.op === 'message')
    const p2 = next(ws2, f => f.op === 'message')
    await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${a.token}` }, payload: { to: 'bob.ops', type: 'text', body: { text: 'dup' }, client_msg_id: 'w2' } })
    expect(await p1).toBeTruthy()
    expect(await p2).toBeTruthy()
    ws1.close(); ws2.close()
  })
  it('revoking token closes its live ws connection', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev')
    const { token } = srv.mk('bob.ops')
    const ws = await open(srv.url, token)
    await next(ws, f => f.op === 'auth_ok')
    const list = await srv.app.inject({ method: 'GET', url: '/v1/tokens', headers: { authorization: `Bearer ${token}` } })
    const tokenId = list.json().find((t: any) => !t.revoked_at).id
    await srv.app.inject({ method: 'DELETE', url: `/v1/tokens/${tokenId}`, headers: { authorization: `Bearer ${token}` } })
    const closed = new Promise(r => ws.on('close', r))
    await closed // hub.closeToken fired via onRevoke
    expect((await srv.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${a.token}` } })).statusCode).toBe(200)
  })
  it('ws send op creates message visible over REST', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const ws = await open(srv.url, a.token)
    await next(ws, f => f.op === 'auth_ok')
    ws.send(JSON.stringify({ op: 'send', to: 'bob.ops', type: 'text', body: { text: 'via-ws' }, client_msg_id: 'w3' }))
    const sent = await next(ws, f => f.op === 'sent')
    expect(sent.message.id).toMatch(/^msg_/)
    const inbox = await srv.app.inject({ method: 'GET', url: '/v1/inbox?wait=0', headers: { authorization: `Bearer ${b.token}` } })
    expect(inbox.json()[0].body.text).toBe('via-ws')
    ws.close()
  })
  it('ws send shares REST rate budget (spec §11)', async () => {
    srv = await startWsServer({ RATE_LIMIT_MESSAGE_PER_MIN: '1' })
    const a = srv.mk('alice.dev'); srv.mk('bob.ops')
    const ws = await open(srv.url, a.token)
    await next(ws, f => f.op === 'auth_ok')
    ws.send(JSON.stringify({ op: 'send', to: 'bob.ops', type: 'text', body: { text: 'one' }, client_msg_id: 'r1' }))
    await next(ws, f => f.op === 'sent')
    ws.send(JSON.stringify({ op: 'send', to: 'bob.ops', type: 'text', body: { text: 'two' }, client_msg_id: 'r2' }))
    const err = await next(ws, f => f.op === 'error')
    expect(err.code).toBe('RATE_LIMITED')
    ws.close()
  })
  it('ws send rejects missing/empty/overlong client_msg_id instead of silently deduping (终审 Important-2)', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'); srv.mk('bob.ops')
    const ws = await open(srv.url, a.token)
    await next(ws, f => f.op === 'auth_ok')
    for (const f of [
      { op: 'send', to: 'bob.ops', type: 'text', body: { text: 'no cmid' } }, // 缺失
      { op: 'send', to: 'bob.ops', type: 'text', body: { text: 'empty' }, client_msg_id: '' }, // 空串
      { op: 'send', to: 'bob.ops', type: 'text', body: { text: 'long' }, client_msg_id: 'x'.repeat(65) }, // 超长
    ]) {
      ws.send(JSON.stringify(f))
      const err = await next(ws, x => x.op === 'error')
      expect(err.code).toBe('INVALID_REQUEST')
    }
    // 两条不同内容、均无 cmid 的消息必须不再共用同一 id（此前第二条 deduplicated 静默丢失）
    expect(srv.db.prepare('SELECT COUNT(*) c FROM messages').get()).toMatchObject({ c: 0 })
    // 正常 cmid 仍可发（不回归）
    ws.send(JSON.stringify({ op: 'send', to: 'bob.ops', type: 'text', body: { text: 'ok' }, client_msg_id: 'r-ok' }))
    const sent = await next(ws, f => f.op === 'sent')
    expect(sent.message.id).toMatch(/^msg_/)
    ws.close()
  })
  it('batch ack emits a single merged receipt frame containing all ids', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const ids: string[] = []
    for (const c of ['m1', 'm2']) {
      const res = await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${a.token}` }, payload: { to: 'bob.ops', type: 'text', body: { text: c }, client_msg_id: c } })
      ids.push(res.json().message.id)
    }
    const wsB = await open(srv.url, b.token)
    await next(wsB, f => f.op === 'auth_ok')
    wsB.send(JSON.stringify({ op: 'ack', ids }))
    // 合并后单条 receipt 帧含全部 id（此前逐 id 各发一帧）
    const r = await next(wsB, f => f.op === 'receipt' && f.message_ids.length === 2)
    expect(r.message_ids).toEqual(ids)
    wsB.close()
  })
  it('presence event only when an agent’s LAST connection closes (终审 Minor-9)', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const events: string[] = []
    srv.bus.on(e => { if (e.type === 'presence' && e.agentId === 'bob.ops') events.push(e.type) })
    const conn = async (token: string) => { const ws = await open(srv.url, token); await next(ws, f => f.op === 'auth_ok'); return ws }
    const ws1 = await conn(b.token), ws2 = await conn(b.token)
    await new Promise(r => setTimeout(r, 50))
    expect(events).toHaveLength(2) // 每次 auth 上线各发一次（保持既有行为，仅在关闭侧收敛噪声）
    ws1.close() // 关其一：bob.ops 仍在线，不应发 presence
    await new Promise(r => setTimeout(r, 150))
    expect(events).toHaveLength(2) // 仍只有两次 auth 事件，无断连 presence
    ws2.close() // 全关：发 presence
    await new Promise(r => setTimeout(r, 150))
    expect(events).toHaveLength(3)
    expect(srv.hub.connectedAgents().has('bob.ops')).toBe(false)
  })
})
