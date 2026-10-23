// server/test/identity-routes.test.ts — /v1/identity claim|bind|rotate 路由（TDD RED 先行）
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { buildApp } from '../src/http/app.js'
import { loadConfig } from '../src/config.js'
import { startWsServer } from './helpers/ws-server.js'
import type { Db } from '../src/db/sqlite.js'

let db: Db
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db) })
const cfg = () => loadConfig({ REGISTRATION_CODE: 'x' } as never)
const app = () => buildApp({ db, cfg: cfg() } as never)

const reg = (a: ReturnType<typeof app>, agent_id: string, extra: Record<string, unknown> = {}) =>
  a.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id, registration_code: 'x', ...extra } })
const claim = (a: ReturnType<typeof app>, payload: Record<string, unknown>) =>
  a.inject({ method: 'POST', url: '/v1/identity/claim', payload })

describe('限流 IP 取值（反代透传）', () => {
  it('X-Forwarded-For 末段参与分桶：不同来源 IP 各自 10/h，不塌缩为代理 IP 全局桶', async () => {
    const a = app()
    await reg(a, 'alice.dev', { identity_key: 'al_ident_KEY_AAA' })
    const xclaim = (ip: string) =>
      a.inject({ method: 'POST', url: '/v1/identity/claim', payload: { identity_key: 'al_ident_KEY_AAA' }, headers: { 'x-forwarded-for': `fake-first, ${ip}` } })
    // 用户 A 打满自己的桶（10 次）
    for (let i = 0; i < 10; i++) await xclaim('203.0.113.10')
    expect((await xclaim('203.0.113.10')).statusCode).toBe(429)
    // 用户 B（不同来源 IP）不受影响；伪造首段也不影响分桶（末段才是可信代理追加的真实来源）
    expect((await xclaim('198.51.100.20')).statusCode).toBe(200)
    // reg 桶同样吃 XFF：不同来源 IP 各自可注册
    const xreg = (ip: string, id: string) =>
      a.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: id, registration_code: 'x' }, headers: { 'x-forwarded-for': ip } })
    for (let i = 0; i < 10; i++) await xreg('203.0.113.30', `a${i}.dev`)
    expect((await xreg('203.0.113.30', 'full.dev')).statusCode).toBe(429)
    expect((await xreg('198.51.100.40', 'b.dev')).statusCode).toBe(201)
  })
})

describe('POST /v1/identity/claim', () => {
  it('claim by key 200：agent/token/recovery_code，免注册码；坏 key 401；同 IP 第 11 次 429', async () => {
    const a = app()
    const r0 = await reg(a, 'alice.dev', { identity_key: 'al_ident_KEY_AAA' })
    expect(r0.statusCode).toBe(201)
    expect(r0.json().recovery_code).toMatch(/^al_rec_/)
    // 免注册码：不带 registration_code 直接 claim
    const res = await claim(a, { identity_key: 'al_ident_KEY_AAA' })
    expect(res.statusCode).toBe(200)
    const j = res.json()
    expect(j.agent.id).toBe('alice.dev')
    expect(j.token).toMatch(/^al_[A-Za-z0-9_-]{43}$/)
    expect(j.recovery_code).toMatch(/^al_rec_/)
    // 坏 key 401（INVALID_CREDENTIALS 统一口径）
    const bad = await claim(a, { identity_key: 'al_ident_WRONG' })
    expect(bad.statusCode).toBe(401)
    // 独立限流 claim:${ip} 10/h：上面已用 2 次，再 8 次打满 → 第 11 次 429
    for (let i = 0; i < 8; i++) await claim(a, { identity_key: 'al_ident_KEY_AAA' })
    const last = await claim(a, { identity_key: 'al_ident_KEY_AAA' })
    expect(last.statusCode).toBe(429)
  })

  it('claim 失败也落 audit identity.claim_failed（含 IP）', async () => {
    const a = app()
    await reg(a, 'alice.dev', { identity_key: 'al_ident_KEY_AAA' })
    await claim(a, { identity_key: 'al_ident_WRONG' })
    const rows = db.prepare(`SELECT * FROM audit_log WHERE event='identity.claim_failed'`).all() as any[]
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].detail).ip).toBeTruthy()
  })

  it('register 带 key 冲突 → 409，body 含 agents 数组与 hint', async () => {
    const a = app()
    await reg(a, 'alice.dev', { identity_key: 'al_ident_KEY_AAA' })
    const res = await reg(a, 'alice.two', { identity_key: 'al_ident_KEY_AAA' })
    expect(res.statusCode).toBe(409)
    const j = res.json()
    expect(j.error.agents).toContain('alice.dev')
    expect(j.error.hint).toBeTruthy()
  })

  it('claim 不消耗 reg 桶：打满 reg:${ip} 后 claim 仍 200', async () => {
    const a = app()
    await reg(a, 'alice.dev', { identity_key: 'al_ident_KEY_AAA' })
    // reg 桶容量 10/h：同 app 实例（同 limiter）再 10 次注册打满 → 第 11 次 429
    for (let i = 0; i < 10; i++) await reg(a, `fill${i}.dev`)
    const full = await reg(a, 'overflow.dev')
    expect(full.statusCode).toBe(429)
    const res = await claim(a, { identity_key: 'al_ident_KEY_AAA' })
    expect(res.statusCode).toBe(200)
  })
})

