// skills/agentlink/test/fixtures/preload-fetch.mjs — 测试专用 fetch 注入（不起真服）
// 用法：NODE_OPTIONS="--import <本文件>" + IM_FETCH_ROUTES（{路径:{status,body}}）+ IM_FETCH_LOG（请求日志）
// 把 globalThis.fetch 替换为按路由表应答的 mock；im.mjs 保持零依赖、零改动。
const routes = JSON.parse(process.env.IM_FETCH_ROUTES ?? '{}')
const log = process.env.IM_FETCH_LOG
globalThis.fetch = async (url, opts = {}) => {
  const { appendFileSync } = await import('node:fs')
  appendFileSync(log, JSON.stringify({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.authorization ?? null }) + '\n')
  const u = new URL(String(url))
  const hit = routes[u.pathname]
  if (!hit) return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'no mock route ' + u.pathname } }), { status: 404, headers: { 'content-type': 'application/json' } })
  return new Response(JSON.stringify(hit.body ?? {}), { status: hit.status ?? 200, headers: { 'content-type': 'application/json' } })
}
