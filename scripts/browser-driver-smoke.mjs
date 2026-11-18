import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserDriver } from '../src/driver.js'
import { waitForReply } from '../src/detect.js'
import { WebChatAdapter } from '../src/provider.js'
import { ChatSession } from '../src/session.js'

const root = await mkdtemp(join(tmpdir(), 'webbridge-native-pages-'))
const settings = {
  stateDir: join(root, 'state'),
  browserProfileDir: join(root, 'profile'),
  chromeVersion: '157.0.8103.52',
  fingerprint: {
    seed: '4cb98f09fbe92eba8bcf6b6527d7056c', platform: 'Win32', vendor: 'Google Inc.',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvasNoise: true, audioNoise: true, webgl: 'auto', navigator: false, devtoolsFix: true,
  },
}
const driver = new BrowserDriver(settings, message => process.stdout.write(message + '\n'))
try {
  const urls = await Promise.all([
    driver.exclusive(async () => {
      await driver.open('data:text/html,<title>Session A</title><h1>A</h1>')
      const state = await driver.state()
      assert.equal(state.title, 'Session A')
      assert.equal(state.headless, true)
      return (await driver.currentPage()).url()
    }, 'session-A'),
    driver.exclusive(async () => {
      await driver.open('data:text/html,<title>Session B</title><h1>B</h1>')
      const state = await driver.state()
      assert.equal(state.title, 'Session B')
      assert.equal(state.headless, true)
      return (await driver.currentPage()).url()
    }, 'session-B'),
  ])
  assert.notEqual(urls[0], urls[1])
  assert.equal(driver.pages.size, 2)
  const pageA = await driver.storage.run('session-A', () => driver.currentPage())
  const pageB = await driver.storage.run('session-B', () => driver.currentPage())
  assert.notEqual(pageA, pageB)
  await pageA.setContent('<input contenteditable style="display:none"><div contenteditable></div><button aria-label="Stop generating"><span>Stop</span></button>')
  await driver.storage.run('session-A', async () => {
    await driver.fill('[contenteditable]', 'visible composer')
    assert.equal(await pageA.locator('div').innerText(), 'visible composer')
    await driver.startGenerationWatch('trusted-stop')
    await driver.click('button span')
    assert.equal((await driver.eval('window.__webbridgeGenerationWatch.stopped')).result, true)
    await driver.endGenerationWatch('trusted-stop')
    await driver.startGenerationWatch('synthetic-stop')
    await driver.eval('document.querySelector("button").click()')
    assert.equal((await driver.eval('window.__webbridgeGenerationWatch.stopped')).result, false)
    await driver.endGenerationWatch('synthetic-stop')
    await pageA.setContent(`<script>window.fills = 0; window.sends = 0</script>
      <div class="ProseMirror" contenteditable="true" oninput="if(this.textContent.trim() && ++window.fills === 2) document.querySelector('button').disabled = false"></div>
      <button aria-label="Send" disabled onclick="window.sends++; const input = document.querySelector('.ProseMirror'); const row = document.createElement('div'); row.setAttribute('data-content-search-unit-key', 'retry-turn:0:user'); row.textContent = input.textContent; document.body.appendChild(row); input.textContent = ''; this.disabled = true">Send</button>`)
    const submissionSession = new ChatSession({ settings: { commandTimeoutMs: 150 }, driver })
    const submissionAdapter = { inputSelector: 'div.ProseMirror', sendSelector: 'button[aria-label="Send"]', messageSelector: '.reply', matchReplyToUserTurn: true }
    const retried = await submissionSession.submit('RECOVER_NATIVE_DISABLED_SEND', 'chatgpt', submissionAdapter)
    assert.equal(retried.userTurnKey, 'retry-turn')
    assert.deepEqual((await driver.eval('({ fills: window.fills, sends: window.sends })')).result, { fills: 2, sends: 1 })
    await pageA.setContent(`<div class="ProseMirror" contenteditable="true"></div>
      <button aria-label="Send" onclick="const input = document.querySelector('.ProseMirror'); const row = document.createElement('div'); row.setAttribute('data-content-search-unit-key', 'delivered-turn:0:user'); row.textContent = input.textContent + ' Nexus DSH'; document.body.appendChild(row); input.remove()">Send</button>`)
    const delivered = await submissionSession.submit('NATIVE_DELIVERY_WITH_APP', 'chatgpt', { ...submissionAdapter, pluginName: 'Nexus DSH' })
    assert.equal(delivered.userTurnKey, 'delivered-turn')
    assert.equal(await pageA.locator('.ProseMirror').count(), 0)
    await pageA.setContent('<div data-talvt-turn-state="generating"><div data-content-search-unit-key="native-turn:0:user">question</div><div data-content-search-unit-key="native-turn:0:assistant"><div class="reply" data-markdown-text-style="assistant-message">Partial native stop</div></div></div><button aria-label="Stop generating" onclick="this.remove()">Stop</button>')
    let cancelledSession = ''
    const provider = new WebChatAdapter({
      providerId: 'webbridge-chatgpt', modelId: 'chatgpt-web', settings: { site: 'chatgpt', providers: {} },
      toolScope: { withSession: (_id, operation) => operation(), cancelSession: id => { cancelledSession = id } },
      session: { async ask(_message, options) {
        await driver.startGenerationWatch('provider-stop')
        options.onSubmitted()
        try {
          const reply = await waitForReply({ driver, adapter: { messageSelector: '.reply', matchReplyToUserTurn: true }, baseline: {},
            settings: { replyTimeoutMs: 0, pollIntervalMs: 20, stableSamples: 1 }, expectedText: 'question', onProgress: options.onProgress })
          return { reply: reply.text }
        } finally { await driver.endGenerationWatch('provider-stop') }
      } },
    })
    const stream = provider.generate({ sessionId: 'native-web-stop', messages: [{ role: 'user', content: 'question' }] })
    assert.equal((await stream.next()).value.type, 'block-start')
    assert.equal((await stream.next()).value.text, 'Partial native stop')
    await driver.click('button')
    const stopped = []; for await (const chunk of stream) stopped.push(chunk)
    assert.equal(stopped.at(-1).reason.kind, 'aborted')
    assert.equal(stopped.at(-1).reason.failure.code, 'ABORTED')
    assert.equal(cancelledSession, 'native-web-stop')
    await driver.startGenerationWatch('navigation-stop')
    await driver.open('data:text/html,<button aria-label="Stop generating">Stop after navigation</button>')
    await driver.installGenerationWatch(await driver.currentPage(), 'navigation-stop')
    await driver.click('button')
    assert.equal((await driver.eval('window.__webbridgeGenerationWatch.stopped')).result, true)
    await driver.endGenerationWatch('navigation-stop')
    const closingPage = await driver.currentPage()
    const closedWait = assert.rejects(waitForReply({
      driver, adapter: { messageSelector: '.missing-reply', matchReplyToUserTurn: true }, baseline: {},
      settings: { replyTimeoutMs: 0, pollIntervalMs: 5, stableSamples: 1 }, expectedText: 'pending question',
    }), error => error.code === 'browser-closed')
    await closingPage.close()
    await closedWait
    await driver.open(urls[0])
    driver.lastMode = { headed: true }
    driver.switchToHeadless = async () => { throw new Error('An unauthenticated/loading page must not trigger a browser restart') }
    assert.equal((await driver.state()).authenticated, false)
    driver.lastMode = { headed: false }
  })
  await driver.stop()
  const restored = new BrowserDriver(settings)
  try {
    const summary = await restored.restoreSessions()
    assert.equal(summary.restored, 0)
    assert.equal(summary.saved, 2)
    assert.equal(restored.context, null)
    assert.equal(restored.pages.size, 0)
    const resumed = await restored.storage.run('session-A', () => restored.currentPage())
    assert.equal(restored.pages.size, 1)
    const resumedB = await restored.storage.run('session-B', () => restored.currentPage())
    assert.equal(resumed.url(), urls[0])
    assert.equal(resumedB.url(), urls[1])
    assert.equal(restored.pages.size, 2)
    await restored.releasePage('session-A')
    assert.equal(restored.pages.size, 1)
    assert.equal((await restored.getSessionInfo('session-A')).url, urls[0])
    await restored.releasePage('session-B')
    assert.equal(restored.pages.size, 0)
    process.stdout.write('NATIVE_PAGES_SMOKE_OK: independent pages, concurrent navigation, lazy restore, task page cleanup, trusted stop through provider cancellation, and stop listener after navigation\n')
  } finally {
    await restored.stop()
  }
} finally {
  await driver.stop().catch(() => {})
  await rm(root, { recursive: true, force: true })
}