describe('POST /v1/identity/bind', () => {
  it('bearer + 新 key 201；IDENTITY_TAKEN 409；重复绑 409；bind 后 claim by key 成功', async () => {
    const a = app()
    const r = await reg(a, 'alice.dev')
    const t = r.json().token
    const bind = await a.inject({ method: 'POST', url: '/v1/identity/bind', headers: { authorization: `Bearer ${t}` }, payload: { identity_key: 'al_ident_KEY_BBB' } })
    expect(bind.statusCode).toBe(201)
    expect(bind.json().recovery_code).toMatch(/^al_rec_/)
    // key 已属 alice → 第二个 agent 绑同 key → 409 IDENTITY_TAKEN
    const r2 = await reg(a, 'bob.ops')
    const t2 = r2.json().token
    const taken = await a.inject({ method: 'POST', url: '/v1/identity/bind', headers: { authorization: `Bearer ${t2}` }, payload: { identity_key: 'al_ident_KEY_BBB' } })
    expect(taken.statusCode).toBe(409)
    expect(taken.json().error.message).toMatch(/IDENTITY_TAKEN|已被/)
    // alice 已绑 → 换 key 再绑 → 409 IDENTITY_EXISTS
    const dup = await a.inject({ method: 'POST', url: '/v1/identity/bind', headers: { authorization: `Bearer ${t}` }, payload: { identity_key: 'al_ident_KEY_CCC' } })
    expect(dup.statusCode).toBe(409)
    // bind 后可用该 key claim 回账号
    const res = await claim(a, { identity_key: 'al_ident_KEY_BBB' })
    expect(res.statusCode).toBe(200)
    expect(res.json().agent.id).toBe('alice.dev')
  })

  it('bind 也吃 claim:${ip} 独立桶：同 IP 第 11 次 → 429', async () => {
    const a = app()
    const r = await reg(a, 'alice.dev')
    const t = r.json().token
    const bind = (key: string) => a.inject({ method: 'POST', url: '/v1/identity/bind', headers: { authorization: `Bearer ${t}` }, payload: { identity_key: key } })
    // 前 10 次无论成败（首次 201，其余 409 EXISTS）都消耗 claim:${ip} → 第 11 次 429
    for (let i = 0; i < 10; i++) await bind(`al_ident_K${i}`)
    const last = await bind('al_ident_K99')
    expect(last.statusCode).toBe(429)
  })
})

describe('claim by recovery_code', () => {
  it('200 且滚动新码；旧码复用 401', async () => {
    const a = app()
    const r0 = await reg(a, 'alice.dev', { identity_key: 'al_ident_KEY_AAA' })
    const rc = r0.json().recovery_code
    const res = await claim(a, { recovery_code: rc })
    expect(res.statusCode).toBe(200)
    expect(res.json().agent.id).toBe('alice.dev')
    expect(res.json().recovery_code).toMatch(/^al_rec_/)
    // 旧 recovery 已被消费滚动 → 复用 401
    const again = await claim(a, { recovery_code: rc })
    expect(again.statusCode).toBe(401)
  })
})

