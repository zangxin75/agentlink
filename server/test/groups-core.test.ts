// groups core：伪 agent 建群/成员权限/可见性/时间线（spec §1.2/§1.3）
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent, getAgent, alignRoles } from '../src/core/agents.js'
import { createGroup, membersOf, isDissolved, visibleTo, renameGroup, addMember, removeMember, dissolveGroup, listGroupsFor, groupTimeline, GROUP_ID_RE } from '../src/core/groups.js'

const setup = () => {
  // r1-C4：必须走分码注册——单码下所有 agent owner 都是 kt.human，
  // visibleTo(zhy.human)/mineOnly 分叉断言全部失效。分码正是 Task 2 已实现的能力，测试消费它
  const cfg = loadConfig({ AGENTLINK_REG_CODES: 'kt.human:KA,zhy.human:ZB', PORT: '0', AGENTLINK_HUMAN_IDS: 'kt.human,zhy.human' } as never)
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'gp-')), 't.db')); migrate(db)
  const mk = (id: string, owner: 'kt' | 'zhy' = 'kt') => registerAgent(db, cfg, { agent_id: id, registration_code: owner === 'kt' ? 'KA' : 'ZB' })
  mk('kt.human'); mk('kt.a1'); mk('zhy.human', 'zhy'); mk('zhy.a1', 'zhy'); alignRoles(db, cfg.humanIds)
  return { db, mk }
}

describe('groups core', () => {
  it('建群：伪 agent role=group 无 token，members 快照；统一拉任意 agent（跨 owner）', () => {
    const { db } = setup()
    const g = createGroup(db, 'kt.human', { name: '作战室', members: ['kt.a1', 'zhy.a1'] })
    expect(GROUP_ID_RE.test(g.id)).toBe(true)
    const ga = getAgent(db, g.id)
    expect(ga.role).toBe('group'); expect(ga.owner).toBe('kt.human'); expect(ga.display_name).toBe('作战室')
    expect((db.prepare('SELECT COUNT(*) c FROM tokens WHERE agent_id=?').get(g.id) as any).c).toBe(0) // 不发 token
    expect(membersOf(db, g.id).sort()).toEqual(['kt.a1', 'kt.human', 'zhy.a1']) // r1-M2：建群者入 members
  })
  it('可见性：成员 agent 可见；建群 human 可见；有 mine 成员的另一 human 可见；无关 human 不可见', () => {
    const { db } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1', 'zhy.a1'] })
    expect(visibleTo(db, g.id, 'kt.a1')).toBe(true)
    expect(visibleTo(db, g.id, 'kt.human')).toBe(true)   // 建群者
    expect(visibleTo(db, g.id, 'zhy.human')).toBe(true)  // zhy.a1 是 mine
    expect(visibleTo(db, g.id, 'server')).toBe(false)
  })
  it('权限分叉：建群者拉任意/移任意/改名/解散；其他 human 只能动自己的 agent', () => {
    const { db } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    addMember(db, 'kt.human', g.id, 'zhy.a1')                     // 建群者拉任意
    expect(() => addMember(db, 'zhy.human', g.id, 'kt.a1')).toThrow() // zhy 再拉 kt 的 → 拒
    expect(() => addMember(db, 'zhy.human', g.id, 'zhy.a1')).not.toThrow() // 冗余添加自己人 = 幂等跳过
    removeMember(db, 'zhy.human', g.id, 'zhy.a1')                 // 移自己的
    expect(() => removeMember(db, 'zhy.human', g.id, 'kt.a1')).toThrow()
    expect(() => removeMember(db, 'kt.human', g.id, 'kt.human')).toThrow() // r1-Minor9：建群者本人不可被移出
    renameGroup(db, 'kt.human', g.id, '新名'); expect(getAgent(db, g.id).display_name).toBe('新名')
    expect(() => renameGroup(db, 'zhy.human', g.id, 'x')).toThrow()
    dissolveGroup(db, 'kt.human', g.id)
    expect(isDissolved(db, g.id)).toBe(true)
    expect(getAgent(db, g.id).role).toBe('group')                  // 伪 agent 行保留（FK 完整）
  })
  it('listGroupsFor：kt.human 看到两个群（建群 + mine 成员）', () => {
    const { db } = setup()
    const g1 = createGroup(db, 'kt.human', { name: 'a', members: ['kt.a1'] })
    const g2 = createGroup(db, 'zhy.human', { name: 'b', members: ['zhy.a1', 'kt.a1'] })
    const ids = listGroupsFor(db, 'kt.human').map(g => g.id).sort()
    expect(ids).toEqual([g1.id, g2.id].sort())
  })
  it('groupTimeline：按 group_id 过滤正序，after 增量', () => {
    const { db } = setup()
    const g = createGroup(db, 'kt.human', { name: 'g', members: ['kt.a1'] })
    const now = new Date().toISOString()
    db.prepare(`INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, topic, created_at, group_id) VALUES ('m1','c1','kt.human','kt.a1','text','{}',NULL,'g-ab12cd34',?,'${g.id}')`).run(now)
    db.prepare(`INSERT INTO messages (id, client_msg_id, from_agent, to_agent, type, body, thread_id, topic, created_at) VALUES ('m2','c2','kt.a1','zhy.a1','text','{}',NULL,'_default',?)`).run(now)
    const rows = groupTimeline(db, g.id, { limit: 10 })
    expect(rows.map(r => r.id)).toEqual(['m1']) // m2 无 group_id 不入群时间线
    expect(groupTimeline(db, g.id, { after: 'm0', limit: 10 }).map(r => r.id)).toEqual(['m1'])
    expect(groupTimeline(db, g.id, { after: 'm1', limit: 10 })).toEqual([])
  })
})
