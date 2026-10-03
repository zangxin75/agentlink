// im market / im credits 纯函数部分:不连网,直接测 lib/market-cli.mjs 的 buildMarketRequest
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'market-cli-'))
test.after(() => rmSync(dir, { recursive: true, force: true }))
const F = (name, text) => { const p = join(dir, name); writeFileSync(p, text); return p }

test('market list: --kind/--tag/-q 拼查询串', async () => {
  const { buildMarketRequest } = await import('../lib/market-cli.mjs')
  const r = buildMarketRequest('market', 'list', [], { kind: 'demand', tag: 'web', q: '爬虫', status: 'open' })
  assert.equal(r.method, 'GET')
  assert.equal(r.path, '/market/listings?kind=demand&tag=web&q=' + encodeURIComponent('爬虫') + '&status=open')
})

test('market publish demand: --budget --body-file --tag 拼成 POST body', async () => {
  const { buildMarketRequest } = await import('../lib/market-cli.mjs')
  const f = F('rfp.md', '需求正文')
  const r = buildMarketRequest('market', 'publish', ['demand', '写个爬虫'], { budget: '500', 'body-file': f, tag: 'a,b' })
  assert.deepEqual(r, { method: 'POST', path: '/market/listings', body: { kind: 'demand', title: '写个爬虫', body: '需求正文', tags: ['a', 'b'], budget: 500, days: undefined, price: undefined } })
})

test('market bid: --points --body-file → POST /listings/:id/bids', async () => {
  const { buildMarketRequest } = await import('../lib/market-cli.mjs')
  const f = F('proposal.md', '方案')
  const r = buildMarketRequest('market', 'bid', ['l1'], { points: '400', 'body-file': f })
  assert.deepEqual(r, { method: 'POST', path: '/market/listings/l1/bids', body: { points: 400, body: '方案' } })
})

test('credits send: --note → POST /credits/transfer', async () => {
  const { buildMarketRequest } = await import('../lib/market-cli.mjs')
  const r = buildMarketRequest('credits', 'send', ['bob', '100'], { note: 'hi' })
  assert.deepEqual(r, { method: 'POST', path: '/credits/transfer', body: { to: 'bob', points: 100, note: 'hi' } })
  assert.deepEqual(buildMarketRequest('credits', undefined, [], {}), { method: 'GET', path: '/credits/account', body: undefined })
})

test('--body-file 缺文件:抛错且信息含路径', async () => {
  const { buildMarketRequest } = await import('../lib/market-cli.mjs')
  assert.throws(() => buildMarketRequest('market', 'publish', ['demand', 't'], { 'body-file': join(dir, 'nope.md') }), /nope\.md/)
})

test('accept/select/buy/deliver: 端点与 method 正确', async () => {
  const { buildMarketRequest } = await import('../lib/market-cli.mjs')
  assert.equal(buildMarketRequest('market', 'accept', ['b1']).path, '/market/bids/b1/accept')
  assert.equal(buildMarketRequest('market', 'accept', ['b1']).method, 'POST')
  assert.deepEqual(buildMarketRequest('market', 'select', ['l1', 'b1']), { method: 'POST', path: '/market/listings/l1/select/b1', body: undefined })
  assert.deepEqual(buildMarketRequest('market', 'buy', ['l1']), { method: 'POST', path: '/market/listings/l1/buy', body: undefined })
  // buy --counter:买家先出一轮议价记录(服务端由卖家 accept 按新价成交)
  assert.equal(buildMarketRequest('market', 'buy', ['l1'], { counter: '40' }).path, '/market/listings/l1/bids')
  assert.deepEqual(buildMarketRequest('market', 'deliver', ['d1'], { note: 'done' }), { method: 'POST', path: '/market/deals/d1/deliver', body: { note: 'done' } })
})
