import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserDriver } from '../src/driver.js'

function fixture({ present = true, afterReload = true, manualAuth = false } = {}) {
  const calls = []
  const url = 'https://chatgpt.com/c/original'
  const target = {
    filter() { return this }, last() { return this },
    async count() { return Number(present) },
    async waitFor(options) {
      calls.push(['wait', options])
      if (!present) throw Object.assign(new Error('not found'), { name: 'TimeoutError' })
    },
    async scrollIntoViewIfNeeded(options) { calls.push(['scroll', options]) },
  }
  const page = {
    url: () => url, isClosed: () => false,
    viewportSize: () => ({ width: 1440, height: 900 }),
    mouse: { async move() {}, async wheel() { calls.push(['wheel']) } },
    locator(selector) { calls.push(['selector', selector]); return target },
    async goto(destination, options) { calls.push(['goto', destination, options]); present = afterReload },
  }
  const driver = new BrowserDriver({ stateDir: '', commandTimeoutMs: 100 })
  driver.context = { browser: () => ({ isConnected: () => true }) }
  driver.currentKey = () => 'owned-session'
  driver.currentPage = async () => page
  driver.sessionPages.set('owned-session', 'owned-page')
  driver.pages.set('owned-page', page)
  driver.state = async () => ({ manualAuth: { required: manualAuth, kind: 'verification' } })
  return { driver, calls, url }
}

test('reply recovery scrolls only the requested turn without resending or reloading when present', async () => {
  const { driver, calls, url } = fixture()
  const result = await driver.reconnectReply({ turnKey: 'current-turn', url })
  assert.equal(result.found, true)
  assert.equal(result.reloaded, false)
  assert.ok(calls.find(call => call[0] === 'selector')[1].includes('current-turn:'))
  assert.equal(calls.filter(call => call[0] === 'scroll').length, 1)
  assert.equal(calls.filter(call => call[0] === 'wheel').length, 1)
  assert.equal(calls.filter(call => call[0] === 'goto').length, 0)
})

test('a missing turn reopens only the original conversation and passes cancellation to browser operations', async () => {
  const { driver, calls, url } = fixture({ present: false })
  const signal = new AbortController().signal
  const result = await driver.reconnectReply({ turnKey: 'current-turn', url, signal })
  assert.deepEqual(result, { found: true, reloaded: true })
  const navigation = calls.filter(call => call[0] === 'goto')
  assert.equal(navigation.length, 1)
  assert.equal(navigation[0][1], url)
  assert.equal(navigation[0][2].signal, signal)
  assert.equal(calls.find(call => call[0] === 'scroll')[1].signal, signal)
})

test('a turn still missing after reload is reported without navigating or sending again', async () => {
  const { driver, calls, url } = fixture({ present: false, afterReload: false })
  assert.deepEqual(await driver.reconnectReply({ turnKey: 'current-turn', url }), { found: false, reloaded: true })
  assert.equal(calls.filter(call => call[0] === 'goto').length, 1)
})

test('recovery refuses a closed or replaced page instead of attaching to another request', async () => {
  const { driver, calls, url } = fixture()
  driver.pages.delete('owned-page')
  await assert.rejects(driver.reconnectReply({ turnKey: 'current-turn', url }), error => error.code === 'browser-closed')
  assert.equal(calls.length, 0)
})

test('verification and cancellation stop recovery before browser navigation', async () => {
  const locked = fixture({ manualAuth: true, present: false })
  await assert.rejects(locked.driver.reconnectReply({ turnKey: 'current-turn', url: locked.url }), error => error.code === 'auth-required:verification')
  assert.equal(locked.calls.length, 0)
  const cancelled = fixture({ present: false })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(cancelled.driver.reconnectReply({ turnKey: 'current-turn', url: cancelled.url, signal: controller.signal }), error => error.code === 'aborted')
  assert.equal(cancelled.calls.length, 0)
})
