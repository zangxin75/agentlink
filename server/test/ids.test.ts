// server/test/ids.test.ts
import { describe, it, expect } from 'vitest'
import { sha256Hex, newToken, newMsgId, newTaskId } from '../src/core/ids.js'

describe('ids', () => {
  it('token format: al_ + 43 url-safe chars', () => {
    for (let i = 0; i < 50; i++) expect(newToken()).toMatch(/^al_[A-Za-z0-9_-]{43}$/)
  })
  it('sha256Hex matches known vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
  it('message/task ids are prefixed, monotonic-ish and unique', () => {
    const a = newMsgId(), b = newMsgId()
    expect(a).toMatch(/^msg_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(newTaskId()).toMatch(/^task_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(a < b).toBe(true) // monotonicFactory 严格递增，同毫秒生成也有序
  })
})
