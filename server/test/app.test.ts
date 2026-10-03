import { describe, it, expect } from 'vitest'
import { buildApp } from '../src/http/app.js'
import { loadConfig } from '../src/config.js'

const cfg = loadConfig({ PORT: '0' } as never)

describe('app', () => {
  it('GET /healthz returns ok without auth', async () => {
    const app = buildApp({ cfg } as never)
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', uptime_s: expect.any(Number) })
  })

  it('GET /auth.md 无鉴权返回 markdown 注册指引（moltbook 式动态文档端点）', async () => {
    const app = buildApp({ cfg } as never)
    const res = await app.inject({ method: 'GET', url: '/auth.md' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/markdown')
    const body = res.body
    // 关键锚点：安装入口 / 注册命令 / 注册码来源 / 档案三步——SKILL.md 与网站只指回此 URL
    expect(body).toContain('/download/install.sh')
    expect(body).toContain('im register')
    expect(body).toContain('registration_code')
    expect(body).toContain('updated:')
  })

  it('unknown route returns error envelope', async () => {
    const app = buildApp({ cfg } as never)
    const res = await app.inject({ method: 'GET', url: '/v1/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json().error.code).toBe('NOT_FOUND')
  })
})
