// skills/agentlink/test/identity-cli.test.mjs — Task 4：register --claim/--new-identity 与 identity bind/rotate
// fetch 全部经 fixtures/preload-fetch.mjs 注入（--import 预加载替换 globalThis.fetch），不起真服。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const imPath = fileURLToPath(new URL('../im.mjs', import.meta.url))
const preload = fileURLToPath(new URL('./fixtures/preload-fetch.mjs', import.meta.url))

// 子进程跑 im.mjs：HOME/配置/状态全部隔离进临时目录；routes 即 mock 路由表
async function runIm(args, { routes = {}, env = {}, cwd } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'identcli-'))
  mkdirSync(join(work, 'cfg')); mkdirSync(join(work, 'state'))
  const log = join(work, 'fetch.log')
  const [err, so, se] = await new Promise((r) => execFile(process.execPath, [imPath, ...args], {
    cwd: cwd ?? work,
    env: {
      ...process.env, HOME: work, IM_CONFIG_DIR: join(work, 'cfg'),
      AGENTLINK_CONFIG: join(work, 'cfg'), AGENTLINK_STATE: join(work, 'state'),
      AGENTLINK_SERVER: 'http://mock.local', AGENTLINK_NO_AUTODETECT: '1',
      NODE_OPTIONS: `--import ${preload}`,
      IM_FETCH_ROUTES: JSON.stringify(routes), IM_FETCH_LOG: log,
      ...env,
    },
  }, (e, o, x) => r([e, o, x])))
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  return { err, so: String(so), se: String(se), calls, work }
}

const KEY_RE = /^al_ident_[A-Za-z0-9]{43}$/
const mkKey = () => 'al_ident_' + 'k'.repeat(43)

// —— register 默认带 key（新注册 200 流）——
test('register：默认携带 identity_key；成功后 env 写 AGENTLINK_ID/RECOVERY，recovery 只在 stderr 出现一次', async () => {
  const r = await runIm(['register', 'regname', '--code', 'x', '--no-autodetect'], {
    routes: { '/v1/agents': { status: 200, body: { agent: { id: 'regname-abc' }, token: 'al_t1', recovery_code: 'al_rec_new1' } } },
  })
  assert.ok(!r.err, `register 应成功: ${r.se}`)
  const call = r.calls.find(c => c.url.endsWith('/v1/agents'))
  assert.ok(KEY_RE.test(call.body.identity_key), `请求应带合法 identity_key: ${JSON.stringify(call.body)}`)
  // T3 约定：env 钉注册时公式 id（与请求 agent_id 同值），非 mock 回显 id
  const { agentIdFor } = await import('../lib/identity.mjs')
  const formulaId = agentIdFor('regname', (await import('node:os')).hostname(), r.work)
  const envFile = readFileSync(join(r.work, 'cfg', 'agents.d', 'regname.env'), 'utf8')
  assert.ok(envFile.includes(`AGENTLINK_ID=${formulaId}\n`))
  assert.ok(envFile.includes('AGENTLINK_RECOVERY=al_rec_new1\n'))
  assert.ok(envFile.includes(`AGENTLINK_TOKEN=al_t1\n`))
  assert.ok(!r.so.includes('al_rec_new1'), 'stdout 不得出现 recovery 明文')
  assert.ok(r.se.includes('al_rec_new1'), 'stderr 应提示 recovery 一次')
})

// —— register 409 IDENTITY_MULTI：列身份 + 两分支指引 ——
test('register 409 MULTI：stderr 列已绑身份并给出 --claim / --new-identity 两分支指引', async () => {
  const r = await runIm(['register', 'regname', '--code', 'x', '--no-autodetect'], {
    routes: { '/v1/agents': { status: 409, body: { error: { code: 'IDENTITY_MULTI', message: 'multi', agents: ['old-abc', 'old2-def'], hint: 'im register --claim' } } } },
  })
  assert.ok(r.err, '应非零退出')
  assert.ok(r.se.includes('old-abc') && r.se.includes('old2-def'), `stderr 应列身份: ${r.se}`)
  assert.ok(r.se.includes('--claim'), '应提示 --claim')
  assert.ok(r.se.includes('--new-identity'), '应提示 --new-identity')
})

