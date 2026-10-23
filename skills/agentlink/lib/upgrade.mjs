// skills/agentlink/lib/upgrade.mjs — 客户端自升级（发现→校验→换目录→重启 daemon）
// 与 install.ps1/install.sh 语义一致但零依赖跨平台：tar 用系统 bsdtar/GNU tar，Windows 优先 System32 绝对路径（Git Bash GNU tar 遮蔽问题，agent18 实测）
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname, basename, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { httpBase } from './identity.mjs'

export const CLIENT_DIR = fileURLToPath(new URL('..', import.meta.url))

export function localVersion() { try { return readFileSync(join(CLIENT_DIR, 'VERSION'), 'utf8').trim() } catch { return null } } // dev checkout 无 VERSION → null（自动升级跳过的判据）

export function resolveDistBase(server, envBase) {
  if (envBase) return envBase.replace(/\/+$/, '')
  return httpBase(server).replace(/\/+$/, '') + '/download'
}

export async function fetchLatest(distBase) {
  const res = await fetch(`${distBase}/latest-version`)
  if (!res.ok) throw new Error(`latest-version -> ${res.status}`)
  return (await res.text()).trim()
}

// 版本串形如 0.0.0-YYYYMMDD-shorthash：日期段数值比较；同日不同 hash 视为更新（重新分发）
// 两边都无日期段（git tag 版本）时退化为"不同即更新"
export function isNewer(latest, current) {
  if (!latest) return false
  if (!current) return true
  if (latest === current) return false
  const d = (v) => Number((v.match(/(\d{8})/) ?? [0, 0])[1])
  if (d(latest) === 0 && d(current) === 0) return true
  return d(latest) > d(current) || (d(latest) === d(current) && d(latest) > 0)
}

function tarExe() {
  if (process.platform === 'win32') {
    const sys = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (existsSync(sys)) return sys
  }
  return 'tar'
}

// 递归列相对路径文件清单（升级替换/删除的依据）；相对路径统一 '/' 分隔（白名单正则跨平台一致）
function walkFiles(root, base = root, out = []) {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name)
    if (e.isDirectory()) walkFiles(p, base, out)
    else if (e.isFile()) out.push(relative(base, p).split(sep).join('/'))
  }
  return out
}

// 白名单删除：只有代码路径可被新包清单 diff 删除；data/ 等运行时文件一律不动（v3-2）
const DELETABLE = /^(im\.mjs|lib\/|bin\/|contrib\/|vendor\/)/

export async function applyUpgrade({
  distBase, clientDir = CLIENT_DIR, log = () => {}, fetchImpl = fetch, spawnImpl = spawn,
  copyImpl = copyFileSync, stopDaemonImpl = defaultStopDaemon, startDaemonImpl = defaultStartDaemon,
}) {
  // 审计 2026-10-20：http:// distBase 下 tar.gz 与 SHA256SUMS 同信道明文（SUMS 只防损坏不防 MITM）——一次性 stderr 告警
  if (/^http:\/\//.test(distBase)) console.error(`⚠ 升级源非 HTTPS（${distBase}），包与校验和可被同路篡改；生产环境请配置 HTTPS 的 AGENTLINK_DIST_BASE`)
  const parent = dirname(clientDir)
  const stage = join(parent, `.al-upg-${Date.now()}`)
  mkdirSync(stage, { recursive: true })
  try {
    const tgz = join(stage, 'agentlink.tar.gz')
    const res = await fetchImpl(`${distBase}/agentlink.tar.gz`)
    if (!res.ok) throw new Error(`agentlink.tar.gz -> ${res.status}`)
    writeFileSync(tgz, Buffer.from(await res.arrayBuffer()))
    const sumsRes = await fetchImpl(`${distBase}/SHA256SUMS`)
    if (!sumsRes.ok) throw new Error(`SHA256SUMS -> ${sumsRes.status}`)
    const want = (await sumsRes.text()).split('\n').find(l => /  agentlink\.tar\.gz$/.test(l))?.split(' ')[0]
    if (!want) throw new Error('SHA256SUMS 无 agentlink.tar.gz 条目')
    const got = createHash('sha256').update(readFileSync(tgz)).digest('hex')
    if (got !== want) throw new Error(`SHA256 校验失败: 期望 ${want} 实得 ${got}`)
    const unpack = join(stage, 'unpack')
    mkdirSync(unpack, { recursive: true })
    await new Promise((ok, err) => {
      const p = spawnImpl(tarExe(), ['-xzf', tgz, '-C', unpack], { stdio: 'ignore' })
      p.on('error', err); p.on('exit', (c) => c === 0 ? ok() : err(new Error(`tar exit=${c}`)))
    })
    const src = join(unpack, 'agentlink')
    if (!existsSync(src)) throw new Error('解包后无 agentlink/ 目录')

    // v2 §2（Windows EBUSY 修复）：不做目录 rename——升级进程自身与 daemon 都持 im.mjs 句柄，
    // Windows 下 rename 目录必 EBUSY。改逐文件 copyFileSync 覆盖：node 已加载的模块不受覆盖影响。
    // daemon 活着先停（减少持句柄方）；替换中途失败保留已完成文件，tarball 校验已过 → 重跑幂等。
    await stopDaemonImpl()
    const newFiles = walkFiles(src)
    for (const rel of newFiles) {
      const dst = join(clientDir, rel)
      mkdirSync(dirname(dst), { recursive: true })
      copyImpl(join(src, rel), dst)
    }
    const newSet = new Set(newFiles)
    for (const rel of walkFiles(clientDir))
      if (!newSet.has(rel) && DELETABLE.test(rel)) { try { unlinkSync(join(clientDir, rel)) } catch (e) { log(`del skip ${rel}: ${e.message}`) } }
    // 替换后拉起 daemon；失败非致命——systemd Restart / Windows 计划任务 5 分钟兜底会拉起新目录
    try { await startDaemonImpl() } catch (e) { log(`daemon start 失败（keepalive 兜底）: ${e.message}`) }
    const v = readFileSync(join(clientDir, 'VERSION'), 'utf8').trim()
    log(`upgraded -> ${v}`)
    return v
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

// 缺省实现走 daemonctl（测试注入假实现）；keepalive 竞态窗口（stop→start 间计划任务 respawn 落空）
    // 属静默失败下轮成功，无害（v2 §2 注释要求）
async function defaultStopDaemon() {
  const { stopDaemon } = await import('./daemonctl.mjs')
  return stopDaemon()
}
async function defaultStartDaemon() {
  const { startDaemon } = await import('./daemonctl.mjs')
  return startDaemon()
}

// 换目录后自重启：新 daemon 从同一 daemon.mjs 路径拉起（systemd/计划任务路径不变）
export function restartDaemon({ spawnImpl = spawn, log = () => {} } = {}) {
  const p = spawnImpl(process.execPath, [join(CLIENT_DIR, 'daemon.mjs')], { detached: true, stdio: 'ignore', cwd: CLIENT_DIR })
  p.unref()
  log('daemon restarted')
}

export async function autoUpgradeOnce({ server, envBase, autoUpgradeEnabled, log = () => {} }) {
  if (!autoUpgradeEnabled) return null
  const cur = localVersion()
  if (!cur) return null // dev checkout：跳过
  const base = resolveDistBase(server, envBase)
  const latest = await fetchLatest(base)
  if (!isNewer(latest, cur)) return null
  log(`autoupgrade: ${cur} -> ${latest}`)
  await applyUpgrade({ distBase: base, log })
  return latest
}
