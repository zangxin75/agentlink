// skills/agentlink/test/upgrade-file-replace.test.mjs — upgrade 逐文件替换（设计 v2 §2 / v3-2，Windows EBUSY 修复）
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, copyFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'; import { join } from 'node:path'

// 造一个假 dist（fetchImpl 从磁盘读）+ 假 tar（spawnImpl 直接拷贝新树到 unpack）
function makeWorld() {
  const root = mkdtempSync(join(tmpdir(), 'up-'))
  const clientDir = join(root, 'client')
  const dist = join(root, 'dist')
  const newTree = join(root, 'newtree') // tar 解包后应有的 agentlink/ 内容
  mkdirSync(join(clientDir, 'lib'), { recursive: true }); mkdirSync(join(clientDir, 'data'), { recursive: true })
  mkdirSync(join(newTree, 'lib'), { recursive: true }); mkdirSync(dist, { recursive: true })
  // 旧客户端：im.mjs + lib/keep.mjs + lib/old.mjs（新包已删）+ data/agentlink.db（白名单外，必须保留）
  writeFileSync(join(clientDir, 'im.mjs'), 'OLD im')
  writeFileSync(join(clientDir, 'lib/keep.mjs'), 'OLD keep')
  writeFileSync(join(clientDir, 'lib/old.mjs'), 'OLD old')
  writeFileSync(join(clientDir, 'data/agentlink.db'), 'runtime data')
  // 新包
  writeFileSync(join(newTree, 'im.mjs'), 'NEW im')
  writeFileSync(join(newTree, 'lib/keep.mjs'), 'NEW keep')
  writeFileSync(join(newTree, 'VERSION'), '9.9.9-20991234-deadbee')
  const tgz = Buffer.from('fake tarball')
  writeFileSync(join(dist, 'agentlink.tar.gz'), tgz)
  writeFileSync(join(dist, 'SHA256SUMS'), `${createHash('sha256').update(tgz).digest('hex')}  agentlink.tar.gz\n`)
  const fetchImpl = async (url) => url.endsWith('SHA256SUMS')
    ? new Response(readFileSync(join(dist, 'SHA256SUMS')))
    : new Response(readFileSync(join(dist, 'agentlink.tar.gz')))
  // 假 tar：把 newTree 拷到 -C 指定目录下的 agentlink/
  const spawnImpl = (cmd, args, opts) => ({
    on(ev, fn) { if (ev === 'exit') { const c = args[args.indexOf('-C') + 1]; mkdirSync(join(c, 'agentlink'), { recursive: true }); cpSync(newTree, join(c, 'agentlink'), { recursive: true }); fn(0) } },
  })
  return { root, clientDir, dist, newTree, fetchImpl, spawnImpl }
}

async function apply(world, extra = {}) {
  const { applyUpgrade } = await import('../lib/upgrade.mjs')
  return applyUpgrade({ distBase: 'https://x', clientDir: world.clientDir, fetchImpl: world.fetchImpl, spawnImpl: world.spawnImpl, log: () => {}, ...extra })
}

test('applyUpgrade：逐文件替换——白名单内旧文件删除、白名单外（data/）保留、daemon 先停后起', async () => {
  const w = makeWorld()
  const order = []
  const stop = async () => { order.push('stop') }
  const start = async () => { order.push('start') }
  const v = await apply(w, { stopDaemonImpl: stop, startDaemonImpl: start })
  assert.equal(v, '9.9.9-20991234-deadbee')
  assert.equal(readFileSync(join(w.clientDir, 'im.mjs'), 'utf8'), 'NEW im')
  assert.equal(readFileSync(join(w.clientDir, 'lib/keep.mjs'), 'utf8'), 'NEW keep')
  assert.ok(!existsSync(join(w.clientDir, 'lib/old.mjs')), 'lib/ 下新包没有的旧文件应删除')
  assert.ok(existsSync(join(w.clientDir, 'data/agentlink.db')), 'data/ 白名单外必须保留')
  assert.equal(readFileSync(join(w.clientDir, 'data/agentlink.db'), 'utf8'), 'runtime data')
  assert.deepEqual(order, ['stop', 'start'])
})

test('applyUpgrade：daemon start 失败非致命（keepalive 兜底），升级结果仍返回', async () => {
  const w = makeWorld()
  const v = await apply(w, { stopDaemonImpl: async () => {}, startDaemonImpl: async () => { throw new Error('spawn fail') } })
  assert.equal(v, '9.9.9-20991234-deadbee') // start 失败不回滚不抛错
  assert.equal(readFileSync(join(w.clientDir, 'im.mjs'), 'utf8'), 'NEW im')
})

test('applyUpgrade：中途 copy 失败——保留已完成文件并抛错；重跑幂等成功', async () => {
  const w = makeWorld()
  let calls = 0
  const copyImpl = (src, dst) => { copyFileSync(src, dst); if (++calls === 2) throw new Error('disk full') }
  await assert.rejects(apply(w, { stopDaemonImpl: async () => {}, startDaemonImpl: async () => {}, copyImpl }), /disk full/)
  assert.equal(readFileSync(join(w.clientDir, 'VERSION'), 'utf8').trim(), '9.9.9-20991234-deadbee') // 已完成的部分替换保留（readdir 顺序，VERSION 在 im.mjs 前被拷）
  // 重跑（真 copy）成功
  const v = await apply(w, { stopDaemonImpl: async () => {}, startDaemonImpl: async () => {} })
  assert.equal(v, '9.9.9-20991234-deadbee')
  assert.ok(!existsSync(join(w.clientDir, 'lib/old.mjs')))
})

test('applyUpgrade：重跑（内容已一致）幂等，不误删 data/ 与无并发的多余文件', async () => {
  const w = makeWorld()
  await apply(w, { stopDaemonImpl: async () => {}, startDaemonImpl: async () => {} })
  writeFileSync(join(w.clientDir, 'untracked-note.txt'), 'user file') // 白名单外顶层文件
  const v = await apply(w, { stopDaemonImpl: async () => {}, startDaemonImpl: async () => {} })
  assert.equal(v, '9.9.9-20991234-deadbee')
  assert.ok(existsSync(join(w.clientDir, 'untracked-note.txt')))
  assert.ok(existsSync(join(w.clientDir, 'data/agentlink.db')))
})
