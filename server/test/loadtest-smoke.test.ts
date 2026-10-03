import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { startWsServer } from './helpers/ws-server.js'

// 实现注记（偏离声明）：brief 原稿用 spawnSync，但 spawnSync 会阻塞本进程事件循环，
// 而被测服务就在本进程内 —— 子进程的首个 HTTP 请求会死锁，测试永远挂起。
// 改用异步 spawn + Promise 收集退出码与输出，语义不变。
function runLoadtest(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('node', [`${process.cwd()}/../scripts/loadtest.mjs`, ...args], { encoding: 'utf8' } as never)
    let stdout = '', stderr = ''
    p.stdout.on('data', d => { stdout += d })
    p.stderr.on('data', d => { stderr += d })
    p.on('error', reject)
    p.on('close', status => resolve({ status, stdout, stderr }))
  })
}

describe('loadtest script smoke tier', () => {
  it('zero loss at tiny scale', async () => {
    // 注册限流默认 10/h/IP，压测需放宽（生产压测同理，见 Task 21 Step 7）
    const srv = await startWsServer({ RATE_LIMIT_REGISTER_PER_HOUR: '100' })
    const url = `http://127.0.0.1:${(srv.app.server.address() as any).port}`
    const r = await runLoadtest(['--url', url, '--connections', '10', '--rate', '5', '--duration', '6', '--reg-code', 'x'])
    await srv.close()
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/"loss":0\b/)
  }, 60_000)
})
