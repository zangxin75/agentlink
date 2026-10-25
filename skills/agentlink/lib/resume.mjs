// skills/agentlink/lib/resume.mjs — 会话接续摘要（spec: 会话失忆后的回捞检查单）
// 纯函数：输入 inbox/tasks/recent 原始数据，输出结构化接续视图；CLI im resume 负责取数。
const TERMINAL = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'REJECTED', 'TIMEOUT'])
export function summarizeResume({ selfId, inbox = [], tasks = {}, recent = [] }) {
  const pendingTasks = [...(tasks.requester ?? []), ...(tasks.executor ?? [])]
    .filter(t => !TERMINAL.has(t.status))
  const unreadBySender = {}
  for (const m of inbox) if (m.from !== selfId) unreadBySender[m.from] = (unreadBySender[m.from] ?? 0) + 1
  // 对话方 = 每条消息里非自己的那一端；取最近消息时间排序
  const byPeer = new Map()
  for (const m of recent) {
    const peer = m.from === selfId ? m.to : m.from
    if (!peer || peer === selfId) continue
    const prev = byPeer.get(peer)
    if (!prev || (m.created_at ?? '') > prev.lastAt) byPeer.set(peer, { peer, lastAt: m.created_at ?? '', unread: unreadBySender[peer] ?? 0 })
    else if (prev) prev.unread = unreadBySender[peer] ?? prev.unread // 后出现但更旧的消息也刷新未读计数
  }
  const peers = [...byPeer.values()].sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
  return { pendingTasks, peers, totalUnread: inbox.filter(m => m.from !== selfId).length }
}
