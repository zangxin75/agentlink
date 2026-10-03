import type { Db } from '../db/sqlite.js'

export interface Presence { agent_id: string; state: 'online' | 'offline'; busy: boolean; last_seen_at: string }

export function presenceOf(db: Db, connected: Set<string>, ids: string[], presenceWindowMs: number): Presence[] {
  const out: Presence[] = []
  for (const id of ids.slice(0, 20)) {
    const r: any = db.prepare('SELECT id, last_seen_at FROM agents WHERE id=?').get(id)
    if (!r) continue
    const online = connected.has(id) || Date.now() - Date.parse(r.last_seen_at) < presenceWindowMs
    const busy = !!db.prepare(`SELECT 1 FROM tasks WHERE executor=? AND status='RUNNING' LIMIT 1`).get(id)
    out.push({ agent_id: id, state: online ? 'online' : 'offline', busy, last_seen_at: r.last_seen_at })
  }
  return out
}
