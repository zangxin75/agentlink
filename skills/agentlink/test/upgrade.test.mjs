// skills/agentlink/test/upgrade.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer as httpServer } from 'node:http'
import { gzipSync } from 'node:zlib'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

test('isNewer：日期段比较；同日不同 hash 视为更新；无日期退化不同即更新；同版/空不升', async () => {
  const { isNewer } = await import('../lib/upgrade.mjs')
  assert.equal(isNewer('0.0.0-20261011-aaa', '0.0.0-20261010-bbb'), true)
  assert.equal(isNewer('0.0.0-20261010-aaa', '0.0.0-20261011-bbb'), false)
  assert.equal(isNewer('0.0.0-20261011-aaa', '0.0.0-20261011-bbb'), true)  // 同日重分发
  assert.equal(isNewer('0.0.0-20261011-aaa', '0.0.0-20261011-aaa'), false)
  assert.equal(isNewer('v1.2.3', 'v1.2.2'), true)   // 无日期段：不同即更新
  assert.equal(isNewer('x', ''), true)
  assert.equal(isNewer('', 'y'), false)
})

test('resolveDistBase：env 覆盖优先；缺省从 server 派生并去尾斜杠', async () => {
  const { resolveDistBase } = await import('../lib/upgrade.mjs')
  assert.equal(resolveDistBase('wss://s.example', 'https://mirror.example/x/'), 'https://mirror.example/x')
  assert.equal(resolveDistBase('wss://s.example'), 'https://s.example/download')
  assert.equal(resolveDistBase('http://s.example:8080/'), 'http://s.example:8080/download')
})

test('fetchLatest：读 latest-version 文本并 trim', async () => {
  const h = httpServer((req, res) => { if (req.url === '/download/latest-version') { res.end('0.0.0-20261011-abc1234\n') } else { res.statusCode = 404; res.end() } })
  await new Promise(r => h.listen(0, r))
  const { fetchLatest } = await import('../lib/upgrade.mjs')
  assert.equal(await fetchLatest(`http://127.0.0.1:${h.address().port}/download`), '0.0.0-20261011-abc1234')
  h.close()
})

test('applyUpgrade：SHA256 校验→解包→换目录→回读新 VERSION；校验失败即拒', async () => {
  const { applyUpgrade } = await import('../lib/upgrade.mjs')
  const root = mkdtempSync(join(tmpdir(), 'upg-'))
  const clientDir = join(root, 'client'); mkdirSync(clientDir)
  writeFileSync(join(clientDir, 'VERSION'), '0.0.0-20261010-old')
  // 假 dist：真 gzip 内容 + 真 sha256（crypto 自算，不依赖子进程）
  const newTree = { 'agentlink/VERSION': '0.0.0-20261011-new' }
  const tgz = gzipSync(Buffer.from('tar-simulated')) // 内容任意——解包由假 tar 完成
  const sha = createHash('sha256').update(tgz).digest('hex')
  const fakeFetch = async (url) => {
    if (url.endsWith('/agentlink.tar.gz')) return { ok: true, arrayBuffer: async () => tgz }
    if (url.endsWith('/SHA256SUMS')) return { ok: true, text: async () => `${sha}  agentlink.tar.gz\n` }
    return { ok: false, status: 404 }
  }
  const fakeTar = (exe, args) => { // 模拟 tar：按清单落出 agentlink/ 目录
    const unpack = args[args.indexOf('-C') + 1]
    mkdirSync(join(unpack, 'agentlink'), { recursive: true })
    for (const [p, c] of Object.entries(newTree)) writeFileSync(join(unpack, p), c)
    return { on(ev, fn) { if (ev === 'exit') fn(0) } }
  }
  const badFetch = async (url) => url.endsWith('/agentlink.tar.gz')
    ? { ok: true, arrayBuffer: async () => Buffer.from('tampered') }
    : { ok: true, text: async () => `${sha}  agentlink.tar.gz\n` }
  await assert.rejects(applyUpgrade({ distBase: 'http://x', clientDir, fetchImpl: badFetch, spawnImpl: fakeTar }), /SHA256/)
  const v = await applyUpgrade({ distBase: 'http://x', clientDir, fetchImpl: fakeFetch, spawnImpl: fakeTar })
  assert.equal(v, '0.0.0-20261011-new')
  assert.equal(readFileSync(join(clientDir, 'VERSION'), 'utf8'), '0.0.0-20261011-new')
  const { readdirSync } = await import('node:fs')
  assert.ok(!readdirSync(root).some(f => f.startsWith('.al-old-') || f.startsWith('.al-upg-')), 'staging/旧版目录已清理')
})

test('localVersion：dev checkout 无 VERSION → null（daemon 自动升级据此跳过）', async () => {
  const { localVersion } = await import('../lib/upgrade.mjs')
  assert.equal(localVersion(), null) // repo checkout 无 VERSION（构建产物才有）
})
