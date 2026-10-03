// topic 字段全链路:schema 校验/落库/默认值/inbox-history 过滤透传/WS 帧/srv: 派生
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { startWsServer } from './helpers/ws-server.js'

let base: Awaited<ReturnType<typeof startWsServer>>
beforeEach(async () => { base = await startWsServer({}) })
afterEach(async () => { await base.close() })

// 夹具照 test/ws.test.ts 现状复制的私有辅助（最小改动，不提炼）
const wsConnect = (url: string, token: string) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(url)
  ws.on('open', () => { ws.send(JSON.stringify({ op: 'auth', token })); resolve(ws) })
  ws.on('error', reject)
})
const next = (ws: WebSocket, pred: (f: any) => boolean, ms = 3000) => new Promise<any>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('frame timeout')), ms)
  const h = (raw: any) => { const f = JSON.parse(String(raw)); if (pred(f)) { clearTimeout(t); ws.off('message', h); resolve(f) } }
  ws.on('message', h)
})

describe('topic registry', () => {
  it('PUT /v1/me/topics 注册；GET /v1/agents/:id/topics 可查；_default 拒绝', async () => {
    const A = await base.mk('alice-reg')
    const put = await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['imchat', 'promote'] } })
    expect(put.statusCode).toBe(200)
    const get = await base.app.inject({ method: 'GET', url: `/v1/agents/${A.agent.id}/topics`, headers: { authorization: `Bearer ${A.token}` } })
    expect(get.json().topics.map((t: any) => t.topic).sort()).toEqual(['imchat', 'promote'])
    const bad = await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['_default'] } })
    expect(bad.statusCode).toBe(400)
  })
  it('PUT 不注销列表外 topic（会话无权注销别人）；空数组合法 no-op', async () => {
    const A = await base.mk('alice-reg2')
    await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['a.b'] } })
    await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['c-d'] } })
    await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: [] } })
    const get = await base.app.inject({ method: 'GET', url: `/v1/agents/${A.agent.id}/topics`, headers: { authorization: `Bearer ${A.token}` } })
    expect(get.json().topics.map((t: any) => t.topic).sort()).toEqual(['a.b', 'c-d'])
  })
  it('发送响应带 topic_registered；未注册 topic 不拒收', async () => {
    const A = await base.mk('alice-reg3'); const B = await base.mk('bob-reg3')
    await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['imchat'] } })
    const r1 = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'x' }, client_msg_id: 'reg1', topic: 'imchat' } })
    expect(r1.json().topic_registered).toBe(true)
    const r2 = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'y' }, client_msg_id: 'reg2', topic: 'ghost' } })
    expect(r2.statusCode).toBe(201)
    expect(r2.json().topic_registered).toBe(false)
  })
  it('TTL 过期：expires_at 过去后 GET 返回空、topic_registered 变 false（critic-M6）', async () => {
    const A = await base.mk('alice-reg4'); const B = await base.mk('bob-reg4')
    await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['imchat'] } })
    // 直接改库快进过期（不走真实 25h;ws-server helper 已暴露 base.db,直接 exec）:
    base.db.exec(`UPDATE agent_topics SET expires_at = '2000-01-01T00:00:00Z'`)
    const get = await base.app.inject({ method: 'GET', url: `/v1/agents/${A.agent.id}/topics`, headers: { authorization: `Bearer ${A.token}` } })
    expect(get.json().topics).toEqual([])
    const r = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'z' }, client_msg_id: 'reg5', topic: 'imchat' } })
    expect(r.json().topic_registered).toBe(false)
  })
  it('topics 上报限频：连续 PUT 超 topicsPerMin → 429（critic-M6）', async () => {
    const A = await base.mk('alice-reg5')
    let last = 200
    for (let i = 0; i <= 60; i++) last = (await base.app.inject({ method: 'PUT', url: '/v1/me/topics', headers: { authorization: `Bearer ${A.token}` }, payload: { topics: ['t' + (i % 8)] } })).statusCode
    expect(last).toBe(429)
  })
})

