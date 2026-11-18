import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createActivity, payloadShape } from '../src/activity.js'

function fixture(t) {
  const stateDir = mkdtempSync(join(tmpdir(), 'webbridge-activity-'))
  t.after(() => rmSync(stateDir, { recursive: true, force: true }))
  return stateDir
}

test('activity records retain request identity and payload shapes without private values', t => {
  const stateDir = fixture(t)
  const activity = createActivity({ stateDir, site: 'chatgpt' }, undefined, { sessionId: '/private/session-name' })
  activity.emit('mcp.received', 'MCP 收到工具调用', { argumentsShape: payloadShape({ password: 'PRIVATE_VALUE', path: '/private/file' }) })
  activity.emit('mcp.output', 'MCP 已返回工具执行结果', { outputChars: 20 })
  const raw = readFileSync(join(stateDir, 'activity.log'), 'utf8')
  const records = raw.trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records[0].requestId, records[1].requestId)
  assert.equal(records[0].session, records[1].session)
  assert.deepEqual(records[0].argumentsShape.keys, ['password', 'path'])
  assert.doesNotMatch(raw, /PRIVATE_VALUE|private\/file|private\/session-name/)
  if (process.platform !== 'win32') assert.equal(statSync(join(stateDir, 'activity.log')).mode & 0o777, 0o600)
})

test('activity logs rotate at one MiB and keep only two backups', t => {
  const stateDir = fixture(t)
  const path = join(stateDir, 'activity.log')
  const activity = createActivity({ stateDir })
  for (let index = 0; index < 4; index++) {
    writeFileSync(path, String(index).repeat(1024 * 1024))
    activity.emit('test', '记录流程状态')
  }
  assert.deepEqual(readdirSync(stateDir).sort(), ['activity.log', 'activity.log.1', 'activity.log.2'])
  assert.equal(readFileSync(`${path}.1`, 'utf8')[0], '3')
  assert.equal(readFileSync(`${path}.2`, 'utf8')[0], '2')
  assert.ok(statSync(path).size < 1024 * 1024)
})

test('an unwritable log or a throwing host logger cannot interrupt a request', t => {
  const stateDir = fixture(t)
  const file = join(stateDir, 'not-a-directory')
  writeFileSync(file, '')
  let warnings = 0
  const activity = createActivity({ stateDir: file }, line => {
    if (line.includes('无法写入流程日志')) warnings++
    throw new Error('host logger unavailable')
  })
  assert.doesNotThrow(() => {
    activity.emit('input.waiting', '开始监听输入框元素')
    activity.emit('input.filled', '已找到输入框元素')
  })
  assert.equal(warnings, 1)
})
