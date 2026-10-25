// skills/agentlink/lib/hooks-install.mjs — im hooks install（设计 v3 §1）
// 把安装目录的 hook-stop.mjs / hook-inject.mjs 三事件（Stop + SessionStart/UserPromptSubmit）
// 合并写入 <projectDir>/.claude/settings.json：追加不替换、command 全串判重、剥 BOM、
// 损坏 JSON 拒写、写前备份 bak-YYYYMMDD-HHmmss（无冒号，Windows 合法）只留最新 3 份。
// hook 路径与身份无关：全身份共用安装目录，运行时按 cwd 解析（r1-M2）。
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const BOM = '﻿'
export const stripBOM = (t) => t.replace(/^﻿/, '')

// 三事件 → 安装目录内 hook 脚本
export function hookCommands(hookDir) {
  return {
    Stop: `node ${join(hookDir, 'hook-stop.mjs')}`,
    SessionStart: `node ${join(hookDir, 'hook-inject.mjs')}`,
    UserPromptSubmit: `node ${join(hookDir, 'hook-inject.mjs')}`,
  }
}

function readSettings(path) {
  if (!existsSync(path)) return {}
  let s
  try { s = JSON.parse(stripBOM(readFileSync(path, 'utf8'))) }
  catch (e) { throw new Error(`settings.json 解析失败（${path}），拒绝写入以免覆写：${e.message}`) }
  return typeof s === 'object' && s !== null ? s : {}
}

// 已配置任一 AgentLink hook 事件（命令串含 hook-inject/hook-stop 路径）
function hasAgentlinkHook(settings, hookDir) {
  for (const evs of Object.values(settings?.hooks ?? {}))
    for (const m of evs ?? []) for (const h of m?.hooks ?? [])
      if (typeof h?.command === 'string' && (h.command.includes('hook-inject.mjs') || h.command.includes('hook-stop.mjs'))) return true
  return false
}

export function installHooks({ projectDir, hookDir, now = () => new Date(), maxBackups = 3 }) {
  const claudeDir = join(projectDir, '.claude')
  const path = join(claudeDir, 'settings.json')
  const localPath = join(claudeDir, 'settings.local.json')
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true })
  const settings = readSettings(path)
  const cmds = hookCommands(hookDir)
  const written = [], skipped = []
  const hooks = settings.hooks ?? (settings.hooks = {})
  for (const [ev, cmd] of Object.entries(cmds)) {
    const arr = Array.isArray(hooks[ev]) ? hooks[ev] : (hooks[ev] = [])
    if (arr.some(m => (m?.hooks ?? []).some(h => h?.command === cmd))) { skipped.push(ev); continue }
    arr.push({ hooks: [{ type: 'command', command: cmd }] })
    written.push(ev)
  }
  if (written.length) {
    // 备份原文件（只备份已存在的）；时间戳无冒号无点，Windows 合法
    if (existsSync(path)) {
      const t = now()
      const pad = (n) => String(n).padStart(2, '0')
      const stamp = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}`
      const bak = join(claudeDir, `settings.json.bak-${stamp}`)
      writeFileSync(bak, readFileSync(path))
      const baks = readdirSync(claudeDir).filter(f => f.startsWith('settings.json.bak-')).sort()
      for (const b of baks.slice(0, Math.max(0, baks.length - maxBackups))) { try { unlinkSync(join(claudeDir, b)) } catch { /* 竞态，下轮再清 */ } }
    }
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n')
  }
  // local 已配置任一 AgentLink hook → 提示二选一（不自动写 local）
  const localConflict = existsSync(localPath) && hasAgentlinkHook(readSettings(localPath), hookDir)
  return { written, skipped, localConflict }
}

// register/upgrade 收尾检测：返回缺失事件清单
export function checkHooks(projectDir, hookDir) {
  const path = join(projectDir, '.claude', 'settings.json')
  const settings = existsSync(path) ? readSettings(path) : {}
  const cmds = hookCommands(hookDir)
  const missing = []
  for (const [ev, cmd] of Object.entries(cmds)) {
    const arr = settings?.hooks?.[ev]
    if (!Array.isArray(arr) || !arr.some(m => (m?.hooks ?? []).some(h => h?.command === cmd))) missing.push(ev)
  }
  return { missing }
}
