// skills/agentlink/test/spool.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
// SPOOL_ROOT 在模块加载期求值——必须先设 env 再动态 import（静态 import 会被 hoist，读到真实 home）
process.env.AGENTLINK_STATE = mkdtempSync(join(tmpdir(), 'spool-'))
const { writeMessage, unreadList, unreadListMulti, unreadAll, claim, maxCursor, cleanup, clearTmp } = await import('../lib/spool.mjs')

const A = 't-agent-00000001'
const msg = (id, at) => ({ id, from: 'peer-x', thread_id: 'thr_1', type: 'text', body: { text: 'hi ' + id }, created_at: at, received_at: at })
const spoolTopic = (a, topic = '_default') => join(process.env.AGENTLINK_STATE, 'spool', a, 'topics', topic)

test('writeMessage 幂等：同 id 二写不重复、received_at 保留首写', () => {
  assert.equal(writeMessage(A, msg('a', 1)), true)
  assert.equal(writeMessage(A, msg('a', 2)), false) // 重复投递覆盖=跳过
  assert.equal(unreadList(A).length, 1)
})
test('spool 按 topic 分目录布局：写入落在 topics/<topic>/ 下', () => {
  assert.equal(existsSync(join(spoolTopic(A), 'a.json')), true)          // 缺省 topic → _default
  writeMessage(A, { id: 'a-t', topic: 'imchat', from: 'p', type: 'text', body: {}, created_at: 1 })
  assert.equal(existsSync(join(spoolTopic(A, 'imchat'), 'a-t.json')), true)
})

test('claim 原子认领：一胜一跳；consumed 后 writeMessage 不复活（r2-F12）', () => {
  writeMessage(A, msg('b', 2))
  assert.equal(claim(A, '_default', 'b'), true)
  assert.equal(claim(A, '_default', 'b'), false) // 输家
  assert.equal(writeMessage(A, msg('b', 3)), false) // 已 consumed，重放不注入
  assert.equal(unreadList(A).filter(m => m.id === 'b').length, 0)
  assert.equal(existsSync(join(spoolTopic(A), 'consumed', 'b.json')), true) // 认领后进本 topic consumed/
})

test('maxCursor 合并两目录（跨 topic 全局）', () => {
  writeMessage(A, msg('c', 3))
  // consumed/ 里手动放一个更大的 id
  writeMessage(A, msg('z9', 4)); claim(A, '_default', 'z9')
  assert.equal(maxCursor(A), 'z9')
  assert.equal(maxCursor('t-empty-00000002'), null)
})

test('unreadList 按 created_at 升序，忽略 tmp', () => {
  writeMessage(A, msg('d2', 9))
  // 简报原文期望 ['a','d2']，但前述用例写入的 'c'（created_at=3，未认领）仍在未读队列，
  // 按“created_at 升序”语义应为 ['a','c','d2']——修正期望以匹配声明的行为
  assert.deepEqual(unreadList(A).map(m => m.id), ['a', 'c', 'd2'])
})

test('cleanup: consumed>7天删、未读永不动；clearTmp 删孤儿', () => {
  writeMessage(A, msg('old', 5)); claim(A, '_default', 'old')
  const p = JSON.parse(readFileSync(join(spoolTopic(A), 'consumed', 'old.json'), 'utf8'))
  p.received_at = Date.now() - 8 * 86400_000
  writeFileSync(join(spoolTopic(A), 'consumed', 'old.json'), JSON.stringify(p))
  writeFileSync(join(spoolTopic(A), 'orphan.tmp'), '{}')
  writeMessage(A, { id: 'o-t', topic: 'imchat', from: 'p', type: 'text', body: {}, created_at: 6 })
  writeFileSync(join(spoolTopic(A, 'imchat'), 'orphan2.tmp'), '{}') // clearTmp 遍历全部 topics
  cleanup(A, Date.now()); clearTmp(A)
  assert.equal(existsSync(join(spoolTopic(A), 'consumed', 'old.json')), false)
  assert.equal(existsSync(join(spoolTopic(A), 'orphan.tmp')), false)
  assert.equal(existsSync(join(spoolTopic(A, 'imchat'), 'orphan2.tmp')), false)
  assert.equal(unreadList(A).length > 0, true)
})

// ---- T3：topic 布局新用例（简报 Step 1 逐字） ----

test('spool 按 topic 分目录:写入/读取/认领互不串', () => {
  const A2 = 't-agent-1'
  writeMessage(A2, { id: 'm1', topic: 'imchat', from: 'x', to: A2, type: 'text', body: { text: 'a' }, created_at: 1 })
  writeMessage(A2, { id: 'm2', topic: 'promote', from: 'x', to: A2, type: 'text', body: { text: 'b' }, created_at: 2 })
  writeMessage(A2, { id: 'm3', from: 'x', to: A2, type: 'text', body: { text: 'c' }, created_at: 3 }) // 无 topic → _default
  assert.deepEqual(unreadList(A2, 'imchat').map(m => m.id), ['m1'])
  assert.deepEqual(unreadList(A2, 'promote').map(m => m.id), ['m2'])
  assert.deepEqual(unreadList(A2, '_default').map(m => m.id), ['m3'])
  assert.ok(claim(A2, 'imchat', 'm1'))
  assert.deepEqual(unreadList(A2, 'imchat'), [])
  assert.deepEqual(unreadList(A2, 'promote').map(m => m.id), ['m2']) // 认领不跨 topic 误伤
})

test('同 msg id 已 consumed 后换 topic 重放不复活（补洞场景）', () => {
  const A2 = 't-agent-2'
  assert.ok(writeMessage(A2, { id: 'm9', topic: 'imchat', from: 'x', to: A2, type: 'text', body: {}, created_at: 1 }))
  claim(A2, 'imchat', 'm9')
  assert.equal(writeMessage(A2, { id: 'm9', topic: 'imchat', from: 'x', to: A2, type: 'text', body: {}, created_at: 1 }), false)
  // 服务器旧帧若 topic 缺失重放为 _default:consumed 只看本 topic 目录,_default 落盘但同 id pending 亦拒绝
  assert.equal(writeMessage(A2, { id: 'm9', from: 'x', to: A2, type: 'text', body: {}, created_at: 1 }), true) // _default 目录首次 → 落盘
  assert.equal(writeMessage(A2, { id: 'm9', from: 'x', to: A2, type: 'text', body: {}, created_at: 1 }), false) // 同目录重复 → 拒
})

test('maxCursor 跨 topic 全局取最大（RF3）', () => {
  const A2 = 't-agent-3'
  writeMessage(A2, { id: 'msg_00A', topic: 'imchat', from: 'x', to: A2, type: 'text', body: {}, created_at: 1 })
  writeMessage(A2, { id: 'msg_00B', topic: 'promote', from: 'x', to: A2, type: 'text', body: {}, created_at: 2 })
  assert.equal(maxCursor(A2), 'msg_00B')
})

test('unreadListMulti 聚合多 topic 并按 created_at 排序;unreadAll 列全部', () => {
  const A2 = 't-agent-4'
  writeMessage(A2, { id: 'n1', topic: 'imchat', from: 'x', to: A2, type: 'text', body: {}, created_at: 1 })
  writeMessage(A2, { id: 'n2', topic: '_default', from: 'x', to: A2, type: 'text', body: {}, created_at: 2 })
  assert.deepEqual(unreadListMulti(A2, ['imchat', '_default']).map(m => m.id), ['n1', 'n2'])
  const all = unreadAll(A2)
  assert.deepEqual(all.map(x => x.topic).sort(), ['_default', 'imchat'])
})
