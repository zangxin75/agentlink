#!/usr/bin/env node
// Load test: register N agents, ring messaging (i -> i+1), WS receive + REST ack,
// assert zero loss. Exit 0 iff loss === 0.
// 前置：服务端需放宽注册限流（RATE_LIMIT_REGISTER_PER_HOUR >= N），见 Step 7。
import { parseArgs } from 'node:util'
import WebSocket from 'ws'

const { values: a } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:8080' },
  connections: { type: 'string', default: '200' },
  rate: { type: 'string', default: '50' },
  duration: { type: 'string', default: '60' },
  'reg-code': { type: 'string' },
  'drain-ms': { type: 'string', default: '5000' },
} })
const N = +a.connections, RATE = +a.rate, DUR = +a.duration * 1000
const H = { 'content-type': 'application/json' }
const auth = t => ({ ...H, authorization: `Bearer ${t}` })
// 高并发下 undici keep-alive socket 与服务端 keepAliveTimeout 存在竞态（"other side closed"），
// 单次失败重试一次即可恢复（幂等 ack / client_msg_id 幂等发送均安全）
async function post(url, headers, body) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetch(url, { method: 'POST', headers, body }) }
    catch (e) { if (attempt >= 1) throw e }
  }
}

// 1) register N agents（收集 id + token）
const agents = []
for (let i = 0; i < N; i++) {
  const res = await post(`${a.url}/v1/agents`, H, JSON.stringify({ agent_id: `load-${i}-${Date.now().toString(36)}`, registration_code: a['reg-code'] }))
  if (!res.ok) { console.error(`register failed (${res.status}): ${await res.text()}`); process.exit(1) }
  const j = await res.json()
  agents.push({ id: j.agent.id, token: j.token })
}
console.log(`registered ${N} agents`)
const peers = agents.map(x => x.id) // 环形目标：peers[(i+1)%N]

// 2) one WS per agent; 等 auth_ok 才算就绪（收到 error 帧即失败退出）
const sent = new Set(), acked = new Set(), latencies = []
// 单个连接失败（burst 下 accept 队列抖动 / keep-alive 竞态）重试 2 次
const connect = ag => new Promise((resolve, reject) => {
  const ws = new WebSocket(`${a.url.replace(/^http/, 'ws')}/ws`)
  ws.once('open', () => ws.send(JSON.stringify({ op: 'auth', token: ag.token })))
  ws.once('error', reject)
  ws.on('message', function onAuth(raw) {
    const f = JSON.parse(String(raw))
    if (f.op === 'auth_ok') { ws.off('message', onAuth); ws.on('error', () => {}); resolve(ws) } // 认证后网络抖动不致命
    else if (f.op === 'error') reject(new Error(`auth failed: ${f.code}`))
  })
})
const sockets = await Promise.all(agents.map(async ag => {
  for (let attempt = 0; ; attempt++) {
    try { return await connect(ag) } catch (e) { if (attempt >= 2) throw e }
  }
}))
sockets.forEach((ws, i) => ws.on('message', async raw => {
  const f = JSON.parse(String(raw))
  if (f.op !== 'message') return
  latencies.push(Date.now() - Date.parse(f.message.created_at))
  const r = await post(`${a.url}/v1/messages/ack`, auth(agents[i].token), JSON.stringify({ ids: [f.message.id] })).catch(() => null)
  if (r && r.ok) acked.add(f.message.id)
}))
// 心跳：spec §9 要求客户端每 30s 发 {op:'ping'}，否则服务端 90s 空闲即断开
const pingers = sockets.map(ws => setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ op: 'ping' })) }, 30_000))

// 3) ring senders: agent i -> peers[(i+1)%N]；总速率 RATE 均摊到 N 个发送端；
//    单端 interval = 1000*N/RATE（下限 1000ms），低于消息限流 60/min/token；
//    busy 闭锁保证单端异步发送不重叠，慢响应时自动降速而不超速
let stopped = false
const busy = new Array(N).fill(false)
const senders = agents.map((ag, i) => setInterval(async () => {
  if (busy[i] || stopped) return
  busy[i] = true
  try {
    const cmid = `lt-${i}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const r = await post(`${a.url}/v1/messages`, auth(ag.token), JSON.stringify({ to: peers[(i + 1) % N], type: 'text', body: { text: cmid }, client_msg_id: cmid })).catch(() => null)
    if (r && r.ok) sent.add((await r.json()).message.id)
  } finally { busy[i] = false }
}, Math.max(1000, Math.floor(1000 * N / RATE))))

setTimeout(() => {
  stopped = true
  senders.forEach(clearInterval)
  pingers.forEach(clearInterval)
  setTimeout(() => { // drain in-flight deliveries; M5 高档位积压时 ack 尾部延迟可超 5s，可用 --drain-ms 放宽
    sockets.forEach(ws => ws.close())
    const loss = [...sent].filter(id => !acked.has(id)).length
    const sorted = latencies.sort((x, y) => x - y)
    const p = q => sorted[Math.floor(sorted.length * q)] ?? -1
    console.log(JSON.stringify({ sent: sent.size, acked: acked.size, loss, p50_ms: p(0.5), p99_ms: p(0.99) }))
    process.exit(loss === 0 ? 0 : 1)
  }, +a['drain-ms'])
}, DUR)
