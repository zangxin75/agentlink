// server/test/cli-smoke.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
// NOTE(deviation from brief): spawnSync blocks the parent event loop, and startWsServer
// runs in this same process — the child CLI's HTTP request would never be served
// (deadlock). Use async spawn instead; assertions are unchanged.
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { startWsServer } from './helpers/ws-server.js'

let srv: Awaited<ReturnType<typeof startWsServer>>, home: string, tokenA: string, tokenB: string

beforeAll(async () => {
  srv = await startWsServer()
  home = mkdtempSync(join(tmpdir(), 'al-home-'))
  tokenA = srv.mk('alice.dev').token
  tokenB = srv.mk('bob.ops').token
})
afterAll(async () => { await srv.close() })

const env = (t: string) => ({ ...process.env, AGENTLINK_SERVER: `http://127.0.0.1:${(srv.app.server.address() as any).port}`, AGENTLINK_TOKEN: t, HOME: home, IM_CONFIG_DIR: home })
const im = (args: string[], t: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
  const p = spawn('node', [join(process.cwd(), '..', 'skills', 'agentlink', 'im.mjs'), ...args], { env: env(t) })
  let stdout = '', stderr = ''
  p.stdout.on('data', (d) => { stdout += d })
  p.stderr.on('data', (d) => { stderr += d })
  p.on('close', (code) => resolve({ status: code, stdout, stderr }))
})

describe('im cli smoke', () => {
  it('whoami / send / inbox / ack / history / unread', async () => {
    expect((await im(['whoami'], tokenA)).stdout).toContain('alice.dev')
    const send = await im(['send', 'bob.ops', 'hello bob'], tokenA)
    expect(send.status).toBe(0)
    const inbox = await im(['inbox', '--wait', '0'], tokenB)
    const msg = JSON.parse(inbox.stdout)[0]
    expect(msg.body.text).toBe('hello bob')
    expect((await im(['ack', msg.id], tokenB)).status).toBe(0)
    expect((await im(['unread'], tokenB)).stdout).toContain('alice.dev')
    expect((await im(['history', 'alice.dev'], tokenB)).stdout).toContain('hello bob')
  })
  it('search finds agents by capability', async () => {
    // alice sets capability via PATCH，search 命中 capabilities（q 匹配规则）
    await im(['me', '--capabilities', 'deploy,review'], tokenA)
    const out = await im(['search', 'deploy'], tokenB)
    expect(out.stdout).toContain('alice.dev')
  })
  it('task full cycle via cli', async () => {
    const send = await im(['task', 'send', 'bob.ops', 'say hi back', '--timeout', '300'], tokenA)
    expect(send.status).toBe(0)
    const taskId = JSON.parse(send.stdout).id
    expect((await im(['task', 'list', '--role', 'executor'], tokenB)).stdout).toContain(taskId)
    expect((await im(['task', 'accept', taskId], tokenB)).status).toBe(0)
    expect((await im(['task', 'result', taskId, 'hi alice!'], tokenB)).status).toBe(0)
    const show = await im(['task', 'show', taskId], tokenA)
    expect(show.stdout).toContain('COMPLETED')
  })
  it('exit code non-zero on error', async () => {
    expect((await im(['send', 'ghost', 'x'], tokenA)).status).not.toBe(0)
  })
  it('thread round-trip and review via cli', async () => {
    await im(['send', 'bob.ops', 'in thread', '--thread', 't-cli'], tokenA)
    const h = await im(['history', 'alice.dev', '--thread', 't-cli'], tokenB) // brief 写 peer=bob.ops，但 tokenB 即 bob 本人（查自己=空）；改为从 bob 视角查对端 alice
    expect(h.stdout).toContain('in thread')
    const send = await im(['task', 'send', 'bob.ops', 'cli work'], tokenA)
    const taskId = JSON.parse(send.stdout).id
    await im(['task', 'accept', taskId], tokenB)
    await im(['task', 'result', taskId, 'done'], tokenB)
    expect((await im(['task', 'show', taskId], tokenA)).stdout).toContain('task.accepted') // 时间线含事件
    expect((await im(['review', taskId, '5', 'nice'], tokenA)).status).toBe(0)
    expect((await im(['ledger', '--summary'], tokenA)).stdout).toContain('[]') // 无预算任务 → 空账
  })
  it('webhook set/off via cli', async () => {
    const set = await im(['webhook', 'set', 'http://127.0.0.1:9/x'], tokenA) // SSRF 默认拒绝在投递时，set 本身成功
    expect(set.status).toBe(0); expect(set.stdout).toContain('wl_')
    expect((await im(['webhook', 'off'], tokenA)).status).toBe(0)
  })
  it('version', async () => {
    const v = await im(['version'], tokenA)
    expect(v.stdout).toContain('"protocol":"v1"')
  })
})
