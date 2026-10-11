// skills/agentlink/lib/upgrade.mjs — 客户端自升级（发现→校验→换目录→重启 daemon）
// 与 install.ps1/install.sh 语义一致但零依赖跨平台：tar 用系统 bsdtar/GNU tar，Windows 优先 System32 绝对路径（Git Bash GNU tar 遮蔽问题，agent18 实测）
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
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

export async function applyUpgrade({ distBase, clientDir = CLIENT_DIR, log = () => {}, fetchImpl = fetch, spawnImpl = spawn }) {
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
    if (!existsSync(join(unpack, 'agentlink'))) throw new Error('解包后无 agentlink/ 目录')
    const old = join(parent, `.al-old-${Date.now()}`)
    renameSync(clientDir, old)       // 同卷原子换目录；失败保留旧版可手工恢复
    try { renameSync(join(unpack, 'agentlink'), clientDir) }
    catch (e) { renameSync(old, clientDir); throw e } // 换入失败：回滚旧版
    rmSync(old, { recursive: true, force: true })
    const v = readFileSync(join(clientDir, 'VERSION'), 'utf8').trim()
    log(`upgraded -> ${v}`)
    return v
  } finally { rmSync(stage, { recursive: true, force: true }) }
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