// —— register --claim ——
test('register --claim：调 /v1/identity/claim（免注册码），env 写回原 AGENTLINK_ID + 新 token + recovery，stdout 提示旧设备下线', async () => {
  const r = await runIm(['register', '--claim'], {
    routes: { '/v1/identity/claim': { status: 200, body: { agent: { id: 'orig-id-x1' }, token: 'al_t9', recovery_code: 'al_rec_clm' } } },
  })
  assert.ok(!r.err, `--claim 应成功: ${r.se}`)
  const call = r.calls.find(c => c.url.endsWith('/v1/identity/claim'))
  assert.ok(call, '应调 claim 端点')
  assert.equal(call.body.registration_code, undefined)
  assert.ok(KEY_RE.test(call.body.identity_key))
  assert.ok(r.so.includes('身份已找回，旧设备已下线'), `stdout: ${r.so}`)
  assert.ok(!r.so.includes('al_rec_clm'), 'stdout 不得出现 recovery')
  // env：原 agent_id 钉入 AGENTLINK_ID，NAME/DIR 保留（老 daemon 兼容窗口）
  const envFile = readFileSync(join(r.work, 'cfg', 'agents.d', 'orig-id.env'), 'utf8')
  assert.ok(envFile.includes('AGENTLINK_ID=orig-id-x1\n'))
  assert.ok(envFile.includes('AGENTLINK_TOKEN=al_t9\n'))
  assert.ok(envFile.includes('AGENTLINK_RECOVERY=al_rec_clm\n'))
  assert.ok(envFile.includes('AGENTLINK_NAME=orig-id\n'))
  assert.ok(envFile.includes(`AGENTLINK_DIR=${r.work}\n`))
})

test('register --claim <agent_id>：agent_id 透传消歧；409 MULTI 提示带 agent_id', async () => {
  const r = await runIm(['register', '--claim', 'old2-def'], {
    routes: { '/v1/identity/claim': { status: 409, body: { error: { code: 'IDENTITY_MULTI', message: 'm', agents: ['old-abc', 'old2-def'], hint: 'agent_id' } } } },
  })
  assert.ok(r.err)
  const call = r.calls.find(c => c.url.endsWith('/v1/identity/claim'))
  assert.equal(call.body.agent_id, 'old2-def')
  assert.ok(r.se.includes('old-abc') && r.se.includes('--claim'))
})

test('register --claim 401：凭据无效即退（统一口径）', async () => {
  const r = await runIm(['register', '--claim'], {
    routes: { '/v1/identity/claim': { status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'bad' } } } },
  })
  assert.ok(r.err)
  assert.ok(r.se.includes('401') || r.se.includes('凭据'))
})

// —— register --new-identity ——
test('register --new-identity：用独立 key 文件（缺省 ~/.agentlink/identity-2.key），不动主 key', async () => {
  const r = await runIm(['register', 'second', '--code', 'x', '--no-autodetect', '--new-identity'], {
    routes: { '/v1/agents': { status: 200, body: { agent: { id: 'second-fff' }, token: 'al_t2', recovery_code: 'al_rec_2nd' } } },
  })
  assert.ok(!r.err, `应成功: ${r.se}`)
  const key2 = readFileSync(join(r.work, '.agentlink', 'identity-2.key'), 'utf8').trim()
  const call = r.calls.find(c => c.url.endsWith('/v1/agents'))
  assert.equal(call.body.identity_key, key2)
  assert.ok(!existsSync(join(r.work, '.agentlink', 'identity.key')), '不得触碰主 key 文件')
})

test('register：key 文件损坏 → 非零退出 + 中文处置指引（含路径）', async () => {
  const work = mkdtempSync(join(tmpdir(), 'identcli-corrupt-'))
  mkdirSync(join(work, '.agentlink'), { recursive: true })
  const bad = join(work, '.agentlink', 'identity.key')
  writeFileSync(bad, 'garbage-not-a-key')
  const [err, , se] = await new Promise((r2) => execFile(process.execPath, [imPath, 'register', 'n1', '--code', 'x', '--no-autodetect'], {
    cwd: work,
    env: { ...process.env, HOME: work, AGENTLINK_SERVER: 'http://mock.local', IM_CONFIG_DIR: join(work, 'cfg'), AGENTLINK_CONFIG: join(work, 'cfg'), AGENTLINK_STATE: join(work, 'state'), AGENTLINK_NO_AUTODETECT: '1', NODE_OPTIONS: `--import ${preload}`, IM_FETCH_ROUTES: '{}', IM_FETCH_LOG: join(work, 'l') },
  }, (e, o, x) => r2([e, o, x])))
  assert.ok(err, '损坏 key 应非零退出')
  assert.ok(se.includes(bad) && se.includes('人工'), `stderr 应含路径与处置指引: ${se}`)
})

