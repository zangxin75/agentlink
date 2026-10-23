// skills/agentlink/lib/find.mjs — im find 输出格式化（按内容找人，纯函数可测）
const snippet = (text, q, radius = 40) => {
  const s = String(text ?? '')
  const i = s.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return s.slice(0, radius * 2) // 未命中（--tasks 混合来源等）取头部
  const a = Math.max(0, i - radius), b = Math.min(s.length, i + q.length + radius)
  return (a > 0 ? '…' : '') + s.slice(a, b) + (b < s.length ? '…' : '')
}
export function formatFindResults(selfId, msgs, q = '') {
  return msgs.map(m => {
    const peer = m.from === selfId ? m.to : m.from
    const topic = m.topic && m.topic !== '_default' ? ` [${m.topic}]` : ''
    return `${peer} · ${m.created_at}${topic} — ${snippet(m.body?.text, q)}`
  })
}
