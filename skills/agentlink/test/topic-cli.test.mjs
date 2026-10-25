// send 决策链纯函数部分:不连网,直接测 lib/topics-cli.mjs 的 decideTopic
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('decideTopic: --reply 命中本地原信 → 继承其 topic', async () => {
  const { decideTopic } = await import('../lib/topics-cli.mjs')
  // 夹具:临时 state 目录 spool 已有 consumed 记录 {id:'m1', topic:'imchat'}
  assert.equal(await decideTopic({ to: 'x', reply: 'm1', localLookup: async () => 'imchat', fetchTopics: async () => [] }), 'imchat')
})
test('decideTopic: --reply 本地查不到 → 回退注册表;恰 1 个自动;0 个 → _default', async () => {
  const { decideTopic } = await import('../lib/topics-cli.mjs')
  assert.equal(await decideTopic({ reply: 'gone', localLookup: async () => null, fetchTopics: async () => [{ topic: 'promote' }] }), 'promote')
  assert.equal(await decideTopic({ reply: 'gone', localLookup: async () => null, fetchTopics: async () => [] }), '_default')
})
test('decideTopic: ≥2 个 → 抛错含列表(强制分诊);--topic 显式直用', async () => {
  const { decideTopic } = await import('../lib/topics-cli.mjs')
  await assert.rejects(decideTopic({ localLookup: async () => null, fetchTopics: async () => [{ topic: 'a' }, { topic: 'b' }] }), /a.*b/)
  assert.equal(await decideTopic({ topic: 'imchat', fetchTopics: async () => [{ topic: 'a' }, { topic: 'b' }] }), 'imchat')
})