// —— identity bind / rotate ——
function seedAgentEnv(work, { name = 'a1', id, token = 'al_old', dir } = {}) {
  const dir2 = dir ?? work
  const envName = name
  writeFileSync(join(work, 'cfg', 'agents.d', `${envName}.env`), [
    `AGENTLINK_NAME=${name}`, `AGENTLINK_DIR=${dir2}`, 'AGENTLINK_SERVER=http://mock.local',
    `AGENTLINK_TOKEN=${token}`, `AGENTLINK_WAKE_CMD=true`, 'AGENTLINK_WAKE_COOLDOWN=60000',
    ...(id ? [`AGENTLINK_ID=${id}`] : []),
  ].join('\n') + '\n', { mode: 0o600 })
  return dir2
}

test('identity bind：Bearer 用该 agent env 的 token；recovery 写回 env；stdout 不漏明文', async () => {
  const work = mkdtempSync(join(tmpdir(), 'identcli-bind-'))
  mkdirSync(join(work, 'cfg/agents.d'), { recursive: true })
  seedAgentEnv(work, { id: 'a1-abc' })
  const r = await runIm(['identity', 'bind'], {
    routes: { '/v1/identity/bind': { status: 201, body: { recovery_code: 'al_rec_bnd' } } },
    env: { HOME: work, IM_CONFIG_DIR: join(work, 'cfg'), AGENTLINK_CONFIG: join(work, 'cfg'), AGENTLINK_STATE: join(work, 'state') },
    cwd: work,
  })
  assert.ok(!r.err, `bind 应成功: ${r.se}`)
  const call = r.calls.find(c => c.url.endsWith('/v1/identity/bind'))
  assert.equal(call.auth, 'Bearer al_old', 'Bearer 应取该 agent env 的 token')
  assert.ok(KEY_RE.test(call.body.identity_key))
  const envFile = readFileSync(join(work, 'cfg', 'agents.d', 'a1.env'), 'utf8')
  assert.ok(envFile.includes('AGENTLINK_RECOVERY=al_rec_bnd\n'))
  assert.ok(envFile.includes('AGENTLINK_NAME=a1\n') && envFile.includes('AGENTLINK_TOKEN=al_old\n'), '原键保留')
  assert.ok(!r.so.includes('al_rec_bnd'))
  assert.ok(r.se.includes('al_rec_bnd'))
})

test('identity rotate：发 new_identity_key≠旧 key；成功后 key 文件换新、env 换 token/id/recovery', async () => {
  const work = mkdtempSync(join(tmpdir(), 'identcli-rot-'))
  mkdirSync(join(work, 'cfg/agents.d'), { recursive: true })
  mkdirSync(join(work, '.agentlink'), { recursive: true })
  const oldKey = mkKey()
  writeFileSync(join(work, '.agentlink', 'identity.key'), oldKey + '\n', { mode: 0o600 })
  seedAgentEnv(work, { id: 'a1-abc' })
  const r = await runIm(['identity', 'rotate'], {
    routes: { '/v1/identity/rotate': { status: 200, body: { agent: { id: 'a1-abc' }, token: 'al_t5', recovery_code: 'al_rec_rot' } } },
    env: { HOME: work, IM_CONFIG_DIR: join(work, 'cfg'), AGENTLINK_CONFIG: join(work, 'cfg'), AGENTLINK_STATE: join(work, 'state') },
    cwd: work,
  })
  assert.ok(!r.err, `rotate 应成功: ${r.se}`)
  const call = r.calls.find(c => c.url.endsWith('/v1/identity/rotate'))
  assert.equal(call.body.identity_key, oldKey)
  assert.ok(KEY_RE.test(call.body.new_identity_key) && call.body.new_identity_key !== oldKey)
  const newKey = readFileSync(join(work, '.agentlink', 'identity.key'), 'utf8').trim()
  assert.equal(newKey, call.body.new_identity_key, 'key 文件应换成新 key')
  const envFile = readFileSync(join(work, 'cfg', 'agents.d', 'a1.env'), 'utf8')
  assert.ok(envFile.includes('AGENTLINK_TOKEN=al_t5\n'))
  assert.ok(envFile.includes('AGENTLINK_RECOVERY=al_rec_rot\n'))
  assert.ok(envFile.includes('AGENTLINK_ID=a1-abc\n'))
  assert.ok(!r.so.includes('al_rec_rot'))
})

