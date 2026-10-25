// skills/agentlink/lib/daemonctl.mjs — im daemon stop/start/status（设计 v2 §2 / v3）
// pid 文件 = join(dirname(HEARTBEAT), 'daemon.lock')（daemon.mjs:180 写）。
// Windows 硬 kill 不执行 releaseLock → 死 pid 残留锁；本模块判活用 signal-0，
// 死 pid 一律"视为已停"，acquireLock 的 isAlive 判活会正确接管，残留无害（v3-6）。
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HEARTBEAT } from './identity.mjs'

export const lockPathOf = () => join(dirname(HEARTBEAT), 'daemon.lock')

// signal 0 探活（与 keepalive.mjs isAlive 同语义）：EPERM = 进程存在但非本用户
export const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

function readPid(lp) {
  try { const n = Number.parseInt(readFileSync(lp, 'utf8').trim(), 10); return Number.isInteger(n) ? n : null } catch { return null }
}

export function statusDaemon({ lockPath = lockPathOf(), alive = isAlive } = {}) {
  const pid = readPid(lockPath)
  return { running: !!(pid && alive(pid)), pid }
}

// stop：SIGTERM → 等 waitMs → 仍活 SIGKILL。ENOENT/ESRCH = 已停（视为成功）；EPERM/其他错透传。
export async function stopDaemon({ lockPath = lockPathOf(), kill = process.kill, alive = isAlive, waitMs = 3000, pollMs = 100 } = {}) {
  const pid = readPid(lockPath)
  if (!pid || !alive(pid)) return { stopped: true, pid }
  try { kill(pid, 'SIGTERM') } catch (e) { if (e.code === 'ESRCH' || e.code === 'ENOENT') return { stopped: true, pid }; throw e }
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs))
    if (!alive(pid)) return { stopped: true, pid }
  }
  try { kill(pid, 'SIGKILL') } catch (e) { if (e.code === 'ESRCH' || e.code === 'ENOENT') return { stopped: true, pid }; throw e }
  return { stopped: true, pid }
}

// start：detached spawn daemon.mjs —— 与 upgrade.mjs restartDaemon 同一方式（复用语义，独立导出便于注入测试）
export async function startDaemon({ spawnImpl, clientDir = fileURLToPath(new URL('..', import.meta.url)), log = () => {} } = {}) {
  const { spawn } = await import('node:child_process')
  const impl = spawnImpl ?? spawn
  const p = impl(process.execPath, [join(clientDir, 'daemon.mjs')], { detached: true, stdio: 'ignore', cwd: clientDir })
  p.unref?.()
  log('daemon started')
  return { started: true }
}
