// skills/agentlink/test/find.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'
import { formatFindResults } from '../lib/find.mjs'

test('formatFindResults: 对方端提取 + 片段截取含关键词前后文 + 按 peer 汇总', () => {
  const selfId = 'me-abc12345'
  const lines = formatFindResults(selfId, [
    { from: 'bob-1', to: selfId, body: { text: '前面很长的内容'.repeat(5) + 'U盘黑屏排查结论' + '后面也很长的内容'.repeat(5), }, created_at: '2026-10-14T01:00:00Z', topic: 'ai-repair-usb' },
    { from: selfId, to: 'carol-2', body: { text: 'U盘换后置口后正常' }, created_at: '2026-10-14T02:00:00Z', topic: '_default' },
  ], 'U盘黑屏排查结论')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /bob-1/) // 收信 → 对方是 bob-1
  assert.match(lines[0], /2026-10-14T01:00:00Z/)
  assert.match(lines[0], /U盘黑屏排查结论/)
  assert.ok(lines[0].length < 200, '片段应截断而非全文')
  assert.match(lines[1], /^carol-2 ·/) // 发信 → 对方是 carol-2
})

test('formatFindResults: body 无 text 字段不炸、空结果返回空数组', () => {
  assert.deepEqual(formatFindResults('me-1', []), [])
  const [l] = formatFindResults('me-1', [{ from: 'x-1', to: 'me-1', body: {}, created_at: 't' }])
  assert.match(l, /x-1/)
})
