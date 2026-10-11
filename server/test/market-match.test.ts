// 市场代理匹配（spec 2026-10-11-market-agent-broker §2）：tags 交集查询——core 单测 + 路由
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { findMatches, parseMatchTags } from '../src/core/market.js'

let base: Awaited<ReturnType<typeof startWsServer>>
beforeEach(async () => {
  base = await startWsServer({ ADMIN_TOKEN: 'adm', RATE_LIMIT_REGISTER_PER_HOUR: '1000', RATE_LIMIT_MARKET_PUBLISH_PER_DAY: '100', RATE_LIMIT_MARKET_BID_PER_DAY: '100' })
})
afterEach(async () => { await base.close() })
const H = (t: string) => ({ authorization: `Bearer ${t}` })
let seq = 0
// 直接走 app.inject POST 造数据（保持真实路径），core 查询用 base.db 直测
async function fixture(publisherToken: string, kind: 'demand' | 'service', title: string, tags: string[], points: number) {
  const r = await base.app.inject({ method: 'POST', url: '/v1/market/listings', headers: H(publisherToken),
    payload: { kind, title, body: 'x', tags, ...(kind === 'demand' ? { budget: points } : { price: points }) } })
  return r.json()
}

describe('parseMatchTags', () => {
  it('trim/小写/去重归一', () => {
    expect(parseMatchTags(' SEO, seo , Writing ')).toEqual(['seo', 'writing'])
  })
  it('缺失/空串/全空白 → 抛 invalidRequest', () => {
    expect(() => parseMatchTags(undefined)).toThrow()
    expect(() => parseMatchTags('')).toThrow()
    expect(() => parseMatchTags(' , ')).toThrow()
  })
  it('非法字符（空格/中文/首字符非法）与超 8 项 → 抛', () => {
    expect(() => parseMatchTags('seo audit')).toThrow()   // 空格
    expect(() => parseMatchTags('审计')).toThrow()        // 中文
    expect(() => parseMatchTags('-seo')).toThrow()        // 首字符非法
    expect(() => parseMatchTags('a,b,c,d,e,f,g,h,i')).toThrow() // 9 项
  })
})

describe('findMatches（core 查询）', () => {
  it('交集命中、排序 |交集|desc→budget desc→created_at desc；matched_tags 为小写交集；剔除 body', async () => {
    const A = await base.mk(`ma-${seq++}`), B = await base.mk(`mb-${seq++}`)
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(B.token) })
    await fixture(B.token, 'demand', '单交集低预算', ['seo'], 100)
    await fixture(B.token, 'demand', '双交集', ['seo', 'writing'], 50)
    await fixture(B.token, 'demand', '单交集高预算', ['writing'], 200)
    await fixture(B.token, 'service', '服务不该命中', ['seo'], 30)   // 非 demand
    const { matches } = findMatches(base.db, A.agent.id, ['seo', 'writing'])
    expect(matches.map((m: any) => m.title)).toEqual(['双交集', '单交集高预算', '单交集低预算'])
    expect(matches[0].matched_tags).toEqual(['seo', 'writing'])   // 小写交集
    expect(matches.every((m: any) => !('body' in m))).toBe(true)  // 响应剔 body
  })
  it('自己的 demand 不出现在自己的 matches', async () => {
    const A = await base.mk(`mc-${seq++}`)
    await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(A.token) })
    await fixture(A.token, 'demand', '自己发的', ['seo'], 10)
    expect(findMatches(base.db, A.agent.id, ['seo']).matches).toHaveLength(0)
  })
  it('limit clamp：999→50、0→1（55 条在库）', async () => {
    const A = await base.mk(`mf-${seq++}`), B = await base.mk(`mg-${seq++}`)
    for (const t of [A.token, B.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
    for (let i = 0; i < 55; i++) await fixture(B.token, 'demand', `d${i}`, ['seo'], 1) // 每条 burn 1 + escrow 1，B 额度足够
    expect(findMatches(base.db, A.agent.id, ['seo'], 999).matches).toHaveLength(50)
    expect(findMatches(base.db, A.agent.id, ['seo'], 0).matches).toHaveLength(1)
  })
  it('非 open / 已过期的行排除', async () => {
    const A = await base.mk(`md-${seq++}`), B = await base.mk(`me-${seq++}`)
    for (const t of [A.token, B.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
    const l = await fixture(B.token, 'demand', '会被取消', ['seo'], 10)
    // 直接 UPDATE 模拟 scanner 扫描间隙的过期行 + canceled 行（core 只读 status/expires_at）
    base.db.prepare('UPDATE listings SET status=? WHERE id=?').run('canceled', l.id)
    const e = await fixture(B.token, 'demand', '已过期未清扫', ['seo'], 10)
    base.db.prepare('UPDATE listings SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', e.id)
    expect(findMatches(base.db, A.agent.id, ['seo']).matches).toHaveLength(0)
  })
})

describe('GET /v1/market/matches（路由）', () => {
  it('鉴权缺失 → 401；tags 缺失 → 400；limit 非数字 → 400', async () => {
    expect((await base.app.inject({ method: 'GET', url: '/v1/market/matches?tags=seo' })).statusCode).toBe(401)
    const A = await base.mk(`mr-${seq++}`)
    expect((await base.app.inject({ method: 'GET', url: '/v1/market/matches', headers: H(A.token) })).statusCode).toBe(400)
    expect((await base.app.inject({ method: 'GET', url: '/v1/market/matches?tags=seo&limit=abc', headers: H(A.token) })).statusCode).toBe(400)
  })
  it('归一后命中：大写/空白查询串命中小写挂牌 tags；limit clamp 0→1', async () => {
    const A = await base.mk(`ms-${seq++}`), B = await base.mk(`mt-${seq++}`)
    for (const t of [A.token, B.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
    await fixture(B.token, 'demand', '归一命中', ['seo'], 10)
    await fixture(B.token, 'demand', '归一命中2', ['seo'], 20)
    const r1 = await base.app.inject({ method: 'GET', url: '/v1/market/matches?tags=%20SEO%2C%20seo', headers: H(A.token) }) // " SEO, seo"
    expect(r1.statusCode).toBe(200)
    expect(r1.json().matches).toHaveLength(2)
    expect((await base.app.inject({ method: 'GET', url: '/v1/market/matches?tags=seo&limit=0', headers: H(A.token) })).json().matches).toHaveLength(1)
  })
  it('响应 JSON 不含 body 键', async () => {
    const A = await base.mk(`mu-${seq++}`)
    const r = await base.app.inject({ method: 'GET', url: '/v1/market/matches?tags=seo', headers: H(A.token) })
    expect(/"body"/.test(r.body)).toBe(false)
  })
})
