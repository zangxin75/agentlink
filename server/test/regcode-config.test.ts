// SMTP 工厂 + 限流（spec §4/§5）
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'
import { RateLimiter } from '../src/core/ratelimit.js'

describe('config smtp', () => {
  it('SMTP_* 全配 → 工厂非 null；缺任一 → null', () => {
    const full = loadConfig({ SMTP_HOST: 'smtpdm.aliyun.com', SMTP_PORT: '465', SMTP_USER: 'no-reply@tokeneff.com', SMTP_PASSWORD: 'p', SMTP_FROM: 'no-reply@tokeneff.com' } as never)
    expect(full.smtpTransport()).not.toBeNull()
    const noPass = loadConfig({ SMTP_HOST: 'h', SMTP_USER: 'u' } as never)
    expect(noPass.smtpTransport()).toBeNull()
    expect(loadConfig({}).smtpTransport()).toBeNull()
    expect(full.rate.regcodeApplyIpPerHour).toBe(3); expect(full.rate.regcodeApplyEmailPerHour).toBe(2); expect(full.rate.regcodeVerifyIpPerHour).toBe(10)
  })
  it('env 可覆盖限流配额', () => {
    const cfg = loadConfig({ RATE_LIMIT_REGCODE_APPLY_EMAIL: '5' } as never)
    expect(cfg.rate.regcodeApplyEmailPerHour).toBe(5)
  })
})

describe('RateLimiter regcode', () => {
  it('apply email 2/h：第 3 次 429；同配额 IP 桶独立', () => {
    const l = new RateLimiter(loadConfig({} as never).rate)
    l.checkRegcodeApplyEmail('a@b.c'); l.checkRegcodeApplyEmail('a@b.c')
    expect(() => l.checkRegcodeApplyEmail('a@b.c')).toThrowError(/429|rate/i)
    l.checkRegcodeApplyIp('1.2.3.4') // 独立桶
  })
  it('email 键 1h 内不被惰性清理、超 1h 被清（r2-N2：注入时钟钉死 cutoff，改 2min 清理必挂）', () => {
    let t = 1_700_000_000_000
    const l = new RateLimiter(loadConfig({} as never).rate, () => t)
    l.checkRegcodeApplyEmail('seed@x.y') // 制造 seen 记录
    for (let i = 0; i < 2100; i++) l.checkRegcodeApplyEmail(`k${i}@x.y`) // 撑过 2000 阈值，触发惰性清理
    expect((l as any).buckets.has('rge:seed@x.y')).toBe(true) // 时钟未动：1h 内不得清（2min cutoff 会在此挂）
    t += 3600_000 + 1 // 推进 1h+1ms：seed 已出 cutoff
    l.checkRegcodeApplyEmail('trig@x.y') // 再触发 sweep
    expect((l as any).buckets.has('rge:seed@x.y')).toBe(false) // 超 1h 被清
  })
})
