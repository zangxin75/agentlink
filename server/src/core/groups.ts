// 群聊 core（spec 2026-10-22-human-console-groupchat-design.md §1.3/§2/§3）
// 群=伪 agent（role='group' 无 token）；成员快照存 group_members；解散=清空成员（伪 agent 行保留保 FK）
import { randomBytes } from 'node:crypto'
import type { Db } from '../db/sqlite.js'
import { Errors } from '../http/errors.js'
import { getAgent } from './agents.js'
import { audit } from './audit.js'

export const GROUP_ID_RE = /^grp\.[0-9a-f]{8}$/

const membersOf = (db: Db, groupId: string): string[] =>
  (db.prepare('SELECT agent_id FROM group_members WHERE group_id=? ORDER BY joined_at, agent_id').all(groupId) as { agent_id: string }[]).map(r => r.agent_id)
const isDissolved = (db: Db, groupId: string): boolean => membersOf(db, groupId).length === 0
const requireGroup = (db: Db, groupId: string) => {
  if (!GROUP_ID_RE.test(groupId)) throw Errors.invalidRequest('group id must match ^grp\\.[0-9a-f]{8}$')
  getAgent(db, groupId) // 404 if unknown
}

export function createGroup(db: Db, owner: string, input: { name: string; members: string[] }): { id: string } {
  if (!input.name || input.name.length > 64) throw Errors.invalidRequest('name required (1-64 chars)')
  // r1-M2：建群者一并入 group_members（spec §1.3 封皮 members=落库时快照，含建群者）——
  // 否则建群人类收不到自己的 fanout 行，M3 console 将看不到自己发过什么
  const members = [...new Set([owner, ...(input.members ?? [])])]
  if (members.length < 2) throw Errors.invalidRequest('members required (>=1 besides creator)') // members 至少 1 个（去重后含 owner 至少 2）
  for (const m of members) getAgent(db, m) // 成员必须存在（404）
  const id = `grp.${randomBytes(4).toString('hex')}`
  const now = new Date().toISOString()
  db.transaction(() => {
    db.prepare(`INSERT INTO agents (id, display_name, description, capabilities, task_policy, created_at, last_seen_at, role, owner) VALUES (?,?,'','[]','{"mode":"closed","allowlist":[],"scope":"read-only"}',?,?, 'group', ?)`)
      .run(id, input.name, now, now, owner)
    db.prepare('INSERT INTO groups (id, owner, created_at) VALUES (?,?,?)').run(id, owner, now)
    for (const m of members) db.prepare('INSERT INTO group_members (group_id, agent_id, joined_at) VALUES (?,?,?)').run(id, m, now)
  })()
  audit(db, owner, 'group.created', { group_id: id, members })
  return { id }
}

// 可见性（spec §1.2）：成员 agent；human 建群者；human 且有 owner==自己 的成员 agent
export function visibleTo(db: Db, groupId: string, requesterId: string): boolean {
  const requester = getAgent(db, requesterId)
  if (membersOf(db, groupId).includes(requesterId)) return true
  if (requester.role !== 'human') return false
  const g = db.prepare('SELECT owner FROM groups WHERE id=?').get(groupId) as { owner: string } | undefined
  if (!g) return false
  if (g.owner === requesterId) return true
  return !!db.prepare(`SELECT 1 FROM group_members gm JOIN agents a ON a.id=gm.agent_id WHERE gm.group_id=? AND a.owner=?`).get(groupId, requesterId)
}

const groupOwner = (db: Db, groupId: string): string => (db.prepare('SELECT owner FROM groups WHERE id=?').get(groupId) as { owner: string }).owner
const mineOnly = (db: Db, agentId: string, actor: string): boolean => (db.prepare('SELECT owner FROM agents WHERE id=?').get(agentId) as any)?.owner === actor

export function renameGroup(db: Db, actor: string, groupId: string, name: string): void {
  requireGroup(db, groupId)
  if (!name || name.length > 64) throw Errors.invalidRequest('name required (1-64 chars)')
  if (groupOwner(db, groupId) !== actor) throw Errors.forbidden('only group owner can rename')
  db.prepare('UPDATE agents SET display_name=? WHERE id=?').run(name, groupId)
  audit(db, actor, 'group.renamed', { group_id: groupId, name })
}