describe('claim 踢 WS（真 hub）', () => {
  let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
  afterEach(async () => { await srv?.close(); srv = null })

  it('claim 后旧连接 close(4003)，新 token 可重连', async () => {
    srv = await startWsServer()
    // 经 HTTP 注册带 key（REGISTRATION_CODE='x'）
    const regRes = await srv.app.inject({ method: 'POST', url: '/v1/agents', payload: { agent_id: 'alice.dev', registration_code: 'x', identity_key: 'al_ident_KEY_AAA' } })
    expect(regRes.statusCode).toBe(201)
    const token = regRes.json().token
    // 旧 token 连 WS
    const ws = new WebSocket(srv.url)
    await new Promise((res, rej) => { ws.on('open', () => { ws.send(JSON.stringify({ op: 'auth', token })); res(null) }); ws.on('error', rej) })
    await new Promise(res => { const h = (raw: any) => { if (JSON.parse(String(raw)).op === 'auth_ok') { ws.off('message', h); res(null) } }; ws.on('message', h) })
    // 用 key claim → 撤全部旧 token → hub.closeToken → 旧连接断
    const c = await srv.app.inject({ method: 'POST', url: '/v1/identity/claim', payload: { identity_key: 'al_ident_KEY_AAA' } })
    expect(c.statusCode).toBe(200)
    const closed = new Promise<number>(res => ws.on('close', (code: number) => res(code)))
    expect(await closed).toBe(4003)
    // 新 token 可重连
    const ws2 = new WebSocket(srv.url)
    await new Promise((res, rej) => { ws2.on('open', () => { ws2.send(JSON.stringify({ op: 'auth', token: c.json().token })); res(null) }); ws2.on('error', rej) })
    await new Promise(res => { const h = (raw: any) => { if (JSON.parse(String(raw)).op === 'auth_ok') { ws2.off('message', h); res(null) } }; ws2.on('message', h) })
    ws2.close()
  })
})

describe('POST /v1/identity/rotate', () => {
  it('旧 key 作废、新 key 可 claim，rotate 后旧 key claim 401', async () => {
    const a = app()
    await reg(a, 'alice.dev', { identity_key: 'al_ident_OLD' })
    const rot = await a.inject({ method: 'POST', url: '/v1/identity/rotate', payload: { identity_key: 'al_ident_OLD', new_identity_key: 'al_ident_NEW' } })
    expect(rot.statusCode).toBe(200)
    expect(rot.json().token).toMatch(/^al_/)
    expect(rot.json().recovery_code).toMatch(/^al_rec_/)
    // 旧 key 作废
    const old = await claim(a, { identity_key: 'al_ident_OLD' })
    expect(old.statusCode).toBe(401)
    // 新 key 可 claim
    const fresh = await claim(a, { identity_key: 'al_ident_NEW' })
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json().agent.id).toBe('alice.dev')
  })
  it('无凭据（只带 new_identity_key）→ 401 统一口径，不 500', async () => {
    const a = app()
    await reg(a, 'alice.dev', { identity_key: 'al_ident_OLD' })
    const r = await a.inject({ method: 'POST', url: '/v1/identity/rotate', payload: { new_identity_key: 'al_ident_NEW' } })
    expect(r.statusCode).toBe(401)
    expect(r.json().error?.code ?? r.json().code).toBe('UNAUTHORIZED')
  })
})

describe('可信代理白名单（审计 2026-10-21 core MEDIUM/ops F3）', () => {
  it('非白名单直连自带伪造 XFF → 桶键用 remoteAddress：轮换 XFF 打满后仍 429', async () => {
    const a = app()
    await reg(a, 'alice.dev', { identity_key: 'al_ident_KEY_ZZZ' }) // 有效 key，别让 401 抢在限流前
    // 同一公网 remote，每请求换伪造 XFF —— 若采信 XFF 则每次新桶永不 429；修复后 10 次即打满
    const hit = (i: number) => a.inject({ method: 'POST', url: '/v1/identity/claim', payload: { identity_key: 'al_ident_KEY_ZZZ' }, remoteAddress: '198.51.100.7', headers: { 'x-forwarded-for': `203.0.113.${i}` } })
    let last = 0
    for (let i = 1; i <= 10; i++) last = (await hit(i)).statusCode
    expect(last).toBe(200)
    const eleventh = await hit(99)
    expect(eleventh.statusCode).toBe(429) // XFF 轮换救不了：桶键钉在 remoteAddress
  })
  it('可信代理来源（loopback）→ XFF 末段仍参与分桶（回归：不破坏反代语义）', async () => {
    const a = app()
    await reg(a, 'alice.dev', { identity_key: 'al_ident_KEY_QQQ' })
    const xclaim = (ip: string) => a.inject({ method: 'POST', url: '/v1/identity/claim', payload: { identity_key: 'al_ident_KEY_QQQ' }, headers: { 'x-forwarded-for': `spoofed-first, ${ip}` } })
    for (let i = 0; i < 10; i++) await xclaim('203.0.113.77')
    expect((await xclaim('203.0.113.77')).statusCode).toBe(429)
    expect((await xclaim('203.0.113.78')).statusCode).toBe(200) // 不同末段独立桶
  })
})
