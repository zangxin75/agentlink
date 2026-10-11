import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWsServer } from './helpers/ws-server.js'

const dir = mkdtempSync(join(tmpdir(), 'dl-'))
process.env.DOWNLOAD_DIR = dir
writeFileSync(join(dir, 'latest-version'), '0.0.0-20261011-deadbee\n')
writeFileSync(join(dir, 'agentlink.tar.gz'), Buffer.from('fake-gzip'))

let s: Awaited<ReturnType<typeof startWsServer>>
beforeAll(async () => { s = await startWsServer() })
afterAll(async () => { await s.close() })

describe('GET /download/*', () => {
  it('返回 latest-version 纯文本', async () => {
    const r = await fetch(`http://127.0.0.1:${(s.app.server.address() as any).port}/download/latest-version`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toContain('text/plain')
    expect((await r.text()).trim()).toBe('0.0.0-20261011-deadbee')
  })
  it('返回 tarball（application/gzip）', async () => {
    const r = await fetch(`http://127.0.0.1:${(s.app.server.address() as any).port}/download/agentlink.tar.gz`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/gzip')
  })
  it('路径穿越与未知文件 404', async () => {
    const port = (s.app.server.address() as any).port
    for (const f of ['../secret', 'a/b', 'nope.txt']) {
      const r = await fetch(`http://127.0.0.1:${port}/download/${f}`)
      expect(r.status).toBe(404)
    }
  })
})