describe('POST /v1/messages topic', () => {
  it('带合法 topic 落库且响应/收件方 inbox 带 topic', async () => {
    const A = await base.mk('alice-top'); const B = await base.mk('bob-top')
    const res = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'hi' }, client_msg_id: 'c1', topic: 'imchat' } })
    expect(res.statusCode).toBe(201)
    expect(res.json().message.topic).toBe('imchat')
    const inbox = await base.app.inject({ method: 'GET', url: '/v1/inbox', headers: { authorization: `Bearer ${A.token}` } })
    expect(inbox.json()[0].topic).toBe('imchat')
  })
  it('省略 topic → _default；显式 _default 合法等价', async () => {
    const A = await base.mk('alice-top2'); const B = await base.mk('bob-top2')
    const r1 = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'a' }, client_msg_id: 'c2' } })
    const r2 = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'b' }, client_msg_id: 'c3', topic: '_default' } })
    expect(r1.json().message.topic).toBe('_default')
    expect(r2.statusCode).toBe(201)
  })
  it('非法 topic（大写/下划线开头/超长）→ 400 INVALID_REQUEST', async () => {
    const A = await base.mk('alice-top3'); const B = await base.mk('bob-top3')
    for (const bad of ['Imchat', '_x', 'a'.repeat(33)]) {
      const r = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'x' }, client_msg_id: 'c-' + bad, topic: bad } })
      expect(r.statusCode).toBe(400)
    }
  })
  it('inbox?topic= 与 history?topic= 过滤', async () => {
    const A = await base.mk('alice-top4'); const B = await base.mk('bob-top4')
    for (const [cmid, topic] of [['t1', 'imchat'], ['t2', 'promote'], ['t3', undefined]] as const)
      await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${B.token}` }, payload: { to: A.agent.id, type: 'text', body: { text: 'x' }, client_msg_id: cmid, ...(topic ? { topic } : {}) } })
    const inbox = await base.app.inject({ method: 'GET', url: '/v1/inbox?topic=imchat', headers: { authorization: `Bearer ${A.token}` } })
    expect(inbox.json()).toHaveLength(1)
    expect(inbox.json()[0].topic).toBe('imchat')
    const hist = await base.app.inject({ method: 'GET', url: '/v1/history?topic=promote', headers: { authorization: `Bearer ${A.token}` } })
    expect(hist.json().some((m: any) => m.topic === 'promote')).toBe(true)
    expect(hist.json().every((m: any) => m.topic === 'promote')).toBe(true)
  })
  it('srv: 派生消息 topic 落 _default（spec §1 决策钉住，critic-M4）', async () => {
    const A = await base.mk('alice-srv'); const B = await base.mk('bob-srv')
    // POST /v1/tasks 响应体即 task 对象（无 .task 包装）
    const t = (await base.app.inject({ method: 'POST', url: '/v1/tasks', headers: { authorization: `Bearer ${A.token}` }, payload: { to: B.agent.id, action: 'ping', max_duration_s: 60 } })).json()
    await base.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/accept`, headers: { authorization: `Bearer ${B.token}` }, payload: {} })
    await base.app.inject({ method: 'POST', url: `/v1/tasks/${t.id}/result`, headers: { authorization: `Bearer ${B.token}` }, payload: { status: 'completed', result: 'ok' } })
    const hist = (await base.app.inject({ method: 'GET', url: `/v1/history?peer=${B.agent.id}&limit=100`, headers: { authorization: `Bearer ${A.token}` } })).json()
    const srvMsgs = hist.filter((m: any) => m.client_msg_id.startsWith('srv:')) // srv: 前缀在幂等键上,消息 id 仍是 msg_*
    expect(srvMsgs.length).toBeGreaterThan(0)
    expect(srvMsgs.every((m: any) => m.topic === '_default')).toBe(true)
  })
  it('WS 推送帧带 topic（critic-M5）', async () => {
    const A = await base.mk('alice-ws'); const B = await base.mk('bob-ws')
    const wsB = await wsConnect(base.url, B.token)
    await next(wsB, f => f.op === 'auth_ok') // 先等 auth 完成再发,否则推送早于会话注册会丢帧
    const send = await base.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${A.token}` }, payload: { to: B.agent.id, type: 'text', body: { text: 'x' }, client_msg_id: 'ws1', topic: 'imchat' } })
    const mid = send.json().message.id
    const frame = await next(wsB, (f: any) => f.op === 'message' && f.message.id === mid)
    expect(frame.message.topic).toBe('imchat')
    wsB.close()
  })
})
