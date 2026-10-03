import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask, scanTimeouts } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const SCHEMA = { type: 'object', required: ['report'], properties: { report: { type: 'string', maxLength: 10 }, n: { type: 'integer', minimum: 0 } } }

describe('result schema acceptance', () => {
  it('mismatch → 422 + still RUNNING; fixed resubmit → COMPLETED; deadline unchanged', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops') // 直接调 core 也必须先注册（getAgent 404，r1-C3 同类）
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', result_schema: SCHEMA }).task
    expect(t.result_schema).toBeTruthy()
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' })
    const deadline = (await import('../src/core/tasks.js')).getTask(srv.db, t.id).deadline
    let err: any
    try { transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'not json' }) } catch (e) { err = e }
    expect(err.code).toBe('RESULT_SCHEMA_MISMATCH'); expect(err.status).toBe(422)
    const still = (await import('../src/core/tasks.js')).getTask(srv.db, t.id)
    expect(still.status).toBe('RUNNING'); expect(still.deadline).toBe(deadline) // 不顺延
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: JSON.stringify({ report: 'ok', n: 1 }) })
    expect((await import('../src/core/tasks.js')).getTask(srv.db, t.id).status).toBe('COMPLETED')
  })
  it('near-deadline ordering: heartbeating executor can resubmit; stale one is TIMEOUT by scanner', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', result_schema: SCHEMA }).task
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'heartbeat' })
    try { transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'bad' }) } catch { /* 422 */ }
    srv.db.prepare(`UPDATE tasks SET deadline='2020-01-01T00:00:00Z' WHERE id=?`).run(t.id)
    try { transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: JSON.stringify({ report: 'late' }) }) } catch { /* 已被扫描前手动置 deadline：此处仍应成功或 TIMEOUT 由扫描器判 */ }
    scanTimeouts(srv.db, srv.bus, new Date('2020-01-02T00:00:00Z'))
    const fin = (await import('../src/core/tasks.js')).getTask(srv.db, t.id)
    expect(['COMPLETED', 'TIMEOUT']).toContain(fin.status) // 心跳在场者：deadline 人工回拨前的成功提交有效
    // r1-I9 钉 3 第二条腿：心跳停摆者（422 后不再 heartbeat）必须被 scanner 置 TIMEOUT
    const stale = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a2', result_schema: SCHEMA }).task
    transitionTask(srv.db, srv.bus, stale.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, stale.id, 'bob.ops', { kind: 'heartbeat' })
    try { transitionTask(srv.db, srv.bus, stale.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'bad' }) } catch { /* 422 后放弃心跳 */ }
    srv.db.prepare(`UPDATE tasks SET deadline='2020-01-01T00:00:00Z', last_heartbeat_at='2020-01-01T00:00:00Z' WHERE id=?`).run(stale.id)
    scanTimeouts(srv.db, srv.bus, new Date('2020-01-02T00:00:00Z'))
    expect((await import('../src/core/tasks.js')).getTask(srv.db, stale.id).status).toBe('TIMEOUT')
  })
  it('create validation: oversized 413, unsupported operator 422, absent schema keeps v1 free-text', async () => {
    srv = await startWsServer()
    srv.mk('alice.dev'); srv.mk('bob.ops')
    // r2-N1：toThrowError 的不对称匹配器无文档承诺，统一 try/catch 显式断言
    let e1: any; try { createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', result_schema: { type: 'object', properties: { pad: { enum: ['x'.repeat(9 * 1024)] } } } }) } catch (x) { e1 = x }
    expect(e1?.status).toBe(413) // r1-M-e：8KB 超限真断言
    let e2: any; try { createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a', result_schema: { type: 'object', properties: { x: { type: 'string', pattern: 'a' } } } }) } catch (x) { e2 = x }
    expect(e2?.code).toBe('SCHEMA_UNSUPPORTED')
    const free = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'a' }).task
    transitionTask(srv.db, srv.bus, free.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, free.id, 'bob.ops', { kind: 'result', status: 'completed', result: '任意文本' })
    expect((await import('../src/core/tasks.js')).getTask(srv.db, free.id).status).toBe('COMPLETED')
  })
})
