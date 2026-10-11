import { Errors } from '../http/errors.js'
import type { Config } from '../config.js'

export class TokenBucket {
  private tokens: number
  private last: number
  constructor(public capacity: number, public refillPerSec: number) { this.tokens = capacity; this.last = Date.now() }
  tryTake(n = 1): boolean {
    const now = Date.now()
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec)
    this.last = now
    if (this.tokens >= n) { this.tokens -= n; return true }
    return false
  }
}

// 真 60 分钟滑动窗口（spec §3.2 M1）：per-min 桶取整后要么 0=无限频、要么 1/min=60/h 弱 12 倍，不可用
export class SlidingWindow {
  private hits: number[] = []
  constructor(private capacity: number, private windowMs = 3600_000, private now: () => number = Date.now) {} // now 可注入——滑出行为可测（r1-m2）
  tryTake(): boolean {
    const t = this.now()
    this.hits = this.hits.filter(h => t - h < this.windowMs)
    if (this.hits.length >= this.capacity) return false
    this.hits.push(t); return true
  }
  // 窗口内最早命中滑出还需多久（毫秒）；空窗口返回 0——checkProfile 据此算真实 Retry-After 而非恒定值
  retryAfterMs(): number {
    const t = this.now()
    this.hits = this.hits.filter(h => t - h < this.windowMs)
    return this.hits.length ? Math.max(0, this.hits[0] + this.windowMs - t) : 0
  }
}

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>()
  private windows = new Map<string, SlidingWindow>()
  constructor(private rate: Config['rate']) {}

  private check(key: string, quota: number, label: string, windowS = 60): void {
    let b = this.buckets.get(key)
    if (!b) { b = new TokenBucket(quota, quota / windowS); this.buckets.set(key, b) }
    if (!b.tryTake()) throw Errors.rateLimited(Math.ceil(windowS / quota))
    void label
  }
  checkMessage(agentId: string) { this.check(`msg:${agentId}`, this.rate.messagePerMin, 'message') }
  checkTask(agentId: string) { this.check(`task:${agentId}`, this.rate.taskPerMin, 'task') }
  checkHistory(agentId: string) { this.check(`hist:${agentId}`, this.rate.historyPerMin, 'history') }
  // 每小时配额整窗放置：容量=quota，补充=quota/3600 每秒（除以 60 会得到容量<1，导致永远 429）
  checkRegister(ip: string) { this.check(`reg:${ip}`, this.rate.registerPerHourPerIp, 'register', 3600) }
  checkWebhookTest(agentId: string) { this.check(`wht:${agentId}`, this.rate.webhookTestPerMin, 'webhook-test') }
  checkTopics(agentId: string) { this.check(`topics:${agentId}`, this.rate.topicsPerMin, 'topics') }
  // feed 匿名接口（spec §3.1）：每 IP 60/min + 全局 600/min 兜底（≈100 在线观众）。
  // feed key 是匿名访客自选的 IP，Map 无清理会被刷键撑爆内存（终审 I-4）——
  // 记录最后命中时间，超阈值时惰性清掉 2 分钟未活跃的 feed 桶（正常观众 10s 轮询不受影响）
  private feedSeen = new Map<string, number>()
  checkFeed(ip: string) {
    const key = `feed:${ip}`
    this.feedSeen.set(key, Date.now())
    if (this.feedSeen.size > 5000) {
      const cutoff = Date.now() - 120_000
      for (const [k, t] of this.feedSeen) if (t < cutoff) { this.feedSeen.delete(k); this.buckets.delete(k) }
    }
    this.check(key, this.rate.feedPerMinPerIp, 'feed')
  }
  checkFeedGlobal() { this.check('feed:__global__', this.rate.feedPerMinGlobal, 'feed-global') }
  checkProfile(agentId: string): void {
    let w = this.windows.get(agentId)
    if (!w) { w = new SlidingWindow(this.rate.profilePerHour); this.windows.set(agentId, w) }
    if (!w.tryTake()) throw Errors.rateLimited(Math.max(1, Math.ceil(w.retryAfterMs() / 1000)))
  }

  // 市场日桶（spec §3：滚动 24h 滑窗，不可复用 TokenBucket——连续补充会让 5/日变成持续超额）。
  // key 按 agentId 有界，Map 不清理可接受；SlidingWindow 命中自惰性过期。
  private daily = new Map<string, SlidingWindow>()
  private checkDaily(key: string, quota: number): void {
    let w = this.daily.get(key)
    if (!w) { w = new SlidingWindow(quota, 86_400_000); this.daily.set(key, w) }
    if (!w.tryTake()) throw Errors.rateLimited(Math.max(1, Math.ceil(w.retryAfterMs() / 1000)))
  }
  checkMarketPublish(agentId: string) { this.checkDaily(`mpub:${agentId}`, this.rate.marketPublishPerDay) }
  checkMarketBid(agentId: string) { this.checkDaily(`mbid:${agentId}`, this.rate.marketBidPerDay) }
  checkMarketCounter(agentId: string) { this.checkDaily(`mctr:${agentId}`, this.rate.marketCounterPerDay) }
}
