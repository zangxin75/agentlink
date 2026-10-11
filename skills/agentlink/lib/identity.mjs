// skills/agentlink/lib/identity.mjs
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ID_RE = /^[a-z0-9][a-z0-9.-]{2,31}$/
// register 写 daemon env 的模板（2026-10-12 安全档）：默认唤醒命令带 --max-turns 20 防跑飞；
// 非 Windows 加 `timeout 600` 前缀防网络类挂起（Windows 的 timeout 是等待命令，语义不同，不加）。
// 提醒用户可加 --dangerously-skip-permissions 实现全自动回信（写在文档，不写进默认）。
export function buildAgentEnv(name, dir, server, token) {
  const wake = `claude -p "AgentLink 新信已注入，按 SKILL.md 处理并回信" --max-turns 20`
  const wakeCmd = process.platform === 'win32' ? wake : `timeout 600 ${wake}`
  return `AGENTLINK_NAME=${name}\nAGENTLINK_DIR=${dir}\nAGENTLINK_SERVER=${server}\nAGENTLINK_TOKEN=${token}\n` +
    `AGENTLINK_WAKE_CMD=${wakeCmd}\nAGENTLINK_WAKE_COOLDOWN=60000\n`
}
export function agentIdFor(name, hostname, dir) {
  const hex = createHash('sha256').update(`${hostname}:${dir}`).digest('hex')
  const hash8 = BigInt('0x' + hex).toString(36).slice(0, 8) // base36 小写（spec §3）
  const id = `${name}-${hash8}`
  if (!ID_RE.test(id)) throw new Error(`invalid agent_id: ${id} (name must be lowercase [a-z0-9.-], total <= 32 chars)`)
  return id
}
export const httpBase = (s) => s.replace(/^ws(s?):\/\//, (_, sec) => 'http' + sec + '://')
export const wsUrl = (s) => s.replace(/\/+$/, '').replace(/^http(s?):\/\//, (_, sec) => 'ws' + sec + '://') + '/ws'
const KEYS = { AGENTLINK_NAME: 'name', AGENTLINK_DIR: 'dir', AGENTLINK_SERVER: 'server', AGENTLINK_TOKEN: 'token', AGENTLINK_WAKE_CMD: 'wakeCmd', AGENTLINK_WAKE_FROM: 'wakeFrom', AGENTLINK_WAKE_COOLDOWN: 'wakeCooldown', AGENTLINK_DIST_BASE: 'distBase', AGENTLINK_AUTOUPGRADE: 'autoUpgrade',
  AGENTLINK_MARKET_WATCH: 'marketWatch', AGENTLINK_MARKET_WATCH_INTERVAL: 'marketWatchInterval', AGENTLINK_FEISHU_WEBHOOK: 'feishuWebhook', AGENTLINK_FEISHU_SECRET: 'feishuSecret' } // 市场守望/飞书（市场代理 spec §6）——漏列即静默 no-op（r1-M1）
const REQUIRED = ['AGENTLINK_NAME', 'AGENTLINK_DIR', 'AGENTLINK_SERVER', 'AGENTLINK_TOKEN']
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
  for (const envKey of REQUIRED) if (!out[KEYS[envKey]]) throw new Error(`missing ${envKey} (env file requires 4 keys: AGENTLINK_NAME, AGENTLINK_DIR, AGENTLINK_SERVER, AGENTLINK_TOKEN — one per line, KEY=value)`)
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
// state 根收敛单源（T5 seen 目录消费）；config 根独立
export const STATE_ROOT = process.env.AGENTLINK_STATE ?? join(homedir(), '.local/state/agentlink')
export const SPOOL_ROOT = join(STATE_ROOT, 'spool')
export const AGENTS_DIR = join(process.env.AGENTLINK_CONFIG ?? join(homedir(), '.config/agentlink'), 'agents.d')
export const HEARTBEAT = join(STATE_ROOT, 'heartbeat')
