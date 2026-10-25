// 市场 WS 事件（task-7）：op:'market' 下行帧 {op,evt,ref} + BusEvent market 类型。
// 覆盖：deal_created/delivered/accepted/canceled、bid_new/bid_decided、
// RF5 老客户端兼容（未知 op → error 帧不断连）、waiters 不受 market 事件干扰。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import WebSocket from 'ws'
import { startWsServer } from './helpers/ws-server.js'

let base: Awaited<ReturnType<typeof startWsServer>>
beforeEach(async () => {
  base = await startWsServer({ RATE_LIMIT_REGISTER_PER_HOUR: '1000', RATE_LIMIT_MARKET_PUBLISH_PER_DAY: '100', RATE_LIMIT_MARKET_BID_PER_DAY: '100', RATE_LIMIT_MARKET_COUNTER_PER_DAY: '100' })
})
afterEach(async () => { await base.close() })
const H = (t: string) => ({ authorization: `Bearer ${t}` })

const open = (url: string, token: string) => new Promise<WebSocket>((resolve, reject) => {
  const ws = new WebSocket(url)
  ws.on('open', () => { ws.send(JSON.stringify({ op: 'auth', token })); resolve(ws) })
  ws.on('error', reject)
})
const next = (ws: WebSocket, pred: (f: any) => boolean, ms = 3000) => new Promise<any>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('frame timeout')), ms)
  const h = (raw: any) => { const f = JSON.parse(String(raw)); if (pred(f)) { clearTimeout(t); ws.off('message', h); resolve(f) } }
  ws.on('message', h)
})
const conn = async (token: string) => { const ws = await open(base.url, token); await next(ws, f => f.op === 'auth_ok'); return ws }
const isMarket = (evt: string) => (f: any) => f.op === 'market' && f.evt === evt

let seq = 0
async function serviceFixture(price = 100) {
  const s = `ev${seq++}`
  const A = await base.mk(`alice-${s}`)
  const B = await base.mk(`bob-${s}`)
  for (const t of [A.token, B.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
  const listing = (await base.app.inject({
    method: 'POST', url: '/v1/market/listings', headers: H(A.token),
    payload: { kind: 'service', title: '代码审查', body: '一次 review', price },
  })).json()
  return { A, B, listing, alice: `alice-${s}`, bob: `bob-${s}` }
}

describe('市场 WS 事件 op:market', () => {
  it('service 直购全链路：buy→双方 deal_created；deliver→买家 deal_delivered；accept→卖家 deal_accepted', async () => {
    const { A, B, listing } = await serviceFixture(100)
    const wsSeller = await conn(A.token), wsBuyer = await conn(B.token)
    // 先挂监听再触发（服务端同步推送，事后挂会丢帧）
    const pSeller = next(wsSeller, f => f.op === 'market' && f.evt === 'deal_created')
    const pBuyer = next(wsBuyer, f => f.op === 'market' && f.evt === 'deal_created')
    const deal = (await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/buy`, headers: H(B.token) })).json()
    expect((await pSeller).ref).toBe(deal.id)
    expect((await pBuyer).ref).toBe(deal.id) // brief：买家也收到

    const pDlv = next(wsBuyer, isMarket('deal_delivered'))
    await base.app.inject({ method: 'POST', url: `/v1/market/deals/${deal.id}/deliver`, headers: H(A.token), payload: { note: 'done' } })
    expect((await pDlv).ref).toBe(deal.id)

    const pAcc = next(wsSeller, isMarket('deal_accepted'))
    await base.app.inject({ method: 'POST', url: `/v1/market/deals/${deal.id}/accept`, headers: H(B.token) })
    expect((await pAcc).ref).toBe(deal.id)
    wsSeller.close(); wsBuyer.close()
  })

  it('demand：bid→挂牌人 bid_new；counter/决策→对方 bid_decided；select→bid 主 deal_created；cancel→对方 deal_canceled', async () => {
    const s = `ev${seq++}`
    const A = await base.mk(`alice-${s}`), B = await base.mk(`bob-${s}`)
    for (const t of [A.token, B.token]) await base.app.inject({ method: 'GET', url: '/v1/credits/account', headers: H(t) })
    const listing = (await base.app.inject({
      method: 'POST', url: '/v1/market/listings', headers: H(A.token),
      payload: { kind: 'demand', title: '写爬虫', body: 'x', budget: 500 },
    })).json()
    const wsA = await conn(A.token), wsB = await conn(B.token)

    const pNew = next(wsA, isMarket('bid_new'))
    const bid = (await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/bids`, headers: H(B.token), payload: { points: 450, body: '提案' } })).json()
    expect((await pNew).ref).toBe(bid.id)

    // 挂牌人 counter → bid 主收到 bid_decided
    const pDec = next(wsB, isMarket('bid_decided'))
    await base.app.inject({ method: 'POST', url: `/v1/market/bids/${bid.id}/counter`, headers: H(A.token), payload: { points: 480, body: '还价' } })
    expect((await pDec).ref).toBe(bid.id)

    // select → 中标方 deal_created（买家即挂牌人自身，也收帧）
    const pSel = next(wsB, f => f.op === 'market' && f.evt === 'deal_created')
    const pSelA = next(wsA, f => f.op === 'market' && f.evt === 'deal_created')
    const deal = (await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/select/${bid.id}`, headers: H(A.token) })).json()
    expect((await pSel).ref).toBe(deal.id)
    expect((await pSelA).ref).toBe(deal.id)

    // bob（卖家）cancel → 买家收到 deal_canceled
    const pCxl = next(wsA, isMarket('deal_canceled'))
    await base.app.inject({ method: 'POST', url: `/v1/market/deals/${deal.id}/cancel`, headers: H(B.token) })
    expect((await pCxl).ref).toBe(deal.id)
    wsA.close(); wsB.close()
  })

  it('RF5 老客户端兼容：未知 op → error 帧且连接保持', async () => {
    const { token } = await base.mk('old-cli.dev')
    const ws = await conn(token)
    ws.send(JSON.stringify({ op: 'market_subscribe' }))
    const err = await next(ws, f => f.op === 'error')
    expect(err.code).toBe('INVALID_REQUEST')
    // 连接未断：ping 仍能 pong
    ws.send(JSON.stringify({ op: 'ping' }))
    expect((await next(ws, f => f.op === 'pong')).op).toBe('pong')
    ws.close()
  })

  it('bus.waitFor：market 事件可唤醒 market 等待者，不干扰 new-message 等待者', async () => {
    const { A, B, listing, alice } = await serviceFixture(100)
    // 先挂 waitFor 再触发投标：bid_new 是纯 market 事件（无派生消息）
    const pMarket = base.bus.waitFor(alice, ['market'], 1000)
    const pMsg = base.bus.waitFor(alice, ['new-message'], 250)
    await base.app.inject({ method: 'POST', url: `/v1/market/listings/${listing.id}/bids`, headers: H(B.token), payload: { points: 90, body: '议价' } })
    expect(await pMarket).toBe(true) // market 等待者被唤醒
    expect(await pMsg).toBe(false) // new-message 等待者不受干扰（超时返回 false）
    void A
  })
})
