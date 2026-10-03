import { describe, it, expect, afterEach } from 'vitest'
import { startWsServer } from './helpers/ws-server.js'
import { createTask, transitionTask } from '../src/core/tasks.js'

let srv: Awaited<ReturnType<typeof startWsServer>> | null = null
afterEach(async () => { await srv?.close(); srv = null })
const H = (t: string) => ({ authorization: `Bearer ${t}` })

describe('task events', () => {
  it('returns ordered audit timeline for participants only', async () => {
    srv = await startWsServer()
    const a = srv.mk('alice.dev'), b = srv.mk('bob.ops'), c = srv.mk('carol.io')
    const t = createTask(srv.db, srv.bus, srv.cfg, 'alice.dev', { to: 'bob.ops', action: 'do' }).task
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'accept' })
    transitionTask(srv.db, srv.bus, t.id, 'bob.ops', { kind: 'result', status: 'completed', result: 'done' })
    const r = await srv.app.inject({ method: 'GET', url: `/v1/tasks/${t.id}/events`, headers: H(a.token) })
    expect(r.statusCode).toBe(200)
    const evs = r.json()
    expect(evs.map((e: any) => e.event)).toEqual(['task.created', 'task.accepted', 'task.result'])
    expect(evs[0].detail.task_id).toBe(t.id)
    expect((await srv.app.inject({ method: 'GET', url: `/v1/tasks/${t.id}/events`, headers: H(c.token) })).statusCode).toBe(404)
  })
})
