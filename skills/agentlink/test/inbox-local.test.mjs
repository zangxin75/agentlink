// skills/agentlink/test/inbox-local.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
const cfg = mkdtempSync(join(tmpdir(), 'ib-cfg-')); const state = mkdtempSync(join(tmpdir(), 'ib-state-'))
process.env.AGENTLINK_CONFIG = cfg; process.env.AGENTLINK_STATE = state
mkdirSync(join(cfg, 'agents.d'), { recursive: true })
writeFileSync(join(cfg, 'agents.d', 'w.env'), 'AGENTLINK_NAME=w\nAGENTLINK_DIR=/work\nAGENTLINK_SERVER=https://s.invalid\nAGENTLINK_TOKEN=t\n')
const { writeMessage } = await import('../lib/spool.mjs')
const { agentIdFor } = await import('../lib/identity.mjs')
const idW = agentIdFor('w', 'testhost', '/work')
writeMessage(idW, { id: 'm1', from: 'p', thread_id: 't', type: 'text', body: { text: 'local msg' }, created_at: 1 })
const { heartbeatFresh, localInbox, localInboxPlan } = await import('../lib/inbox-local.mjs')

test('心跳新鲜 → 只读本地（即便本地为空也 needRest=false）；心跳过期 → needRest=true', () => {
  const hb = join(state, 'heartbeat'); writeFileSync(hb, ''); utimesSync(hb, new Date(), new Date())
  assert.equal(heartbeatFresh(30_000), true)
  assert.deepEqual(localInbox({ cwd: '/work/sub', hostname: 'testhost' }).map(m => m.id), ['m1'])
  const planFresh = localInboxPlan({ cwd: '/work/sub', hostname: 'testhost' })
  assert.equal(planFresh.needRest, false) // 心跳新鲜：只信本地（RF4）
  utimesSync(hb, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000))
  assert.equal(heartbeatFresh(30_000), false)
  const plan = localInboxPlan({ cwd: '/work/sub', hostname: 'testhost' })
  assert.equal(plan.needRest, true); assert.equal(plan.cursor, 'm1') // 游标含本地未读
})
test('heartbeat 文件缺失 → needRest=true（daemon 从未跑过）', () => {
  // HEARTBEAT 在模块加载期求值——env 切换须走子进程（进程内 re-import 命中缓存，测不到）
  const cfg2 = mkdtempSync(join(tmpdir(), 'ib-cfg2-')); const state2 = mkdtempSync(join(tmpdir(), 'ib-state2-'))
  const r = execFileSync(process.execPath, ['--input-type=module', '-e', `
    process.env.AGENTLINK_CONFIG = ${JSON.stringify(cfg2)}; process.env.AGENTLINK_STATE = ${JSON.stringify(state2)}
    const { heartbeatFresh } = await import(${JSON.stringify(new URL('../lib/inbox-local.mjs', import.meta.url).href)})
    if (heartbeatFresh(30_000) !== false) process.exit(1)
  `])
  assert.equal(r.length, 0) // exit 0 即通过；非零会抛
})
