// im market / im credits 参数解析与端点映射（spec §4 逐字）——纯函数、零依赖、无 fetch。
// im.mjs 调 buildMarketRequest() 拿 {path, method, body} 后走现有 api() 帮助函数。
import { readFileSync } from 'node:fs'

// --body-file 读文件为 body 文本；缺文件抛错（信息含路径，im.mjs 捕获后 die 退出非 0）
function readBodyFile(file) {
  try { return readFileSync(file, 'utf8') }
  catch { throw new Error(`读 body 文件失败: ${file}`) }
}

const num = (v) => (v === undefined || v === true ? undefined : Number(v))

export function buildMarketRequest(cmd, sub, rest = [], flags = {}) {
  if (cmd === 'credits') {
    if (sub === 'send') return { path: '/credits/transfer', method: 'POST', body: { to: rest[0], points: Number(rest[1]), ...(flags.note ? { note: flags.note } : {}) } }
    if (sub === 'ledger') return { path: `/credits/ledger?limit=${flags.limit ?? 50}`, method: 'GET', body: undefined }
    if (sub === undefined) return { path: '/credits/account', method: 'GET', body: undefined } // 余额 + 今日 faucet 状态
    throw new Error(`unknown credits subcommand: ${sub}`)
  }

  switch (sub) {
    case 'list': { // 查询串只拼出现的 flag
      const qs = []
      for (const [k, key] of [['kind', 'kind'], ['tag', 'tag'], ['q', 'q'], ['status', 'status']]) {
        if (flags[k] !== undefined && flags[k] !== true) qs.push(`${key}=${encodeURIComponent(flags[k])}`)
      }
      return { path: `/market/listings${qs.length ? '?' + qs.join('&') : ''}`, method: 'GET', body: undefined }
    }
    case 'publish': { // rest: [demand|service, title]
      const body = flags['body-file'] !== undefined ? readBodyFile(flags['body-file']) : ''
      if (!body && flags['body-file'] === undefined) throw new Error('publish 需要 --body-file <file>')
      return {
        path: '/market/listings', method: 'POST',
        body: {
          kind: rest[0], title: rest.slice(1).join(' '), body,
          tags: flags.tag ? flags.tag.split(',').filter(Boolean) : undefined,
          budget: num(flags.budget), price: num(flags.price), days: num(flags.days),
        },
      }
    }
    case 'view': return { path: `/market/listings/${rest[0]}`, method: 'GET', body: undefined }
    case 'bid':
      return { path: `/market/listings/${rest[0]}/bids`, method: 'POST', body: { points: num(flags.points), body: flags['body-file'] !== undefined ? readBodyFile(flags['body-file']) : (flags.body ?? '') } }
    case 'counter':
      return { path: `/market/bids/${rest[0]}/counter`, method: 'POST', body: { points: num(flags.points), body: flags['body-file'] !== undefined ? readBodyFile(flags['body-file']) : (flags.body ?? '') } }
    case 'accept': case 'reject': case 'withdraw': // bid 三态（accept=卖家接受议价记录）
      return { path: `/market/bids/${rest[0]}/${sub}`, method: 'POST', body: undefined }
    case 'select': // rest: [listing_id, bid_id]
      return { path: `/market/listings/${rest[0]}/select/${rest[1]}`, method: 'POST', body: undefined }
    case 'buy':
      // --counter N:买家先出一轮议价记录（POST bids；卖家 accept 后按新价建 deal，spec §2.2）
      if (flags.counter !== undefined && flags.counter !== true)
        return { path: `/market/listings/${rest[0]}/bids`, method: 'POST', body: { points: num(flags.counter), body: flags['body-file'] !== undefined ? readBodyFile(flags['body-file']) : (flags.body ?? '') } }
      return { path: `/market/listings/${rest[0]}/buy`, method: 'POST', body: undefined }
    case 'deals':
      return { path: `/market/deals${flags.role ? `?role=${flags.role}` : ''}`, method: 'GET', body: undefined }
    case 'deliver': case 'accept': case 'cancel': // deal 三操作；deliver 可带 --note
      return { path: `/market/deals/${rest[0]}/${sub}`, method: 'POST', body: flags.note ? { note: flags.note } : undefined }
    default:
      throw new Error(`unknown market subcommand: ${sub ?? '(none)'} — usage: list|publish|view|bid|counter|accept|reject|withdraw|select|buy|deals|deliver|cancel / credits [send|ledger]`)
  }
}
