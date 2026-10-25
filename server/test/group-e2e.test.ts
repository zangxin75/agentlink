// group e2e — 全链路：human 建群 → agent 群发 → 成员收件箱可见 + ack（成员侧零改动证明）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { getInbox, ackMessages } from '../src/core/messages.js'
import { startWsServer } from './helpers/ws-server.js'

let srv: Awaited<ReturnType<typeof startWsServer>>
beforeAll(async () => { srv = await startWsServer({ AGENTLINK_HUMAN_IDS: 'kt.human' }) })
afterAll(async () => { await srv.close() })

describe('group e2e', () => {
  it('human 建群 → 成员 agent 经 POST /v1/messages 群发 → 双成员 inbox 各见 1 条 + 封皮 + ack', async () => {
    srv.mk('kt.human'); srv.mk('kt.a1'); srv.mk('kt.a2')
    const ht = srv.mk('kt.human').token
    const g = await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: `Bearer ${ht}` }, payload: { name: 'E2E 群', members: ['kt.a1', 'kt.a2'] } })
    const gid = g.json().id
    // 成员 agent 用现有 im send 路径（零新命令）
    const at = srv.mk('kt.a1').token
    const r = await srv.app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${at}` }, payload: { to: gid, type: 'text', body: { text: '群发冒烟' }, client_msg_id: 'e2e-1' } })
    expect(r.statusCode).toBe(201); expect(r.json().delivered).toBe(3) // owner(kt.human)+a1+a2（r1-M2）
    for (const member of ['kt.a1', 'kt.a2']) {
      const inbox = getInbox(srv.db, member, 10)
      expect(inbox).toHaveLength(1)
      expect(inbox[0].body.group.name).toBe('E2E 群')
      expect(inbox[0].topic).toBe('g-' + gid.slice(4))
      expect(inbox[0].group_id).toBe(gid) // messages.ts COLS 已加 group_id（r1-Minor2）
      expect(ackMessages(srv.db, srv.bus, member, [inbox[0].id]).acked).toHaveLength(1)
    }
    // human 视角群时间线
    const tl = await srv.app.inject({ method: 'GET', url: `/v1/groups/${gid}/messages`, headers: { authorization: `Bearer ${ht}` } })
    expect(tl.json()).toHaveLength(3)
  })
})
