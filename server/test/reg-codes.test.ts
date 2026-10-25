// 分码注册：AGENTLINK_REG_CODES 'owner:code' → 注册即归属；alignRoles 按 HUMAN_IDS 对齐
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'
import { openDb, migrate } from '../src/db/sqlite.js'
import { loadConfig } from '../src/config.js'
import { registerAgent, getAgent, alignRoles } from '../src/core/agents.js'

const setup = (env: Record<string, string> = {}) => {
  const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0', ...env } as never)
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'rc-')), 't.db')); migrate(db, { defaultOwner: cfg.defaultOwner ?? undefined })
  return { cfg, db }
}

describe('分码注册', () => {
  it('AGENTLINK_REG_CODES：码A→owner=kt.human，码B→owner=zhy.human，错码 403', () => {
    const { cfg, db } = setup({ AGENTLINK_REG_CODES: 'kt.human:CODE_A,zhy.human:CODE_B' })
    const a = registerAgent(db, cfg, { agent_id: 'kt.bot1', registration_code: 'CODE_A' })
    expect(getAgent(db, 'kt.bot1').owner).toBe('kt.human')
    registerAgent(db, cfg, { agent_id: 'zhy.bot1', registration_code: 'CODE_B' })
    expect(getAgent(db, 'zhy.bot1').owner).toBe('zhy.human')
    expect(() => registerAgent(db, cfg, { agent_id: 'bad.x', registration_code: 'WRONG' })).toThrowError(/forbidden|registration/i)
  })
  it('分码与 open registration 互斥：无码注册拒绝', () => {
    const { cfg, db } = setup({ AGENTLINK_REG_CODES: 'kt.human:CODE_A', ALLOW_OPEN_REGISTRATION: 'true' })
    expect(() => registerAgent(db, cfg, { agent_id: 'open.x' })).toThrowError(/分码|registration|forbidden/i)
  })
  it('旧单码 REGISTRATION_CODE → owner=defaultOwner（AGENTLINK_DEFAULT_OWNER，缺省 humanIds[0]）', () => {
    const { cfg, db } = setup({ AGENTLINK_DEFAULT_OWNER: 'zhy.human' })
    registerAgent(db, cfg, { agent_id: 'old.bot', registration_code: 'x' })
    expect(getAgent(db, 'old.bot').owner).toBe('zhy.human')
    const c2 = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0', AGENTLINK_HUMAN_IDS: 'kt.human,zhy.human' } as never)
    expect(c2.defaultOwner).toBe('kt.human') // 缺省取 HUMAN_IDS 第一个
  })
  it('alignRoles：HUMAN_IDS 内置 role=human，幂等', () => {
    const { cfg, db } = setup({ AGENTLINK_HUMAN_IDS: 'kt.human,zhy.human' })
    registerAgent(db, cfg, { agent_id: 'kt.human', registration_code: 'x' })
    alignRoles(db, cfg.humanIds); alignRoles(db, cfg.humanIds)
    expect(getAgent(db, 'kt.human').role).toBe('human')
    expect(getAgent(db, 'server').role).toBe('agent')
  })
})

// —— 邮箱自助码分支（spec §3，v9）——
describe('registerAgent DB regcode branch', () => {
  const setup = () => {
    const cfg = loadConfig({ REGISTRATION_CODE: 'x', PORT: '0' } as never)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'rdb-')), 't.db')); migrate(db)
    return { cfg, db }
  }
  const insCode = (db: any, code: string, owner: string) =>
    db.prepare(`INSERT INTO registration_codes (code, owner_agent_id, email_norm, created_at) VALUES (?,?,'a@b.c','2026-01-01T00:00:00Z')`).run(code, owner)

  it('DB 码命中 → owner=码 owner；agent_id===owner → role=human；伪码 403', () => {
    const { cfg, db } = setup(); insCode(db, 'al_reg_good', 'kt.human')
    const out = registerAgent(db, cfg, { agent_id: 'kt.human', registration_code: 'al_reg_good' })
    expect(out.agent.owner).toBe('kt.human'); expect(out.agent.role).toBe('human')
    const a = registerAgent(db, cfg, { agent_id: 'kt.bot', registration_code: 'al_reg_good' })
    expect(a.agent.owner).toBe('kt.human'); expect(a.agent.role).toBe('agent')
    // r2-N1：DB 发过码（未吊销存在）→ sticky 门在公开码分支之前，伪码走 registrationClosed（消息 'registration requires …'），不是 forbidden('invalid registration code')
    expect(() => registerAgent(db, cfg, { agent_id: 'x.y', registration_code: 'al_reg_bad' })).toThrowError(/registration requires/)
  })
  it('已吊销 DB 码不认 → 403（sticky：仍 registrationClosed）', () => {
    const { cfg, db } = setup()
    insCode(db, 'al_reg_r', 'kt.human')
    db.prepare(`UPDATE registration_codes SET revoked_at='2026-01-01T00:00:00Z' WHERE code='al_reg_r'`).run()
    expect(() => registerAgent(db, cfg, { agent_id: 'kt.bot', registration_code: 'al_reg_r' })).toThrowError(/registration requires/)
  })
  it('优先级：DB 码存在时 env 分码不参与归属（DB 优先）', () => {
    const cfg = loadConfig({ REGISTRATION_CODE: 'x', AGENTLINK_REG_CODES: 'kt.human:envcode', PORT: '0' } as never)
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'rdb-')), 't.db')); migrate(db)
    insCode(db, 'al_reg_db', 'other.human')
    const out = registerAgent(db, cfg, { agent_id: 'a.bot', registration_code: 'al_reg_db' })
    expect(out.agent.owner).toBe('other.human')
  })
  it('sticky 收口（r4-M1）：env 分码空 + DB 发过码（含已吊销）→ 公开码与 ALLOW_OPEN 均闭门', () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), 'rdb-')), 't.db')); migrate(db)
    insCode(db, 'al_reg_s', 'kt.human')
    db.prepare(`UPDATE registration_codes SET revoked_at='2026-01-01T00:00:00Z' WHERE code='al_reg_s'`).run() // 全部吊销
    // 公开码：旧实现 cfg.registrationCode 命中即放行 → 应 403（r1-C5：断言按消息文本，错误码 REGISTRATION_CLOSED 不出现在 message 里）
    const cfgPub = loadConfig({ REGISTRATION_CODE: 'pub', PORT: '0' } as never)
    expect(() => registerAgent(db, cfgPub, { agent_id: 'a.bot', registration_code: 'pub' })).toThrowError(/registration requires/)
    // ALLOW_OPEN：旧实现无码放行 → 应 403
    const cfgOpen = loadConfig({ ALLOW_OPEN_REGISTRATION: 'true', PORT: '0' } as never)
    expect(() => registerAgent(db, cfgOpen, { agent_id: 'a.bot' })).toThrowError(/registration requires/)
    // 同库从未发码 → ALLOW_OPEN 正常放行（门只挡发过码的库）
    const db2 = openDb(join(mkdtempSync(join(tmpdir(), 'rdb-')), 't.db')); migrate(db2)
    const out = registerAgent(db2, cfgOpen, { agent_id: 'a.bot' })
    expect(out.agent.owner).toBe('') // r1-M3：humanIds 未配 → defaultOwner=null → owner 落 ''
    // 显式钉死：无码 + 无公开码 + 无 ALLOW_OPEN → 一律 closed（r1 minor）
    const cfgNone = loadConfig({ REGISTRATION_CODE: '', PORT: '0' } as never)
    expect(() => registerAgent(db2, cfgNone, { agent_id: 'b.bot' })).toThrowError(/registration requires/)
  })
})
