// groups REST：建群/群发/时间线/权限分叉 + POST /v1/messages 群拦截（双入口一致）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'

let srv: Awaited<ReturnType<typeof startWsServer>>
let token = (id: string) => 'Bearer ' + srv.mk(id).token

beforeAll(async () => { srv = await startWsServer({ AGENTLINK_HUMAN_IDS: 'kt.human,zhy.human' }) })
afterAll(async () => { await srv.close() })

describe('groups REST', () => {
  it('human 建群/群发/时间线；agent 不能建群（403）；非可见 human 403', async () => {
    srv.mk('kt.human'); srv.mk('zhy.human'); srv.mk('kt.a1'); srv.mk('kt.a2'); srv.mk('stranger.human'); srv.mk('other.agent')
    const g = await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: token('kt.human') }, payload: { name: '作战室', members: ['kt.a1', 'kt.a2'] } })
    expect(g.statusCode).toBe(201); const gid = g.json().id
    expect((await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: token('kt.a1') }, payload: { name: 'x', members: ['kt.a1'] } })).statusCode).toBe(403)
    const send = await srv.app.inject({ method: 'POST', url: `/v1/groups/${gid}/messages`, headers: { authorization: token('kt.human') }, payload: { type: 'text', body: { text: '开会' }, client_msg_id: 'c1' } })
    expect(send.statusCode).toBe(201); expect(send.json().delivered).toBe(3) // owner+a1+a2（r1-M2：建群者入 members）
    const tl = await srv.app.inject({ method: 'GET', url: `/v1/groups/${gid}/messages?limit=10`, headers: { authorization: token('kt.human') } })
    expect(tl.json()).toHaveLength(3)
    expect((await srv.app.inject({ method: 'GET', url: `/v1/groups/${gid}/messages`, headers: { authorization: token('stranger.human') } })).statusCode).toBe(403) // 注：stranger.human 不在 HUMAN_IDS → role='agent'，以 agent 身份 403（非成员），断言同成立
  })
  it('POST /v1/messages to=grp.* 拦截：与 groups 端点行为一致（fanout 而非单行）；限流按 1 条', async () => {
    const g = await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: token('kt.human') }, payload: { name: 'g2', members: ['kt.a1', 'kt.a2'] } })
    const gid = g.json().id
    const r = await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: token('kt.human') }, payload: { to: gid, type: 'text', body: { text: 'via im send' }, client_msg_id: 'c2' } })
    expect(r.statusCode).toBe(201); expect(r.json().delivered).toBe(3)   // owner+a1+a2，不是单行 message
    expect(r.json().group_id).toBe(gid)
    // 非成员 agent 走旧端点 → 403
    expect((await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: token('other.agent') }, payload: { to: gid, type: 'text', body: { text: 'x' }, client_msg_id: 'c3' } })).statusCode).toBe(403)
    // 普通 DM 不受影响
    expect((await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: token('kt.a1') }, payload: { to: 'kt.a2', type: 'text', body: { text: 'dm' }, client_msg_id: 'c4' } })).statusCode).toBe(201)
  })
  it('时间线 limit 钳制：?limit=-1 不退化为 LIMIT -1（无限行），上限 50/200（终审 Important-1）', async () => {
    const g = await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: token('kt.human') }, payload: { name: 'tl', members: ['kt.a1'] } })
    const gid = g.json().id
    const now = new Date().toISOString()
    const ins = srv.db.prepare(`INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, topic, created_at, group_id) VALUES (?,?, 'kt.human', 'kt.a1', 'text', '{}', NULL, 't', ?, ?)`)
    for (let i = 0; i < 51; i++) ins.run('msg_tl_' + i, 'tl_' + i, now, gid) // 直插 51 行，绕开限流
    const r = await srv.app.inject({ method: 'GET', url: `/v1/groups/${gid}/messages?limit=-1`, headers: { authorization: token('kt.human') } })
    expect(r.statusCode).toBe(200)
    expect(r.json().length).toBeLessThanOrEqual(50) // 旧代码 LIMIT -1 会吐全部 51 行
  })
  it('改名/拉人/移人/解散 410：REST 权限分叉与 410 语义', async () => {
    const g = await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: token('kt.human') }, payload: { name: 'g3', members: ['kt.a1'] } })
    const gid = g.json().id
    expect((await srv.app.inject({ method: 'PATCH', url: `/v1/groups/${gid}`, headers: { authorization: token('zhy.human') }, payload: { name: 'x' } })).statusCode).toBe(403)
    expect((await srv.app.inject({ method: 'POST', url: `/v1/groups/${gid}/members`, headers: { authorization: token('kt.human') }, payload: { agent_id: 'kt.a2' } })).statusCode).toBe(204)
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/groups/${gid}/members/kt.a2`, headers: { authorization: token('zhy.human') } })).statusCode).toBe(403)
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/groups/${gid}`, headers: { authorization: token('kt.human') } })).statusCode).toBe(204)
    expect((await srv.app.inject({ method: 'POST', url: `/v1/groups/${gid}/messages`, headers: { authorization: token('kt.human') }, payload: { type: 'text', body: { text: 'x' }, client_msg_id: 'c5' } })).statusCode).toBe(410)
    expect((await srv.app.inject({ method: 'POST', url: `/v1/groups/${gid}/members`, headers: { authorization: token('kt.human') }, payload: { agent_id: 'kt.a2' } })).statusCode).toBe(410) // r2-Minor3：解散后拉人也 410
  })
})
