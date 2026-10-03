// skills/agentlink/lib/topics.mjs — 项目 topic 声明（spec §4.1）
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export const TOPIC_RE = /^(_default|[a-z0-9][a-z0-9._-]{0,31})$/

// 从 cwd 向上找最近 .agentlink.json,取合法 topics（_default 声明无意义被滤）;无 → []
export function projectTopics(cwd) {
  let d = cwd
  for (;;) {
    const p = join(d, '.agentlink.json')
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'))
        const list = Array.isArray(j.topics) ? j.topics : []
        return [...new Set(list)].filter(t => typeof t === 'string' && TOPIC_RE.test(t) && t !== '_default').slice(0, 8)
      } catch { return [] } // 坏文件=无声明,不炸
    }
    const parent = dirname(d)
    if (parent === d) return []
    d = parent
  }
}

// skills/agentlink/lib/topics.mjs 追加（T4）——注册表续期（spec §4.3）
// 变化或距上次 >1h 才 PUT;缓存按 agentId 分文件
export async function pushTopics({ agentId, token, server, topics: list }) {
  const cachePath = join(process.env.AGENTLINK_STATE ?? join(homedir(), '.local/state/agentlink'), `topic-push-${agentId}.json`)
  let cached = null
  try { cached = JSON.parse(readFileSync(cachePath, 'utf8')) } catch {}
  const fresh = cached && Date.now() - cached.at < 3600_000 && JSON.stringify(cached.topics) === JSON.stringify(list)
  if (fresh) return false
  let res
  try {
    res = await fetch(`${server.replace(/\/+$/, '')}/v1/me/topics`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ topics: list }) })
  } catch { return false } // 连不上：上报失败不阻塞注入
  if (!res.ok) return false
  writeFileSync(cachePath, JSON.stringify({ topics: list, at: Date.now() }), { mode: 0o600 })
  return true
}
