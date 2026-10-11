import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask } from '../src/core/tasks.js'
import type { WebhookDispatcher } from '../src/core/webhook.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
let whSrv: Server | null = null
afterEach(async () => { await srv?.close(); srv = null; whSrv?.close(); whSrv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })
const bodies: string[] = []
beforeEach(() => { bodies.length = 0 }) // r1-I11：跨用例共享会弱化计数断言
const listen = () => new Promise<string>(resolve => {
  // 记录原始 body 以便断言事件名/角色（终审 C1：HTTP 路径集成测试需要看投递内容）
  whSrv = createServer((q, res) => { let b = ''; q.on('data', c => { b += c }); q.on('end', () => { bodies.push(b); res.writeHead(200); res.end('{}') }) })
  whSrv.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(whSrv!.address() as any).port}`))
})
const events = () => bodies.map(b => JSON.parse(b))

describe('webhook wiring', () => {
  it('PATCH /me sets webhook, secret shown once, GET never echoes; events fire on transitions', async () => {
    srv = await startWsServer({ WEBHOOK_ALLOW_PRIVATE: 'true' })
    const a = srv.mk('alice.dev'); srv.mk('bob.ops')
    const url = await listen()
    const set = await srv.app.inject({ method: 'PATCH', url: '/v1/me', headers: H(a.token), payload: { webhook_url: url } })
    expect(set.statusCode).toBe(200)
    const secret = set.json().webhook_secret
    expect(secret).toMatch(/^wl_/)
    const again = await srv.app.inject({ method: 'PATCH', url: '/v1/me', headers: H(a.token), payload: { display_name: 'x' } })
    expect(again.json().webhook_secret).toBeUndefined()
    expect(JSON.stringify(await srv.app.inject({ method: 'GET', url: '/v1/me', headers: H(a.token) }).then(r => r.json()))).not.toContain('webhook_secret')
    // task lifecycle → requester webhook (role=requester)
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'go' }, { notify: (tk, e) => srv!.hooks.notify(tk, e) }).task
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' }, srv.hooks)
    await new Promise(r => setTimeout(r, 300))
    expect(bodies.length).toBe(1) // 仅 alice 配了 webhook：accept → 1 条投递（bob 未配置，静默跳过）
  })
  it('policy reject notifies requester only; POST /v1/webhook/test fires; rate limited', async () => {
    srv = await startWsServer({ WEBHOOK_ALLOW_PRIVATE: 'true', RATE_LIMIT_WEBHOOK_TEST_PER_MIN: '1' })
    const a = srv.mk('alice.dev'); srv.mk('bob.ops')
    srv.db.prepare(`UPDATE agents SET task_policy='{"mode":"closed","allowlist":[],"scope":"read-only"}' WHERE id='bob.ops'`).run()
    const url = await listen()
    await srv.app.inject({ method: 'PATCH', url: '/v1/me', headers: H(a.token), payload: { webhook_url: url } })
    createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'x' }, srv.hooks)
    const t1 = await srv.app.inject({ method: 'POST', url: '/v1/webhook/test', headers: H(a.token) })
    expect(t1.statusCode).toBe(204)
    const t2 = await srv.app.inject({ method: 'POST', url: '/v1/webhook/test', headers: H(a.token) })
    expect(t2.statusCode).toBe(429)
    await new Promise(r => setTimeout(r, 300))
    expect(bodies.length).toBe(2) // 精确计数：policy_rejected 1 + webhook.test 1
  })
})

// 终审 C1：纯 HTTP 路径的接线集成测试——禁止直接调 core / 传 srv.hooks，否则会继续掩盖路由层未接 hooks 的缺陷
describe('webhook wiring via HTTP routes', () => {
  it('POST /v1/tasks + accept over HTTP fires task.accepted delivery', async () => {
    srv = await startWsServer({ WEBHOOK_ALLOW_PRIVATE: 'true' })
    const a = srv.mk('alice.dev'); const b = srv.mk('bob.ops')
    const url = await listen()
    expect((await srv.app.inject({ method: 'PATCH', url: '/v1/me', headers: H(a.token), payload: { webhook_url: url } })).statusCode).toBe(200)
    const create = await srv.app.inject({ method: 'POST', url: '/v1/tasks', headers: H(a.token), payload: { to: 'bob.ops', action: 'go' } })
    expect(create.statusCode).toBe(201)
    const id = create.json().id
    const acc = await srv.app.inject({ method: 'POST', url: `/v1/tasks/${id}/accept`, headers: H(b.token), payload: {} })
    expect(acc.statusCode).toBe(200)
    await new Promise(r => setTimeout(r, 300))
    expect(bodies.length).toBe(1)
    expect(events()[0]).toMatchObject({ event: 'task.accepted', task_id: id, role: 'requester' })
  })
  it('policy rejection over HTTP (closed executor) fires task.policy_rejected', async () => {
    srv = await startWsServer({ WEBHOOK_ALLOW_PRIVATE: 'true' })
    const a = srv.mk('alice.dev'); const b = srv.mk('bob.ops')
    srv.db.prepare("UPDATE agents SET task_policy=? WHERE id=?").run(JSON.stringify({ mode: 'closed', allowlist: [], scope: 'full' }), 'bob.ops')
    const url = await listen()
    expect((await srv.app.inject({ method: 'PATCH', url: '/v1/me', headers: H(a.token), payload: { webhook_url: url } })).statusCode).toBe(200)
    const res = await srv.app.inject({ method: 'POST', url: '/v1/tasks', headers: H(a.token), payload: { to: 'bob.ops', action: 'go' } })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('POLICY_REJECTED')
    await new Promise(r => setTimeout(r, 300))
    expect(bodies.length).toBe(1)
    expect(events()[0].event).toBe('task.policy_rejected')
  })
  it('result_schema 422 over HTTP fires no task.result delivery', async () => {
    srv = await startWsServer({ WEBHOOK_ALLOW_PRIVATE: 'true' })
    const a = srv.mk('alice.dev'); const b = srv.mk('bob.ops')
    const url = await listen()
    expect((await srv.app.inject({ method: 'PATCH', url: '/v1/me', headers: H(a.token), payload: { webhook_url: url } })).statusCode).toBe(200)
    const create = await srv.app.inject({ method: 'POST', url: '/v1/tasks', headers: H(a.token), payload: {
      to: 'bob.ops', action: 'go',
      // depth-1 嵌套操作符（终审 I1）：maxLength/minimum/enum 须在嵌套层同样执行
      result_schema: { type: 'object', properties: { nested: { type: 'object', properties: { x: { type: 'string', maxLength: 3 }, lvl: { type: 'integer', minimum: 10 }, mode: { enum: ['a'] } } } } } } })
    expect(create.statusCode).toBe(201)
    const id = create.json().id
    expect((await srv.app.inject({ method: 'POST', url: `/v1/tasks/${id}/accept`, headers: H(b.token), payload: {} })).statusCode).toBe(200)
    await new Promise(r => setTimeout(r, 300))
    const before = bodies.length
    const bad = await srv.app.inject({ method: 'POST', url: `/v1/tasks/${id}/result`, headers: H(b.token), payload: { status: 'completed', result: JSON.stringify({ nested: { x: 'way-too-long', lvl: 1, mode: 'zzz' } }) } })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('RESULT_SCHEMA_MISMATCH')
    await new Promise(r => setTimeout(r, 300))
    expect(events().slice(before).map(e => e.event)).not.toContain('task.result') // 422 不触发任何投递
  })
})
