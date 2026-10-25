// server/test/bus.test.ts
import { describe, it, expect } from 'vitest'
import { Bus } from '../src/core/bus.js'

describe('Bus', () => {
  it('waitFor resolves on matching event, clears waiter', async () => {
    const bus = new Bus()
    const p = bus.waitFor('bob', ['new-message'], 500)
    bus.emit({ type: 'receipt', agentId: 'bob', messageIds: [] }) // wrong type: no wake
    bus.emit({ type: 'new-message', agentId: 'alice' })           // wrong agent: no wake
    const tick = new Promise(r => setTimeout(r, 20))
    let done = false; p.then(() => { done = true })
    await tick; expect(done).toBe(false)
    bus.emit({ type: 'new-message', agentId: 'bob' })
    expect(await p).toBe(true)
  })
  it('waitFor resolves false on timeout', async () => {
    const bus = new Bus()
    expect(await bus.waitFor('bob', ['new-message'], 10)).toBe(false)
  })
})
