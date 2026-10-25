// 受限 JSON Schema 子集（spec §4.1）：明确不支持完整 JSON Schema——支持范围即文档，
// 超出操作符直接 422，不静默忽略（静默忽略 = 用户以为校验了其实没有）
import { Errors } from '../http/errors.js'

const TYPES = ['string', 'number', 'integer', 'boolean', 'array', 'object'] as const
type Prim = typeof TYPES[number]
export interface Prop { type?: Prim; enum?: unknown[]; minLength?: number; maxLength?: number; minimum?: number; maximum?: number; items?: { type: Prim }; properties?: Record<string, Prop>; required?: string[] }
export interface ResultSchema { type: 'object'; properties?: Record<string, Prop>; required?: string[] }
const PRIM_KEYS = new Set(['type', 'enum', 'minLength', 'maxLength', 'minimum', 'maximum'])
const OBJ_KEYS = new Set([...PRIM_KEYS, 'properties', 'required', 'items'])

const bad = (m: string): never => { throw Errors.unprocessable('SCHEMA_UNSUPPORTED', m) }
const checkProp = (p: unknown, depth: number, path: string): Prop => {
  if (typeof p !== 'object' || p === null) bad(`${path}: property schema must be object`)
  const prop = p as Record<string, unknown>
  for (const k of Object.keys(prop)) if (!OBJ_KEYS.has(k)) bad(`${path}.${k}: unsupported operator`)
  if (prop.type !== undefined && !(TYPES as readonly string[]).includes(prop.type as string)) bad(`${path}.type: unsupported type`)
  if (prop.items !== undefined) { // r1-M-d：items 内容同型白名单校验，防 items:{type:'weird'} 或 items:{pattern} 溜进运行期
    const it = prop.items as Record<string, unknown>
    for (const k of Object.keys(it)) if (k !== 'type') bad(`${path}.items.${k}: unsupported operator`)
    if (it.type === undefined || !(TYPES as readonly string[]).includes(it.type as string)) bad(`${path}.items.type: unsupported type`)
  }
  if (depth === 1 && (prop.properties !== undefined || prop.items !== undefined)) bad(`${path}: nesting beyond one level unsupported`)
  if (prop.properties !== undefined) { for (const [k, v] of Object.entries(prop.properties as object)) checkProp(v, depth + 1, `${path}.properties.${k}`) }
  return prop as Prop
}
export function assertSchemaDraft(s: unknown): asserts s is ResultSchema {
  if (typeof s !== 'object' || s === null) bad('schema must be object')
  const o = s as Record<string, unknown>
  if (o.type !== 'object') bad('top-level type must be object')
  for (const k of Object.keys(o)) if (!['type', 'properties', 'required'].includes(k)) bad(`${k}: unsupported top-level operator`)
  if (o.required !== undefined && !Array.isArray(o.required)) bad('required must be array')
  if (o.properties !== undefined) for (const [k, v] of Object.entries(o.properties as object)) checkProp(v, 0, `properties.${k}`)
}
const typeOk = (v: unknown, t: Prim): boolean =>
  t === 'string' ? typeof v === 'string' : t === 'boolean' ? typeof v === 'boolean' : t === 'number' ? typeof v === 'number'
  : t === 'integer' ? Number.isInteger(v) : t === 'array' ? Array.isArray(v) : typeof v === 'object' && v !== null && !Array.isArray(v)
export function validateResult(schema: ResultSchema, value: unknown): string[] {
  const errs: string[] = []
  const obj = (typeof value === 'object' && value !== null && !Array.isArray(value)) ? value as Record<string, unknown> : null
  if (!obj) return [ '$: expected object' ]
  for (const key of schema.required ?? []) if (!(key in obj)) errs.push(`$.${key}: required`)
  for (const [key, p] of Object.entries(schema.properties ?? {})) {
    if (!(key in obj)) continue
    const v = obj[key]; const at = `$.${key}`
    if (!checkValue(v, p, at, errs)) continue
    if (p.properties && typeOk(v, 'object')) {
      const vo = v as Record<string, unknown>
      for (const key2 of p.required ?? []) if (!(key2 in vo)) errs.push(`${at}.${key2}: required`)
      // 嵌套（depth-1）属性复用顶层同款校验（终审 I1）：enum/长度/数值界不再静默放行
      for (const [k2, p2] of Object.entries(p.properties)) if (k2 in vo) checkValue(vo[k2], p2, `${at}.${k2}`, errs)
    }
  }
  return errs
}
// 单值操作符校验（type/enum/minLength/maxLength/minimum/maximum/items），顶层与嵌套共用；返回 false 表示类型不符、跳过后续检查
const checkValue = (v: unknown, p: Prop, at: string, errs: string[]): boolean => {
  if (p.type && !typeOk(v, p.type)) { errs.push(`${at}: expected ${p.type}`); return false }
  if (p.enum && !p.enum.includes(v)) errs.push(`${at}: enum`)
  if (typeof v === 'string') {
    if (p.minLength !== undefined && v.length < p.minLength) errs.push(`${at}: minLength ${p.minLength}`)
    if (p.maxLength !== undefined && v.length > p.maxLength) errs.push(`${at}: maxLength ${p.maxLength}`)
  }
  if (typeof v === 'number') {
    if (p.minimum !== undefined && v < p.minimum) errs.push(`${at}: minimum ${p.minimum}`)
    if (p.maximum !== undefined && v > p.maximum) errs.push(`${at}: maximum ${p.maximum}`)
  }
  if (Array.isArray(v) && p.items?.type) v.forEach((el, i) => { if (!typeOk(el, p.items!.type)) errs.push(`${at}[${i}]: expected ${p.items!.type}`) })
  return true
}
