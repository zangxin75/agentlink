// server/test/messages-search.test.ts — GET /v1/messages/search 全文反查对话方（按内容找人）
import { describe, it, expect } from 'vitest'
import { buildApp } from '../src/http/app.js'
import { openDb, migrate } from '../src/db/sqlite.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig } from '../src/config.js'
import { registerAgent } from '../src/core/agents.js'
import { Bus } from '../src/core/bus.js'
import { RateLimiter } from '../src/core/ratelimit.js'
import { sendMessage } from '../src/core/messages.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cfg = loadConfig({ REGISTRATION_CODE: 'x' } as never)
const mk = () => {
  const db = openDb(join(tmpdir(), `al-search-${Date.now()}-${Math.random().toString(36).slice(2)}.db`))
  migrate(db)
  const bus = new Bus()
  const app = buildApp({ db, cfg, bus, limiter: new RateLimiter(cfg.rate) } as never)
  const reg = (id: string) => registerAgent(db, cfg, { agent_id: id, registration_code: 'x' }).token
  return { app, reg, send: (from: string, to: string, text: string) => sendMessage(db, bus, from, { to, type: 'text', body: { text }, client_msg_id: `cmid-${Math.random()}` }).message }
}
const send = async (app: any, tok: string, to: string, text: string) => {
  const r = await app.inject({ method: 'POST', url: '/v1/messages', headers: { authorization: `Bearer ${tok}` }, payload: { to, type: 'text', body: { text }, client_msg_id: `cmid-${Math.random()}` } })
  expect(r.statusCode).toBe(200)
}

describe('GET /v1/messages/search', () => {
  it('按关键词命中正文，返回双方消息并含 peer 可读字段；不命中返回空数组', async () => {
    const { app, reg, send } = mk()
    const ta = reg('alice.search'), tb = reg('bob.search')
    send('alice.search', 'bob.search', 'U盘启动黑屏的排查结论')
    send('bob.search', 'alice.search', '收到，U盘结论认可')
    send('alice.search', 'bob.search', '另外一件事：市场挂牌续期')
    const hit = await app.inject({ method: 'GET', url: '/v1/messages/search?q=U盘', headers: { authorization: `Bearer ${ta}` } })
    expect(hit.statusCode).toBe(200)
    const arr = hit.json()
    expect(arr.length).toBe(2) // 双向两条都命中
    expect(arr.every((m: any) => (m.from === 'alice.search' || m.to === 'alice.search'))).toBe(true) // 只含本人会话
    const miss = await app.inject({ method: 'GET', url: '/v1/messages/search?q=不存在词', headers: { authorization: `Bearer ${ta}` } })
    expect(miss.json()).toEqual([])
  })

  it('只搜本人参与的会话：他人的对话不可见', async () => {
    const { app, reg, send } = mk()
    const ta = reg('carol.search'), tx = reg('x.search'), ty = reg('y.search')
    send('x.search', 'y.search', '绝密关键词北极狐')
    const r = await app.inject({ method: 'GET', url: '/v1/messages/search?q=北极狐', headers: { authorization: `Bearer ${ta}` } })
    expect(r.json()).toEqual([]) // carol 不在会话里,搜不到
    const r2 = await app.inject({ method: 'GET', url: '/v1/messages/search?q=北极狐', headers: { authorization: `Bearer ${tx}` } })
    expect(r2.json().length).toBe(1)
  })

  it('LIKE 特殊字符按字面匹配（% _ 转义），大小写不敏感，倒序+limit 生效', async () => {
    const { app, reg, send } = mk()
    const ta = reg('dave.search'), tb = reg('erin.search')
    send('dave.search', 'erin.search', '进度 100% 完成')
    send('erin.search', 'dave.search', 'task_id 是 msg_abc')
    send('dave.search', 'erin.search', '早期的一条 SQUASHFS 信息')
    send('dave.search', 'erin.search', '较新的 SQUASHFS 讨论')
    const pct = await app.inject({ method: 'GET', url: '/v1/messages/search?q=100%25', headers: { authorization: `Bearer ${ta}` } }) // URL 编码的 %
    expect(pct.json().length).toBe(1)
    const us = await app.inject({ method: 'GET', url: '/v1/messages/search?q=msg_abc', headers: { authorization: `Bearer ${tb}` } })
    expect(us.json().length).toBe(1) // 下划线不当通配符
    const ci = await app.inject({ method: 'GET', url: '/v1/messages/search?q=squashfs', headers: { authorization: `Bearer ${ta}` } })
    const ciArr = ci.json()
    expect(ciArr.length).toBe(2)
    expect(ciArr[0].body.text).toContain('较新') // 倒序:最新在前
    const lim = await app.inject({ method: 'GET', url: '/v1/messages/search?q=SQUASHFS&limit=1', headers: { authorization: `Bearer ${ta}` } })
    expect(lim.json().length).toBe(1)
  })
})
