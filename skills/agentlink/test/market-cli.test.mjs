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

test('buildSuggestDraft：标题=display_name+capabilities；正文 heredoc <<\'EOF\'；建议价 20；零网络写', async () => {
  const { buildSuggestDraft } = await import('../lib/market-cli.mjs')
  const agent = { id: 'writer-x1', display_name: '写手', description: '能写 `文案`，报价 $50/篇，含"引号"', capabilities: ['Copywriting', 'SEO 审计'] }
  const d = buildSuggestDraft(agent)
  assert.match(d.title, /^写手：Copywriting \/ SEO 审计/)
  assert.equal(d.price, 20)
  assert.deepEqual(d.tags, ['copywriting', 'seo-']) // 'SEO 审计' → CJK 折叠为 '-'，尾随 '-' 合法保留
  assert.match(d.command, /<<'EOF'/)                     // 带引号定界符：$ 与反引号原样
  assert.match(d.command, /im market publish service "/)
  assert.match(d.command, /--body-file \/tmp\/al-service-writer-x1\.md/)
  assert.ok(d.command.includes('报价 $50/篇，含"引号"'))  // 原文未被 shell 改写
  assert.ok(d.command.includes('`文案`'))
})

test('buildSuggestDraft：tags 走 capabilityTags 归一（大写→小写）；无 capabilities 兜底 service', async () => {
  const { buildSuggestDraft } = await import('../lib/market-cli.mjs')
  const d = buildSuggestDraft({ id: 'a-b', display_name: 'A', description: '', capabilities: ['SEO', 'Writing'] })
  assert.deepEqual(d.tags, ['seo', 'writing'])
  const none = buildSuggestDraft({ id: 'c-d', display_name: 'C', description: '', capabilities: [] })
  assert.deepEqual(none.tags, ['service'])
  const long = buildSuggestDraft({ id: 'e-f', display_name: '超'.repeat(300), description: '', capabilities: [] })
  assert.ok(Buffer.byteLength(long.title) <= 200) // 按字节截断：长 CJK display_name 生成的命令可直接执行不 400
})

test('buildSuggestDraft：标题双引号上下文全量转义——$()/反引号/反斜杠不可执行（终审 C-1）', async () => {
  const { buildSuggestDraft } = await import('../lib/market-cli.mjs')
  const d = buildSuggestDraft({ id: 'pwn-x', display_name: 'SEO$(touch /tmp/PWNED)x', description: '', capabilities: ['`id`'] })
  assert.ok(!d.command.includes('"SEO$(touch'))
  assert.match(d.command, /\\\$\(touch/)   // $( 被转义
  assert.match(d.command, /\\`id\\`/)      // 反引号被转义
  const d2 = buildSuggestDraft({ id: 'pwn-y', display_name: 'a\\b"c', description: '', capabilities: [] })
  assert.match(d2.command, /a\\\\b\\"c/)   // 反斜杠与双引号被转义
})

test('market del/renew：DELETE 挂牌与 POST 续期端点（agent 自主下架/续挂）', async () => {
  const { buildMarketRequest } = await import('../lib/market-cli.mjs')
  assert.deepEqual(buildMarketRequest('market', 'del', ['l1']), { method: 'DELETE', path: '/market/listings/l1', body: undefined })
  assert.deepEqual(buildMarketRequest('market', 'renew', ['l1']), { method: 'POST', path: '/market/listings/l1/renew', body: { days: undefined } })
  assert.deepEqual(buildMarketRequest('market', 'renew', ['l1'], { days: '14' }), { method: 'POST', path: '/market/listings/l1/renew', body: { days: 14 } })
})
