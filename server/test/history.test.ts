import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent } from '../src/core/agents.js'
import { Bus } from '../src/core/bus.js'
import { sendMessage, history } from '../src/core/messages.js'
import type { Db } from '../src/db/sqlite.js'

let db: Db
const cfg = loadConfig({ REGISTRATION_CODE: 'x' } as never)
beforeEach(() => { db = openDb(join(mkdtempSync(join(tmpdir(), 'al-')), 't.db')); migrate(db) })
const mk = (id: string) => registerAgent(db, cfg, { agent_id: id, registration_code: 'x' })
const send = (from: string, cmid: string) => ({ to: from === 'alice.dev' ? 'bob.ops' : 'alice.dev', type: 'text' as const, body: { text: cmid }, client_msg_id: cmid })

describe('history', () => {
  it('returns both directions newest-first, paginates with before, increments with after', () => {
    const bus = new Bus()
    mk('alice.dev'); mk('bob.ops')
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const from = i % 2 ? 'alice.dev' : 'bob.ops'
      ids.push(sendMessage(db, bus, from, send(from, `c${i}`)).message.id)
    }
    const page1 = history(db, 'alice.dev', { peer: 'bob.ops', limit: 3 })
    expect(page1.map(m => m.id)).toEqual(ids.slice(-3).reverse()) // newest-first
    const page2 = history(db, 'alice.dev', { peer: 'bob.ops', limit: 3, before: page1[page1.length - 1].id })
    expect(page2.map(m => m.id)).toEqual([ids[1], ids[0]])
    const inc = history(db, 'alice.dev', { peer: 'bob.ops', limit: 10, after: ids[2] })
    expect(inc.map(m => m.id)).toEqual([ids[3], ids[4]])
  })
})
