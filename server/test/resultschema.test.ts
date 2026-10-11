import { describe, it, expect } from 'vitest'
import { assertSchemaDraft, validateResult } from '../src/core/resultschema.js'

const S = (props: Record<string, unknown>, required?: string[]) => ({ type: 'object', properties: props, required })
const E = (s: unknown) => { try { assertSchemaDraft(s); return null } catch (e: any) { return e.code } }

describe('schema draft validation', () => {
  it('rejects unsupported operators and malformed drafts', () => {
    expect(E({ type: 'object', properties: { a: { pattern: '^x$' } } })).toBe('SCHEMA_UNSUPPORTED')
    expect(E({ type: 'object', properties: { a: { type: 'string', default: 'x' } } })).toBe('SCHEMA_UNSUPPORTED')
    expect(E({ type: 'array' })).toBe('SCHEMA_UNSUPPORTED') // 顶层必须 object
    expect(E('nope')).toBe('SCHEMA_UNSUPPORTED')
    expect(E({ type: 'object', properties: { a: { type: 'weird' } } })).toBe('SCHEMA_UNSUPPORTED')
    expect(E({ type: 'object', properties: { a: { type: 'array', items: { type: 'weird' } } } })).toBe('SCHEMA_UNSUPPORTED') // r1-M-d
    expect(E({ type: 'object', properties: { a: { type: 'array', items: { pattern: '^x$' } } } })).toBe('SCHEMA_UNSUPPORTED') // r1-M-d（brief 原文缺一个右括号，已补）
    expect(E({ type: 'object', properties: { a: { properties: { b: { properties: {} } } } } })).toBe('SCHEMA_UNSUPPORTED') // 二层嵌套
  })
  it('operator matrix: positive cases all pass', () => {
    const s = S({
      name: { type: 'string', minLength: 1, maxLength: 5 }, level: { type: 'integer', minimum: 1, maximum: 3 },
      score: { type: 'number' }, ok: { type: 'boolean' }, tags: { type: 'array', items: { type: 'string' } },
      mode: { enum: ['fast', 'slow'] }, nested: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
    }, ['name', 'level'])
    expect(validateResult(s as never, { name: 'abc', level: 2, score: 1.5, ok: true, tags: ['a'], mode: 'fast', nested: { x: 1 } })).toEqual([])
  })
  it('operator matrix: negative cases report precise paths', () => {
    const s = S({ name: { type: 'string', minLength: 2, maxLength: 4 }, level: { type: 'integer', minimum: 1, maximum: 3 }, tags: { type: 'array', items: { type: 'string' } }, nested: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }, mode: { enum: ['a', 'b'] } }, ['name', 'nested'])
    expect(validateResult(s as never, {})).toEqual(['$.name: required', '$.nested: required'])
    expect(validateResult(s as never, { name: 'x', nested: {} })).toContain('$.name: minLength 2')
    expect(validateResult(s as never, { name: 'xxxxx', nested: { x: 1 } })).toContain('$.name: maxLength 4')
    expect(validateResult(s as never, { name: 'ok', level: 0, nested: { x: 1 } })).toContain('$.level: minimum 1')
    expect(validateResult(s as never, { name: 'ok', level: 4, nested: { x: 1 } })).toContain('$.level: maximum 3')
    expect(validateResult(s as never, { name: 'ok', level: 1.5, nested: { x: 1 } })).toContain('$.level: expected integer')
    expect(validateResult(s as never, { name: 'ok', tags: [1], nested: { x: 1 } })).toContain('$.tags[0]: expected string')
    expect(validateResult(s as never, { name: 'ok', mode: 'c', nested: { x: 1 } })).toContain('$.mode: enum')
    expect(validateResult(s as never, { name: 'ok', nested: { x: 's' } })).toContain('$.nested.x: expected number')
  })
})

// 终审 I1：depth-1 嵌套属性的操作符（enum/长度/数值界）须与顶层同样执行，不得静默放行
describe('nested (depth-1) operator enforcement', () => {
  const s = S({ nested: { type: 'object', properties: { x: { type: 'string', maxLength: 3 }, lvl: { type: 'integer', minimum: 10 }, mode: { enum: ['a'] } } } })
  it('positive: conforming nested values pass', () => {
    expect(validateResult(s as never, { nested: { x: 'ok', lvl: 20, mode: 'a' } })).toEqual([])
  })
  it('negative: nested maxLength / minimum / enum violations are reported', () => {
    expect(validateResult(s as never, { nested: { x: 'too long', lvl: 20, mode: 'a' } })).toContain('$.nested.x: maxLength 3')
    expect(validateResult(s as never, { nested: { x: 'ok', lvl: 1, mode: 'a' } })).toContain('$.nested.lvl: minimum 10')
    expect(validateResult(s as never, { nested: { x: 'ok', lvl: 20, mode: 'zzz' } })).toContain('$.nested.mode: enum')
  })
})
