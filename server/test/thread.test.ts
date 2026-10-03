import { describe, it, expect, afterEach } from 'vitest'
import WebSocket from 'ws'
import { startWsServer } from './helpers/ws-server.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const send = async (token: string, body: any) => (await srv!.app.inject({ method: 'POST', url: '/v1/messages', headers: H(token), payload: body })).json()

describe('thread', () => {
  it('two threads with same peer do not cross; NULL excluded from any thread filter', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    await send(a.token, { to: 'bob.ops', type: 'text', body: { text: 't1-a' }, client_msg_id: 'x1', thread_id: 't1' })
    await send(a.token, { to: 'bob.ops', type: 'text', body: { text: 't2-a' }, client_msg_id: 'x2', thread_id: 't2' })
    await send(a.token, { to: 'bob.ops', type: 'text', body: { text: 'no-thread' }, client_msg_id: 'x3' })
    const h1 = await srv.app.inject({ method: 'GET', url: '/v1/history?peer=alice.dev&thread_id=t1', headers: H(b.token) })
    expect(h1.json().map((m: any) => m.body.text)).toEqual(['t1-a'])
    const h2 = await srv.app.inject({ method: 'GET', url: '/v1/history?thread_id=t2', headers: H(b.token) })
    expect(h2.json().map((m: any) => m.body.text)).toEqual(['t2-a'])
    const hAll = await srv.app.inject({ method: 'GET', url: '/v1/history?peer=alice.dev', headers: H(b.token) })
    expect(hAll.json().length).toBe(3) // 不过滤时全在（v1 行为）
    const inbox = await srv.app.inject({ method: 'GET', url: '/v1/inbox?wait=0&thread_id=t1', headers: H(b.token) })
    expect(inbox.json().map((m: any) => m.body.text)).toEqual(['t1-a'])
  })
  it('invalid thread_id rejected at core (REST and message field always present', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'); srv.mk('bob.ops')
    const r = await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: H(a.token), payload: { to: 'bob.ops', type: 'text', body: { text: 'x' }, client_msg_id: 'y1', thread_id: '带空格 错误!' } })
    expect(r.statusCode).toBe(400)
    const ok = await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: H(a.token), payload: { to: 'bob.ops', type: 'text', body: { text: 'ok' }, client_msg_id: 'y2' } })
    expect(ok.json().message.thread_id).toBe(null) // 字段始终存在（兼容承诺 §9.2）
  })
  it('ws send carries thread_id; message frame echoes it', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops')
    const ws = new WebSocket(srv.url)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({ op: 'auth', token: b.token }))
    await new Promise(r => ws.on('message', r)) // auth_ok
    const frameP = new Promise<any>(r => ws.on('message', (raw: any) => { const f = JSON.parse(String(raw)); if (f.op === 'message' && f.message.body.text === 'via-ws') r(f) }))
    ws.send(JSON.stringify({ op: 'send', to: 'bob.ops', from: 'alice.dev', body: { text: 'via-ws' }, client_msg_id: 'w1', thread_id: 42 }))
    // thread_id 非字符串由 hub String() 规整为 '42'，core 校验通过
    const f = await frameP
    expect(f.message.thread_id).toBe('42')
    const wsA = new WebSocket(srv.url)
    await new Promise(r => wsA.on('open', r))
    wsA.send(JSON.stringify({ op: 'auth', token: a.token }))
    await new Promise(r => wsA.on('message', r))
    const sentP = new Promise<any>(r => wsA.on('message', (raw: any) => { const f2 = JSON.parse(String(raw)); if (f2.op === 'sent') r(f2) }))
    wsA.send(JSON.stringify({ op: 'send', to: 'bob.ops', body: { text: 'via-ws' }, client_msg_id: 'w2', thread_id: 'wt1' }))
    const sent = await sentP
    expect(sent.message.thread_id).toBe('wt1')
    ws.close(); wsA.close()
  })
  it('history with unknown peer still 404 (v1 semantics preserved)', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev')
    expect((await srv.app.inject({ method: 'GET', url: '/v1/history?peer=ghost.x', headers: H(a.token) })).statusCode).toBe(404)
    expect((await srv.app.inject({ method: 'GET', url: '/v1/history?thread_id=t', headers: H(a.token) })).statusCode).toBe(200) // 仅 thread：跳过 peer 校验
  })
})
