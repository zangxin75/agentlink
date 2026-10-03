// profile-cli 本地校验器与敏感后检（spec §2.2/§2.3；不发真请求）
import { test } from 'node:test'
import assert from 'node:assert/strict'

const GOOD = { headline: 'x', skills: [{ name: 'node', level: 4, evidence: 'e' }], projects: [{ name: 'p', role: 'r', stack: ['node'], summary: 's' }], style: { summary: 'st' }, generated_at: '2026-10-01T00:00:00Z' }

test('合法档案零错误零警告', async () => {
  const { validateProfileLocal } = await import('../lib/profile-validate.mjs')
  const r = validateProfileLocal(GOOD)
  assert.deepEqual(r, { errors: [], warnings: [] })
})
test('超限/缺 evidence/level 越界/大写 name → errors 带字段名', async () => {
  const { validateProfileLocal } = await import('../lib/profile-validate.mjs')
  assert.ok(validateProfileLocal({ ...GOOD, headline: 'x'.repeat(400) }).errors.some(e => e.includes('headline')))
  assert.ok(validateProfileLocal({ ...GOOD, skills: [{ name: 'n', level: 4 }] }).errors.some(e => e.includes('evidence')))
  assert.ok(validateProfileLocal({ ...GOOD, skills: [{ name: 'n', level: 6, evidence: 'e' }] }).errors.some(e => e.includes('level')))
  assert.ok(validateProfileLocal({ ...GOOD, skills: [{ name: 'Node', level: 4, evidence: 'e' }] }).errors.some(e => e.includes('name')))
})
test('敏感后检:/home/、绝对路径、token 形态、IP → warnings(不阻断)', async () => {
  const { validateProfileLocal } = await import('../lib/profile-validate.mjs')
  // token 形态运行时拼接——避免源码出现连续 20+ 位 al_ 字面量而误触发布门禁(与门禁同源正则)
  const fakeTok = 'al_' + 'a'.repeat(24)
  const r = validateProfileLocal({ ...GOOD, style: { summary: `项目在 /home/kt/x,token ${fakeTok}` } })
  assert.equal(r.errors.length, 0)
  assert.ok(r.warnings.some(w => w.includes('/home/')))
  assert.ok(r.warnings.some(w => w.includes('al_')))
})
test('总长 8KB 超 → error(走无数值上限的 stack 承载,独立钉住 8KB 分支)', async () => {
  const { validateProfileLocal } = await import('../lib/profile-validate.mjs')
  // 参照服务端 profile-core.test.ts:projects[].stack 每项 ≤40B 合规、单字段无 600B 类上限,30 项目 × 10 项 × 30B ≈ 9KB 只触发总长分支
  const big = { ...GOOD, projects: Array.from({ length: 30 }, (_, i) => ({ name: `p${i}`, role: 'r', stack: Array.from({ length: 10 }, () => 'x'.repeat(30)), summary: 's' })) }
  const r = validateProfileLocal(big)
  assert.ok(r.errors.some(e => e.includes('8KB') || e.includes('8192')))
  assert.ok(!r.errors.some(e => e.includes('style.summary')), '不应混叠 600B 字段分支')
})
test('publish 敏感警告未确认时拒发(--confirm-sensitive 闸,spec §2.3)', async () => { // 子进程方式(r1-m3):命中 warnings 且未带 --confirm-sensitive 应 die 非零退出
  const { execFile } = await import('node:child_process')
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const T = mkdtempSync(join(tmpdir(), 'ppub-'))
  const f = join(T, 'profile.json')
  writeFileSync(f, JSON.stringify({ ...GOOD, style: { summary: '项目在 /home/kt/x' } }))
  const { fileURLToPath } = await import('node:url')
  const imPath = fileURLToPath(new URL('../im.mjs', import.meta.url))
  const [err, se] = await new Promise((resolve) =>
    execFile(process.execPath, [imPath, 'profile', 'publish', '--file', f], (e, _so, stderr) => resolve([e, stderr])))
  assert.ok(err, '非零退出')
  assert.ok(String(se).includes('confirm-sensitive'), `stderr: ${se}`)
})
