import { describe, it, expect, vi } from 'vitest'
import { TokenBucket, RateLimiter } from '../src/core/ratelimit.js'

describe('TokenBucket', () => {
  it('allows up to capacity then refills over time', async () => {
    const b = new TokenBucket(2, 100) // fast refill for test
    expect(b.tryTake()).toBe(true); expect(b.tryTake()).toBe(true); expect(b.tryTake()).toBe(false)
    await new Promise(r => setTimeout(r, 30)) // +3 tokens
    expect(b.tryTake()).toBe(true)
  })
})

describe('RateLimiter', () => {
  it('throws RATE_LIMITED with retry-after beyond per-minute budget', () => {
    const rl = new RateLimiter({ messagePerMin: 2, taskPerMin: 20, historyPerMin: 120, registerPerHourPerIp: 10 })
    rl.checkMessage('a'); rl.checkMessage('a')
    expect(() => rl.checkMessage('a')).toThrowError(/rate limited/)
    try { rl.checkMessage('a') } catch (e: any) { expect(e.code).toBe('RATE_LIMITED'); expect(e.retryAfterS).toBeGreaterThan(0) }
    rl.checkMessage('b') // independent key
  })
  it('register limiter keyed by ip', () => {
    const rl = new RateLimiter({ messagePerMin: 60, taskPerMin: 20, historyPerMin: 120, registerPerHourPerIp: 1 })
    rl.checkRegister('1.2.3.4')
    expect(() => rl.checkRegister('1.2.3.4')).toThrowError(/rate limited/)
    rl.checkRegister('5.6.7.8')
  })
})
  it('feed 限流：每 IP 独立、超限抛 RATE_LIMITED', () => {
    const mk = (over: Record<string, number>) => new RateLimiter({ messagePerMin: 60, taskPerMin: 20, historyPerMin: 120, registerPerHourPerIp: 10, webhookTestPerMin: 6, profilePerHour: 5, topicsPerMin: 60, marketPublishPerDay: 5, marketBidPerDay: 30, marketCounterPerDay: 20, ...over })
    const small = mk({ feedPerMinPerIp: 2, feedPerMinGlobal: 100 })
    expect(() => small.checkFeed('1.1.1.1')).not.toThrow()
    expect(() => small.checkFeed('1.1.1.1')).not.toThrow()
    expect(() => small.checkFeed('1.1.1.1')).toThrow()
    expect(() => small.checkFeed('2.2.2.2')).not.toThrow() // 独立桶
  })
  it('feed 全局兜底独立于每 IP', () => {
    const mk = (over: Record<string, number>) => new RateLimiter({ messagePerMin: 60, taskPerMin: 20, historyPerMin: 120, registerPerHourPerIp: 10, webhookTestPerMin: 6, profilePerHour: 5, topicsPerMin: 60, marketPublishPerDay: 5, marketBidPerDay: 30, marketCounterPerDay: 20, ...over })
    const g = mk({ feedPerMinPerIp: 1000, feedPerMinGlobal: 1 })
    expect(() => g.checkFeedGlobal()).not.toThrow()
    expect(() => g.checkFeedGlobal()).toThrow()
  })
  it('feed 桶惰性清理：超 5000 键后 2 分钟未活跃的旧桶被清（防匿名刷键撑内存）', () => {
    vi.useFakeTimers()
    try {
      const mk = (over: Record<string, number>) => new RateLimiter({ messagePerMin: 60, taskPerMin: 20, historyPerMin: 120, registerPerHourPerIp: 10, webhookTestPerMin: 6, profilePerHour: 5, topicsPerMin: 60, marketPublishPerDay: 5, marketBidPerDay: 30, marketCounterPerDay: 20, ...over })
      const rl = mk({ feedPerMinPerIp: 60, feedPerMinGlobal: 1_000_000 })
      rl.checkFeed('victim.ip')
      vi.advanceTimersByTime(121_000) // victim 桶闲置 2 分钟以上
      for (let i = 0; i < 5100; i++) { vi.advanceTimersByTime(1); rl.checkFeed(`flood-${i}.example`) } // 刷键超阈值 → 惰性清理
      const seen = (rl as unknown as { feedSeen: Map<string, number> }).feedSeen
      expect(seen.has('feed:victim.ip')).toBe(false) // 旧键被清，内存有界
    } finally { vi.useRealTimers() }
  })