export function addMember(db: Db, actor: string, groupId: string, agentId: string): void {
  requireGroup(db, groupId)
  if (isDissolved(db, groupId)) throw Errors.gone('group dissolved')
  const actorRow = getAgent(db, actor)
  if (actorRow.role === 'human') {
    if (groupOwner(db, groupId) !== actor && !mineOnly(db, agentId, actor)) throw Errors.forbidden('owner can add anyone; others only their own agents')
  } else if (actor !== groupOwner(db, groupId)) throw Errors.forbidden('agents cannot manage members')
  getAgent(db, agentId) // 404 if unknown
  if (agentId.startsWith('grp.')) throw Errors.invalidRequest('cannot add a group into a group')
  const now = new Date().toISOString()
  db.prepare('INSERT OR IGNORE INTO group_members (group_id, agent_id, joined_at) VALUES (?,?,?)').run(groupId, agentId, now)
  audit(db, actor, 'group.member_added', { group_id: groupId, agent_id: agentId })
}

export function removeMember(db: Db, actor: string, groupId: string, agentId: string): void {
  requireGroup(db, groupId)
  if (agentId === groupOwner(db, groupId)) throw Errors.invalidRequest('cannot remove the group creator') // r1-Minor9：唯一合法的空成员路径只有 dissolveGroup
  const actorRow = getAgent(db, actor)
  if (actorRow.role === 'human') {
    if (groupOwner(db, groupId) !== actor && !mineOnly(db, agentId, actor)) throw Errors.forbidden('owner can remove anyone; others only their own agents')
  } else if (actor !== agentId) throw Errors.forbidden('agents can only leave by themselves')
  db.prepare('DELETE FROM group_members WHERE group_id=? AND agent_id=?').run(groupId, agentId)
  audit(db, actor, 'group.member_removed', { group_id: groupId, agent_id: agentId })
}

export function dissolveGroup(db: Db, actor: string, groupId: string): void {
  requireGroup(db, groupId)
  if (groupOwner(db, groupId) !== actor) throw Errors.forbidden('only group owner can dissolve')
  db.prepare('DELETE FROM group_members WHERE group_id=?').run(groupId)
  audit(db, actor, 'group.dissolved', { group_id: groupId })
}

export function listGroupsFor(db: Db, humanId: string): { id: string; name: string; owner: string; mine_members: string[] }[] {
  const rows = db.prepare(`SELECT DISTINCT g.id, a.display_name as name, g.owner FROM groups g
    LEFT JOIN group_members gm ON gm.group_id=g.id
    LEFT JOIN agents m ON m.id=gm.agent_id
    JOIN agents a ON a.id=g.id
    WHERE g.owner=? OR m.owner=?`).all(humanId, humanId) as { id: string; name: string; owner: string }[]
  return rows.map(r => ({ ...r, mine_members: db.prepare(`SELECT gm.agent_id FROM group_members gm JOIN agents x ON x.id=gm.agent_id WHERE gm.group_id=? AND x.owner=?`).all(r.id, humanId).map((x: any) => x.agent_id) }))
}

export function groupTimeline(db: Db, groupId: string, q: { after?: string; limit: number }) {
  const COLS = 'id, client_msg_id, from_agent as `from`, to_agent as `to`, type, body, thread_id, topic, created_at, delivered_at, read_at, group_id'
  const rows = q.after
    ? db.prepare(`SELECT ${COLS} FROM messages WHERE group_id=? AND id > ? ORDER BY id LIMIT ?`).all(groupId, q.after, q.limit)
    : db.prepare(`SELECT ${COLS} FROM messages WHERE group_id=? ORDER BY id LIMIT ?`).all(groupId, q.limit)
  return rows.map((r: any) => ({ ...r, body: JSON.parse(r.body) }))
}

export { membersOf, isDissolved }
