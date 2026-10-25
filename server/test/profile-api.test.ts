// 路由级：互斥 400（schema 层）、限频 429、投影、单查完整（spec §6）
import { describe, it, expect } from 'vitest'
import { buildApp } from '../src/http/app.js'
import { openDb } from '../src/db/sqlite.js'
import { migrate } from '../src/db/schema.js'
import { loadConfig } from '../src/config.js'
import { WsHub } from '../src/ws/hub.js'

async function app() {
  const db = openDb(':memory:'); migrate(db)
  const cfg = loadConfig({ REGISTRATION_CODE: 'x', DB_PATH: ':memory:' })
  const fastify = buildApp({ db, cfg, bus: { on: () => {}, emit: () => {} } } as never)
  await fastify.ready()
  const r = await fastify.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'alice.dev', registration_code: 'x' } })
  const token = r.json().token
  const bob = await (async () => { const rr = await fastify.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'bob.ops', registration_code: 'x' } }); return rr.json().token })()
  return { fastify, token, bob }
}
const GOOD = { headline: 'x', skills: [{ name: 'node', level: 4, evidence: 'e' }] }

describe('PATCH /v1/me profile', () => {
  it('profile 落库（经 GET /v1/me 验证）——schema 含 profile 的回归，防静默剥离复发', async () => {
    const { fastify, token } = await app()
    const r = await fastify.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${token}` }, payload: { profile: GOOD } })
    expect(r.statusCode).toBe(200)
    const me = await fastify.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } })
    expect(me.json().agent.profile.skills[0].name).toBe('node')
    expect(me.json().agent.capabilities).toEqual(['node'])
  })
  it('profile+capabilities 同给 → 400', async () => {
    const { fastify, token } = await app()
    const r = await fastify.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${token}` }, payload: { profile: GOOD, capabilities: ['x'] } })
    expect(r.statusCode).toBe(400)
  })
  it('第 6 次 publish（1 小时内）→ 429 RATE_LIMITED；前 5 次成功', async () => {
    const { fastify, token } = await app()
    for (let i = 0; i < 5; i++) {
      const r = await fastify.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${token}` }, payload: { profile: { ...GOOD, headline: `v${i}` } } })
      expect(r.statusCode).toBe(200)
    }
    const r6 = await fastify.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${token}` }, payload: { profile: GOOD } })
    expect(r6.statusCode).toBe(429)
    expect(r6.json().error.code).toBe('RATE_LIMITED')
  })
  it('另一个 agent 不受本 agent 限频影响', async () => {
    const { fastify, token, bob } = await app()
    for (let i = 0; i < 5; i++) await fastify.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${token}` }, payload: { profile: GOOD } })
    const r = await fastify.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${bob}` }, payload: { profile: GOOD } })
    expect(r.statusCode).toBe(200)
  })
})

describe('SlidingWindow（时钟注入直测，r1-m2）', () => {
  it('窗口滑出后恢复放行', async () => {
    const { SlidingWindow } = await import('../src/core/ratelimit.js')
    let t = 1_000_000
    const w = new SlidingWindow(2, 3600_000, () => t)
    expect(w.tryTake() && w.tryTake()).toBe(true)
    expect(w.tryTake()).toBe(false) // 窗口内第 3 次拒
    t += 3600_000 // 恰好一整窗：首两次命中滑出
    expect(w.tryTake()).toBe(true)
  })
  it('retryAfterMs 反映真实剩余窗口', async () => {
    const { SlidingWindow } = await import('../src/core/ratelimit.js')
    let t = 1_000_000
    const w = new SlidingWindow(2, 3600_000, () => t)
    w.tryTake(); w.tryTake(); expect(w.tryTake()).toBe(false)
    t += 600_000 // 10 分钟后：首命中还剩 50 分钟滑出
    expect(w.retryAfterMs()).toBe(3000_000)
  })
  it('checkProfile 429 的 Retry-After 与注入时钟推算一致（真实剩余秒，下限 1）', async () => {
    const db = openDb(':memory:'); migrate(db)
    const cfg = loadConfig({ REGISTRATION_CODE: 'x', DB_PATH: ':memory:', RATE_LIMIT_PROFILE_PER_HOUR: '1' })
    const fastify = buildApp({ db, cfg, bus: { on: () => {}, emit: () => {} } } as never)
    await fastify.ready()
    const r = await fastify.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'alice.dev', registration_code: 'x' } })
    const token = r.json().token
    const h = { authorization: `Bearer ${token}` }
    expect((await fastify.inject({ method: 'PATCH', url: '/v1/me', headers: h, payload: { profile: GOOD } })).statusCode).toBe(200)
    const r2 = await fastify.inject({ method: 'PATCH', url: '/v1/me', headers: h, payload: { profile: GOOD } })
    expect(r2.statusCode).toBe(429)
    expect(r2.json().error.code).toBe('RATE_LIMITED')
    const ra = Number(r2.headers['retry-after'])
    expect(ra).toBeGreaterThanOrEqual(3598) // 真实剩余 ≈ 3600 秒（毫秒级流逝），不再是恒定 60
    expect(ra).toBeLessThanOrEqual(3600)
  })
})

describe('目录投影与单查', () => {
  it('列表：profile 只含 headline/skills 名单/profile_updated_at，不含 projects/style；capability 逗号 AND 生效', async () => {
    const { fastify, token, bob } = await app()
    await fastify.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${token}` }, payload: { profile: { ...GOOD, projects: [{ name: 'imchat', summary: 's' }] } } })
    await fastify.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${bob}` }, payload: { profile: { ...GOOD, skills: [{ name: 'node', level: 3, evidence: 'e' }, { name: 'go', level: 3, evidence: 'e' }] } } })
    const list = await fastify.inject({ method: 'GET', url: '/v1/agents?capability=node,go', headers: { authorization: `Bearer ${token}` } })
    const items = list.json()
    expect(items).toHaveLength(1)
    expect(items[0].agent.id).toBe('bob.ops')
    expect(items[0].agent.profile).toEqual({ headline: 'x', skills: ['node', 'go'], profile_updated_at: expect.any(String) })
  })
  it('单查：返回完整 profile', async () => {
    const { fastify, token } = await app()
    await fastify.inject({ method: 'PATCH', url: '/v1/me', headers: { authorization: `Bearer ${token}` }, payload: { profile: { ...GOOD, projects: [{ name: 'imchat', summary: 's' }] } } })
    const one = await fastify.inject({ method: 'GET', url: '/v1/agents/alice.dev', headers: { authorization: `Bearer ${token}` } })
    expect(one.json().agent.profile.projects[0].name).toBe('imchat')
  })
})
