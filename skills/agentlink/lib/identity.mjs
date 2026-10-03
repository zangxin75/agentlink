// skills/agentlink/lib/identity.mjs
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ID_RE = /^[a-z0-9][a-z0-9.-]{2,31}$/
export function agentIdFor(name, hostname, dir) {
  const hex = createHash('sha256').update(`${hostname}:${dir}`).digest('hex')
  const hash8 = BigInt('0x' + hex).toString(36).slice(0, 8) // base36 小写（spec §3）
  const id = `${name}-${hash8}`
  if (!ID_RE.test(id)) throw new Error(`invalid agent_id: ${id} (name must be lowercase [a-z0-9.-], total <= 32 chars)`)
  return id
}
export const httpBase = (s) => s.replace(/^ws(s?):\/\//, (_, sec) => 'http' + sec + '://')
export const wsUrl = (s) => s.replace(/\/+$/, '').replace(/^http(s?):\/\//, (_, sec) => 'ws' + sec + '://') + '/ws'
const KEYS = { AGENTLINK_NAME: 'name', AGENTLINK_DIR: 'dir', AGENTLINK_SERVER: 'server', AGENTLINK_TOKEN: 'token' }
export function parseEnvFile(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    const i = s.indexOf('=')
    if (i < 0) continue
    const k = KEYS[s.slice(0, i)]
    if (k) out[k] = s.slice(i + 1).trim()
  }
  // 键名必须带 AGENTLINK_ 前缀；裸 NAME=/SERVER= 一律忽略——报错自描述（用户实测：手工补写 env 键名易漏前缀，旧报错 missing server 不明所以）
  for (const [envKey, k] of Object.entries(KEYS)) if (!out[k]) throw new Error(`missing ${envKey} (env file requires 4 keys: AGENTLINK_NAME, AGENTLINK_DIR, AGENTLINK_SERVER, AGENTLINK_TOKEN — one per line, KEY=value)`)
  return out
}
export function matchAgentForCwd(entries, cwd) {
  let best = null
  for (const e of entries) {
    if (cwd === e.dir || cwd.startsWith(e.dir.endsWith('/') ? e.dir : e.dir + '/')) {
      if (!best || e.dir.length > best.dir.length) best = e
    }
  }
  return best
}
export const SPOOL_ROOT = join(process.env.AGENTLINK_STATE ?? join(homedir(), '.local/state/agentlink'), 'spool')
export const AGENTS_DIR = join(process.env.AGENTLINK_CONFIG ?? join(homedir(), '.config/agentlink'), 'agents.d')
export const HEARTBEAT = join(process.env.AGENTLINK_STATE ?? join(homedir(), '.local/state/agentlink'), 'heartbeat')
