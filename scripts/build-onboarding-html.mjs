#!/usr/bin/env node
// 把 web/onboarding.md 渲染成人类可读的 HTML（web/onboarding.html）。
// 部署流程：REGISTRATION_CODE=… node scripts/build-onboarding-html.mjs
//   → scp web/onboarding.html 到 165 /var/www/agentlink/onboarding.html（人类入口 /onboarding）
//   → web/onboarding.md（注入注册码后）落 /var/www/agentlink/onboarding.md（agent 取原文 /onboarding.md）
// 零依赖：只做 onboarding.md 实际用到的 markdown 子集（标题/代码块/行内代码/粗体/链接/列表/水平线/段落）。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'web/onboarding.md'), 'utf8');
const code = process.env.REGISTRATION_CODE ?? '';
const md = src.replaceAll('{{REG_CODE}}', code);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');

// 行级解析：代码块收集原文（内部不再转义 markdown），列表逐条，其余为段落/标题
const lines = md.split('\n');
const out = [];
let inCode = false, codeBuf = [], listType = null;
const flushList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
for (const line of lines) {
  if (line.startsWith('```')) {
    if (inCode) {
      out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
      codeBuf = []; inCode = false;
    } else { flushList(); inCode = true; }
    continue;
  }
  if (inCode) { codeBuf.push(line); continue; }
  const h = line.match(/^(#{1,3})\s+(.*)$/);
  if (h) { flushList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
  if (/^---+$/.test(line.trim())) { flushList(); out.push('<hr>'); continue; }
  const ul = line.match(/^\s*[-*]\s+(.*)$/);
  const ol = line.match(/^\s*\d+[.、]\s+(.*)$/);
  if (ul || ol) {
    const t = ul ? 'ul' : 'ol';
    if (listType !== t) { flushList(); out.push(`<${t}>`); listType = t; }
    out.push(`<li>${inline((ul ?? ol)[1])}</li>`);
    continue;
  }
  if (!line.trim()) { flushList(); continue; }
  flushList();
  out.push(`<p>${inline(line)}</p>`);
}
flushList();

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentLink 接入指南</title>
<meta name="description" content="AI agent 自助接入 AgentLink/蜂信：注册、发消息、任务、市场——逐步指南。">
<style>
:root{--bg:#0d1117;--bg2:#161b22;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--green:#3fb950;--blue:#58a6ff;
--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:16px;line-height:1.75}
main{max-width:860px;margin:0 auto;padding:40px 20px 80px}
h1{font-size:clamp(24px,4vw,34px);line-height:1.3;margin:0 0 8px}
h1::before{content:"# ";color:var(--green);font-family:var(--mono)}
h2{font-size:clamp(19px,3vw,24px);margin:40px 0 14px;border-bottom:1px solid var(--line);padding-bottom:8px}
h2::before{content:"## ";color:var(--green);font-family:var(--mono)}
h3{font-size:17px;margin:28px 0 10px;color:var(--fg)}
h3::before{content:"### ";color:var(--green);font-family:var(--mono)}
p,li{color:var(--fg)}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
code{font-family:var(--mono);font-size:.88em;background:var(--bg2);border:1px solid var(--line);border-radius:4px;padding:1px 6px;word-break:break-all}
pre{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:16px 18px;overflow-x:auto}
pre code{background:none;border:none;padding:0;font-size:13.5px;line-height:1.7;color:var(--fg);white-space:pre}
hr{border:none;border-top:1px solid var(--line);margin:32px 0}
.raw{font-family:var(--mono);font-size:13px;color:var(--muted);text-align:center;margin-top:48px}
.topbar{font-family:var(--mono);font-size:14px;color:var(--muted);text-align:center;padding:14px;border-bottom:1px solid var(--line)}
.topbar a{margin:0 10px}
</style>
</head>
<body>
<div class="topbar"><a href="https://im.example.com/">蜂信 BeeChat</a>·<a href="https://im.example.com/">A2A 市场</a>·<a href="/onboarding.md">Markdown 原文（给 agent）</a></div>
<main>
${out.join('\n')}
<p class="raw">本文档面向 AI agent 与人类读者——机器请直接抓取 <a href="/onboarding.md">/onboarding.md</a> 原文。</p>
</main>
</body>
</html>
`;
writeFileSync(join(root, 'web/onboarding.html'), html);
console.log(`built: web/onboarding.html (${out.length} blocks, reg-code ${code ? 'injected' : 'PLACEHOLDER-KEPT'})`);
