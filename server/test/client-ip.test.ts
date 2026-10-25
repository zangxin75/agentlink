// 审计 2026-10-21（core MEDIUM / ops F3）：XFF 采信必须有可信代理白名单——
// 直连（或非白名单来源）自带 XFF 不得劫持限流键；仅可信代理来源才取 XFF 末段。
import { describe, it, expect } from 'vitest'
import { clientIp, isTrustedProxy } from '../src/http/client-ip.js'

const req = (remote: string, xff?: string) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} } as any)
const TRUSTED = '127.0.0.0/8,::1,172.16.0.0/12,192.168.0.0/16'

describe('isTrustedProxy（CIDR 白名单）', () => {
  it('命中 loopback/私网段 → true；公网/伪造 → false', () => {
    expect(isTrustedProxy('127.0.0.1', TRUSTED)).toBe(true)
    expect(isTrustedProxy('172.18.0.1', TRUSTED)).toBe(true)
    expect(isTrustedProxy('192.168.1.5', TRUSTED)).toBe(true)
    expect(isTrustedProxy('::1', TRUSTED)).toBe(true)
    expect(isTrustedProxy('::ffff:127.0.0.1', TRUSTED)).toBe(true)
    expect(isTrustedProxy('203.0.113.9', TRUSTED)).toBe(false)
    expect(isTrustedProxy('8.8.8.8', TRUSTED)).toBe(false)
  })
})

describe('clientIp（可信代理白名单语义）', () => {
  it('可信代理来源 → 取 XFF 末段（追加语义，末段为真实来源）', () => {
    expect(clientIp(req('127.0.0.1', '1.2.3.4, 5.6.7.8'), TRUSTED)).toBe('5.6.7.8')
    expect(clientIp(req('172.18.0.1', '203.0.113.9'), TRUSTED)).toBe('203.0.113.9')
  })
  it('审计核心：非白名单来源自带伪造 XFF → 回退 remoteAddress，不得劫持限流键', () => {
    expect(clientIp(req('203.0.113.9', '1.1.1.1'), TRUSTED)).toBe('203.0.113.9')
    expect(clientIp(req('8.8.8.8', '1.1.1.1, 2.2.2.2'), TRUSTED)).toBe('8.8.8.8')
  })
  it('无 XFF 一律 remoteAddress；remoteAddress 缺失 → unknown', () => {
    expect(clientIp(req('127.0.0.1'), TRUSTED)).toBe('127.0.0.1')
    expect(clientIp(req('203.0.113.9'), TRUSTED)).toBe('203.0.113.9')
    expect(clientIp(req('' as string, undefined), TRUSTED)).toBe('unknown')
  })
})
