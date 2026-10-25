// skills/agentlink/test/hook-stop.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
const cfg = mkdtempSync(join(tmpdir(), 'hook-cfg-'))
const state = mkdtempSync(join(tmpdir(), 'hook-state-'))
process.env.AGENTLINK_CONFIG = cfg; process.env.AGENTLINK_STATE = state
mkdirSync(join(cfg, 'agents.d'), { recursive: true })
writeFileSync(join(cfg, 'agents.d', 'w.env'), 'AGENTLINK_NAME=w\nAGENTLINK_DIR=/work\nAGENTLINK_SERVER=https://s\nAGENTLINK_TOKEN=t\n')
const { writeMessage, unreadList, claim } = await import('../lib/spool.mjs')
const { agentIdFor } = await import('../lib/identity.mjs')
const { runHook, claimIds } = await import('../hook-stop.mjs')

const idW = agentIdFor('w', 'testhost', '/work') // 与 runHook 注入同一个 fake hostname
writeMessage(idW, { id: 'm1', from: 'p', thread_id: 't', type: 'text', body: { text: 'deploy done' }, created_at: 1 })

test('匹配 cwd → block+注入，且 runHook 不认领（打印先行）', async () => {
  const r1 = await runHook({ cwd: '/work/sub', hostname: 'testhost' })
  assert.equal(r1.decision, 'block')
  assert.equal(r1.agentId, idW)
  assert.deepEqual(r1.items, [{ topic: '_default', id: 'm1' }])
  assert.match(r1.reason, /不可信数据/); assert.match(r1.reason, /deploy done/)
  assert.equal(unreadList(idW).length, 1) // 关键：还没认领——RF3 打印先行
  claimIds(idW, r1.items) // CLI 在 stdout 写出后调用
  assert.equal(unreadList(idW).length, 0)
})
test('认领后二跑为空；无匹配 cwd → null', async () => {
  assert.equal(await runHook({ cwd: '/work/sub', hostname: 'testhost' }), null)
  assert.equal(await runHook({ cwd: '/elsewhere', hostname: 'testhost' }), null)
})
test('claimIds 全部 ENOENT 静默（exit 0 语义，RF3）', () => {
  assert.doesNotThrow(() => claimIds(idW, [{ topic: '_default', id: 'nonexistent' }]))
  assert.equal(claim(idW, '_default', 'nonexistent'), false)
})
