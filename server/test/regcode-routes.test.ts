// 邮箱自助注册码路由测试（spec §4）：路由行为 + admin 鉴权 + 限流接线
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import type { MailTransport } from '../src/core/regcodes.js'

let srv: Awaited<ReturnType<typeof startWsServer>>
let outbox: { to: string; text: string }[] = []
const smtp: MailTransport = { sendMail: async (o) => { outbox.push({ to: o.to, text: o.text }) } }
const codeFromMail = () => /\b(\d{6})\b/.exec(outbox[outbox.length - 1].text)![1]

// r1-C6：共享 srv 的 apply IP 桶（127.0.0.1，3/h）会被前序用例耗尽，抬高到 99——限流断言只打 email 2/h 桶
beforeAll(async () => { outbox = []; srv = await startWsServer({ ADMIN_TOKEN: 'adm', RATE_LIMIT_REGCODE_APPLY_IP: '99' }, { smtpTransport: smtp }) })
afterAll(async () => { await srv.close() })

describe('regcode routes', () => {
  it('apply 204（恒；不暴露占用）；verify 发码；用码注册 role=human（链路）', async () => {
    srv.mk('kt.human')
    const r = await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'New@Mail.com', human_agent_id: 'zhy.human' } })
    expect(r.statusCode).toBe(204); expect(outbox[0].to).toBe('New@Mail.com')
    const v = await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'new@mail.com', verify_code: codeFromMail() } })
    expect(v.statusCode).toBe(200)
    const code = v.json().registration_code
    const reg = await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'zhy.human', registration_code: code } })
    expect(reg.statusCode).toBe(201); expect(reg.json().agent.role).toBe('human'); expect(reg.json().agent.owner).toBe('zhy.human')
  })
  it('apply 形状错 400；SMTP null → 503（独立 srv 实例）；该实例 status=open（HTTP 位面补钉 open 态，r4-M2）', async () => {
    const s2 = await startWsServer({}, { smtpTransport: null })
    try {
      expect((await s2.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'bad', human_agent_id: 'a.b' } })).statusCode).toBe(400)
      expect((await s2.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'a@b.c', human_agent_id: 'a.b' } })).statusCode).toBe(503)
      expect((await s2.app.inject({ method: 'GET', url: '/v1/regcode/status' })).json()).toEqual({ mode: 'open' })
    } finally { await s2.close() }
  })
  it('verify 404（错码/无记录）与 409（占用）', async () => {
    await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'o@p.q', human_agent_id: 'kt.human' } }) // kt.human 已注册
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'o@p.q', verify_code: '000001' } })).statusCode).toBe(404)
    const v = await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'o@p.q', verify_code: codeFromMail() } })
    expect(v.statusCode).toBe(409); expect(v.json().error.code).toBe('AGENT_ID_TAKEN')
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'none@x.y', verify_code: '123456' } })).statusCode).toBe(404)
  })
  it('status 三态：本 srv（env 分码空、已发码）→ code（依赖首个用例为 zhy.human 发的未吊销码——vitest 默认顺序执行，依赖显式声明 r2-N7）', async () => {
    expect((await srv.app.inject({ method: 'GET', url: '/v1/regcode/status' })).json()).toEqual({ mode: 'code' })
  })
  it('吊销：x-admin-token 鉴权恒 403；DELETE 幂等 204；revoke-by-owner 204；吊销后码 403、status 仍 code（sticky）', async () => {
    await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'r@s.t', human_agent_id: 'rev.human' } })
    const code = (await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'r@s.t', verify_code: codeFromMail() } })).json().registration_code
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/regcode/${code}` })).statusCode).toBe(403) // 无头
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/regcode/${code}`, headers: { 'x-admin-token': 'wrong' } })).statusCode).toBe(403)
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/regcode/${code}`, headers: { 'x-admin-token': 'adm' } })).statusCode).toBe(204)
    expect((await srv.app.inject({ method: 'DELETE', url: `/v1/regcode/${code}`, headers: { 'x-admin-token': 'adm' } })).statusCode).toBe(204) // 幂等
    expect((await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'rev.bot', registration_code: code } })).statusCode).toBe(403)
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/revoke-by-owner', headers: { 'x-admin-token': 'adm' }, payload: { owner_agent_id: 'nobody' } })).statusCode).toBe(204)
    expect((await srv.app.inject({ method: 'GET', url: '/v1/regcode/status' })).json()).toEqual({ mode: 'code' }) // sticky
  })
  it('apply 限流：email 2/h 接线——循环 apply→verify→再 apply 后 429 封顶（spec §7；IP 桶已在本 srv env 抬高到 99，不参与断言）', async () => {
    const email = 'limited@x.y'
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email, human_agent_id: 'lim.human' } })).statusCode).toBe(204)
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email, verify_code: '000001' } })).statusCode).toBe(404) // verify 不占 apply email 桶
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email, human_agent_id: 'lim.human' } })).statusCode).toBe(204) // 再 apply（覆盖 pending）
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email, human_agent_id: 'lim.human' } })).statusCode).toBe(429) // 2/h 封顶
  })
})
