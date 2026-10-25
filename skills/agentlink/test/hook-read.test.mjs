// skills/agentlink/test/hook-read.test.mjs — spool 链路补 read + im ack 空 acked 文案（设计 v3 §3）
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createServer as httpServer } from 'node:http'
import { execFile } from 'node:child_process'

const cfg = mkdtempSync(join(tmpdir(), 'hr-cfg-'))
const state = mkdtempSync(join(tmpdir(), 'hr-state-'))
process.env.AGENTLINK_CONFIG = cfg; process.env.AGENTLINK_STATE = state
mkdirSync(join(cfg, 'agents.d'), { recursive: true })
writeFileSync(join(cfg, 'agents.d', 'w.env'), 'AGENTLINK_NAME=w\nAGENTLINK_DIR=/work\nAGENTLINK_SERVER=https://s\nAGENTLINK_TOKEN=t\n')
const { writeMessage, claim } = await import('../lib/spool.mjs')
const { agentIdFor } = await import('../lib/identity.mjs')
const { claimIds: claimInject } = await import('../hook-inject.mjs')
const { claimIds: claimStop } = await import('../hook-stop.mjs')

const idW = agentIdFor('w', 'testhost', '/work')

test('hook-inject claimIds：claim 成功的 id 逐个异步 POST /v1/messages/:id/read（带 5s 超时信号）；claim 失败不发', async () => {
  writeMessage(idW, { id: 'r1', from: 'p', thread_id: 't', type: 'text', body: { text: 'x' }, created_at: 1 })
  writeMessage(idW, { id: 'r2', from: 'p', thread_id: 't', type: 'text', body: { text: 'x' }, created_at: 2 })
  claim(idW, '_default', 'r2') // r2 已被并发方认领 → hook 侧 claim 落空
  const reads = []
  const fetchImpl = async (url, opts) => { reads.push({ url, opts }); return { ok: true } }
  await claimInject(idW, [['_default', 'r1'], ['_default', 'r2']], { server: 'https://s', token: 't', fetchImpl })
  assert.equal(reads.length, 1) // 只有 claim 成功的 r1
  assert.equal(reads[0].url, 'https://s/v1/messages/r1/read')
  assert.equal(reads[0].opts.method, 'POST')
  assert.equal(reads[0].opts.headers.authorization, 'Bearer t')
  assert.ok(reads[0].opts.signal?.aborted === false, 'AbortSignal.timeout 信号应传入')
})

test('hook-stop claimIds：同样补 read（items={topic,id} 形状）；read 失败静默不抛', async () => {
  writeMessage(idW, { id: 's1', from: 'p', thread_id: 't', type: 'text', body: { text: 'x' }, created_at: 3 })
  const reads = []
  await claimStop(idW, [{ topic: '_default', id: 's1' }], { server: 'https://s', token: 't', fetchImpl: async () => { throw new Error('net down') } })
  assert.ok(true) // 失败静默：上面没抛即通过
})

test('claimIds：无 server/token（旧调用方式）→ 只本地 claim，不发 read', async () => {
  writeMessage(idW, { id: 'n1', from: 'p', thread_id: 't', type: 'text', body: { text: 'x' }, created_at: 4 })
  await claimInject(idW, [['_default', 'n1']], { fetchImpl: async () => { throw new Error('should not fetch') } })
})

test('im ack：服务端返回 {acked:[]} → 输出「已在早前投递时确认」（幂等重复 ack，daemon 双通道产物）', async () => {
  const http = httpServer((req, res) => {
    if (req.url === '/v1/messages/ack') { let b = ''; req.on('data', c => b += c); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ acked: [] })) }) }
    else { res.statusCode = 404; res.end('{}') }
  })
  const port = await new Promise(r => http.listen(0, () => r(http.address().port)))
  writeFileSync(join(cfg, 'agents.d', 'w.env'), `AGENTLINK_NAME=w\nAGENTLINK_DIR=/work\nAGENTLINK_SERVER=http://127.0.0.1:${port}\nAGENTLINK_TOKEN=t\n`)
  // 密闭性：子进程用 AGENTLINK_SERVER/TOKEN 直连本测试服务器——不能依赖宿主 ~/.agentlink
  // 或 agents.d 的 cwd 匹配（本测试 cwd 不在 AGENTLINK_DIR=/work 下，CI 无配置即 die）。
  // try/finally：断言失败也要 close，否则监听中的 http server 挂住事件循环（CI 曾挂 6h）
  try {
    const stdout = await new Promise((ok, err) => execFile(process.execPath, [join(import.meta.dirname, '..', 'im.mjs'), 'ack', 'zz1'], {
      env: { ...process.env, AGENTLINK_CONFIG: cfg, AGENTLINK_STATE: state, AGENTLINK_SERVER: `http://127.0.0.1:${port}`, AGENTLINK_TOKEN: 't' },
    }, (e, so, se) => e ? err(e) : ok(so + se)))
    assert.ok(stdout.includes('已在早前投递时确认'), stdout)
  } finally {
    http.close()
  }
})
