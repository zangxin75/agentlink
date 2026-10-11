// skills/agentlink/test/autodetect.test.mjs —— 装机自动建档嗅探（纯函数，execFile 全 mock）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = mkdtempSync(join(tmpdir(), 'ad-'))
process.env.AGENTLINK_STATE = state // spool.mjs 的 SPOOL_ROOT 首次 import 固化（前案 I-1 教训）
test.after(() => rmSync(state, { recursive: true, force: true }))

const okExec = (installed) => async (cmd) => {
  if (installed[cmd]) return { stdout: installed[cmd] }
  const e = new Error('not found'); e.code = 'ENOENT'; throw e
}

test('sniffCapabilities：命中工具映射为规范 tag；未命中跳过；去重保序', async () => {
  const { sniffCapabilities } = await import('../lib/autodetect.mjs')
  const tags = await sniffCapabilities({ execFile: okExec({ node: 'v22.1.0', python: 'Python 3.12.0', docker: '27.0', ffmpeg: 'ffmpeg 7' }) })
  assert.ok(tags.includes('node')); assert.ok(tags.includes('python')); assert.ok(tags.includes('docker'))
  assert.equal(tags.length, new Set(tags).size) // 去重
  assert.ok(!tags.some(t => /node-v22|v22/.test(t))) // 版本号不进 tag
})

test('sniffCapabilities：execFile 抛非 ENOENT 错误或超时 → 该工具静默跳过，不整体失败', async () => {
  const { sniffCapabilities } = await import('../lib/autodetect.mjs')
  const exec = async (cmd) => {
    if (cmd === 'node') throw new Error('EACCES')       // 非未安装类错误
    if (cmd === 'python3') { const e = new Error('timed out'); e.timedOut = true; throw e }
    if (cmd === 'git') return { stdout: 'git version 2.43' }
    throw Object.assign(new Error('nf'), { code: 'ENOENT' })
  }
  const tags = await sniffCapabilities({ execFile: exec })
  assert.deepEqual(tags, ['git'])
})

test('buildAutoNotice：草稿命令 + 确认指引 + from=market + 确定性 id；标题折叠换行（前案 M-1 同源）', async () => {
  const { buildAutoNotice } = await import('../lib/autodetect.mjs')
  const n = buildAutoNotice({ id: 'new-1', display_name: '新装\n$(touch /tmp/PWNED3)', description: '', capabilities: ['Node', 'SEO 审计'] })
  assert.equal(n.from, 'market'); assert.equal(n.to, 'new-1')
  assert.match(n.id, /^mkt-auto/)
  assert.ok(!/^\$\(/m.test(n.body.text))                     // 换行折叠，不可伪造命令行
  assert.ok(n.body.text.includes('im market publish service')) // 草稿命令在场
  assert.ok(n.body.text.includes('确认后执行'))                 // 人类确认闸门文案
})

test('buildAutoNotice：嗅探零 tag（全空机器）→ 返回 null（不打扰，不发空档案）', async () => {
  const { buildAutoNotice } = await import('../lib/autodetect.mjs')
  assert.equal(buildAutoNotice({ id: 'x', capabilities: [] }), null)
})

// —— autoProfile：register 尾部胶水（api/spool 全 mock）——
test('autoProfile：嗅探 → PATCH /me → spool 草稿通知；已有 capabilities 则只发草稿不 PATCH', async () => {
  const { autoProfile } = await import('../lib/autodetect.mjs')
  const { unreadList } = await import('../lib/spool.mjs')
  const patches = []
  const api = async (p, o) => { if (p === '/me' && o?.method === 'PATCH') patches.push(o.body.capabilities); return { agent: {} } }
  const sniff = async () => ['node', 'git']
  const run = autoProfile({ sniff })
  const tags = await run(api, { id: 'reg-1', display_name: 'R1', description: '', capabilities: [] })
  assert.deepEqual(tags, ['node', 'git'])
  assert.deepEqual(patches, [['node', 'git']])            // 嗅探结果写入档案
  const msgs = unreadList('reg-1')
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].from, 'market'); assert.match(msgs[0].id, /^mkt-auto-reg-1/)
  assert.ok(msgs[0].body.text.includes('im market publish service')) // 草稿在场
  // 已有 capabilities（注册时 --caps 给过）：不再 PATCH，直接发草稿
  const tags2 = await run(api, { id: 'reg-2', display_name: 'R2', description: '', capabilities: ['seo'] })
  assert.deepEqual(tags2, ['seo']); assert.equal(patches.length, 1)
  assert.ok(unreadList('reg-2').some(m => m.from === 'market'))
})

test('autoProfile：嗅探零 tag → 不 PATCH 不 spool；AGENTLINK_NO_AUTODETECT=1 → 整体跳过', async () => {
  const { autoProfile } = await import('../lib/autodetect.mjs')
  const { unreadList } = await import('../lib/spool.mjs')
  const patches = []
  const api = async (p, o) => { if (o?.method === 'PATCH') patches.push(o.body); return { agent: {} } }
  const run = autoProfile({ sniff: async () => [] })
  assert.deepEqual(await run(api, { id: 'reg-3', capabilities: [] }), [])
  assert.equal(patches.length, 0); assert.equal(unreadList('reg-3').length, 0)
  process.env.AGENTLINK_NO_AUTODETECT = '1'
  try {
    const run2 = autoProfile({ sniff: async () => ['node'] })
    assert.deepEqual(await run2(api, { id: 'reg-4', capabilities: [] }), [])
    assert.equal(patches.length, 0); assert.equal(unreadList('reg-4').length, 0)
  } finally { delete process.env.AGENTLINK_NO_AUTODETECT }
})
