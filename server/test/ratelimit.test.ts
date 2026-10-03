import { describe, it, expect } from 'vitest'
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
