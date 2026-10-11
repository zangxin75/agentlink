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

test('env 新键：4 个市场守望/飞书键进 KEYS 白名单（r1-M1：漏了整体静默 no-op）', () => {
  const e = parseEnvFile([
    'AGENTLINK_NAME=w', 'AGENTLINK_DIR=/w', 'AGENTLINK_SERVER=ws://x', 'AGENTLINK_TOKEN=t',
    'AGENTLINK_MARKET_WATCH=0', 'AGENTLINK_MARKET_WATCH_INTERVAL=120',
    'AGENTLINK_FEISHU_WEBHOOK=https://open.feishu.cn/hook/x', 'AGENTLINK_FEISHU_SECRET=sec',
  ].join('\n'))
  assert.equal(e.marketWatch, '0')
  assert.equal(e.marketWatchInterval, '120')
  assert.equal(e.feishuWebhook, 'https://open.feishu.cn/hook/x')
  assert.equal(e.feishuSecret, 'sec')
})

test('未配置市场键：输出无该键（默认值由消费方兜底）', () => {
  const e = parseEnvFile('AGENTLINK_NAME=w\nAGENTLINK_DIR=/w\nAGENTLINK_SERVER=ws://x\nAGENTLINK_TOKEN=t')
  assert.equal('marketWatch' in e, false); assert.equal('feishuWebhook' in e, false)
})

// —— register 默认 WAKE_CMD 安全档（2026-10-12）：--max-turns 防跑飞 + Unix timeout 防网络类挂起 ——
test('buildAgentEnv：默认唤醒命令带 --max-turns 20；非 win32 加 timeout 600 前缀，win32 不加', async () => {
  const { buildAgentEnv } = await import('../lib/identity.mjs')
  const txt = buildAgentEnv('im1', '/work', 'https://s', 'al_t')
  const m = txt.match(/AGENTLINK_WAKE_CMD=(.+)/)
  assert.ok(m, 'env 缺 WAKE_CMD')
  assert.match(m[1], /--max-turns 20/)
  assert.match(m[1], /claude -p "/)
  if (process.platform === 'win32') assert.ok(!m[1].startsWith('timeout '))
  else assert.match(m[1], /^timeout 600 claude -p "/)
  assert.match(txt, /AGENTLINK_WAKE_COOLDOWN=60000/)
})
