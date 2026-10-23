// skills/agentlink/test/hooks-install.test.mjs — im hooks install（三事件接线，设计 v3 §1）
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'

const hookDir = () => join(tmpdir(), 'agentlink-fake-client') // 假安装目录（含 hook 脚本名）

async function run(args = {}) {
  const { installHooks } = await import('../lib/hooks-install.mjs')
  return installHooks(args)
}

const proj = () => {
  const p = mkdtempSync(join(tmpdir(), 'hk-'))
  mkdirSync(join(p, '.claude'), { recursive: true })
  return p
}

test('installHooks：全新项目写入三事件（Stop/SessionStart/UserPromptSubmit），命令含安装目录 hook 绝对路径', async () => {
  const p = proj()
  const r = await run({ projectDir: p, hookDir: hookDir(), now: () => new Date('2026-10-22T10:30:00Z') })
  const s = JSON.parse(readFileSync(join(p, '.claude/settings.json'), 'utf8'))
  assert.deepEqual(Object.keys(s.hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'])
  const stopCmd = s.hooks.Stop[0].hooks[0].command
  assert.ok(stopCmd.includes(join(hookDir(), 'hook-stop.mjs')), stopCmd)
  assert.ok(s.hooks.SessionStart[0].hooks[0].command.includes('hook-inject.mjs'))
  assert.ok(s.hooks.UserPromptSubmit[0].hooks[0].command.includes('hook-inject.mjs'))
  assert.deepEqual(r.written.sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'])
  assert.equal(r.skipped.length, 0)
})

test('installHooks：已有事件追加不替换，command 全串相等判重跳过', async () => {
  const p = proj()
  const mine = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node /my/other-hook.mjs' }] }] } }
  writeFileSync(join(p, '.claude/settings.json'), JSON.stringify(mine, null, 2))
  await run({ projectDir: p, hookDir: hookDir(), now: () => new Date('2026-10-22T10:30:00Z') })
  const s = JSON.parse(readFileSync(join(p, '.claude/settings.json'), 'utf8'))
  assert.equal(s.hooks.Stop.length, 2) // 保留既有 + 追加
  assert.ok(s.hooks.Stop.some(x => x.hooks[0].command === 'node /my/other-hook.mjs'))
  const again = await run({ projectDir: p, hookDir: hookDir(), now: () => new Date('2026-10-22T10:31:00Z') })
  assert.deepEqual(again.written, [])            // 全部已存在
  assert.deepEqual(again.skipped.sort(), ['SessionStart', 'Stop', 'UserPromptSubmit'])
})

test('installHooks：剥 BOM 后读写；写回 2 空格缩进 + 末尾换行；保留非 hooks 键', async () => {
  const p = proj()
  writeFileSync(join(p, '.claude/settings.json'), '﻿' + JSON.stringify({ model: 'opus', hooks: {} }))
  await run({ projectDir: p, hookDir: hookDir(), now: () => new Date('2026-10-22T10:30:00Z') })
  const raw = readFileSync(join(p, '.claude/settings.json'), 'utf8')
  assert.ok(!raw.startsWith('﻿'))
  assert.ok(raw.endsWith('\n'))
  assert.ok(raw.includes('\n  "hooks"')) // 2 空格缩进
  const s = JSON.parse(raw)
  assert.equal(s.model, 'opus')
})

test('installHooks：损坏 JSON 拒绝写入并抛错，原文件不动；无备份损坏污染', async () => {
  const p = proj()
  writeFileSync(join(p, '.claude/settings.json'), '{ broken json !!')
  await assert.rejects(run({ projectDir: p, hookDir: hookDir(), now: () => new Date() }), /parse|解析|JSON/i)
  assert.equal(readFileSync(join(p, '.claude/settings.json'), 'utf8'), '{ broken json !!')
})

test('installHooks：写前备份 bak-YYYYMMDD-HHmmss（无冒号），只留最新 3 份', async () => {
  const p = proj()
  writeFileSync(join(p, '.claude/settings.json'), '{}')
  for (const [H, M] of [[10, 0], [10, 1], [10, 2], [10, 3]]) {
    await run({ projectDir: p, hookDir: hookDir(), now: () => new Date(2026, 9, 22, H, M, 0) }) // 本地时间分量，避开时区偏移
    // 每轮模拟“用户又改了 settings.json 后重装”：换成无 hook 的新内容，触发再次写入+备份
    writeFileSync(join(p, '.claude/settings.json'), '{}')
  }
  const baks = readdirSync(join(p, '.claude')).filter(f => f.startsWith('settings.json.bak-'))
  assert.equal(baks.length, 3)
  for (const b of baks) assert.ok(!/[:.]/.test(b.slice('settings.json.bak-'.length)), b) // Windows 合法文件名
  assert.ok(baks.includes('settings.json.bak-20261022-100100'))
  assert.ok(!baks.includes('settings.json.bak-20261022-100000')) // 最旧的被清
})

test('installHooks：.claude 不存在时 mkdir；缺省 projectDir = cwd（调用方传 process.cwd()）', async () => {
  const p = mkdtempSync(join(tmpdir(), 'hk2-')) // 无 .claude
  const r = await run({ projectDir: p, hookDir: hookDir(), now: () => new Date() })
  assert.equal(r.written.length, 3)
  assert.ok(existsSync(join(p, '.claude/settings.json')))
})

test('installHooks：settings.local.json 已配置任一 AgentLink hook → 返回提示标记', async () => {
  const p = proj()
  writeFileSync(join(p, '.claude/settings.local.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${join(hookDir(), 'hook-stop.mjs')}` }] }] } }))
  const r = await run({ projectDir: p, hookDir: hookDir(), now: () => new Date() })
  assert.equal(r.localConflict, true)
})

test('checkHooks：返回缺失事件清单（供 register/upgrade 收尾提示）', async () => {
  const { checkHooks } = await import('../lib/hooks-install.mjs')
  const p = proj()
  assert.equal(checkHooks(p, hookDir()).missing.length, 3) // 无 settings.json → 三缺
  writeFileSync(join(p, '.claude/settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${join(hookDir(), 'hook-stop.mjs')}` }] }] } }))
  const c = checkHooks(p, hookDir())
  assert.deepEqual(c.missing.sort(), ['SessionStart', 'UserPromptSubmit'])
})
