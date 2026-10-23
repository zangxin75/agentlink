// server/test/regcode-e2e.test.ts —— 全链路：apply→verify→注册→建群；sticky 与吊销在运维位面的复核（spec §7）
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import type { MailTransport } from '../src/core/regcodes.js'

let srv: Awaited<ReturnType<typeof startWsServer>>
let outbox: { to: string; text: string }[] = []
const smtp: MailTransport = { sendMail: async (o) => { outbox.push({ to: o.to, text: o.text }) } }
const lastCode = () => /\b(\d{6})\b/.exec(outbox[outbox.length - 1].text)![1]

beforeAll(async () => { outbox = []; srv = await startWsServer({ RATE_LIMIT_REGCODE_APPLY_IP: '99', RATE_LIMIT_REGCODE_APPLY_EMAIL: '10' }, { smtpTransport: smtp }) }) // r2-N5/r3-P5：e2e 不钉配额（routes 测试已钉），IP/email 双桶抬高留 headroom
afterAll(async () => { await srv.close() })

describe('regcode e2e', () => {
  it('申请→验证→注册（human）→用该 human 身份建群', async () => {
    // apply（大小写混写 +tag：归一化作键、原始收件）
    expect((await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'Zhy+tag@Mail.com', human_agent_id: 'zhy.human' } })).statusCode).toBe(204)
    expect(outbox[0].to).toBe('Zhy+tag@Mail.com')
    const v = await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'zhy@mail.com', verify_code: lastCode() } })
    expect(v.statusCode).toBe(200)
    const code = v.json().registration_code
    const reg = await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'zhy.human', registration_code: code } })
    expect(reg.statusCode).toBe(201); expect(reg.json().agent.role).toBe('human')
    const tk = reg.json().token
    const bot = await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'zhy.bot', registration_code: code } })
    expect(bot.json().agent.owner).toBe('zhy.human') // 同码带 agent
    const g = await srv.app.inject({ method: 'POST', url: '/v1/groups', headers: { authorization: `Bearer ${tk}` }, payload: { name: 'e2e群', members: ['zhy.bot'] } })
    expect(g.statusCode).toBe(201) // human 可建群（M1 语义）
  })
  it('同邮箱二次领取：旧码吊销失效、新码可用（r2-N1 链路语义）', async () => {
    await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'again@x.y', human_agent_id: 'ag.human' } })
    const c1 = (await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'again@x.y', verify_code: lastCode() } })).json().registration_code
    await srv.app.inject({ method: 'POST', url: '/v1/regcode/apply', payload: { email: 'again@x.y', human_agent_id: 'ag.human' } })
    const c2 = (await srv.app.inject({ method: 'POST', url: '/v1/regcode/verify', payload: { email: 'again@x.y', verify_code: lastCode() } })).json().registration_code
    expect((await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'ag2.bot', registration_code: c1 } })).statusCode).toBe(403) // 旧码已吊销
    expect((await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'ag2.bot', registration_code: c2 } })).statusCode).toBe(201)
  })
  it('audit 全链落库（applied/verified/issued，actor=regcode，邮箱脱敏）', () => {
    const rows = srv.db.prepare(`SELECT event, actor, detail FROM audit_log WHERE event LIKE 'regcode.%' ORDER BY id`).all() as any[]
    expect(rows.some(r => r.event === 'regcode.applied' && r.actor === 'regcode' && JSON.parse(r.detail).email.match(/^[0-9a-f]{12}@/))).toBe(true)
    expect(rows.some(r => r.event === 'regcode.issued')).toBe(true)
    expect(rows.every(r => !JSON.stringify(r.detail).includes('Zhy+tag'))).toBe(true) // 明文邮箱不入审计
  })
})
