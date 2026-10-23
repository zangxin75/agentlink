// skills/agentlink/test/keepalive.test.mjs — daemon 保活三件套：单实例锁 / 进程自愈 / systemd 注册刷新
import test from 'node:test'; import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { spawn } from 'node:child_process'

test('acquireLock：取锁/同 pid 幂等/活进程持锁拒绝/陈锁接管/坏锁接管/release 语义', async () => {
  const { acquireLock, releaseLock } = await import('../lib/keepalive.mjs')
  const lock = join(mkdtempSync(join(tmpdir(), 'ka-')), 'daemon.lock')
  // 空目录首取
  assert.deepEqual(acquireLock(lock, 111), { ok: true, holder: null })
  // 同 pid 再取（升级重启竞态窗口）：幂等成功
  assert.equal(acquireLock(lock, 111).ok, true)
  // 活进程持锁：第二个 pid 拿不到，报 holder
  const r2 = acquireLock(lock, 222, () => true)
  assert.equal(r2.ok, false); assert.equal(r2.holder, 111)
  // 持锁者已死：陈锁接管
  assert.equal(acquireLock(lock, 222, () => false).ok, true)
  // 坏锁（非数字内容）：接管不炸
  writeFileSync(lock, 'garbage')
  assert.equal(acquireLock(lock, 333, () => true).ok, true)
  // release：自己的 pid 删锁；别人的 pid 不删
  releaseLock(lock, 999)
  assert.equal(readFileSync(lock, 'utf8'), '333')
  releaseLock(lock, 333)
  assert.equal(existsSync(lock), false)
  assert.equal(acquireLock(lock, 444, () => true).ok, true)
})

test('acquireLock 默认 alive 检查：真实子进程死后陈锁可接管（跨平台 process.kill(pid,0)）', async () => {
  const { acquireLock } = await import('../lib/keepalive.mjs')
  const lock = join(mkdtempSync(join(tmpdir(), 'ka2-')), 'daemon.lock')
  const kid = spawn(process.execPath, ['-e', 'setTimeout(()=>{},300)'])
  await new Promise(r => kid.on('spawn', r))
  const r = acquireLock(lock, kid.pid) // 子进程持锁
  assert.equal(r.ok, true)
  await new Promise(r => kid.on('exit', r)) // 等它退出
  assert.equal(acquireLock(lock, 555).ok, true) // 默认 alive：死 pid → 接管
})

test('installSelfHeal：uncaught/unhandled 只记日志不退出；返回卸载函数', async () => {
  const { installSelfHeal } = await import('../lib/keepalive.mjs')
  const logs = []; const registered = new Map()
  const on = (ev, fn) => registered.set(ev, fn)
  const off = (ev) => registered.delete(ev)
  const uninstall = installSelfHeal((...a) => logs.push(a.join(' ')), on, off)
  registered.get('uncaughtException')(new Error('boom'))
  registered.get('unhandledRejection')({ stack: 'rej-stack' })
  assert.equal(logs.length, 2)
  assert.ok(logs[0].includes('boom') && logs[1].includes('rej-stack'))
  uninstall()
  assert.equal(registered.size, 0)
})

// —— 升级包内容断言（随 tarball 分发的保活强度，dist 测试另有进包断言）——
test('contrib：unit 是 Restart=always；keepalive.ps1 存在且带 UTF-8 BOM + Register-ScheduledTask', async () => {
  const unit = readFileSync(new URL('../contrib/agentlink-daemon.service', import.meta.url), 'utf8')
  assert.match(unit, /Restart=always/)
  const ps1 = readFileSync(new URL('../contrib/agentlink-daemon-keepalive.ps1', import.meta.url))
  assert.ok(ps1.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'WinPS5.1 按 GBK 误读无 BOM 的 ps1')
  assert.match(ps1.toString('utf8'), /Register-ScheduledTask/)
})

