// Task 6 守卫：WS 群黑洞拒绝 / 群文件成员下载 / 目录滤群伪 agent / /v1/me role 透传
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent, alignRoles, searchAgents } from '../src/core/agents.js'
import { createGroup } from '../src/core/groups.js'
import { getFile } from '../src/core/files.js'
import { startWsServer } from './helpers/ws-server.js'
import WebSocket from 'ws'

describe('group guards', () => {
  it('WS send to=grp.* → error INVALID_REQUEST，不落库', async () => {
    const srv = await startWsServer({ AGENTLINK_HUMAN_IDS: 'kt.human' })
    try {
      srv.mk('kt.human'); srv.mk('kt.a1'); srv.mk('kt.a2')
      const gid = createGroup(srv.db, 'kt.human', { name: 'g', members: ['kt.a1', 'kt.a2'] }).id
      const ws = new WebSocket(srv.url)
      const frames: any[] = []; ws.on('message', d => frames.push(JSON.parse(String(d))))
      await new Promise(r => ws.on('open', r))
      ws.send(JSON.stringify({ op: 'auth', token: srv.mk('kt.a1').token }))
      await new Promise(r => setTimeout(r, 300))
      ws.send(JSON.stringify({ op: 'send', to: gid, body: { text: '黑洞?' }, client_msg_id: 'w1' }))
      await new Promise(r => setTimeout(r, 300))
      const err = frames.find(f => f.op === 'error')
      expect(err?.code).toBe('INVALID_REQUEST')
      expect((srv.db.prepare('SELECT COUNT(*) c FROM messages WHERE group_id=?').get(gid) as any).c).toBe(0)
      ws.close()
    } finally { await srv.close() }
  })
  it('getFile：群成员（非发送者）可取回 to=grp 的 file；非成员不可', () => {
    const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0', AGENTLINK_HUMAN_IDS: 'kt.human' } as never)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'fg-')), 't.db')); migrate(db)
    const mk = (id: string) => registerAgent(db, cfg, { agent_id: id, registration_code: 'x' })
    mk('kt.human'); mk('kt.a1'); mk('kt.a2'); mk('out.x'); alignRoles(db, cfg.humanIds)
    const gid = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1', 'kt.a2'] }).id
    db.prepare(`INSERT INTO files (id, from_agent, to_agent, name, size, sha256, created_at, expires_at) VALUES ('file_G1', 'kt.a1', ?, 'f', 1, 'h', '2026-01-01T00:00:00Z', '2999-01-01T00:00:00Z')`).run(gid)
    expect(getFile(db, 'kt.a2', 'file_G1')?.id).toBe('file_G1')  // 成员
    expect(getFile(db, 'kt.human', 'file_G1')?.id).toBe('file_G1') // 建群者（owner 视角可见）
    expect(getFile(db, 'out.x', 'file_G1')).toBeUndefined()        // 非成员按不存在处理
  })
  it('目录默认滤 role=group；?all 列出（searchAgents 加参）', () => {
    const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0' } as never)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'dg-')), 't.db')); migrate(db)
    registerAgent(db, cfg, { agent_id: 'plain.a', registration_code: 'x' })
    registerAgent(db, cfg, { agent_id: 'kt.human', registration_code: 'x' })
    // 直插伪 agent（createGroup 校验 members ≥1，目录过滤测试不需要完整群）
    const gid = 'grp.deadbeef'
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at, role, owner) VALUES (?, 'g', '', '[]', '{}', ?, ?, 'group', 'kt.human')`).run(gid, now, now)
    db.prepare('INSERT INTO groups (id, owner, created_at) VALUES (?,?,?)').run(gid, 'kt.human', now)
    const defaultIds = searchAgents(db, {}, new Set(), 60_000).map(a => a.id)
    expect(defaultIds).not.toContain(gid)
    expect(defaultIds).toContain('plain.a')
    const allIds = searchAgents(db, { all: true } as any, new Set(), 60_000).map(a => a.id)
    expect(allIds).toContain(gid)
  })
})
