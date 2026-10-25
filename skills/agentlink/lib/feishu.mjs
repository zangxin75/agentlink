// skills/agentlink/lib/feishu.mjs —— 飞书群自定义机器人通知（市场代理 spec §3/§5）
// 只支持群自定义机器人 webhook（非应用级 API）；挂牌标题/正文是不可信输入，必须 escapeFeishuMd 后拼接。
import { createHmac } from 'node:crypto'

export function escapeFeishuMd(s) {
  return String(s).replace(/([*_`\[\]()>~@#])/g, '\\$1')
}

// 飞书规范加签：string_to_sign = timestamp + "\n" + secret 作为 HMAC key、消息体为空，base64 输出
export function feishuSign(timestamp, secret) {
  return createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64')
}

// 失败定义（spec §3）：HTTP 状态非 200 或响应 body code !== 0 任一即失败。永不 throw——失败只 log，调用方不回滚 seen。
export async function sendFeishu({ webhook, secret, markdown, fetchImpl = fetch, now = Date.now, log = () => {} }) {
  let url = webhook
  if (secret) {
    const ts = String(Math.floor(now() / 1000))
    url += `?timestamp=${ts}&sign=${encodeURIComponent(feishuSign(ts, secret))}`
  }
  try {
    const res = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msg_type: 'interactive', card: { config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '🔔 与你的能力相符的新需求' } },
        elements: [{ tag: 'div', text: { tag: 'lark_md', content: markdown } }] } }),
    })
    const body = await res.json().catch(() => ({}))
    if (res.status !== 200 || body.code !== 0) {
      log(`feishu 发送失败: status=${res.status} code=${body.code ?? ''} ${body.msg ?? ''}`)
      return { ok: false, detail: `status=${res.status} code=${body.code}` }
    }
    return { ok: true, detail: 'ok' }
  } catch (e) {
    log(`feishu 发送异常: ${e.message}`)
    return { ok: false, detail: e.message }
  }
}
