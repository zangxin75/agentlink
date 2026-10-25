// im market / im credits 参数解析与端点映射（spec §4 逐字）——纯函数、零依赖、无 fetch。
// im.mjs 调 buildMarketRequest() 拿 {path, method, body} 后走现有 api() 帮助函数。
import { readFileSync } from 'node:fs'
import { capabilityTags } from './market-watch.mjs' // 归一规则同源（守望与上架草稿同一套 capability→tag）

// --body-file 读文件为 body 文本；缺文件抛错（信息含路径，im.mjs 捕获后 die 退出非 0）
function readBodyFile(file) {
  try { return readFileSync(file, 'utf8') }
  catch { throw new Error(`读 body 文件失败: ${file}`) }
}

const num = (v) => (v === undefined || v === true ? undefined : Number(v))

// 服务端 TITLE_MAX=200 字节（中文 ≈3 字节/字符）——按字节截断，防长 CJK display_name 生成即 400 的命令
const clipBytes = (s, max) => {
  if (Buffer.byteLength(s) <= max) return s
  let out = ''
  for (const ch of s) { if (Buffer.byteLength(out + ch) > max) break; out += ch }
  return out
}

// —— 引导式上架（spec §4）：零副作用，只打印可执行草稿命令；执行与否由人类决定 ——
export function buildSuggestDraft(agent) {
  const caps = agent.capabilities ?? []
  const name = agent.display_name || agent.id
  const title = clipBytes(`${name}：${caps.slice(0, 3).join(' / ') || '专业服务'}`, 200)
  const body = [
    `## ${name} 提供的服务`, '', agent.description || '（请补充一段服务说明：你交付什么、适合什么场景）', '',
    '## 能力清单', ...(caps.length ? caps.map(c => `- ${c}`) : ['- （请补充能力标签）']), '',
    '## 交付说明', '- 交付物：（描述交付物）', '- 周期：（预计耗时）', '- 验收：（验收标准）', '',
    '> 本草稿由 im market suggest-service 生成，请人类确认并修改后再执行发布命令。',
  ].join('\n')
  const tags = capabilityTags(caps)
  const tagArg = (tags.length ? tags : ['service']).join(',')
  const file = `/tmp/al-service-${agent.id}.md`
  // heredoc 带引号定界符 <<'EOF'：description 含引号/反引号/$ 均原样安全；title 里的双引号转义
  const command = [
    `cat > ${file} <<'EOF'`, body, 'EOF',
    // title 出自不可信档案（display_name/capabilities），双引号上下文全量转义：\ " $ ` 四者都不许活（终审 C-1）
    `im market publish service "${title.replace(/[\\"$`]/g, '\\$&')}" --price 20 --tag ${tagArg} --body-file ${file}`,
  ].join('\n')
  return { title, tags: tags.length ? tags : ['service'], price: 20, command }
}

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
    case 'del': return { path: `/market/listings/${rest[0]}`, method: 'DELETE', body: undefined } // 自主下架（escrowed 退回 publisher）
    case 'renew': return { path: `/market/listings/${rest[0]}/renew`, method: 'POST', body: { days: num(flags.days) } } // 续期：--days 缺省走 cfg.listingDays
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
      throw new Error(`unknown market subcommand: ${sub ?? '(none)'} — usage: list|publish|view|del|renew|bid|counter|accept|reject|withdraw|select|buy|deals|deliver|cancel / credits [send|ledger]`)
  }
}
