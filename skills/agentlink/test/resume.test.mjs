// skills/agentlink/test/resume.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'
import { summarizeResume } from '../lib/resume.mjs'

const SELF = 'me-abc12345'
const T = (over = {}) => ({ id: 'task_1', status: 'RUNNING', to: SELF, action: 'x', ...over })

test('summarizeResume: 未终态任务保留、终态任务剔除、两个角色合并', () => {
  const r = summarizeResume({
    selfId: SELF,
    inbox: [],
    tasks: { requester: [T({ id: 'task_a', status: 'REQUESTED' }), T({ id: 'task_b', status: 'COMPLETED' })],
             executor: [T({ id: 'task_c', status: 'RUNNING' }), T({ id: 'task_d', status: 'TIMEOUT' })] },
    recent: [],
  })
  assert.deepEqual(r.pendingTasks.map(t => t.id), ['task_a', 'task_c']) // COMPLETED/TIMEOUT 是终态,剔除
})

test('summarizeResume: 最近对话方去重、排除自己、按最近消息排序、标注未读', () => {
  const r = summarizeResume({
    selfId: SELF,
    inbox: [{ id: 'm1', from: 'bob-1', to: SELF }, { id: 'm2', from: 'bob-1', to: SELF }],
    tasks: {},
    recent: [
      { id: 'm3', from: 'carol-2', to: SELF, created_at: '2026-10-14T02:00:00Z' },
      { id: 'm4', from: SELF, to: 'bob-1', created_at: '2026-10-14T03:00:00Z' },
      { id: 'm5', from: 'bob-1', to: SELF, created_at: '2026-10-14T04:00:00Z' },
    ],
  })
  // 对话方 = 消息里非自己的那一端；bob-1 最近消息 04:00 在前，carol-2 02:00 在后
  assert.deepEqual(r.peers.map(p => p.peer), ['bob-1', 'carol-2'])
  assert.deepEqual(r.peers.map(p => p.unread), [2, 0]) // bob 有 2 封未读
  assert.equal(r.peers[0].lastAt, '2026-10-14T04:00:00Z')
})

test('summarizeResume: 空状态给出全零摘要而非异常', () => {
  const r = summarizeResume({ selfId: SELF, inbox: [], tasks: {}, recent: [] })
  assert.deepEqual(r.pendingTasks, [])
  assert.deepEqual(r.peers, [])
  assert.equal(r.totalUnread, 0)
})