// —— fix F1：claim 同机重建时保留旧 env 的 NAME/DIR（spec §6 兼容窗口）——
test('register --claim：目标 env 文件已存在 → 沿用其原 AGENTLINK_NAME/DIR，只换 ID/TOKEN/RECOVERY；全新文件才用本次值', async () => {
  // 场景 A：同机重建——旧 env 的 DIR 是别的目录，claim 不得用当前 cwd 覆盖（老 daemon 公式漂移→spool 错位）
  const work = mkdtempSync(join(tmpdir(), 'identcli-f1-'))
  mkdirSync(join(work, 'cfg/agents.d'), { recursive: true })
  const oldDir = join(work, 'old-dir')
  const key2Path = join(work, '.agentlink', 'identity-2.key')
  writeFileSync(join(work, 'cfg', 'agents.d', 'orig-id.env'), [
    'AGENTLINK_NAME=orig-id', `AGENTLINK_DIR=${oldDir}`, 'AGENTLINK_SERVER=http://old.server',
    'AGENTLINK_TOKEN=al_stale', 'AGENTLINK_WAKE_CMD=true', 'AGENTLINK_WAKE_COOLDOWN=30000',
    'AGENTLINK_WAKE_FROM=alice', `AGENTLINK_IDENTITY_FILE=${key2Path}`,
  ].join('\n') + '\n', { mode: 0o600 })
  const other = mkdtempSync(join(tmpdir(), 'identcli-f1-other-'))
  const r = await runIm(['register', '--claim', '--dir', other], {
    routes: { '/v1/identity/claim': { status: 200, body: { agent: { id: 'orig-id-x1' }, token: 'al_t9', recovery_code: 'al_rec_clm' } } },
    env: { HOME: work, IM_CONFIG_DIR: join(work, 'cfg'), AGENTLINK_CONFIG: join(work, 'cfg'), AGENTLINK_STATE: join(work, 'state') },
    cwd: other,
  })
  assert.ok(!r.err, `claim 应成功: ${r.se}`)
  const envFile = readFileSync(join(work, 'cfg', 'agents.d', 'orig-id.env'), 'utf8')
  assert.ok(envFile.includes(`AGENTLINK_NAME=orig-id\n`))
  assert.ok(envFile.includes(`AGENTLINK_DIR=${oldDir}\n`), `应保留旧 DIR，实际: ${envFile}`)
  assert.ok(!envFile.includes(`AGENTLINK_DIR=${other}`), '不得用本次 cwd 覆盖旧 DIR')
  assert.ok(envFile.includes('AGENTLINK_ID=orig-id-x1\n') && envFile.includes('AGENTLINK_TOKEN=al_t9\n') && envFile.includes('AGENTLINK_RECOVERY=al_rec_clm\n'))
  assert.ok(envFile.includes('AGENTLINK_SERVER=http://mock.local\n'), 'SERVER 应更新为当前服务器')
  // fix round 2：同机分支 patch 语义——全部业务键原值存续，不被 buildAgentEnv 覆写丢失
  assert.ok(envFile.includes('AGENTLINK_WAKE_CMD=true\n'), '自定义 WAKE_CMD 应原值存续')
  assert.ok(envFile.includes('AGENTLINK_WAKE_COOLDOWN=30000\n'), '自定义 WAKE_COOLDOWN 应原值存续')
  assert.ok(envFile.includes('AGENTLINK_WAKE_FROM=alice\n'), 'WAKE_FROM 白名单应原值存续')
  assert.ok(envFile.includes(`AGENTLINK_IDENTITY_FILE=${key2Path}\n`), 'IDENTITY_FILE 应原值存续')
  // 场景 B：全新机器（env 不存在）→ 用本次值（name=id 前缀、dir=cwd）
  const r2 = await runIm(['register', '--claim'], {
    routes: { '/v1/identity/claim': { status: 200, body: { agent: { id: 'fresh-id-x1' }, token: 'al_t', recovery_code: 'al_rec_f' } } },
  })
  assert.ok(!r2.err)
  const env2 = readFileSync(join(r2.work, 'cfg', 'agents.d', 'fresh-id.env'), 'utf8')
  assert.ok(env2.includes(`AGENTLINK_DIR=${r2.work}\n`))
})

