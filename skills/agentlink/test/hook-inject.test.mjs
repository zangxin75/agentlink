// skills/agentlink/test/hook-inject.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
const cfg = mkdtempSync(join(tmpdir(), 'hi-cfg-'))
const state = mkdtempSync(join(tmpdir(), 'hi-state-'))
process.env.AGENTLINK_CONFIG = cfg; process.env.AGENTLINK_STATE = state
mkdirSync(join(cfg, 'agents.d'), { recursive: true })
writeFileSync(join(cfg, 'agents.d', 'w.env'), 'AGENTLINK_NAME=w\nAGENTLINK_DIR=/work\nAGENTLINK_SERVER=https://s\nAGENTLINK_TOKEN=t\n')
const { writeMessage, unreadList } = await import('../lib/spool.mjs')
const { agentIdFor } = await import('../lib/identity.mjs')
const { runHook, claimIds } = await import('../hook-inject.mjs')

const idW = agentIdFor('w', 'testhost', '/work')
writeMessage(idW, { id: 'm1', from: 'p', thread_id: 't', type: 'text', body: { text: 'deploy done' }, created_at: 1 })

test('匹配 cwd → 纯文本注入（含不可信框定头），runHook 不认领', async () => {
  const r = await runHook({ cwd: '/work/sub', hostname: 'testhost' })
  assert.ok(r)
  assert.equal(r.decision, undefined) // 纯文本注入契约——与 Stop 的 block 契约区分
  assert.deepEqual(r.ids, [['_default', 'm1']])
  assert.ok(r.text.includes('AgentLink 未读消息'))
  assert.ok(r.text.includes('不可信数据'))
  assert.ok(r.text.includes('from=p'))
  assert.ok(r.text.includes('deploy done'))
  assert.deepEqual(unreadList(idW).map(m => m.id), ['m1']) // 尚未认领
})

test('不匹配 cwd / 空收件箱 → null 静默', async () => {
  assert.equal(await runHook({ cwd: '/elsewhere', hostname: 'testhost' }), null)
  // 认领后再跑：无未读 → null（会话内重复触发不重复注入）
  claimIds(idW, [['_default', 'm1']])
  assert.equal(unreadList(idW).length, 0)
  assert.equal(await runHook({ cwd: '/work', hostname: 'testhost' }), null)
})

// ---- T4：按项目 topic 过滤注入 + 异 topic 警告 ----

// 夹具：第二个 agent，dir 指向带 .agentlink.json 的临时项目根
const projRoot = mkdtempSync(join(tmpdir(), 'hi-proj-'))
writeFileSync(join(projRoot, '.agentlink.json'), JSON.stringify({ topics: ['imchat'] }))
writeFileSync(join(cfg, 'agents.d', 't.env'), `AGENTLINK_NAME=t\nAGENTLINK_DIR=${projRoot}\nAGENTLINK_SERVER=http://127.0.0.1:1\nAGENTLINK_TOKEN=t\n`)
const idT = agentIdFor('t', 'testhost', projRoot)
writeMessage(idT, { id: 't1', topic: 'imchat', from: 'p', type: 'text', body: { text: 'm1-body' }, created_at: 1 })
writeMessage(idT, { id: 't2', topic: 'promote', from: 'p', type: 'text', body: { text: 'm2-body' }, created_at: 2 })
writeMessage(idT, { id: 't3', from: 'p', type: 'text', body: { text: 'm3-body' }, created_at: 3 }) // 无 topic → _default

test('hook: 只注入本会话 topics ∪ _default;异 topic pending 出警告行;信头带 topic', async () => {
  const r = await runHook({ cwd: join(projRoot, 'sub'), hostname: 'testhost' })
  assert.ok(r)
  assert.ok(r.text.includes('m1-body'))
  assert.ok(r.text.includes('m3-body'))
  assert.ok(!r.text.includes('m2-body')) // promote 未订阅 → 不注入正文
  assert.ok(r.text.includes('topic=imchat'))
  assert.ok(r.text.includes('topic=广播')) // _default 渲染为广播
  assert.ok(r.text.includes('⚠ 存在 1 封落在 topic「promote」'))
  // ids 为 [topic, msgId] 对，且只含被注入的信
  assert.deepEqual(r.ids, [['imchat', 't1'], ['_default', 't3']])
  claimIds(idT, r.ids)
  assert.equal(unreadList(idT, 'imchat').length, 0)
  assert.equal(unreadList(idT, '_default').length, 0)
  assert.deepEqual(unreadList(idT, 'promote').map(m => m.id), ['t2']) // 未注入的不认领
})

test('hook: 无 .agentlink.json 的 cwd → 只见 _default,不报错', async () => {
  const r = await runHook({ cwd: '/work', hostname: 'testhost' }) // /work 无 .agentlink.json 且已无未读
  assert.equal(r, null)
  writeMessage(idW, { id: 'm9', topic: 'other', from: 'p', type: 'text', body: { text: 'm9-body' }, created_at: 9 })
  const r2 = await runHook({ cwd: '/work', hostname: 'testhost' })
  assert.ok(r2)
  assert.ok(!r2.text.includes('m9-body')) // 未声明的 topic 只警告
  assert.ok(r2.text.includes('⚠ 存在 1 封落在 topic「other」'))
  claimIds(idW, [])
  claimIds(idW, [['other', 'm9']]) // 清理
})
