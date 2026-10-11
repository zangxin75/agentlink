// 飞书群自定义机器人通知（市场代理 spec §3/§5）：加签、markdown 转义、失败定义与降级
import test from 'node:test'; import assert from 'node:assert/strict'

test('escapeFeishuMd：markdown 特殊字符转义（防挂牌标题格式注入）', async () => {
  const { escapeFeishuMd } = await import('../lib/feishu.mjs')
  assert.equal(escapeFeishuMd('**加粗** [链接](x) `代码` > 引用'), '\\*\\*加粗\\*\\* \\[链接\\]\\(x\\) \\`代码\\` \\> 引用')
  assert.equal(escapeFeishuMd('普通标题 30 点'), '普通标题 30 点') // 无特殊字符原样
})

test('feishuSign：固定 timestamp+secret 断言 HMAC-SHA256 base64 值（飞书规范）', async () => {
  const { feishuSign } = await import('../lib/feishu.mjs')
  // 参考实现独立复算（node:crypto），钉死 key=timestamp+"\n"+secret、message=''
  const { createHmac } = await import('node:crypto')
  const want = createHmac('sha256', '1700000000\nmysecret').update('').digest('base64')
  assert.equal(feishuSign('1700000000', 'mysecret'), want)
})

test('sendFeishu：加签查询串与卡片体；成功 ok=true', async () => {
  const { sendFeishu } = await import('../lib/feishu.mjs')
  const calls = []
  const fetchImpl = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) })
    return { ok: true, status: 200, json: async () => ({ code: 0 }) }
  }
  const r = await sendFeishu({ webhook: 'https://open.feishu.cn/hook/x', secret: 's', markdown: '- 每周 SEO 审计 · 30 点', fetchImpl, now: () => 1700000000000 })
  assert.equal(r.ok, true)
  assert.match(calls[0].url, /timestamp=1700000000&sign=/)
  assert.equal(calls[0].body.msg_type, 'interactive')
  assert.match(JSON.stringify(calls[0].body.card), /每周 SEO 审计/)
})

test('sendFeishu 失败定义：HTTP 非 200 或 body code!==0 任一即 ok=false，且不 throw', async () => {
  const { sendFeishu } = await import('../lib/feishu.mjs')
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) })
  const bizErr = async () => ({ ok: true, status: 200, json: async () => ({ code: 19021, msg: 'sign match fail' }) })
  assert.equal((await sendFeishu({ webhook: 'https://x', markdown: 'm', fetchImpl: http500 })).ok, false)
  assert.equal((await sendFeishu({ webhook: 'https://x', markdown: 'm', fetchImpl: bizErr })).ok, false)
})

test('sendFeishu 网络异常（fetch reject）→ ok=false 不 throw', async () => {
  const { sendFeishu } = await import('../lib/feishu.mjs')
  const r = await sendFeishu({ webhook: 'https://x', markdown: 'm', fetchImpl: async () => { throw new Error('ECONNRESET') } })
  assert.equal(r.ok, false)
})
