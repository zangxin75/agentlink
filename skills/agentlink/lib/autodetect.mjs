// skills/agentlink/lib/autodetect.mjs —— 装机自动建档（bounded 设计 2026-10-11）
// im register 成功后 30 秒内完成的工具链嗅探：只查本地版本号，零网络外发；
// 结果 PATCH /v1/me 只是初稿，随时可 im me --capabilities 或 profile scan 精修覆盖。
import { execFile as realExecFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeMessage } from './spool.mjs'
import { buildSuggestDraft } from './market-cli.mjs'

const exec = promisify(realExecFile)

// 探测命令 → capability tag（tag 走 capabilityTags 同一归一；这里直接给合法值）
const TOOLS = [
  ['node', 'node'], ['python3', 'python'], ['python', 'python'], ['go', 'go'], ['cargo', 'rust'],
  ['java', 'java'], ['docker', 'docker'], ['git', 'git'], ['ffmpeg', 'ffmpeg'],
  ['psql', 'postgres'], ['redis-cli', 'redis'], ['nginx', 'nginx'],
]

export async function sniffCapabilities({ execFile = exec, timeoutMs = 3_000 } = {}) {
  const tags = []
  for (const [cmd, tag] of TOOLS) {
    if (tags.includes(tag)) continue // python/python3 命中一个即可
    try { await execFile(cmd, ['--version'], { timeout: timeoutMs }); tags.push(tag) }
    catch { /* ENOENT=未装 / 超时 / EACCES：一律静默跳过，嗅探永不整体失败 */ }
  }
  return tags
}

const fold = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ') // 不可信档案：折叠控制字符（前案 M-1 同源）

export function buildAutoNotice(agent) {
  const caps = (agent.capabilities ?? []).map(c => String(c ?? '').trim()).filter(Boolean)
  if (!caps.length) return null // 全空机器：不打扰、不发空档案
  const sanitized = { ...agent, display_name: fold(agent.display_name), description: fold(agent.description), capabilities: caps }
  const draft = buildSuggestDraft(sanitized)
  const text =
    '🎁 装机自动建档完成：已嗅探本机工具链并写入你的档案（capabilities），其他 agent 现在能按能力搜到你。\n' +
    '下面是基于档案生成的**服务上架草稿**——请人类确认后执行即完成上架；不执行则保持未上架，无任何副作用：\n\n' +
    `${draft.command}\n\n` +
    '（草稿也可随时用 `im market suggest-service` 重新生成；档案可用 `im me --capabilities a,b` 或 `im profile scan` 精修。）'
  return { id: `mkt-auto-${agent.id}`, from: 'market', to: agent.id, type: 'text', topic: '_default',
    body: { text }, created_at: new Date().toISOString() }
}

export function autoProfile({ log = () => {}, sniff = sniffCapabilities } = {}) {
  // register 成功后调用：嗅探 + PATCH + spool 草稿通知。返回嗅探到的 tags（空数组=未建档）。
  return async (api, agent, { force = false } = {}) => {
    if (force === false && process.env.AGENTLINK_NO_AUTODETECT === '1') return []
    let tags = agent.capabilities ?? []
    if (!tags.length) {
      try { tags = await sniff() } catch (e) { log(`autodetect: 嗅探失败 ${e.message}`); return [] }
      if (!tags.length) return []
      try { await api('/me', { method: 'PATCH', body: { capabilities: tags } }) }
      catch (e) { log(`autodetect: PATCH /me 失败 ${e.message}`); return tags } // 已嗅探但档案未更新：仍给草稿
    }
    const notice = buildAutoNotice({ ...agent, capabilities: tags })
    if (notice) writeMessage(agent.id, notice) // spool：from=market 走默认不唤醒门禁，人类打开会话时看到
    return tags
  }
}
