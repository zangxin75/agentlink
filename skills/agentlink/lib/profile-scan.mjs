// 本机能力档案原料采集(spec §2.1)——只读、不提权、不联网;CLI 只做机械采集,总结由 agent 按 lib/profile-prompt.md 完成
import { readdirSync, statSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { execFile } from 'node:child_process'

const SKIP_DIRS = new Set(['proc', 'sys', 'dev', 'run', 'snap', 'mnt', 'media', 'net', 'node_modules', '.git', '$Recycle.Bin', 'Windows', 'vm']) // /private/var/vm 的最后一段
const MANIFESTS = ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'pom.xml', 'build.gradle', 'Gemfile', 'composer.json']
const INSTRUCTIONS = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'README.md']
const isProject = (files) => files.includes('.git') || MANIFESTS.some(m => files.includes(m)) || ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'].some(i => files.includes(i))

function gitHistory(dir) {
  return new Promise((resolve) => {
    // hooksPath 隔离:防被扫仓库的全局 git 配置注入钩子(spec §2.1);10s 超时;失败=维度缺失,不失败
    execFile('git', ['-c', 'core.hooksPath=/dev/null', '--no-optional-locks', 'log', '--since=12.months', '--date=iso', '--name-only', '--pretty=%ad', '-n', '500'], { cwd: dir, timeout: 10_000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const lines = stdout.split('\n').filter(Boolean)
      // git --date=iso 输出 "2026-10-01 09:03:27 +0800"(无 T);iso-strict 才带 T——两种都认
      const dates = lines.filter(l => /^\d{4}-\d{2}-\d{2}[T ]/.test(l))
      const freq = {}
      for (const l of lines) if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(l) && l.includes('/')) { const top = l.split('/')[0]; freq[top] = (freq[top] ?? 0) + 1 }
      resolve({ total_commits: dates.length, active_months: [...new Set(dates.map(d => d.slice(0, 7)))], top_paths: Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([p, n]) => `${p}(${n})`) })
    })
  })
}

export async function scan({ roots, out, timeLimitMs = Number(process.env.AGENTLINK_SCAN_TIME_LIMIT_MS ?? 600_000), maxProjects = 200, maxBytes = 2 * 1024 * 1024 }) {
  const started = Date.now()
  const seen = new Set() // dev+ino 去重,防符号链接环(/etc 类多处有环)
  const projects = []
  let truncated = false, bytes = 0, lastProgress = Date.now()
  const walk = (dir) => {
    if (projects.length >= maxProjects || bytes >= maxBytes) { truncated = true; return }
    if (Date.now() - started > timeLimitMs) { truncated = true; return }
    if (Date.now() - lastProgress > 30_000) { process.stderr.write(`scanned ${projects.length} projects…\n`); lastProgress = Date.now() }
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return } // 权限拒绝静默(不 sudo)
    const files = entries.map(e => e.name)
    if (isProject(files)) {
      // stat 竞态(列举后被删/权限变化)→ 跳过该项,不崩整个扫描
      let dirStat
      try { dirStat = statSync(dir) } catch { return }
      const proj = { name: basename(dir), path: dir, last_modified: new Date(dirStat.mtimeMs).toISOString(), instructions: {}, manifests: {}, git: null }
      // 读取防护:符号链接文件不读;size>1MB 不读入(截 2KB 没必要读大文件);竞态读失败=维度缺失
      const safeRead = (p) => { try { const st = lstatSync(p); if (st.isSymbolicLink() || st.size > 1024 * 1024) return null } catch { return null } try { return readFileSync(p, 'utf8').slice(0, 2048) } catch { return null } }
      for (const f of INSTRUCTIONS) if (files.includes(f)) {
        if (bytes >= maxBytes) { proj.skipped_content = true } // 超预算只记路径名
        else { const t = safeRead(join(dir, f)); if (t !== null) { proj.instructions[f] = t; bytes += Buffer.byteLength(t) } }
      }
      for (const m of MANIFESTS) if (files.includes(m)) {
        try { const j = JSON.parse(readFileSync(join(dir, m), 'utf8')); proj.manifests[m] = { dependencies: Object.keys({ ...(j.dependencies ?? {}), ...(j.devDependencies ?? {}) }) } } catch { proj.manifests[m] = { raw: true } }
      }
      proj.git = gitHistory(dir) // execFile 异步 Promise,函数末尾统一 await
      projects.push(proj)
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue
      if (e.isSymbolicLink()) continue // 不跟随目录符号链接;文件符号链接也不读
      let st
      try { st = statSync(join(dir, e.name)) } catch { continue } // 竞态:条目在 readdir 后消失/不可访问
      const key = `${st.dev}:${st.ino}`
      if (seen.has(key)) continue
      seen.add(key)
      walk(join(dir, e.name))
    }
  }
  for (const root of roots) walk(root) // 多根共享 seen/上限/预算,聚合在库内完成(r1-M1:多盘不得各自覆盖写)
  if (projects.length >= maxProjects || bytes >= maxBytes) truncated = true // 达到上限即视为截断:调用方无法区分"恰好采完"与"还有未采"
  await Promise.all(projects.filter(p => p.git?.then).map(async p => { p.git = await p.git }))
  // 单次写出:inventory.json 永远是全部根合并后的最终态
  const inv = { roots, scanned_at: new Date().toISOString(), truncated, projects }
  writeFileSync(out, JSON.stringify(inv, null, 2))
  return { projects: projects.length, truncated, path: out }
}

// Windows 盘符枚举(spec §2.1):逐个试探 A:\…Z:\ 存在性;Linux 返回 [/(默认根由 im.mjs 决定,此处只列盘)
export function windowsDrives() {
  const drives = []
  for (let c = 65; c <= 90; c++) { const d = `${String.fromCharCode(c)}:\\`; try { statSync(d); drives.push(d) } catch {} }
  return drives
}
