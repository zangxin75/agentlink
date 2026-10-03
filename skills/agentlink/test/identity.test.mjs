// skills/agentlink/test/identity.test.mjs
import test from 'node:test'; import assert from 'node:assert/strict'
import { agentIdFor, parseEnvFile, matchAgentForCwd, httpBase, wsUrl } from '../lib/identity.mjs'

test('agentIdFor: 同输入同输出、base36 格式合法、name 超长抛错', () => {
  const id = agentIdFor('claude-terminal', 'boxA', '/home/kt/proj')
  assert.equal(id, agentIdFor('claude-terminal', 'boxA', '/home/kt/proj'))
  assert.match(id, /^claude-terminal-[0-9a-z]{8}$/) // base36 小写（spec §3）
  assert.ok(id.length <= 32)
  assert.throws(() => agentIdFor('a'.repeat(24), 'boxA', '/d')) // 24+1+8=33 超限
  assert.throws(() => agentIdFor('Bad_Name', 'h', '/d')) // 大写/下划线不合正则
})

test('httpBase/wsUrl: 四种 scheme 转换', () => {
  assert.equal(httpBase('wss://x.example'), 'https://x.example')
  assert.equal(httpBase('ws://127.0.0.1:8080'), 'http://127.0.0.1:8080')
  assert.equal(httpBase('https://x.example'), 'https://x.example')
  assert.equal(wsUrl('https://x.example'), 'wss://x.example/ws')
  assert.equal(wsUrl('http://127.0.0.1:8080'), 'ws://127.0.0.1:8080/ws')
  assert.equal(wsUrl('ws://127.0.0.1:8080'), 'ws://127.0.0.1:8080/ws')
  assert.equal(wsUrl('https://x.example/'), 'wss://x.example/ws') // 尾斜杠归一
})

test('parseEnvFile: 注释/空行/未知键容忍，缺键抛错', () => {
  const e = parseEnvFile('# comment\n\nAGENTLINK_NAME=x\nAGENTLINK_DIR=/w\nAGENTLINK_SERVER=https://s\nAGENTLINK_TOKEN=t\nUNKNOWN=1\n')
  assert.deepEqual({ name: e.name, dir: e.dir, server: e.server, token: e.token },
    { name: 'x', dir: '/w', server: 'https://s', token: 't' })
  assert.throws(() => parseEnvFile('AGENTLINK_NAME=x\n'), /missing/)
})

test('matchAgentForCwd: 最长前缀胜出、无匹配 null、前缀须是路径边界', () => {
  const es = [{ name: 'a', dir: '/home/kt' }, { name: 'b', dir: '/home/kt/proj' }]
  assert.equal(matchAgentForCwd(es, '/home/kt/proj/deep').name, 'b')
  assert.equal(matchAgentForCwd(es, '/home/kt').name, 'a')
  assert.equal(matchAgentForCwd(es, '/home/other'), null)
  assert.equal(matchAgentForCwd(es, '/home/ktx'), null) // /home/kt 不是 /home/ktx 的目录前缀
})
