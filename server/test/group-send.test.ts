// sendGroupMessage fanout：单事务 N 行 + 封皮 + 同源截断基幂等 + file 群分支（spec §1.3/§2）
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent, alignRoles } from '../src/core/agents.js'
import { createGroup } from '../src/core/groups.js'
import { sendGroupMessage } from '../src/core/group-send.js'
import { Bus } from '../src/core/bus.js'

const setup = () => {
  const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0', AGENTLINK_HUMAN_IDS: 'kt.human' } as never)
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'gs-')), 't.db')); migrate(db, { defaultOwner: 'kt.human' })
  const mk = (id: string) => registerAgent(db, cfg, { agent_id: id, registration_code: 'x' })
  mk('kt.human'); mk('kt.a1'); mk('kt.a2'); alignRoles(db, cfg.humanIds)
  return { db, mk, bus: new Bus() }
}

describe('sendGroupMessage fanout', () => {
  it('N=成员数 fanout 行（含建群者 human，r1-M2）：group_id/topic/封皮 members 快照；bus commit 后逐成员发', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: '作战室', members: ['kt.a1', 'kt.a2'] })
    const events: any[] = []; bus.on(e => events.push(e))
    const out = sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: '开会' }, client_msg_id: 'c1' })
    expect(out.delivered).toBe(3); expect(out.deduplicated).toBe(false) // owner+a1+a2
    const rows = db.prepare(`SELECT * FROM messages WHERE group_id=? ORDER BY id`).all(g.id) as any[]
    expect(rows).toHaveLength(3)
    expect(new Set(rows.map(r => r.to_agent))).toEqual(new Set(['kt.human', 'kt.a1', 'kt.a2']))
    expect(rows[0].topic).toBe('g-' + g.id.slice(4)) // 定稿 topic = 'g-<8hex>'
    for (const r of rows) {
      const body = JSON.parse(r.body)
      expect(body.text).toBe('开会')
      expect(body.group).toEqual({ id: g.id, name: '作战室', members: ['kt.a1', 'kt.human', 'kt.a2'].sort() })
    }
    expect(events.filter(e => e.type === 'new-message')).toHaveLength(3) // commit 后 bus
  })
  it('重试同 cmid：0 新行 deduplicated=true 返回既有', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1', 'kt.a2'] })
    sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'x' }, client_msg_id: 'same' })
    const r2 = sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'x' }, client_msg_id: 'same' })
    expect(r2.deduplicated).toBe(true)
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE group_id=?`).get(g.id) as any).c).toBe(3)
  })
  it('cmid 63 字符：截断到 62 基 + 后缀，查重与写入同源，重试幂等（r1-M1）', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    const cmid = 'x'.repeat(63) // 63+2=65 > 64 → 触发截断基 62
    sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'x' }, client_msg_id: cmid })
    const row = db.prepare(`SELECT client_msg_id FROM messages WHERE group_id=? LIMIT 1`).get(g.id) as any
    expect(row.client_msg_id.length).toBe(64) // 62 基 + ':0'
    expect(row.client_msg_id.startsWith(cmid.slice(0, 62) + ':')).toBe(true)
    const r2 = sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'x' }, client_msg_id: cmid })
    expect(r2.deduplicated).toBe(true) // 查重用同一截断基，否则这里会撞唯一索引 500
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE group_id=?`).get(g.id) as any).c).toBe(2) // owner+a1
  })
  it('cmid 含 % 与 _：前缀查重不走 LIKE，不误伤', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'a' }, client_msg_id: 'we%ird_cmid' })
    const r = sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: 'b' }, client_msg_id: 'weXirdZcmid' })
    expect(r.deduplicated).toBe(false) // % 当字面量，不匹配别条
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE group_id=?`).get(g.id) as any).c).toBe(4) // 2 发 × (owner+a1)
  })
  it('跨群复用同 cmid：群 A 成功，群 B 撞唯一索引 → 409 拒，不误 dedup 不串群（r1-M1）', () => {
    const { db, bus } = setup()
    const g1 = createGroup(db, 'kt.human', { name: 'g1', members: ['kt.a1'] })
    const g2 = createGroup(db, 'kt.human', { name: 'g2', members: ['kt.a2'] })
    sendGroupMessage(db, bus, 'kt.human', { to: g1.id, type: 'text', body: { text: 'x' }, client_msg_id: 'dup' })
    expect(() => sendGroupMessage(db, bus, 'kt.human', { to: g2.id, type: 'text', body: { text: 'x' }, client_msg_id: 'dup' })).toThrowError(/reused|another group/i)
    expect((db.prepare(`SELECT COUNT(*) c FROM messages WHERE group_id=?`).get(g2.id) as any).c).toBe(0)
  })
  it('权限：非成员 agent 403；解散 410；text>64KB 拒（按原文计，封皮不计）', () => {
    const { db, bus, mk } = setup()
    mk('other.agent')
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    expect(() => sendGroupMessage(db, bus, 'other.agent', { to: g.id, type: 'text', body: { text: 'x' }, client_msg_id: 'c' })).toThrowError(/forbidden|not visible/i)
    const g2 = createGroup(db, 'kt.human', { name: 'g2', members: ['kt.a1'] })
    db.prepare('DELETE FROM group_members WHERE group_id=?').run(g2.id)
    expect(() => sendGroupMessage(db, bus, 'kt.human', { to: g2.id, type: 'text', body: { text: 'x' }, client_msg_id: 'c' })).toThrowError(/dissolved|gone/i)
    expect(() => sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'text', body: { text: '汉'.repeat(21846) }, client_msg_id: 'c9' })).toThrowError(/64KB|payload/i)
  })
  it('file 分支：file 行 to=grp 校验通过则成员行拷贝封皮；file 行 to=个人 → 拒', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    const now = new Date().toISOString()
    const ins = (fid: string, to: string) => db.prepare(`INSERT INTO files (id, from_agent, to_agent, name, size, sha256, created_at, expires_at) VALUES (?, 'kt.human', ?, 'f', 1, 'abc', ?, '2999-01-01T00:00:00Z')`).run(fid, to, now)
    const fA = 'file_' + 'A'.repeat(26); const fB = 'file_' + 'B'.repeat(26)
    ins(fA, g.id); ins(fB, 'kt.a1')
    const ok = sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'file', body: { file_id: fA }, client_msg_id: 'cf' })
    expect(ok.delivered).toBe(2) // owner+a1
    const body = JSON.parse((db.prepare(`SELECT body FROM messages WHERE group_id=? LIMIT 1`).get(g.id) as any).body)
    expect(body.file_id).toBe(fA); expect(body.group.id).toBe(g.id)
    expect(() => sendGroupMessage(db, bus, 'kt.human', { to: g.id, type: 'file', body: { file_id: fB }, client_msg_id: 'cf2' })).toThrowError(/RECIPIENT|file/i)
  })
  it('成员 agent 也可群发（from=kt.a1），自持行在 fanout 内', () => {
    const { db, bus } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1', 'kt.a2'] })
    const out = sendGroupMessage(db, bus, 'kt.a1', { to: g.id, type: 'text', body: { text: 'hi' }, client_msg_id: 'ca' })
    expect(out.delivered).toBe(3) // owner + a1 自持行 + a2 行
    const rows = db.prepare(`SELECT to_agent FROM messages WHERE group_id=?`).all(g.id) as any[]
    expect(new Set(rows.map(r => r.to_agent))).toEqual(new Set(['kt.human', 'kt.a1', 'kt.a2']))
  })
})