// —— fix F2：bind/rotate 认 agent env 的 AGENTLINK_IDENTITY_FILE（第二身份不误用主 key）——
test('identity bind/rotate：env 带 AGENTLINK_IDENTITY_FILE → 读写该 key 文件而非主 identity.key', async () => {
  const work = mkdtempSync(join(tmpdir(), 'identcli-f2-'))
  mkdirSync(join(work, 'cfg/agents.d'), { recursive: true })
  mkdirSync(join(work, '.agentlink'), { recursive: true })
  const key2Path = join(work, '.agentlink', 'identity-2.key')
  const key2 = 'al_ident_' + 'q'.repeat(43)
  writeFileSync(key2Path, key2 + '\n', { mode: 0o600 })
  writeFileSync(join(work, 'cfg', 'agents.d', 'a1.env'), [
    'AGENTLINK_NAME=a1', `AGENTLINK_DIR=${work}`, 'AGENTLINK_SERVER=http://mock.local',
    'AGENTLINK_TOKEN=al_old', 'AGENTLINK_WAKE_CMD=true', 'AGENTLINK_WAKE_COOLDOWN=60000',
    'AGENTLINK_ID=a1-abc', `AGENTLINK_IDENTITY_FILE=${key2Path}`,
  ].join('\n') + '\n', { mode: 0o600 })
  const subEnv = { HOME: work, IM_CONFIG_DIR: join(work, 'cfg'), AGENTLINK_CONFIG: join(work, 'cfg'), AGENTLINK_STATE: join(work, 'state') }

  const rb = await runIm(['identity', 'bind'], {
    routes: { '/v1/identity/bind': { status: 201, body: { recovery_code: 'al_rec_b2' } } },
    env: subEnv, cwd: work,
  })
  assert.ok(!rb.err, `bind 应成功: ${rb.se}`)
  const bCall = rb.calls.find(c => c.url.endsWith('/v1/identity/bind'))
  assert.equal(bCall.body.identity_key, key2, 'bind 应从 env 指向的 identity-2.key 取 key')

  const rr = await runIm(['identity', 'rotate'], {
    routes: { '/v1/identity/rotate': { status: 200, body: { agent: { id: 'a1-abc' }, token: 'al_t5', recovery_code: 'al_rec_r2' } } },
    env: subEnv, cwd: work,
  })
  assert.ok(!rr.err, `rotate 应成功: ${rr.se}`)
  const rCall = rr.calls.find(c => c.url.endsWith('/v1/identity/rotate'))
  assert.equal(rCall.body.identity_key, key2, 'rotate 旧 key 应取 identity-2.key')
  assert.notEqual(rCall.body.new_identity_key, key2)
  assert.equal(readFileSync(key2Path, 'utf8').trim(), rCall.body.new_identity_key, '新 key 应写回 identity-2.key')
  assert.ok(!existsSync(join(work, '.agentlink', 'identity.key')), '不得触碰主 key 文件')
})

// —— Task 3 deferred：并发孤儿 key 竞态收敛 ——
test('settleConcurrentWrite：盘上已有他值→采用盘上值（后写覆盖方收敛）；盘上为空→保留自值', async () => {
  const { settleConcurrentWrite } = await import('../lib/identity.mjs')
  const { writeFileSync } = await import('node:fs')
  const d = mkdtempSync(join(tmpdir(), 'identcli-race-'))
  const f = join(d, 'k')
  writeFileSync(f, 'al_ident_' + 'z'.repeat(43))
  assert.equal(settleConcurrentWrite(f, 'al_ident_' + 'a'.repeat(43)), 'al_ident_' + 'z'.repeat(43))
  writeFileSync(f, '')
  assert.equal(settleConcurrentWrite(f, 'al_ident_' + 'a'.repeat(43)), 'al_ident_' + 'a'.repeat(43))
})

