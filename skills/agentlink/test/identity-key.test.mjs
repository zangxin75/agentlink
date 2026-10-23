// skills/agentlink/test/identity-key.test.mjs — T3：identity key 落盘 + AGENTLINK_ID 优先
// 注意：AGENTLINK_CONFIG/STATE 必须在任何 identity.mjs/spool 导入前设置（模块级常量）
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'

const cfg = mkdtempSync(join(tmpdir(), 'ik-cfg-'))
const state = mkdtempSync(join(tmpdir(), 'ik-state-'))
process.env.AGENTLINK_CONFIG = cfg
process.env.AGENTLINK_STATE = state
mkdirSync(join(cfg, 'agents.d'), { recursive: true })

// ---- 纯函数接口 ----
const { agentIdFor, agentIdFromEnv, parseEnvFile, buildAgentEnv, loadOrCreateIdentityKey } =
  await import('../lib/identity.mjs')

const BASE62 = /^[A-Za-z0-9]+$/

test('loadOrCreateIdentityKey: 指定路径生成 al_ident_+43 base62,0600,幂等同值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idkey-'))
  const file = join(dir, 'identity.key')
  const k1 = loadOrCreateIdentityKey(file)
  assert.match(k1, /^al_ident_[A-Za-z0-9]{43}$/)
  assert.ok(BASE62.test(k1.slice('al_ident_'.length))) // 43 字符 base62 ≈ 256-bit
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const k2 = loadOrCreateIdentityKey(file) // 幂等：两次调用同值
  assert.equal(k1, k2)
})

test('loadOrCreateIdentityKey: 已存在文件直接读,不覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idkey-'))
  const file = join(dir, 'identity.key')
  writeFileSync(file, 'al_ident_ppppppppppppppppppppppppppppppppppppppppppp', { mode: 0o600 })
  assert.equal(loadOrCreateIdentityKey(file), 'al_ident_ppppppppppppppppppppppppppppppppppppppppppp')
})

test('loadOrCreateIdentityKey: AGENTLINK_IDENTITY_FILE 重定位默认路径', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idkey-'))
  const file = join(dir, 'relocated.key')
  const prev = process.env.AGENTLINK_IDENTITY_FILE
  try {
    process.env.AGENTLINK_IDENTITY_FILE = file
    const k = loadOrCreateIdentityKey()
    assert.match(k, /^al_ident_/)
    assert.ok(existsSync(file))
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(k, loadOrCreateIdentityKey()) // 幂等
  } finally { prev === undefined ? delete process.env.AGENTLINK_IDENTITY_FILE : (process.env.AGENTLINK_IDENTITY_FILE = prev) }
})

test('agentIdFromEnv: e.id 优先;无 id 回退公式', () => {
  const h = 'host1'
  assert.equal(agentIdFromEnv({ id: 'alice.explicit', name: 'alice', dir: '/w' }, h), 'alice.explicit')
  assert.equal(agentIdFromEnv({ name: 'alice', dir: '/w' }, h), agentIdFor('alice', h, '/w'))
})

test('parseEnvFile: 认三新键;缺新键不报错(REQUIRED 语义不变)', () => {
  const base = 'AGENTLINK_NAME=n\nAGENTLINK_DIR=/w\nAGENTLINK_SERVER=https://s\nAGENTLINK_TOKEN=t\n'
  const e = parseEnvFile(base + 'AGENTLINK_ID=n-explicit\nAGENTLINK_RECOVERY=al_rec_x\nAGENTLINK_IDENTITY_FILE=/tmp/k.key\n')
  assert.equal(e.id, 'n-explicit')
  assert.equal(e.recovery, 'al_rec_x')
  assert.equal(e.identityFile, '/tmp/k.key')
  const old = parseEnvFile(base) // 存量 env 缺新键合法
  assert.equal(old.id, undefined)
  assert.equal(old.recovery, undefined)
})

test('buildAgentEnv: id/recovery 可选写入,name/dir 原样保留(兼容窗口)', () => {
  const plain = buildAgentEnv('n', '/w', 'https://s', 'tk')
  assert.ok(plain.includes('AGENTLINK_NAME=n\n'))
  assert.ok(plain.includes('AGENTLINK_DIR=/w\n'))
  assert.ok(!plain.includes('AGENTLINK_ID='))
  const withId = buildAgentEnv('n', '/w', 'https://s', 'tk', { id: 'n-explicit', recovery: 'al_rec_r' })
  assert.ok(withId.includes('AGENTLINK_NAME=n\n')) // 原 name/dir 照写——未升级 daemon 仍按公式算出原 id,spool 不错位
  assert.ok(withId.includes('AGENTLINK_DIR=/w\n'))
  assert.ok(withId.includes('AGENTLINK_ID=n-explicit\n'))
  assert.ok(withId.includes('AGENTLINK_RECOVERY=al_rec_r\n'))
  const env = parseEnvFile(withId)
  assert.equal(env.id, 'n-explicit')
  assert.equal(env.recovery, 'al_rec_r')
})

