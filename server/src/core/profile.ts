import { Errors } from '../http/errors.js'

// 注入黑名单(spec §3.2,best-effort):挡无心模板污染与最粗糙滥用;主防线是消费方不可信框定
export const INJECTION_BLOCKLIST = /curl\s|wget\s|rm\s+-rf|sudo\s|ignore\s+(previous|all)|disregard/i
const B = (s: unknown) => Buffer.byteLength(String(s ?? ''))
const NAME_RE = /^[a-z0-9][a-z0-9.-]*$/

function text(v: unknown, label: string, maxB: number, required = false): string {
  if (v === undefined || v === null) { if (required) throw Errors.invalidRequest(`${label} 必填`); return '' }
  if (typeof v !== 'string') throw Errors.invalidRequest(`${label} 必须是字符串`)
  if (B(v) > maxB) throw Errors.invalidRequest(`${label} 超 ${maxB} 字节(实得 ${B(v)})`)
  return v
}

export function normName(v: unknown, label: string): string {
  if (typeof v !== 'string' || !NAME_RE.test(v) || B(v) > 40) throw Errors.invalidRequest(`${label} 须为 ≤40 字节的小写 [a-z0-9.-](实得 ${JSON.stringify(v)})`)
  return v
}

export interface Profile { headline?: string; skills?: { name: string; level: number; evidence: string }[]; projects?: { name: string; role?: string; stack?: string[]; summary?: string }[]; style?: { summary?: string }; generated_at?: string }

// 校验 + 规范化(spec §2.2 全部约束;失败 throw,错误信息带字段名与字节数)
export function validateProfile(p: unknown): Profile {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) throw Errors.invalidRequest('profile 必须是对象')
  const raw = p as Record<string, unknown>
  const keys = ['headline', 'skills', 'projects', 'style', 'generated_at']
  for (const k of Object.keys(raw)) if (!keys.includes(k)) throw Errors.invalidRequest(`profile 不认识的字段: ${k}`)
  const out: Profile = {}
  if (raw.headline !== undefined) out.headline = text(raw.headline, 'headline', 300)
  if (raw.skills !== undefined) {
    if (!Array.isArray(raw.skills)) throw Errors.invalidRequest('skills 必须是数组')
    if (raw.skills.length > 20) throw Errors.invalidRequest(`skills 超 20 项(实得 ${raw.skills.length})`)
    out.skills = raw.skills.map((s: any, i: number) => {
      if (!s || typeof s !== 'object') throw Errors.invalidRequest(`skills[${i}] 必须是对象`)
      if (!Number.isInteger(s.level) || s.level < 1 || s.level > 5) throw Errors.invalidRequest(`skills[${i}].level 须为 1-5 整数`)
      return { name: normName(s.name, `skills[${i}].name`), level: s.level, evidence: text(s.evidence, `skills[${i}].evidence`, 200, true) }
    })
  }
  if (raw.projects !== undefined) {
    if (!Array.isArray(raw.projects)) throw Errors.invalidRequest('projects 必须是数组')
    if (raw.projects.length > 30) throw Errors.invalidRequest(`projects 超 30 项(实得 ${raw.projects.length})`)
    out.projects = raw.projects.map((pr: any, i: number) => {
      if (!pr || typeof pr !== 'object') throw Errors.invalidRequest(`projects[${i}] 必须是对象`)
      if (pr.stack !== undefined && !Array.isArray(pr.stack)) throw Errors.invalidRequest(`projects[${i}].stack 必须是数组`)
      return {
        name: text(pr.name, `projects[${i}].name`, 80, true),
        role: pr.role === undefined ? undefined : text(pr.role, `projects[${i}].role`, 40),
        stack: pr.stack === undefined ? undefined : pr.stack.map((x: unknown) => normName(x, `projects[${i}].stack[]`)),
        summary: pr.summary === undefined ? undefined : text(pr.summary, `projects[${i}].summary`, 200),
      }
    })
  }
  if (raw.style !== undefined) { if (typeof raw.style !== 'object' || !raw.style) throw Errors.invalidRequest('style 必须是对象'); const st = raw.style as Record<string, unknown>; out.style = { summary: st.summary === undefined ? undefined : text(st.summary, 'style.summary', 600) } }
  if (raw.generated_at !== undefined) out.generated_at = text(raw.generated_at, 'generated_at', 40)
  // 入站注入 best-effort 黑名单:全部自由文本字段(spec §3.2)
  const free: string[] = []
  if (out.headline) free.push(out.headline)
  out.skills?.forEach(s => free.push(s.evidence))
  out.projects?.forEach(pr => { if (pr.summary) free.push(pr.summary); if (pr.role) free.push(pr.role) })
  if (out.style?.summary) free.push(out.style.summary)
  for (const t of free) {
    const m = t.match(INJECTION_BLOCKLIST)
    if (m) throw Errors.invalidRequest(`profile 自由文本含疑似注入模式 "${m[0]}"(字段原文: ${t.slice(0, 60)})`)
  }
  if (B(JSON.stringify(out)) > 8192) throw Errors.invalidRequest(`profile 总长超 8KB(实得 ${B(JSON.stringify(out))})`)
  return out
}