// —— 多 agent 同机：cwd 绑定的 agent env 凭据优先于全局 config.json（缺陷报告 2026-10-20）——
test('im me 在绑定目录下应使用该 agent 的 token，而非全局 config.json', async () => {
  const work = mkdtempSync(join(tmpdir(), 'identcli2-'))
  mkdirSync(join(work, 'cfg')); mkdirSync(join(work, 'state'))
  const proj = join(work, 'proj'); mkdirSync(proj)
  // 全局 config.json：kt 侧 token；agents.d：绑定 proj 目录的 agent，token 不同
  writeFileSync(join(work, 'cfg', 'config.json'), JSON.stringify({ server: 'http://mock.local', token: 'al_global_tok' }))
  mkdirSync(join(work, 'cfg', 'agents.d'))
  writeFileSync(join(work, 'cfg', 'agents.d', 'proj.env'), [
    'AGENTLINK_NAME=proj', `AGENTLINK_DIR=${proj}`, 'AGENTLINK_ID=proj-xyz',
    'AGENTLINK_TOKEN=al_bound_tok', 'AGENTLINK_SERVER=http://mock.local', '',
  ].join('\n'))
  const log = join(work, 'fetch.log')
  const [err, so, se] = await new Promise((r) => execFile(process.execPath, [imPath, 'me'], {
    cwd: proj,
    env: { ...process.env, HOME: work, IM_CONFIG_DIR: join(work, 'cfg'), AGENTLINK_CONFIG: join(work, 'cfg'), AGENTLINK_STATE: join(work, 'state'), AGENTLINK_NO_AUTODETECT: '1', NODE_OPTIONS: `--import ${preload}`, IM_FETCH_ROUTES: JSON.stringify({ '/v1/me': { status: 200, body: { agent: { id: 'proj-xyz' } } } }), IM_FETCH_LOG: log },
  }, (e, o, x) => r([e, o, x])))
  assert.ok(!err, `im me 应成功: ${se}`)
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const me = calls.find(c => c.url.endsWith('/v1/me'))
  assert.equal(me.auth, 'Bearer al_bound_tok', 'cwd 绑定 agent 的 token 必须优先于全局 config.json')
})

// —— claim/register 不得把「无绑定 cwd 的缺省身份」劫到当前身份（审计 2026-10-20：ef9b579 错绑的另一面）——
test('claim 回的身份与 cwd 绑定 agent 不同时，全局 config.json 保持不动', async () => {
  const work = mkdtempSync(join(tmpdir(), 'identcli3-'))
  mkdirSync(join(work, 'cfg')); mkdirSync(join(work, 'state'))
  const proj = join(work, 'proj'); mkdirSync(proj)
  const cfgPath = join(work, 'cfg', 'config.json')
  writeFileSync(cfgPath, JSON.stringify({ server: 'http://mock.local', token: 'al_global_tok' }))
  mkdirSync(join(work, 'cfg', 'agents.d'))
  writeFileSync(join(work, 'cfg', 'agents.d', 'proj.env'), [
    'AGENTLINK_NAME=proj', `AGENTLINK_DIR=${proj}`, 'AGENTLINK_ID=proj-xyz',
    'AGENTLINK_TOKEN=al_bound_tok', 'AGENTLINK_SERVER=http://mock.local', '',
  ].join('\n'))
  const log = join(work, 'fetch.log')
  const [err, , se] = await new Promise((r) => execFile(process.execPath, [imPath, 'register', '--claim'], {
    cwd: proj,
    env: { ...process.env, HOME: work, IM_CONFIG_DIR: join(work, 'cfg'), AGENTLINK_CONFIG: join(work, 'cfg'), AGENTLINK_STATE: join(work, 'state'), AGENTLINK_NO_AUTODETECT: '1', AGENTLINK_IDENTITY_FILE: join(work, 'key'), NODE_OPTIONS: `--import ${preload}`, IM_FETCH_ROUTES: JSON.stringify({ '/v1/identity/claim': { status: 200, body: { agent: { id: 'other-abc' }, token: 'al_other_tok', recovery_code: 'al_rec_x' } } }), IM_FETCH_LOG: log },
  }, (e, o, x) => r([e, o, x])))
  assert.ok(!err, `claim 应成功: ${se}`)
  assert.equal(JSON.parse(readFileSync(cfgPath, 'utf8')).token, 'al_global_tok', 'cwd 绑定的是 proj-xyz，claim 回 other-abc 不得改写全局缺省身份')
  // claim 回的身份凭据应落在它自己的 env 文件
  assert.match(readFileSync(join(work, 'cfg', 'agents.d', 'other.env'), 'utf8'), /al_other_tok/)
})