// ---- 行为级：env 带 AGENTLINK_ID 时 spool 目录用显式 id(hook-inject 为例) ----

writeFileSync(join(cfg, 'agents.d', 'x.env'),
  'AGENTLINK_NAME=x\nAGENTLINK_DIR=/workx\nAGENTLINK_SERVER=https://s\nAGENTLINK_TOKEN=t\nAGENTLINK_ID=x.explicit-id\n')
const { writeMessage } = await import('../lib/spool.mjs')
const { runHook } = await import('../hook-inject.mjs')

test('hook: env 带 AGENTLINK_ID → spool 目录用显式 id', async () => {
  writeMessage('x.explicit-id', { id: 'k1', from: 'p', type: 'text', body: { text: 'explicit-id body' }, created_at: 1 })
  const r = await runHook({ cwd: '/workx', hostname: 'whatever' })
  assert.ok(r)
  assert.equal(r.agentId, 'x.explicit-id')
  assert.ok(r.text.includes('explicit-id body'))
  assert.deepEqual(r.ids, [['_default', 'k1']])
})

// ---- fix round 1：原子写 + 既有文件校验 + register 不信进程环境 AGENTLINK_ID ----

test('loadOrCreateIdentityKey: 既有文件空/前缀错/长度异常 → 抛中文错且含路径,不静默改写', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idkey-'))
  for (const [label, content] of [['空文件', ''], ['前缀错', 'sk_badprefix_aaaa'], ['长度异常', 'al_ident_short']]) {
    const file = join(dir, label.length + '-' + Math.random().toString(36).slice(2) + '.key')
    writeFileSync(file, content, { mode: 0o600 })
    assert.throws(() => loadOrCreateIdentityKey(file),
      (e) => e.message.includes(file) && e.message.includes('identity'),
      `应抛错: ${label}`)
    // 不静默改写：异常文件原样保留
    assert.equal(readFileSync(file, 'utf8'), content)
  }
})

test('agentIdFromEnv: 空串 AGENTLINK_ID 视同缺失回退公式', async () => {
  const { agentIdFromEnv: aife } = await import('../lib/identity.mjs')
  assert.equal(aife({ id: '', name: 'bob', dir: '/b' }, 'h2'), agentIdFor('bob', 'h2', '/b'))
})

test('register: 进程环境 AGENTLINK_ID 不被信任——server 收到公式 id,env 文件钉的是公式 id', async () => {
  const { execFile } = await import('node:child_process')
  const { createServer } = await import('node:http')
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const work = mkdtempSync(join(tmpdir(), 'ik-reg-'))
  const seen = []
  const srv = createServer((req, res) => {
    let b = ''
    req.on('data', (c) => b += c)
    req.on('end', () => {
      if (req.url === '/v1/agents') {
        seen.push(JSON.parse(b).agent_id)
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ agent: { id: JSON.parse(b).agent_id, capabilities: [] }, token: 'al_tok' }))
      } else { res.statusCode = 404; res.end() }
    })
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  const imPath = fileURLToPath(new URL('../im.mjs', import.meta.url))
  const env = {
    ...process.env,
    AGENTLINK_SERVER: `http://127.0.0.1:${port}`,
    AGENTLINK_CONFIG: cfg, AGENTLINK_STATE: state,
    AGENTLINK_CODE: 'x', AGENTLINK_ID: 'evil.foreign-id', AGENTLINK_NO_AUTODETECT: '1',
    HOME: work, // 隔离 ~/.agentlink 等副作用
  }
  const [err, so, se] = await new Promise((r) =>
    execFile(process.execPath, [imPath, 'register', 'regname', '--code', 'x', '--no-autodetect', '--dir', work], { env }, (e, o, x) => r([e, o, x])))
  srv.close()
  assert.ok(!err, `register 应成功: ${se}`)
  assert.equal(seen[0], agentIdFor('regname', (await import('node:os')).hostname(), work)) // 公式 id,非 evil.foreign-id
  assert.ok(!seen[0].startsWith('evil'))
  const envFile = readFileSync(join(cfg, 'agents.d', 'regname.env'), 'utf8')
  assert.ok(envFile.includes(`AGENTLINK_ID=${seen[0]}\n`)) // env 文件钉的是公式 id
})
