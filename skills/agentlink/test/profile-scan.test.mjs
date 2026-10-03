// skills/agentlink/test/profile-scan.test.mjs — scan 采集契约(spec §2.1;fixture 全 mkdtemp,不碰真实盘)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

let TMP, ROOT
const git = (dir, ...a) => execSync(`git -c user.email=t@t -c user.name=t -c commit.gpgsign=false ${a.join(' ')}`, { cwd: dir })

before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'pscan-'))
  ROOT = join(TMP, 'root')
  // 项目 A:真 git 仓库 + CLAUDE.md + package.json
  const a = join(ROOT, 'projA'); mkdirSync(a, { recursive: true })
  writeFileSync(join(a, 'CLAUDE.md'), 'A'.repeat(3000))
  writeFileSync(join(a, 'package.json'), JSON.stringify({ name: 'a', dependencies: { express: '^4.0.0', ws: '^8.0.0' } }))
  git(a, 'init', '-q'); writeFileSync(join(a, 'f.txt'), 'x')
  git(a, 'add', '.'); git(a, 'commit', '-qm', 'c1')
  // 项目 B:仅 pyproject.toml(无 git)——清单判据命中
  const b = join(ROOT, 'projB'); mkdirSync(b, { recursive: true })
  writeFileSync(join(b, 'pyproject.toml'), '[project]\ndependencies = ["fastapi"]\n')
  // 非项目目录:无任何判据
  mkdirSync(join(ROOT, 'plain'), { recursive: true })
  // 符号链接环:root/loop → root(不得死循环)
  symlinkSync(ROOT, join(ROOT, 'loop'))
  // 跳过目录:node_modules 内放假项目,不采
  const nm = join(ROOT, 'nodem', 'node_modules', 'hidden'); mkdirSync(nm, { recursive: true })
  writeFileSync(join(nm, 'package.json'), '{}')
})
after(() => rmSync(TMP, { recursive: true, force: true }))

test('scan 采集项目 A/B、跳过非项目与 node_modules、环不死循环', async () => {
  const { scan } = await import('../lib/profile-scan.mjs')
  const out = join(TMP, 'inv.json')
  const r = await scan({ roots: [ROOT], out })
  const inv = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(r.truncated, false)
  assert.ok(inv.projects.length === 2, `projects=${inv.projects.length}`)
  const A = inv.projects.find(p => p.name === 'projA'); const B = inv.projects.find(p => p.name === 'projB')
  assert.ok(A, 'projA 在')
  assert.ok(A.instructions['CLAUDE.md'].length <= 2048, 'CLAUDE.md 截到 2KB') // brief 原文 A.instructions.CLAUDE.md 是点号歧义,等效修正为括号取值
  assert.deepEqual(A.manifests['package.json'].dependencies.sort(), ['express', 'ws']) // 依赖名,无版本
  assert.ok(A.git.total_commits >= 1, 'git 维度在')
  assert.ok(A.path && A.last_modified, '路径与最后修改时间')
  assert.ok(B.manifests['pyproject.toml'], 'pyproject 命中清单判据')
  assert.ok(!inv.projects.some(p => p.name === 'hidden'), 'node_modules 不采')
})

test('多根合并单写:两根各含一项目,inventory 合并 2 项(r1-M1——多盘不得互相覆盖)', async () => {
  const { scan } = await import('../lib/profile-scan.mjs')
  const out = join(TMP, 'inv-merge.json')
  const r = await scan({ roots: [join(ROOT, 'projA'), join(ROOT, 'projB')], out })
  const inv = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(r.projects, 2)
  assert.ok(inv.projects.some(p => p.name === 'projA') && inv.projects.some(p => p.name === 'projB'))
})

test('git 缺失/非仓库维度静默缺失不失败', async () => {
  const { scan } = await import('../lib/profile-scan.mjs')
  const r = await scan({ roots: [join(ROOT, 'projB')], out: join(TMP, 'inv2.json') })
  const inv = JSON.parse(readFileSync(join(TMP, 'inv2.json'), 'utf8'))
  assert.equal(inv.projects[0].git, null)
  assert.equal(r.truncated, false)
})

test('时间上限触发 truncated=true 且已采部分保留', async () => {
  const { scan } = await import('../lib/profile-scan.mjs')
  const out = join(TMP, 'inv3.json')
  const r = await scan({ roots: [ROOT], out, timeLimitMs: 0 }) // 0ms:首个项目后即超时
  const inv = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(r.truncated, true)
  assert.equal(inv.truncated, true)
  assert.ok(Array.isArray(inv.projects))
})

test('项目数硬上限 200 截断(只记路径)', async () => {
  const { scan } = await import('../lib/profile-scan.mjs')
  // 造 3 个项目的浅树,把 maxProjects 注入为 2
  const r = await scan({ roots: [ROOT], out: join(TMP, 'inv4.json'), maxProjects: 2 })
  assert.equal(r.truncated, true)
  const inv = JSON.parse(readFileSync(join(TMP, 'inv4.json'), 'utf8'))
  assert.ok(inv.projects.length === 2)
})
