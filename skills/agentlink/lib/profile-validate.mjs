// profile.json 本地预检(spec §2.3):schema/尺寸 errors + 敏感模式 warnings(机械后检,把关双轨之一)
const B = (s) => Buffer.byteLength(String(s ?? ''))
const NAME_RE = /^[a-z0-9][a-z0-9.-]*$/
const SENSITIVE = [/\/home\//, /\/Users\//, /(?:^|[^A-Za-z0-9])\/(?:[\w.-]+\/)+[\w.-]+/, /al_[A-Za-z0-9]{20,}/, /\b\d{1,3}(?:\.\d{1,3}){3}\b/]

export function validateProfileLocal(p) {
  const errors = []; const warnings = []
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { errors: ['profile 必须是对象'], warnings }
  const text = (v, label, maxB, required) => {
    if (v === undefined || v === null) { if (required) errors.push(`${label} 必填`); return '' }
    if (typeof v !== 'string') { errors.push(`${label} 必须是字符串`); return '' }
    if (B(v) > maxB) errors.push(`${label} 超 ${maxB} 字节(实得 ${B(v)})`)
    return v
  }
  if (p.headline !== undefined) text(p.headline, 'headline', 300)
  if (Array.isArray(p.skills)) {
    if (p.skills.length > 20) errors.push(`skills 超 20 项`)
    p.skills.forEach((s, i) => {
      if (!s || typeof s !== 'object') return errors.push(`skills[${i}] 必须是对象`)
      if (!Number.isInteger(s.level) || s.level < 1 || s.level > 5) errors.push(`skills[${i}].level 须为 1-5 整数`)
      if (typeof s.name !== 'string' || !NAME_RE.test(s.name) || B(s.name) > 40) errors.push(`skills[${i}].name 须为 ≤40 字节小写 [a-z0-9.-]`)
      text(s.evidence, `skills[${i}].evidence`, 200, true)
    })
  }
  if (Array.isArray(p.projects)) {
    if (p.projects.length > 30) errors.push(`projects 超 30 项`)
    p.projects.forEach((pr, i) => {
      if (!pr || typeof pr !== 'object') return errors.push(`projects[${i}] 必须是对象`)
      text(pr.name, `projects[${i}].name`, 80, true)
      if (pr.role !== undefined) text(pr.role, `projects[${i}].role`, 40)
      if (pr.summary !== undefined) text(pr.summary, `projects[${i}].summary`, 200)
      if (Array.isArray(pr.stack)) pr.stack.forEach((x) => { if (typeof x !== 'string' || !NAME_RE.test(x) || B(x) > 40) errors.push(`projects[${i}].stack[] 须为 ≤40 字节小写 [a-z0-9.-]`) })
    })
  }
  if (p.style?.summary !== undefined) text(p.style.summary, 'style.summary', 600)
  // 敏感后检:命中不阻断,逐条警告(发布前最后一道闸,spec §2.3)
  const freeText = [p.headline, ...(p.skills ?? []).map(s => s?.evidence), ...(p.projects ?? []).map(pr => pr?.summary), p.style?.summary].filter(Boolean).join('\n')
  for (const re of SENSITIVE) { const m = freeText.match(re); if (m) warnings.push(`疑似敏感信息: ${m[0].slice(0, 40)}(剔除绝对路径/token/IP 后再发布)`) }
  if (B(JSON.stringify(p)) > 8192) errors.push(`profile 总长超 8KB(实得 ${B(JSON.stringify(p))})`)
  return { errors, warnings }
}
