// skills/agentlink/lib/identity.mjs
import { createHash, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ID_RE = /^[a-z0-9][a-z0-9.-]{2,31}$/
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// T3：本机身份私钥落盘（256-bit base62，43 字符）。默认 ~/.agentlink/identity.key，
// env AGENTLINK_IDENTITY_FILE 可重定位。不存在则生成并写文件（0600）；已存在直接读——幂等。
export function loadOrCreateIdentityKey(file) {
  const path = file ?? process.env.AGENTLINK_IDENTITY_FILE ?? join(homedir(), '.agentlink/identity.key')
  try {
    const existing = readFileSync(path, 'utf8').trim()
    // 既有文件校验：空/前缀错/长度异常视为半写或损坏——抛错让用户人工处置，绝不静默改写当身份
    if (!existing.startsWith('al_ident_') || existing.length !== 'al_ident_'.length + 43)
      throw new Error(`identity key 文件内容异常（${path}）：应为 al_ident_ + 43 字符，实际为「${existing.slice(0, 20) || '(空)'}」——疑似半写/损坏，请人工确认后删除该文件重生成`)
    return existing
  } catch (e) { if (!(e instanceof Error && e.code === 'ENOENT')) throw e } // 不存在 → 生成；其他错误上抛
  const key = generateIdentityKey()
  writeIdentityKey(path, key)
  // T4（Task 3 deferred）：并发孤儿竞态——两进程同 ENOENT 各自生成 rename，后写覆盖前者；
  // 落盘后回读一次，被覆盖则采用盘上值，两进程收敛到同一 key
  return settleConcurrentWrite(path, key)
}

// 43 字符 base62 ≈ 256.3 bit；拒绝采样避免 %62 取模偏差（248 = 62*4，余 8 个值弃用）
export function generateIdentityKey() {
  let s = ''
  while (s.length < 43) for (const b of randomBytes(64)) { if (b < 248 && s.length < 43) s += BASE62[b % 62] }
  return `al_ident_${s}`
}

// 原子落盘：同目录临时文件 + rename，杜绝并发/中断留下半写身份文件（rotate 换 key 复用同路径）
export function writeIdentityKey(path, key) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  writeFileSync(tmp, key, { mode: 0o600 })
  renameSync(tmp, path)
}

// 并发写收敛：盘上有值且≠自值 → 对方后写胜出，采用盘上值；盘上空/异常 → 保留自值
export function settleConcurrentWrite(path, key) {
  try {
    const onDisk = readFileSync(path, 'utf8').trim()
    return onDisk || key
  } catch { return key }
}

// T3：AGENTLINK_ID 显式优先（空串视同缺失），否则回退 name+hostname+dir 公式——五处调用点统一经此收敛
export function agentIdFromEnv(e, hostname) {
  return e.id || agentIdFor(e.name, hostname, e.dir)
}
// register 写 daemon env 的模板（2026-10-14 无人值守档）：默认唤醒命令带 --dangerously-skip-permissions——
// headless `claude -p` 无 TTY，权限请求无人应答会卡死唤醒会话，无人值守自动回信必须跳过权限门。
// 该默认 = 装机人类的一次性 opt-in（2026-10-14 用户裁决）；收紧单机：删掉 env 中该参数。
// --max-turns 20 防跑飞（2026-10-12 安全档保留）；非 Windows 加 `timeout 600` 前缀防网络类挂起
// （Windows 的 timeout 是等待命令，语义不同，不加）。
export function buildAgentEnv(name, dir, server, token, { id, recovery, identityFile } = {}) {
  const wake = `claude -p "AgentLink 新信已注入，按 SKILL.md 处理并回信" --dangerously-skip-permissions --max-turns 20`
  const wakeCmd = process.platform === 'win32' ? wake : `timeout 600 ${wake}`
  // T3：id/recovery 可选追加；AGENTLINK_NAME/DIR 原样保留——老 daemon 不认新键仍按公式算原 id，spool 不错位
  // T4：identityFile（--new-identity 第二身份）——daemon 各自 env 指向各自 key 文件
  const ident = [id ? `AGENTLINK_ID=${id}\n` : '', recovery ? `AGENTLINK_RECOVERY=${recovery}\n` : '', identityFile ? `AGENTLINK_IDENTITY_FILE=${identityFile}\n` : ''].join('')
  return `AGENTLINK_NAME=${name}\nAGENTLINK_DIR=${dir}\nAGENTLINK_SERVER=${server}\nAGENTLINK_TOKEN=${token}\n` +
    `AGENTLINK_WAKE_CMD=${wakeCmd}\nAGENTLINK_WAKE_COOLDOWN=60000\n` +
    `# 安全档默认（2026-10-21）：AGENTLINK_WAKE_FROM 未配置则不唤醒任何发送方；填发送方 id（逗号分隔）开闸，如：\n` +
    `# AGENTLINK_WAKE_FROM=claude.terminal\n` + ident
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
  // T3 身份键：进 KEYS 不进 REQUIRED——存量 env 缺新键合法
  AGENTLINK_ID: 'id', AGENTLINK_RECOVERY: 'recovery', AGENTLINK_IDENTITY_FILE: 'identityFile',
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
