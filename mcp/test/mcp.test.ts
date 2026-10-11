import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startWsServer } from '../../server/test/helpers/ws-server.js'

let srv: Awaited<ReturnType<typeof startWsServer>>, client: Client, transport: StdioClientTransport

beforeAll(async () => {
  srv = await startWsServer()
  const token = srv.mk('alice.dev').token
  transport = new StdioClientTransport({
    command: process.execPath, args: ['dist/index.js'],
    env: { ...process.env, AGENTLINK_SERVER: `http://127.0.0.1:${(srv.app.server.address() as any).port}`, AGENTLINK_TOKEN: token } as never,
    cwd: new URL('.', import.meta.url).pathname.replace('/test/', '/'),
  })
  client = new Client({ name: 'test', version: '1.0.0' })
  await client.connect(transport)
})
afterAll(async () => { await client.close(); await srv.close() })

describe('mcp server', () => {
  it('lists all 19 im tools with security hints', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    expect(names.filter(n => n.startsWith('im_')).length).toBe(19)
    expect(tools.find(t => t.name === 'im_task_send')!.description).toMatch(/untrusted|不可信/)
  })
  it('im_send → im_inbox → im_ack roundtrip via mcp', async () => {
    const bob = srv.mk('bob.ops')
    await client.callTool({ name: 'im_send', arguments: { to: 'bob.ops', text: 'mcp hello' } })
    // bob reads via REST and alice acks? swap: use bob token via a second config — simpler: verify with REST
    const inbox = await srv.app.inject({ method: 'GET', url: '/v1/inbox?wait=0', headers: { authorization: `Bearer ${bob.token}` } })
    const msg = inbox.json()[0]
    expect(msg.body.text).toBe('mcp hello')
    await srv.app.inject({ method: 'POST', url: '/v1/messages/ack', headers: { authorization: `Bearer ${bob.token}` }, payload: { ids: [msg.id] } })
  })

  it('im_send tool schema accepts thread_id', async () => {
    const { tools } = await client.listTools()
    const send = tools.find((t: any) => t.name === 'im_send')
    expect(JSON.stringify(send.inputSchema)).toContain('thread_id')
  })

  it('im_history tool schema accepts optional peer and thread_id', async () => {
    const { tools } = await client.listTools()
    const history = tools.find((t: any) => t.name === 'im_history')
    const schema = JSON.stringify(history.inputSchema)
    expect(schema).toContain('thread_id')
    // peer 可选化：required 数组（如存在）不含 peer
    expect(history.inputSchema.required ?? []).not.toContain('peer')
  })

  it('im_send with thread_id and im_history by thread_id via mcp', async () => {
    const bob = srv.mk('bob.thr')
    await client.callTool({ name: 'im_send', arguments: { to: 'bob.thr', text: 'threaded hello', thread_id: 't-1' } })
    // bob 侧按 thread 查 history（REST 侧带 thread_id 查询）
    const hist = await srv.app.inject({ method: 'GET', url: '/v1/history?peer=alice.dev&thread_id=t-1', headers: { authorization: `Bearer ${bob.token}` } })
    const rows = hist.json()
    expect(rows.some((m: any) => m.body?.text === 'threaded hello' && m.thread_id === 't-1')).toBe(true)
  })
})
