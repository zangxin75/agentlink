// webhook 出站核心（队列/签名/SSRF/重试）单测
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHmac } from 'node:crypto'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { WebhookDispatcher } from '../src/core/webhook.js'
import { registerAgent } from '../src/core/agents.js'

const mkdb = () => { const db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db); return db }
const cfgPriv = loadConfig({ REGISTRATION_CODE: 'x', WEBHOOK_ALLOW_PRIVATE: 'true' } as never)
const cfgNoPriv = loadConfig({ REGISTRATION_CODE: 'x' } as never)
let servers: Server[] = []
afterEach(() => { servers.forEach(s => s.close()); servers.length = 0 })
// status 可注入：默认 200，测重试时传 500（r1-C4：listener 内不能 throw——会 uncaughtException 且永不响应）
const listener = (fn: (req: any, body: string) => void, status = 200) => new Promise<{ srv: Server; url: string }>(resolve => {
  const srv = createServer((req, res) => { let b = ''; req.on('data', (d: Buffer) => b += d); req.on('end', () => { fn(req, b); res.writeHead(status); res.end('{}') }) })
  servers.push(srv); srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${(srv.address() as any).port}` }))
})

describe('webhook dispatcher', () => {
  it('delivers signed payload with correct role; HMAC verifies', async () => {
    const db = mkdb()
    registerAgent(db, cfgPriv, { agent_id: 'hook.eg', registration_code: 'x' })
    const secret = 'wl_test_secret_0123456789abcdef'
    const got: any[] = []
    const { url } = await listener((req, body) => got.push({ req, body }))
    db.prepare('UPDATE agents SET webhook_url=?, webhook_secret=? WHERE id=?').run(url, secret, 'hook.eg')
    const d = new WebhookDispatcher({ db, cfg: cfgPriv, retryDelaysMs: [0, 10, 10] })
    d.notify({ id: 'tsk_1', requester: 'hook.eg', executor: 'other.x', status: 'COMPLETED' }, 'task.result')
    await new Promise(r => setTimeout(r, 300))
    expect(got.length).toBeGreaterThanOrEqual(1)
    const p = JSON.parse(got[0].body)
    expect(p.event).toBe('task.result'); expect(p.task_id).toBe('tsk_1'); expect(p.role).toBe('requester'); expect(p.ts).toBeTruthy()
    const sig = got[0].req.headers['x-agentlink-signature']
    expect(sig).toBe('sha256=' + createHmac('sha256', secret).update(got[0].body).digest('hex'))
  })
  it('private target denied by default; allowed with WEBHOOK_ALLOW_PRIVATE', async () => {
    const db = mkdb()
    registerAgent(db, cfgNoPriv, { agent_id: 'hook.eg', registration_code: 'x' })
    db.prepare('UPDATE agents SET webhook_url=?, webhook_secret=? WHERE id=?').run('http://127.0.0.1:1/x', 'wl_s', 'hook.eg')
    const d = new WebhookDispatcher({ db, cfg: cfgNoPriv, retryDelaysMs: [0, 10, 10] })
    d.notify({ id: 't', requester: 'hook.eg', executor: 'o.x', status: 'COMPLETED' }, 'task.result')
    await new Promise(r => setTimeout(r, 200))
    const audits = db.prepare(`SELECT * FROM audit_log WHERE event='webhook.failed'`).all()
    expect(audits.length).toBeGreaterThan(0) // 拒绝即失败并审计
  })
  it('retries 3 times then audits webhook.failed; never blocks caller', async () => {
    const db = mkdb()
    registerAgent(db, cfgPriv, { agent_id: 'hook.eg', registration_code: 'x' })
    let hits = 0
    const { url } = await listener(() => { hits++ }, 500) // 恒 500（r1-C4：回调里 throw 会 uncaughtException）
    db.prepare('UPDATE agents SET webhook_url=?, webhook_secret=? WHERE id=?').run(url, 'wl_s', 'hook.eg')
    const t0 = Date.now()
    const d = new WebhookDispatcher({ db, cfg: cfgPriv, retryDelaysMs: [0, 10, 10] })
    d.notify({ id: 't2', requester: 'hook.eg', executor: 'o.x', status: 'FAILED' }, 'task.result')
    expect(Date.now() - t0).toBeLessThan(200) // 入队即返回，零阻塞
    await new Promise(r => setTimeout(r, 400))
    expect(hits).toBe(3)
    expect(db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE event='webhook.failed'`).get()).toMatchObject({ c: 1 })
  })
  it('test() delivers webhook.test event to self', async () => {
    const db = mkdb()
    registerAgent(db, cfgPriv, { agent_id: 'hook.eg', registration_code: 'x' })
    const got: string[] = []
    const { url } = await listener((_r, body) => got.push(body))
    db.prepare('UPDATE agents SET webhook_url=?, webhook_secret=? WHERE id=?').run(url, 'wl_s', 'hook.eg')
    const d = new WebhookDispatcher({ db, cfg: cfgPriv, retryDelaysMs: [0] })
    d.test('hook.eg')
    await new Promise(r => setTimeout(r, 200))
    expect(JSON.parse(got[0]).event).toBe('webhook.test')
  })
  it('redirect re-check: local 302 chain to private target is dead by default (r2-R2-1 降级用例)', async () => {
    const db = mkdb()
    registerAgent(db, cfgNoPriv, { agent_id: 'hook.eg', registration_code: 'x' })
    let redirects = 0
    const url = await new Promise<string>(resolve => {
      const s = createServer((_q, res) => { redirects++; res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end() })
      servers.push(s); s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as any).port}`))
    })
    db.prepare('UPDATE agents SET webhook_url=?, webhook_secret=? WHERE id=?').run(url, 'wl_s', 'hook.eg')
    const d = new WebhookDispatcher({ db, cfg: cfgNoPriv, retryDelaysMs: [0, 10] })
    d.notify({ id: 't3', requester: 'hook.eg', executor: 'o.x', status: 'COMPLETED' }, 'task.result')
    await new Promise(r => setTimeout(r, 300))
    expect(redirects).toBe(0) // 首跳即被拒（127.0.0.1 私网）——默认配置下这条链路整体死亡
    expect(db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE event='webhook.failed'`).get()).toMatchObject({ c: 1 })
  })
  it('ipIsPrivate unit matrix (hop-level判定直接单测，补重定向逐跳复检的覆盖)', async () => {
    const { ipIsPrivate } = await import('../src/core/webhook.js')
    for (const p of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1']) expect(ipIsPrivate(p)).toBe(true)
    for (const pub of ['8.8.8.8', '172.32.0.1', '1.1.1.1']) expect(ipIsPrivate(pub)).toBe(false)
  })
  // r2 保留项：post() 的 301/302 逐跳复检分支在本沙箱无法用可达公网首跳覆盖——执行阶段若 CI/环境能
  // 起公网可达端点，可加「首跳 302→私网」用例补上；否则以 ipIsPrivate 矩阵 + 降级用例为准，不阻塞。
})
