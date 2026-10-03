// im send 的 topic 决策链（spec §3）：--reply 继承 > 显式 > 注册表(1 自动/≥2 报错/0 广播)
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SPOOL_ROOT } from './identity.mjs'

// 本地找 msgId 所属 topic:pending 扫内容,consumed 只看文件名(目录即 topic);agentId=null 安全返回 null
export async function defaultLocalLookup(agentId, msgId) {
  if (!agentId) return null // critic-M8:未绑定 cwd 避免 join(null,...) 抛 TypeError
  const { topics, unreadList } = await import('./spool.mjs')
  for (const t of topics(agentId)) {
    for (const m of unreadList(agentId, t)) if (m.id === msgId) return t
    const cd = join(SPOOL_ROOT, agentId, 'topics', t, 'consumed')
    try { if (readdirSync(cd).includes(msgId + '.json')) return t } catch {}
  }
  return null
}

export async function decideTopic({ to, topic, reply, agentId, localLookup = (id) => defaultLocalLookup(agentId, id), fetchTopics }) {
  if (topic) return topic
  if (reply) {
    const t = await localLookup(reply)
    if (t) return t
    // 查不到:视同无 --reply,继续决策链,不报错（spec §3.1）
  }
  const list = (await fetchTopics(to)) ?? []
  if (list.length === 1) return list[0].topic
  if (list.length >= 2) {
    const names = list.map(x => x.topic).join(', ')
    throw new Error(`对端有 ${list.length} 个活跃 topic: ${names} — 按内容挑一个,用 --topic <name> 重发（广播用 --topic _default）`)
  }
  return '_default'
}
