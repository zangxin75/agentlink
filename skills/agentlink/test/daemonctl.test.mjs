// skills/agentlink/test/daemonctl.test.mjs — im daemon stop/start/status（设计 v2 §2 / v3）
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'

const lockPath = () => join(mkdtempSync(join(tmpdir(), 'dc-')), 'daemon.lock')

test('statusDaemon：无 lock 文件 → running:false；活 pid → running:true；死 pid → running:false', async () => {
  const { statusDaemon } = await import('../lib/daemonctl.mjs')
  assert.deepEqual(statusDaemon({ lockPath: lockPath() }), { running: false, pid: null }) // 无文件
  const lp = lockPath(); writeFileSync(lp, '12345')
  assert.deepEqual(statusDaemon({ lockPath: lp, alive: () => true }), { running: true, pid: 12345 })
  assert.deepEqual(statusDaemon({ lockPath: lp, alive: () => false }), { running: false, pid: 12345 }) // 死 pid 残留（Windows 硬 kill 不清锁，注释见 v3-6）
})

test('stopDaemon：kill 不存在的 pid（ENOENT/ESRCH）视为已停，不报错；活 pid 收 SIGTERM', async () => {
  const { stopDaemon } = await import('../lib/daemonctl.mjs')
  const signals = []
  const kill = (pid, sig) => {
    if (sig === 0) { const e = new Error('no such'); e.code = 'ESRCH'; throw e }
    signals.push([pid, sig]); return true
  }
  const lp = lockPath(); writeFileSync(lp, '424242')
  const r = await stopDaemon({ lockPath: lp, kill, alive: () => true, waitMs: 10 })
  assert.deepEqual(signals, [[424242, 'SIGTERM'], [424242, 'SIGKILL']]) // 不退 → 升级 SIGKILL
  assert.equal(r.stopped, true)
  // 死 pid（signal 0 抛 ESRCH）：无需 kill，视为已停
  const lp2 = lockPath(); writeFileSync(lp2, '7')
  const r2 = await stopDaemon({ lockPath: lp2, kill, alive: () => false, waitMs: 10 })
  assert.equal(r2.stopped, true); assert.equal(signals.length, 2) // 未新增 kill
})

test('stopDaemon：kill 抛 EPERM（进程存在但非本用户）报错；kill 抛其他错透传', async () => {
  const { stopDaemon } = await import('../lib/daemonctl.mjs')
  const eperm = new Error('EPERM'); eperm.code = 'EPERM'
  await assert.rejects(stopDaemon({ lockPath: (() => { const lp = lockPath(); writeFileSync(lp, '9'); return lp })(), kill: (p, s) => { throw eperm }, alive: () => true, waitMs: 10 }), /EPERM/)
})

test('startDaemon：detached spawn daemon.mjs（spawnImpl 注入断言路径与选项）', async () => {
  const { startDaemon } = await import('../lib/daemonctl.mjs')
  const calls = []
  const fakeSpawn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() {} } }
  const r = await startDaemon({ spawnImpl: fakeSpawn })
  const c = calls[0]
  assert.equal(c.cmd, process.execPath)
  assert.ok(c.args[0].endsWith('daemon.mjs'), c.args[0])
  assert.equal(c.opts.detached, true)
  assert.equal(r.started, true)
})