// —— 入口锁集成（真实子进程）：保活拉起方第二个进程必须秒退 0 且不影响第一个 ——
test('daemon.mjs 入口单实例锁：第二个进程退出码 0 且第一个继续运行', async () => {
  const cfg = mkdtempSync(join(tmpdir(), 'ka-cfg-')); const state = mkdtempSync(join(tmpdir(), 'ka-state-'))
  // HOME 一并隔离：入口 ensureKeepalive 按 HOME 定位 systemd unit，否则测试会覆写真机 ~/.config/systemd/user
  const home = mkdtempSync(join(tmpdir(), 'ka-home-'))
  const env = { ...process.env, HOME: home, USERPROFILE: home, AGENTLINK_CONFIG: cfg, AGENTLINK_STATE: state } // 无 env 文件 → daemon 空转待命
  const daemonPath = new URL('../daemon.mjs', import.meta.url).pathname
  const spawned = []
  const start = () => {
    const p = spawn(process.execPath, [daemonPath], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    // exit 监听必须在 spawn 时挂：第二个 daemon 会在测试体内自行退出，事后补挂永远收不到事件（node 不会重放）
    const exited = new Promise(r => p.on('exit', r))
    spawned.push({ p, exited })
    let out = ''; p.stdout.on('data', c => out += c); p.stderr.on('data', c => out += c)
    return { p, out: () => out }
  }
  const first = start()
  try {
    await new Promise(r => setTimeout(r, 1500)) // 等首个完整启动（含锁落盘）
    assert.equal(first.p.exitCode, null, '第一个 daemon 应在运行: ' + first.out())
    const second = start()
    const code = await new Promise((resolve, fail) => { // 最多等 5s：无锁实现会挂到超时
      const t = setTimeout(() => fail(new Error('第二个 daemon 5s 内未退出（无单实例锁？）')), 5000)
      second.p.on('exit', (c) => { clearTimeout(t); resolve(c) })
    })
    assert.equal(code, 0) // 幂等退出 = 保活拉起不产生错误码（计划任务/systemd 不视为失败）
    assert.match(second.out(), /已在运行/)
    assert.equal(first.p.exitCode, null) // 第一个不受影响
  } finally {
    for (const { p } of spawned) p.kill('SIGTERM')
    await Promise.all(spawned.map(({ exited }) => exited)).catch(() => {})
  }
})

test('ensureKeepalive：未注册不强装；旧 unit 刷新+daemon-reload；一致不动；win32 no-op', async () => {
  const { ensureKeepalive } = await import('../lib/keepalive.mjs')
  const tmp = mkdtempSync(join(tmpdir(), 'ka3-'))
  const clientRoot = tmp; const sysd = join(tmp, 'systemd')
  mkdirSync(join(clientRoot, 'contrib')); mkdirSync(sysd)
  const src = join(clientRoot, 'contrib', 'agentlink-daemon.service')
  const dst = join(sysd, 'agentlink-daemon.service')
  writeFileSync(src, 'UNIT-NEW Restart=always\n')
  // 未注册 systemd（用户未装 unit）→ 尊重现状
  assert.equal(ensureKeepalive({ platform: 'linux', clientRoot, systemdDir: sysd }).changed, false)
  assert.equal(existsSync(dst), false)
  // 已注册旧内容 → 覆写 + systemctl --user daemon-reload
  writeFileSync(dst, 'UNIT-OLD Restart=on-failure\n')
  const cmds = []
  const r = ensureKeepalive({ platform: 'linux', clientRoot, systemdDir: sysd, run: (c, a) => cmds.push([c, ...a]) })
  assert.equal(r.changed, true)
  assert.equal(readFileSync(dst, 'utf8'), 'UNIT-NEW Restart=always\n')
  assert.deepEqual(cmds, [['systemctl', '--user', 'daemon-reload']])
  // 内容一致 → 不动不再 reload
  assert.equal(ensureKeepalive({ platform: 'linux', clientRoot, systemdDir: sysd, run: (c, a) => cmds.push([c, ...a]) }).changed, false)
  assert.equal(cmds.length, 1)
  // win32：Linux unit 过期也不动（保活由计划任务承担；任务已存在 → no-op，见下一个测试的缺失补装分支）
  writeFileSync(dst, 'OLD\n')
  assert.equal(ensureKeepalive({ platform: 'win32', clientRoot, systemdDir: sysd, taskExists: () => true }).changed, false)
  assert.equal(readFileSync(dst, 'utf8'), 'OLD\n')
})

test('ensureKeepalive win32：计划任务缺失 → 跑 contrib 注册脚本补装；已存在 → no-op', async () => {
  const { ensureKeepalive } = await import('../lib/keepalive.mjs')
  const cmds = []
  const r = ensureKeepalive({
    platform: 'win32', clientRoot: '/c', systemdDir: '/s',
    taskExists: () => false,   // 任务缺失（存量 Windows 机器只自升级了 daemon，没人注册过任务）
    run: (c, a) => cmds.push([c, ...a]),
  })
  assert.equal(r.changed, true)
  assert.deepEqual(cmds, [['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join('/c', 'contrib', 'agentlink-daemon-keepalive.ps1')]])
  // 任务已存在 → 不再注册
  assert.equal(ensureKeepalive({ platform: 'win32', clientRoot: '/c', taskExists: () => true, run: (c, a) => cmds.push([c, ...a]) }).changed, false)
  assert.equal(cmds.length, 1)
  // 注册抛错不炸 daemon（组策略场景）：只记日志
  const r3 = ensureKeepalive({ platform: 'win32', clientRoot: '/c', taskExists: () => false, run: () => { throw new Error('gp' ) } })
  assert.equal(r3.changed, false)
})
