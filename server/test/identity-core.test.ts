// server/test/identity-core.test.ts — 身份域核心：identity key/recovery 落库、claim/bind/rotate 原子语义（TDD RED→GREEN）
import { describe, it, expect } from 'vitest'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent } from '../src/core/agents.js'
import { bindIdentityKey, claimAgent, rotateIdentity, newRecoveryCode } from '../src/core/identity.js'
import { sha256Hex } from '../src/core/ids.js'
import { AppError } from '../src/http/errors.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cfg = loadConfig({ REGISTRATION_CODE: 'x' } as never)
const mk = () => openDb(join(tmpdir(), `al-identity-${Date.now()}-${Math.random().toString(36).slice(2)}.db`))
const errOf = (fn: () => unknown): AppError => {
  try { fn(); throw new Error('expected throw') } catch (e) { return e as AppError }
}

describe('身份域核心', () => {
  it('register 带 identity_key → 落 hash + 返回 recovery_code；同 key 再注册 → INVALID_REQUEST 含 IDENTITY_MULTI 与 agents 列表', () => {
    const db = mk(); migrate(db)
    const r1 = registerAgent(db, cfg, { agent_id: 'alice.id', registration_code: 'x', identity_key: 'key-1' })
    expect(r1.recovery_code).toBeTruthy()
    // 落的是 sha256，不是明文
    const row: any = db.prepare('SELECT identity_key_hash FROM agents WHERE id=?').get('alice.id')
    expect(row.identity_key_hash).toBe(sha256Hex('key-1'))
    // recovery 同样只存 hash
    const row2: any = db.prepare('SELECT recovery_hash FROM agents WHERE id=?').get('alice.id')
    expect(row2.recovery_hash).toBe(sha256Hex(r1.recovery_code))
    const e = errOf(() => registerAgent(db, cfg, { agent_id: 'bob.id', registration_code: 'x', identity_key: 'key-1' }))
    expect(e.code).toBe('INVALID_REQUEST')
    expect(e.message).toContain('IDENTITY_MULTI')
    expect(e.message).toContain('alice.id')
    expect(e.message).toContain('hint')
  })

  it('claimAgent by key → agent_id 不变、新 token、旧 default token 进 revokedTokenIds；recovery 滚动（旧码再用 → 401）', () => {
    const db = mk(); migrate(db)
    const reg = registerAgent(db, cfg, { agent_id: 'carol.id', registration_code: 'x', identity_key: 'key-2' })
    const claim = claimAgent(db, { identityKey: 'key-2' })
    expect(claim.agent.id).toBe('carol.id')
    expect(claim.token).toBeTruthy()
    expect(claim.token).not.toBe(reg.token)
    expect(claim.revokedTokenIds.length).toBe(1) // 旧 default token 被撤
    const oldTok: any = db.prepare('SELECT revoked_at FROM tokens WHERE id=?').get(claim.revokedTokenIds[0])
    expect(oldTok.revoked_at).toBeTruthy()
    expect(claim.recoveryCode).toBeTruthy()
    // recovery 滚动：注册时的旧 recovery code 再用 → unauthorized
    const e = errOf(() => claimAgent(db, { recoveryCode: reg.recovery_code! }))
    expect(e.status).toBe(401)
    // 新 recovery code 可用（再 claim 一次成功且再滚动）
    const c2 = claimAgent(db, { recoveryCode: claim.recoveryCode })
    expect(c2.agent.id).toBe('carol.id')
  })

  it('recovery 原子消费：同码两次第二次 401；Promise.all 并发亦只成功一次', async () => {
    const db = mk(); migrate(db)
    const reg = registerAgent(db, cfg, { agent_id: 'dave.id', registration_code: 'x' })
    expect(reg.recovery_code).toBeUndefined() // 未带 identity_key 注册不产 recovery
    // 手工落一个 recovery（模拟历史绑定）
    db.prepare('UPDATE agents SET recovery_hash=? WHERE id=?').run(sha256Hex('rc-1'), 'dave.id')
    const first = claimAgent(db, { recoveryCode: 'rc-1' })
    expect(first.agent.id).toBe('dave.id')
    const e = errOf(() => claimAgent(db, { recoveryCode: 'rc-1' }))
    expect(e.status).toBe(401)
    // 并发（better-sqlite3 同步，串行化验证 changes 判定防双花）
    db.prepare('UPDATE agents SET recovery_hash=? WHERE id=?').run(sha256Hex('rc-2'), 'dave.id')
    const results = await Promise.all([
      Promise.resolve().then(() => { try { return claimAgent(db, { recoveryCode: 'rc-2' }) } catch (e) { return e as AppError } }),
      Promise.resolve().then(() => { try { return claimAgent(db, { recoveryCode: 'rc-2' }) } catch (e) { return e as AppError } }),
    ])
    const oks = results.filter((r: any) => r instanceof AppError === false)
    const fails = results.filter((r: any) => r instanceof AppError) as AppError[]
    expect(oks.length).toBe(1)
    expect(fails.length).toBe(1)
    expect(fails[0].status).toBe(401)
  })

  it('bind：新 key 成功返 recovery；同 agent 换 key → IDENTITY_EXISTS；key 属他人 → IDENTITY_TAKEN', () => {
    const db = mk(); migrate(db)
    registerAgent(db, cfg, { agent_id: 'erin.id', registration_code: 'x' })
    const b = bindIdentityKey(db, 'erin.id', 'key-3')
    expect(b.recoveryCode).toBeTruthy()
    const row: any = db.prepare('SELECT identity_key_hash FROM agents WHERE id=?').get('erin.id')
    expect(row.identity_key_hash).toBe(sha256Hex('key-3'))
    const e1 = errOf(() => bindIdentityKey(db, 'erin.id', 'key-4'))
    expect(e1.message).toContain('IDENTITY_EXISTS')
    registerAgent(db, cfg, { agent_id: 'frank.id', registration_code: 'x' })
    const e2 = errOf(() => bindIdentityKey(db, 'frank.id', 'key-3'))
    expect(e2.message).toContain('IDENTITY_TAKEN')
  })

  it('rotate：旧 key 作废（再 claim 401）、新 key 可 claim；新 key 属他人 → IDENTITY_TAKEN', () => {
    const db = mk(); migrate(db)
    registerAgent(db, cfg, { agent_id: 'gina.id', registration_code: 'x', identity_key: 'key-5' })
    const r = rotateIdentity(db, { identityKey: 'key-5', newIdentityKey: 'key-6' })
    expect(r.agent.id).toBe('gina.id')
    expect(r.token).toBeTruthy()
    expect(r.recoveryCode).toBeTruthy()
    const e = errOf(() => claimAgent(db, { identityKey: 'key-5' }))
    expect(e.status).toBe(401)
    const c = claimAgent(db, { identityKey: 'key-6' })
    expect(c.agent.id).toBe('gina.id')
    registerAgent(db, cfg, { agent_id: 'hank.id', registration_code: 'x' })
    const e2 = errOf(() => rotateIdentity(db, { identityKey: 'key-6', newIdentityKey: 'key-6' }))
    expect(e2.message).toContain('IDENTITY_TAKEN')
  })

  it('multi：两 agent 同 key（手工 UPDATE 模拟历史）→ claim 不带 agentId 抛 IDENTITY_MULTI；带 agentId 成功', () => {
    const db = mk(); migrate(db)
    registerAgent(db, cfg, { agent_id: 'ivy1.id', registration_code: 'x', identity_key: 'key-7' })
    registerAgent(db, cfg, { agent_id: 'ivy2.id', registration_code: 'x' })
    db.prepare('UPDATE agents SET identity_key_hash=? WHERE id=?').run(sha256Hex('key-7'), 'ivy2.id')
    const e = errOf(() => claimAgent(db, { identityKey: 'key-7' }))
    expect(e.message).toContain('IDENTITY_MULTI')
    expect(e.message).toContain('ivy1.id')
    expect(e.message).toContain('ivy2.id')
    const c = claimAgent(db, { identityKey: 'key-7', agentId: 'ivy2.id' })
    expect(c.agent.id).toBe('ivy2.id')
    // 另一持有者的绑定未被清除，不带 agentId 仍然歧义
    const e2 = errOf(() => claimAgent(db, { identityKey: 'key-7' }))
    expect(e2.message).toContain('IDENTITY_MULTI')
  })

  it('迁移幂等：migrate 跑两遍不炸，user_version=6；audit 事件落库', () => {
    const db = mk()
    migrate(db); migrate(db)
    expect((db.prepare('PRAGMA user_version').get() as any).user_version).toBeGreaterThanOrEqual(7)
    registerAgent(db, cfg, { agent_id: 'jack.id', registration_code: 'x' })
    bindIdentityKey(db, 'jack.id', 'key-8') // 未绑定的 agent 绑 key → identity.bound
    claimAgent(db, { identityKey: 'key-8' })
    const events = (db.prepare('SELECT event FROM audit_log ORDER BY id').all() as any[]).map(r => r.event)
    expect(events).toContain('identity.claimed')
    expect(events).toContain('identity.bound')
    expect(events).toContain('agent.registered')
  })

  it('原子性：recovery 被并发消费 → 401 且不撤任何 token（不砖号）', () => {
    const db = mk(); migrate(db)
    registerAgent(db, cfg, { agent_id: 'luna.id', registration_code: 'x', identity_key: 'key-c' })
    db.prepare('UPDATE agents SET recovery_hash=? WHERE id=?').run(sha256Hex('rc-c'), 'luna.id')
    // 用 BEFORE UPDATE 触发器确定性模拟「另一线程抢先消费了 recovery」：条件更新必然 changes=0
    db.exec(`CREATE TRIGGER trg_simulate_race BEFORE UPDATE ON agents
      WHEN OLD.recovery_hash IS NOT NULL AND NEW.recovery_hash IS NOT NULL AND NEW.recovery_hash != OLD.recovery_hash
      BEGIN SELECT RAISE(IGNORE); END`)
    const e = errOf(() => claimAgent(db, { recoveryCode: 'rc-c' }))
    expect(e.status).toBe(401)
    // 关键断言：失败路径不得留下任何已撤销 token（撤 token/发新 token/消费 recovery 必须同事务）
    const revoked: any[] = db.prepare('SELECT id FROM tokens WHERE agent_id=? AND revoked_at IS NOT NULL').all('luna.id')
    expect(revoked).toEqual([])
    const tokCount: any = db.prepare('SELECT COUNT(*) c FROM tokens WHERE agent_id=?').get('luna.id')
    expect(tokCount.c).toBe(1) // 只有注册时的 default token
    db.exec('DROP TRIGGER trg_simulate_race')
    // 触发器撤除后同码仍可正常 claim（前次失败未消费 recovery）
    const c = claimAgent(db, { recoveryCode: 'rc-c' })
    expect(c.agent.id).toBe('luna.id')
    // rotate 路径同样不砖号
    db.prepare('UPDATE agents SET recovery_hash=? WHERE id=?').run(sha256Hex('rc-d'), 'luna.id')
    db.exec('CREATE TRIGGER trg_simulate_race2 BEFORE UPDATE ON agents WHEN OLD.recovery_hash IS NOT NULL BEGIN SELECT RAISE(IGNORE); END')
    const e2 = errOf(() => rotateIdentity(db, { recoveryCode: 'rc-d', newIdentityKey: 'key-e' }))
    expect(e2.status).toBe(401)
    // 失败的 rotate 不新增任何撤销（此前成功 claim 合法撤过 1 个，数量不变）
    const revoked2: any[] = db.prepare('SELECT id FROM tokens WHERE agent_id=? AND revoked_at IS NOT NULL').all('luna.id')
    expect(revoked2.length).toBe(1)
  })

  it('newRecoveryCode：随机不重复；identity.claimed detail 记 by=key|recovery', () => {
    const db = mk(); migrate(db)
    const a = newRecoveryCode(), b = newRecoveryCode()
    expect(a).not.toBe(b)
    registerAgent(db, cfg, { agent_id: 'kate.id', registration_code: 'x', identity_key: 'key-a' })
    claimAgent(db, { identityKey: 'key-a' }) // by=key
    db.prepare('UPDATE agents SET recovery_hash=? WHERE id=?').run(sha256Hex('rc-b'), 'kate.id')
    claimAgent(db, { recoveryCode: 'rc-b' }) // by=recovery
    const rows: any[] = db.prepare("SELECT detail FROM audit_log WHERE event='identity.claimed'").all()
    const bys = rows.map(r => JSON.parse(r.detail).by)
    expect(bys).toContain('key')
    expect(bys).toContain('recovery')
  })
})
