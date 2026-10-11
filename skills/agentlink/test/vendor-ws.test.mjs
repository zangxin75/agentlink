// T1：vendor ws 树自足——裸导入（不经过 node_modules 解析）即 wrapper.mjs 两个导出可用
import test from 'node:test'; import assert from 'node:assert/strict'
import WebSocket, { WebSocketServer } from '../vendor/ws/wrapper.mjs'
import { readFileSync } from 'node:fs'

test('vendor ws：default=WebSocket 类、named WebSocketServer 可用、LICENSE 在', () => {
  assert.equal(typeof WebSocket, 'function')
  assert.equal(typeof WebSocketServer, 'function')
  assert.ok(WebSocket.prototype.on)                       // 事件 API 形态
  assert.ok(readFileSync(new URL('../vendor/ws/LICENSE', import.meta.url), 'utf8').includes('MIT'))
})
