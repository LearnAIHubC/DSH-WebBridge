import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SetupBrowser } from '../src/setup-browser.js'
import { WebBridgeSetup } from '../src/setup.js'
import { BrowserDriver } from '../src/driver.js'
import { BridgeError } from '../src/envelope.js'

test('a repeated console login recognizes the existing session without restarting Chrome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-login-test-'))
  try {
    const opens = [], waits = []
    const driver = {
      async open(url, options) { opens.push({ url, options }) },
      async waitLogin(timeout) { waits.push(timeout); return { url: 'https://platform.openai.com/settings/organization/api-keys', authenticated: true, manualAuth: { required: false } } },
      async switchToHeadless() {},
    }
    const browser = new SetupBrowser({ settings: { stateDir: root }, driver })
    const result = await browser.login('console')
    assert.equal(result.status, 'ready')
    assert.deepEqual(waits, [5000])
    assert.equal(opens.length, 1)
    assert.equal(opens[0].options, undefined)
    const setup = new WebBridgeSetup({ settings: {}, driver: { exclusive: fn => fn() }, browser: { ...browser, persist: async () => {}, login: async () => result }, tunnel: { redact: value => value, status: () => ({}) }, bridge: { status: () => ({}) } })
    setup.execute({ action: 'loginConsole' }); await setup.pending
    assert.equal(setup.job.stage, '登录成功，可以连接隧道')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('manual login stays visible until authentication succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-manual-login-'))
  try {
    const events = []
    const driver = {
      async open(_url, options) { events.push(options?.headed ? 'headed' : 'open') },
      async waitLogin(timeout) {
        events.push(timeout)
        if (timeout === 5000) throw new BridgeError('manual-auth-timeout', 'not ready')
        assert.equal(browser.auth.console, 'needs-login')
        return { url: 'https://platform.openai.com/settings/organization/api-keys', authenticated: true }
      },
      async switchToHeadless() { events.push('headless') },
    }
    const browser = new SetupBrowser({ settings: { stateDir: root }, driver })
    await browser.login('console')
    assert.equal(browser.auth.console, 'ready')
    assert.deepEqual(events, ['open', 5000, 'headed', 300000, 'headless'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('observing an icon-only signed-in profile uses the driver authentication result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-profile-login-'))
  try {
    const browser = new SetupBrowser({ settings: { stateDir: root }, driver: {
      async state() { return { url: 'https://chatgpt.com/', authenticated: true, manualAuth: { required: false } } },
      async eval() { return { result: 'unknown' } },
    } })
    browser.auth.chatgpt = 'needs-login'
    await browser.observeAccount()
    assert.equal(browser.auth.chatgpt, 'ready')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('reading authenticated state never restarts or hides a manual setup form', async () => {
  const driver = new BrowserDriver({ stateDir: '' })
  driver.lastMode = { headed: true }
  driver.currentPage = async () => ({
    url: () => 'https://platform.openai.com/settings/organization/api-keys',
    title: async () => 'API keys', evaluate: async () => ({ signedIn: true, login: false, password: false, challenge: false }),
  })
  driver.switchToHeadless = async () => { throw new Error('state must not restart the browser') }
  const state = await driver.state()
  assert.equal(state.authenticated, true)
  assert.equal(state.headless, false)
})
