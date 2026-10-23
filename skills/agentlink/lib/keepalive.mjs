// skills/agentlink/lib/keepalive.mjs — daemon 保活三件套：单实例锁 / 进程自愈 / systemd 注册刷新
// 背景（2026-10-15）：Windows 只有启动文件夹 .lnk（开机拉一次，中途死了没人管）、Linux unit 是
// Restart=on-failure、daemon 无锁无自愈——外部保活（计划任务/systemd）重复拉起会双开。三件套随
// 升级包分发：锁让任何保活机制幂等，自愈扛单次异常，注册刷新让存量机器靠 6h 自升级补上新 unit。
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

// 默认存活检查：signal 0 只探测不发送，跨平台（Windows 同样语义）；EPERM = 进程存在但非本用户
const isAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

// 单实例锁：lock 文件记 pid。活进程持锁 → 拒绝（保活拉起方据此秒退）；死 pid/坏内容/无文件 → 接管。
// 写不进（目录只读等）也返回 ok:false——宁可本轮不起，不可双开。
export function acquireLock(lockPath, pid = process.pid, alive = isAlive) {
  let holder = null
  try { holder = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10) || null } catch {}
  if (holder && holder !== pid && alive(holder)) return { ok: false, holder }
  try { writeFileSync(lockPath, String(pid), { mode: 0o600 }) } catch (e) { return { ok: false, holder, error: e.message } }
  return { ok: true, holder }
}

// 只删自己的锁：升级前让位/正常退出时调用；别人的锁（已被接管）不动
export function releaseLock(lockPath, pid = process.pid) {
  try { if (Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10) === pid) unlinkSync(lockPath) } catch {}
}

// 进程自愈：uncaughtException / unhandledRejection 只记日志继续跑——保活语义是"能不崩就不崩"，
// 崩了由 systemd Restart=always / Windows 计划任务兜底。on/off 可注入（测试），返回卸载函数。
export function installSelfHeal(log = () => {}, on = (ev, fn) => process.on(ev, fn), off = (ev, fn) => process.removeListener(ev, fn)) {
  const handlers = [
    ['uncaughtException', (e) => log(`自愈: uncaughtException 已捕获继续运行: ${e?.stack ?? e}`)],
    ['unhandledRejection', (r) => log(`自愈: unhandledRejection 已捕获继续运行: ${r?.stack ?? r}`)],
  ]
  for (const [ev, fn] of handlers) on(ev, fn)
  return () => { for (const [ev, fn] of handlers) off(ev, fn) }
}

// 注册刷新（升级传播）：daemon 启动时对已注册的 systemd unit 做内容比对，过期则覆写 + daemon-reload。
// 未注册不强装（尊重用户未启用 daemon 的选择）；Windows 保活是计划任务，路径不变则无需刷新。
export function ensureKeepalive({
  platform = process.platform,
  clientRoot = fileURLToPath(new URL('..', import.meta.url)),
  systemdDir, run = defaultRun, log = () => {}, taskExists = defaultTaskExists,
} = {}) {
  // Windows 存量机器只自升级了 daemon.mjs，没人重跑 install.ps1——任务缺失时由 daemon 自补注册
  // （幂等，contrib 脚本内部 -Force；组策略拒绝时脚本自行打印降级提示，此处只记日志不炸）
  if (platform === 'win32') {
    try { if (taskExists('agentlink-daemon-keepalive')) return { changed: false } } catch { return { changed: false } }
    try { run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(clientRoot, 'contrib', 'agentlink-daemon-keepalive.ps1')]) }
    catch (e) { log(`keepalive: Windows 保活任务补注册失败: ${e.message}`); return { changed: false } }
    log('keepalive: Windows 保活计划任务已补注册（每 5 分钟拉起，幂等）')
    return { changed: true }
  }
  const dir = systemdDir ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.config/systemd/user')
  const src = join(clientRoot, 'contrib', 'agentlink-daemon.service')
  const dst = join(dir, 'agentlink-daemon.service')
  let cur; try { cur = readFileSync(dst, 'utf8') } catch { return { changed: false } } // 未注册 → no-op
  let want; try { want = readFileSync(src, 'utf8') } catch { return { changed: false } } // contrib 缺失（checkout 不全）→ no-op
  if (cur === want) return { changed: false }
  try { writeFileSync(dst, want) } catch (e) { log(`keepalive: unit 覆写失败: ${e.message}`); return { changed: false } }
  try { run('systemctl', ['--user', 'daemon-reload']) } catch {}
  log('keepalive: systemd unit 已刷新（Restart=always 下次重启生效）')
  return { changed: true }
}

function defaultRun(cmd, args) { // systemctl/powershell 可能不存在：spawn error 事件必须有监听，否则自身变 uncaught
  const p = spawn(cmd, args, { stdio: 'ignore' })
  p.on?.('error', () => {})
  return p
}

function defaultTaskExists(name) { // schtasks /Query 退出码 0 = 任务存在（仅 win32 路径会调）
  try { const r = spawnSync('schtasks', ['/Query', '/TN', name], { stdio: 'ignore' }); return r.status == null ? true : r.status === 0 } catch { return true } // 查不动（无 schtasks/被拒）视为已存在——宁可少注册不反复尝试
}
