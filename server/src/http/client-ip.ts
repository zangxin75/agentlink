// 限流键的来源 IP：反代（nginx/FRP）后 remoteAddress 直连地址塌缩为代理 IP，会把按 IP 限流桶挤成全局桶（审计 HIGH 2026-10-20）
// 审计 2026-10-21（core MEDIUM/ops F3）：XFF 采信加可信代理白名单——非白名单来源自带伪造 XFF 不得劫持限流键。
// 取 XFF 末段：nginx proxy_add_x_forwarded_for 是追加语义，末段才是可信代理追加的真实来源。
import type { FastifyRequest } from 'fastify'

// 默认信任 loopback + RFC1918 私网：FRP/nginx 同机反代形态（生产即此形态），直连源只能是本机/容器网桥
export const DEFAULT_TRUSTED_PROXIES = '127.0.0.0/8,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'

const v4ToNum = (ip: string): number | null => {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0
}

// remote 是否命中可信代理白名单（精确 IP 或 IPv4 CIDR；::ffff: 双栈折叠按 v4 比对）
export function isTrustedProxy(remote: string, trusted: string): boolean {
  if (!remote) return false
  const addr = remote.replace(/^::ffff:/, '')
  const addrV4 = v4ToNum(addr)
  for (const raw of trusted.split(',').map(s => s.trim()).filter(Boolean)) {
    const cidr = raw.replace(/^::ffff:/, '')
    if (cidr === addr) return true
    if (addrV4 === null || !cidr.includes('/')) continue
    const [net, bitsS] = cidr.split('/')
    const bits = Number(bitsS)
    const netV4 = v4ToNum(net)
    if (netV4 === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
    if (((addrV4 & mask) >>> 0) === ((netV4 & mask) >>> 0)) return true
  }
  return false
}

export function clientIp(req: FastifyRequest, trusted: string = DEFAULT_TRUSTED_PROXIES): string {
  const remote = req.socket.remoteAddress || 'unknown'
  if (!isTrustedProxy(remote, trusted)) return remote // 非白名单来源：自带 XFF 一律不信（审计 2026-10-21）
  const raw = req.headers['x-forwarded-for']
  const xff = Array.isArray(raw) ? raw.join(',') : raw
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]
  }
  return remote // 可信来源但无 XFF（本地/直连）
}
