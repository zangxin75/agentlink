// web/landing/check.mjs — node check.mjs；全部通过 exit 0
import { readFileSync, statSync } from 'node:fs'
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8')
const fail = (m) => { console.error('FAIL:', m); process.exitCode = 1 }
if (statSync(new URL('./index.html', import.meta.url)).size > 60 * 1024) fail('file > 60KB')
// 外部资源零引用（仅允许指向本站与 GitHub 的锚点 href）
for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
  const v = m[1]
  if (/^https?:\/\//i.test(v) && !/im.example.com|github\.com/.test(v)) fail('external ref: ' + v)
}
// 禁固定宽度（Review Focus #1 静态近似）
if (/width:\s*\d{4,}px/.test(html)) fail('fixed-width CSS')
// 六节齐备（按 spec §3 的节 id）
for (const id of ['hero', 'hook', 'pains', 'onboard', 'arch', 'footer']) {
  if (!html.includes(`id="${id}"`)) fail('missing section ' + id)
}
// 双语节点数一致：每个 data-zh 必有配对 data-en
const zh = [...html.matchAll(/data-zh="/g)].length, en = [...html.matchAll(/data-en="/g)].length
if (zh === 0 || zh !== en) fail(`zh/en mismatch: ${zh}/${en}`)
// 文案抽检（spec §2 逐字）
for (const s of ['给你的 AI agent 一个通讯地址', 'Give your AI agents a mailing address', '自托管', 'thread_id']) {
  if (!html.includes(s)) fail('missing copy: ' + s)
}
// 安装区块（dist spec §5）：双平台命令各一、host-swap 复用、单复制按钮（一次复制含双平台指令）、保守两步折叠、自托管与注册码文案
for (const s of ['/download/install.sh', '/download/install.ps1', 'AGENTLINK_DIST_BASE', '管理员索取', 'irm', '<details>']) {
  if (!html.includes(s)) fail('missing install block: ' + s)
}
if (!/class="host-swap">[^<]*<\/span>\.im.example.com\/download\/install\.(sh|ps1)/.test(html)) fail('install cmd host-swap missing')
if (!/id="copy-install"/.test(html) || !/installMsg\(\)/.test(html)) fail('install copy button missing')
// 视觉规范要素
if (!/#0d1117/.test(html)) fail('dark bg missing')
if (!/prefers-reduced-motion/.test(html)) fail('reduced-motion missing')
if (!/name="viewport"/.test(html)) fail('viewport meta missing')
if (!/<html lang="/.test(html)) fail('html lang missing')
console.log(process.exitCode ? 'CHECK FAILED' : `OK (${zh} bilingual pairs)`)
