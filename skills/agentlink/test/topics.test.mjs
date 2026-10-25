// skills/agentlink/test/topics.test.mjs — projectTopics 向上查找 + pushTopics 注册表续期（T4）
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
// pushTopics 缓存按 agentId 落在 STATE 下——模块加载期求值，先设 env 再 import
process.env.AGENTLINK_STATE = mkdtempSync(join(tmpdir(), 'al-top-state-'))
const { projectTopics, pushTopics } = await import('../lib/topics.mjs')

test('projectTopics: 本目录 .agentlink.json 生效;非法 topic 丢弃;无文件 → []', async () => {
  const root = mkdtempSync(join(tmpdir(), 'al-top-'))
  writeFileSync(join(root, '.agentlink.json'), JSON.stringify({ topics: ['imchat', 'Bad', '_default', 'x'.repeat(33)] }))
  assert.deepEqual(projectTopics(join(root, 'sub', 'dir')), ['imchat']) // 向上找到 + 只剩合法项;_default 声明无意义被滤
  const bare = mkdtempSync(join(tmpdir(), 'al-bare-'))
  assert.deepEqual(projectTopics(bare), [])
  writeFileSync(join(bare, '.agentlink.json'), JSON.stringify({}))
  assert.deepEqual(projectTopics(bare), [])
})

test('pushTopics: 首次与变化才 PUT、1h 内同列表跳过;缓存落盘', async () => {
  const hits = []
  const srv = createServer((req, res) => { hits.push(req.method + ' ' + req.url); res.statusCode = 200; res.end('{}') })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    assert.equal(await pushTopics({ agentId: 'push-a', token: 'tk', server: base, topics: ['imchat'] }), true)
    assert.equal(await pushTopics({ agentId: 'push-a', token: 'tk', server: base, topics: ['imchat'] }), false) // 1h 内同列表 → 跳过
    assert.equal(await pushTopics({ agentId: 'push-a', token: 'tk', server: base, topics: ['imchat', 'ops'] }), true) // 变化 → 再 PUT
    assert.deepEqual(hits, ['PUT /v1/me/topics', 'PUT /v1/me/topics'])
    const cached = JSON.parse(readFileSync(join(process.env.AGENTLINK_STATE, 'topic-push-push-a.json'), 'utf8'))
    assert.deepEqual(cached.topics, ['imchat', 'ops'])
    // 失败不阻塞：坏地址返回 false，且不写新缓存
    assert.equal(await pushTopics({ agentId: 'push-b', token: 'tk', server: 'http://127.0.0.1:1', topics: ['x'] }), false)
  } finally { srv.close() }
})
