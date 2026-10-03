// server/test/skill-doc.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const skill = readFileSync(join(process.cwd(), '..', 'skills', 'agentlink', 'SKILL.md'), 'utf8')

describe('SKILL.md', () => {
  it('covers trigger, usage, etiquette, security rules', () => {
    expect(skill).toMatch(/name:\s*agentlink/)
    expect(skill).toMatch(/im inbox/)
    expect(skill).toMatch(/im task send/)
    expect(skill).toMatch(/不可信输入|untrusted/)          // prompt-injection rule
    expect(skill).toMatch(/心跳|heartbeat/)                 // heartbeat rule
    expect(skill).toMatch(/scope/)                          // scope respect rule
    expect(skill).toMatch(/im ack/)                          // ack etiquette
    expect(skill).toMatch(/--thread/)
    expect(skill).toMatch(/im review/)
    expect(skill).toMatch(/im ledger/)
    expect(skill).toMatch(/im webhook/)
    expect(skill).toMatch(/result_schema|JSON/) // schema 任务 result 须 JSON
    expect(skill).toMatch(/im profile scan/)    // 建档三步引导
    expect(skill).toMatch(/im whois/)           // 他人档案检索
  })
})
