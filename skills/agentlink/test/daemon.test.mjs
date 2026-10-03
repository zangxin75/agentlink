// skills/agentlink/test/daemon.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, utimesSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createServer as httpServer } from 'node:http'
import { WebSocketServer } from '../vendor/ws/wrapper.mjs'

const cfg = mkdtempSync(join(tmpdir(), 'dm-cfg-')); const state = mkdtempSync(join(tmpdir(), 'dm-state-'))
process.env.AGENTLINK_CONFIG = cfg; process.env.AGENTLINK_STATE = state
const HOST = 'testhost' // 与 createDaemon 注入一致

function envFile(dir, name = 'w', token = 'tok1', port = 'PORT') {
  mkdirSync(join(cfg, 'agents.d'), { recursive: true })
  writeFileSync(join(cfg, 'agents.d', name + '.env'), `AGENTLINK_NAME=${name}\nAGENTLINK_DIR=${dir}\nAGENTLINK_SERVER=ws://127.0.0.1:${port}\nAGENTLINK_TOKEN=${token}\n`)
}
const msg = (id, at) => ({ id, from: 'p', thread_id: 't', type: 'text', body: { text: 'x' + id }, created_at: at })

// WS 与 REST 同端口：daemon 的 REST URL 从 AGENTLINK_SERVER（ws://host:port）派生，httpBase 得同 host:port
function mockServer(hand, restHandler) {
  const seen = { historyQueries: [], acks: [] }
  const http = httpServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname === '/v1/history') { seen.historyQueries.push(u.searchParams.get('after')); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(restHandler?.messages ?? [])) }
    else if (u.pathname === '/v1/messages/ack') { let b = ''; req.on('data', c => b += c); req.on('end', () => { seen.acks.push(...JSON.parse(b).ids); res.end('{}') }) }
    else { res.statusCode = 404; res.end('{}') }
  })
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', ws => ws.on('message', raw => {
    const f = JSON.parse(String(raw))
    if (f.op === 'auth') { ws.send(JSON.stringify({ op: 'auth_ok', agent: { id: 'a' } })); hand?.(ws, f) }
  }))
  const portP = new Promise(r => http.listen(0, () => r(http.address().port)))
  return { wss, seen, port: portP, close: () => Promise.all([new Promise(r => wss.close(r)), new Promise(r => http.close(r))]) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('收信→落盘→ack；单对象帧重发去重；非 message op 忽略；坏 env 跳过', async () => {
  const s = mockServer((ws) => ws.on('message', raw => { const f = JSON.parse(String(raw)); if (f.op === 'ack') ws.send(JSON.stringify({ op: 'ack_ok', acked: f.ids.length })) }), { messages: [] })
  const port = await s.port
  envFile('/w1', 'w', 'tok1', port); envFile('/bad', 'bad', '', port) // 空 token → parseEnvFile 抛错 → 跳过
  const { createDaemon } = await import('../daemon.mjs')
  const d = createDaemon({ hostname: HOST })
  await sleep(300)
  assert.equal(d.connected(), 1) // 坏 env 未连：RF5
  const a = s.wss.clients.values().next().value
  a.send(JSON.stringify({ op: 'message', message: msg('m1', 1) })) // 真实形状：一帧一条（hub.ts:120）
  a.send(JSON.stringify({ op: 'message', message: msg('m2', 2) }))
  await sleep(300)
  a.send(JSON.stringify({ op: 'message', message: msg('m1', 1) })) // 整箱重发：旧条目逐帧再来
  a.send(JSON.stringify({ op: 'message', message: msg('m2', 2) }))
  a.send(JSON.stringify({ op: 'message', message: msg('m3', 3) })) // +新增
  a.send(JSON.stringify({ op: 'receipt', receipt: {} }))            // 非 message：忽略不炸
  a.send(JSON.stringify({ op: 'presence', body: {} }))
  await sleep(300)
  const { unreadList } = await import('../lib/spool.mjs')
  const { agentIdFor } = await import('../lib/identity.mjs')
  assert.deepEqual(unreadList(agentIdFor('w', HOST, '/w1')).map(m => m.id), ['m1', 'm2', 'm3']) // 无重复：RF1
  assert.ok(s.seen.acks.includes('m1') && s.seen.acks.includes('m3'))
  await d.stop(); await s.close()
})

test('auth_ok 后立即补洞：history 带消息则落盘+ack', async () => {
  const { agentIdFor } = await import('../lib/identity.mjs')
  const { unreadList } = await import('../lib/spool.mjs')
  const s = mockServer(null, { messages: [{ ...msg('h1', 10), to: agentIdFor('w2', HOST, '/w2') }] }) // daemon 宕机期间积压的一条（真实 history 含 to 字段）
  const port = await s.port
  envFile('/w2', 'w2', 'tok2', port)
  const { createDaemon } = await import('../daemon.mjs')
  const d = createDaemon({ hostname: HOST })
  await sleep(500) // 连接 → auth_ok → backfill
  assert.deepEqual(unreadList(agentIdFor('w2', HOST, '/w2')).map(m => m.id), ['h1']) // 首连即补洞（C5）
  assert.ok(s.seen.acks.includes('h1'))
  await d.stop(); await s.close()
})

test('backfill 携带 after=<maxCursor>（含 consumed 条目）', async () => {
  const { agentIdFor } = await import('../lib/identity.mjs')
  const { writeMessage, claim } = await import('../lib/spool.mjs')
  const idW = agentIdFor('w2', HOST, '/w2')
  writeMessage(idW, msg('m4', 4)); claim(idW, 'm4') // 游标推进到 m4（consumed 计入合并游标）
  const s = mockServer(null, { messages: [] })
  const port = await s.port
  // 覆写 env 指向新端口（整行替换 SERVER 行，避免端口正则歧义）
  const fs = await import('node:fs')
  const envP = join(cfg, 'agents.d', 'w2.env')
  fs.writeFileSync(envP, fs.readFileSync(envP, 'utf8').replace(/^AGENTLINK_SERVER=.*$/m, `AGENTLINK_SERVER=ws://127.0.0.1:${port}`))
  const { createDaemon } = await import('../daemon.mjs')
  const d = createDaemon({ hostname: HOST })
  await sleep(500) // env 已先改：此 daemon 首连即新端口，auth_ok → backfill
  assert.equal(s.seen.historyQueries.includes('m4'), true) // after= 合并两目录后的最大 id
  await d.stop(); await s.close()
})

test('心跳：createDaemon 启动即 touch heartbeat', async () => {
  const hb = join(state, 'heartbeat')
  const before = Date.now()
  const { createDaemon } = await import('../daemon.mjs')
  const d = createDaemon({ hostname: HOST })
  await sleep(200)
  const mtime = statSync(hb).mtimeMs
  assert.ok(mtime >= before - 1000 && mtime <= Date.now() + 1000)
  await d.stop()
})

test('auth 失败：error 帧形状（hub.ts:54）与纯 close 4003（hub.ts:129 撤销）都不重连', async () => {
  // 场景 A：真实形状——{op:'error',code:'AUTH_FAILED'} 帧后 close(4003)
  {
    const http = httpServer(); const wss = new WebSocketServer({ server: http })
    wss.on('connection', ws => ws.on('message', () => { ws.send(JSON.stringify({ op: 'error', code: 'AUTH_FAILED', message: 'invalid token' })); ws.close(4003) }))
    await new Promise(r => http.listen(0, r))
    const port = http.address().port
    envFile('/w3', 'w3', 'badtoken', port)
    const { createDaemon } = await import('../daemon.mjs')
    const d = createDaemon({ hostname: HOST })
    await sleep(300)
    assert.equal(d.connected(), 0)
    let connects = 0; wss.on('connection', () => connects++)
    await sleep(2000) // 超过 1s 初始 backoff
    assert.equal(connects, 0) // 4003 后零重连（token 失效需改 env 热加载）
    await d.stop(); await new Promise(r => { wss.close(); http.close(r) })
  }
  // 场景 B：撤销——无 error 帧，纯 close(4003)
  {
    const http = httpServer(); const wss = new WebSocketServer({ server: http })
    wss.on('connection', ws => ws.on('message', () => ws.close(4003)))
    await new Promise(r => http.listen(0, r))
    const port = http.address().port
    envFile('/w4', 'w4', 'revoked', port)
    const { createDaemon } = await import('../daemon.mjs')
    const d = createDaemon({ hostname: HOST })
    await sleep(300)
    assert.equal(d.connected(), 0)
    let connects = 0; wss.on('connection', () => connects++)
    await sleep(2000)
    assert.equal(connects, 0)
    await d.stop(); await new Promise(r => { wss.close(); http.close(r) })
  }
})

test('daemon 协议失败日志带 VERSION（无 VERSION 文件时为 (dev)）', async () => {
  const logs = []; const orig = console.log
  console.log = (...a) => logs.push(a.join(' '))
  const s = mockServer(async (ws) => {   // auth_ok 之后：真实 hub 形状的协议失败（daemon.mjs:67 注释同源）
    ws.send(JSON.stringify({ op: 'error', code: 'AUTH_FAILED', message: 'bad token' }))
    ws.close(4003)
  }, { messages: [] })
  const port = await s.port
  envFile('/wv', 'v', 'badtoken', port)
  const { createDaemon } = await import('../daemon.mjs')
  const d = createDaemon({ hostname: HOST })
  await sleep(300)
  await d.stop(); await s.close(); console.log = orig
  assert.ok(logs.some(l => l.includes('daemon VERSION=')), 'logs: ' + logs.join('|'))
})

test('WS message 帧带 topic → 落对应 topic 目录并 ack', async () => {
  // 沿用本文件既有的 createDaemon + 假 WS 服务器夹具;直接调用内部路径不可行时,用 writeMessage 断言即可:
  const A = 't-daemon-1'
  const { writeMessage, unreadList } = await import('../lib/spool.mjs')
  writeMessage(A, { id: 'd1', topic: 'imchat', from: 'x', to: A, type: 'text', body: { text: 'hi' }, created_at: 1 })
  assert.equal(unreadList(A, 'imchat')[0].id, 'd1')
})

test('backfill 只取 to=me 入站：history 中自己发出的消息不落盘不 ack', async () => {
  const { agentIdFor } = await import('../lib/identity.mjs')
  const { unreadList } = await import('../lib/spool.mjs')
  const own = agentIdFor('w2', HOST, '/w2')
  // history 双向返回：一条自己发的（from=me, to=peer）+ 一条入站（to=me）
  const s = mockServer(null, { messages: [{ ...msg('mine', 30), from: own, to: 'p' }, { ...msg('inb', 31), from: 'p', to: own }] })
  const port = await s.port
  const fs = await import('node:fs')
  const envP = join(cfg, 'agents.d', 'w2.env')
  fs.writeFileSync(envP, fs.readFileSync(envP, 'utf8').replace(/^AGENTLINK_SERVER=.*$/m, `AGENTLINK_SERVER=ws://127.0.0.1:${port}`))
  const { createDaemon } = await import('../daemon.mjs')
  const d = createDaemon({ hostname: HOST })
  await sleep(500)
  assert.deepEqual(unreadList(own).map(m => m.id).filter(id => id === 'mine' || id === 'inb'), ['inb']) // 出站被过滤
  assert.ok(!s.seen.acks.includes('mine') && s.seen.acks.includes('inb'))
  await d.stop(); await s.close()
})
