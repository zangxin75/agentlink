// Webhook 出站核心：内存队列 + 签名投递 + SSRF 复检 + 重试审计
import { createHmac, randomBytes } from 'node:crypto'
import { lookup } from 'node:dns'
import type { Db } from '../db/sqlite.js'
import type { Config } from '../config.js'
import { audit } from './audit.js'

export type WebhookEventName = 'task.accepted' | 'task.rejected' | 'task.policy_rejected' | 'task.cancelled' | 'task.result' | 'task.timeout' | 'task.expired' | 'webhook.test'

// 每次出站按当次解析 IP 复检（防 DNS rebinding）；set 时校验只是提前报错，不是安全边界（spec §2.2 r2-R2-1）
// ipIsPrivate 定义在文件末尾并导出（供 hop 级单测）
const assertDeliverable = (host: string, allowPrivate: boolean) => new Promise<void>((resolve, reject) => {
  if (allowPrivate) return resolve()
  const bare = host.replace(/^\[|\]$/g, '')
  if (/^(\d+\.)+\d+$/.test(bare)) return ipIsPrivate(bare) ? reject(new Error('private ip')) : resolve()
  lookup(bare, { all: true }, (err, addrs) => {
    if (err) return reject(err)
    if (addrs.some(a => ipIsPrivate(a.address))) return reject(new Error(`resolves to private: ${addrs.map(a => a.address).join(',')}`))
    resolve()
  })
})

interface Job { url: string; secret: string; body: string; agentId: string }

export class WebhookDispatcher {
  private queue: Job[] = []
  private active = 0
  constructor(private deps: { db: Db; cfg: Config; retryDelaysMs?: number[] }) {}
  inFlight(): number { return this.active + this.queue.length }

  notify(task: { id: string; requester: string; executor: string; status: string }, event: WebhookEventName, audience: 'both' | 'requester' = 'both'): void {
    const ids = audience === 'both' ? [task.requester, task.executor] : [task.requester]
    const rows = this.deps.db.prepare(`SELECT id, webhook_url, webhook_secret FROM agents WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[]
    const ts = new Date().toISOString()
    for (const r of rows) {
      if (!r.webhook_url) continue
      for (const role of (r.id === task.requester ? ['requester'] : []).concat(r.id === task.executor ? ['executor'] : [])) {
        this.enqueue({ url: r.webhook_url, secret: r.webhook_secret, agentId: r.id,
          body: JSON.stringify({ event, task_id: task.id, role, task: { status: task.status }, ts }) })
      }
    }
  }
  test(agentId: string): void {
    const r: any = this.deps.db.prepare('SELECT webhook_url, webhook_secret FROM agents WHERE id=?').get(agentId)
    if (r?.webhook_url) this.enqueue({ url: r.webhook_url, secret: r.webhook_secret, agentId, body: JSON.stringify({ event: 'webhook.test', task_id: null, role: 'self', task: null, ts: new Date().toISOString() }) })
  }
  private enqueue(job: Job): void { this.queue.push(job); this.pump() }
  private pump(): void {
    while (this.active < 50 && this.queue.length) { this.active++; void this.deliver(this.queue.shift()!).finally(() => { this.active--; this.pump() }) }
  }
  // delays 语义：delays[i] = 第 i 次尝试前的等待（r1-C1：默认 [0,5000,25000] = 立即/+5s/+25s 共 3 次尝试，
  // 测试注入 [0,10,10] → 3 次 hits，[0] → 1 次——与 webhook-core 测试断言逐一对齐）
  private async deliver(job: Job, attempt = 0): Promise<void> {
    try {
      await assertDeliverable(new URL(job.url).hostname, this.deps.cfg.webhookAllowPrivate)
      const ok = await this.post(job.url, job.body, job.secret, 0)
      if (!ok) throw new Error('delivery failed')
    } catch (e) {
      const delays = this.deps.retryDelaysMs ?? [0, 5000, 25_000]
      if (attempt + 1 < delays.length) {
        await new Promise(r => setTimeout(r, delays[attempt + 1] ?? 0))
        return this.deliver(job, attempt + 1)
      }
      audit(this.deps.db, 'server', 'webhook.failed', { agent_id: job.agentId, url: job.url, error: String(e) })
    }
  }
  // redirect:'manual' 逐跳复检（≤3 跳），签名只签原始 body（重定向后同 body 重发）
  private async post(url: string, body: string, secret: string, hops: number): Promise<boolean> {
    if (hops > 3) return false
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 5000)
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentlink-signature': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex') }, body, redirect: 'manual', signal: ctrl.signal })
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location'); if (!loc) return false
        const next = new URL(loc, url).toString()
        await assertDeliverable(new URL(next).hostname, this.deps.cfg.webhookAllowPrivate)
        return this.post(next, body, secret, hops + 1)
      }
      return res.ok
    } catch { return false } finally { clearTimeout(timer) }
  }
  close(): void { // at-most-once：关停丢弃队列，但按 spec §8「丢弃并记 audit」留痕（r1-M-c）
    const dropped = this.queue.length
    this.queue = []
    if (dropped) audit(this.deps.db, 'server', 'webhook.failed', { dropped, reason: 'shutdown' })
  }
}
export const newWebhookSecret = (): string => 'wl_' + randomBytes(32).toString('base64url')
export const ipIsPrivate = (ip: string): boolean => ip === '::1' || ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd') || (() => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip); if (!m) return true; const [a, b] = [Number(m[1]), Number(m[2])]; return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) })()
