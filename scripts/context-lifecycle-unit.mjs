import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatSession } from '../src/session.js'
import { resolveSettings, SITE_PRESETS } from '../src/config.js'

function fixture() {
  const root = 'https://chatgpt.com/'
  let currentUrl = `${root}c/previous`
  let draft = ''
  let number = 0
  const threads = new Map([[currentUrl, ['previous reply']]])
  const saved = new Map()
  const submitted = []
  const events = []
  const queues = []
  let uploaded = 0
  let released = 0
  const driver = {
    async exclusive(operation, key) { queues.push(key); return operation() },
    async state() { return { url: currentUrl, title: 'ChatGPT' } },
    async open(url) { currentUrl = url },
    async getSessionInfo(key) { return saved.has(key) ? { ...saved.get(key) } : null },
    async updateSessionInfo(key, patch) { saved.set(key, { ...saved.get(key), ...patch }) },
    async prepareUploads() { events.push('prepare-uploads') },
    async fillLong(_selector, text) { draft = text; events.push(`fill:${text}`) },
    async attachFiles() { uploaded++; return { async release() { released++ } } },
    async click(selector) {
      assert.equal(selector, SITE_PRESETS.chatgpt.adapter.sendSelector)
      if (currentUrl === root) {
        currentUrl = `${root}c/new-${++number}`
        threads.set(currentUrl, [])
      }
      threads.get(currentUrl).push(draft)
      submitted.push({ url: currentUrl, text: draft })
      draft = ''
    },
    async press() {},
    async eval(expression) {
      if (expression.includes('composerText')) return { result: { composerCount: 1, composerText: draft } }
      const replies = threads.get(currentUrl) || []
      const turn = replies.length ? `${currentUrl}:${replies.length}` : ''
      return { result: {
        count: replies.length, text: replies.at(-1) || '', streaming: false,
        url: currentUrl, userTurnKey: turn, userText: replies.at(-1) || '',
        replyTurnKey: turn, replyId: turn,
      } }
    },
  }
  const settings = resolveSettings({ site: 'chatgpt', stateDir: '', replyTimeoutMs: 1000, commandTimeoutMs: 50, pollIntervalMs: 1, stableSamples: 1 })
  const session = new ChatSession({ settings, driver })
  session.adapter = () => ({ ...SITE_PRESETS.chatgpt.adapter, pluginName: '' })
  session.assertNotRestricted = async () => {}
  session.ensureReasoning = async () => {}
  session.ensurePlugin = async () => ({})
  session.uploadState = async () => ({ uploading: false })
  session.waitUploads = async () => {}
  session.dismissUploadNotice = async () => {}
  session.startNewChat = async () => { currentUrl = root; draft = ''; events.push('new-chat'); return root }
  return { session, driver, saved, submitted, events, queues, uploads: () => uploaded, releases: () => released }
}

test('message preparation sees the real conversation before filling and only a new chat invalidates context', async () => {
  const { session, submitted, events } = fixture()
  const observations = []
  const ask = (word) => session.ask(word, {
    sessionKey: 'A',
    onConversation(info) { observations.push({ ...info }); events.push('context-selected') },
    prepareMessage(info) {
      events.push('context-prepared')
      return { text: `${word}:${info.newConversation ? 'full' : 'continue'}` }
    },
  })
  await ask('first')
  await ask('second')
  assert.deepEqual(submitted.map(item => item.text), ['first:full', 'second:continue'])
  assert.deepEqual(observations.map(info => info.newConversation), [true, false])
  assert.equal(observations[0].key, 'chatgpt:A')
  assert.equal(observations[0].generation, observations[1].generation)
  assert.equal(observations[1].url, submitted[0].url)
  assert.ok(events.indexOf('context-selected') < events.indexOf('context-prepared'))
  assert.ok(events.indexOf('context-prepared') < events.indexOf('fill:first:full'))
})

test('restoring a persisted conversation preserves its generation and does not request a full reset', async () => {
  const { session, driver, saved, submitted } = fixture()
  await session.ask('first', { sessionKey: 'A' })
  const previous = { ...saved.get('chatgpt:A') }
  session.conversations.clear()
  await driver.open('https://chatgpt.com/c/previous')
  let observed
  await session.ask('restored', { sessionKey: 'A', onConversation(info) { observed = info } })
  assert.equal(observed.newConversation, false)
  assert.equal(observed.reset, false)
  assert.equal(observed.generation, previous.generation)
  assert.equal(submitted.at(-1).url, previous.url)
})

test('a persisted site-root navigation starts a new context generation instead of restoring stale context', async () => {
  const { session, saved, submitted } = fixture()
  saved.set('chatgpt:A', { url: 'https://chatgpt.com/', generation: 'abandoned-generation' })
  let observed
  await session.ask('new task', { sessionKey: 'A', onConversation(info) { observed = info } })
  assert.equal(observed.newConversation, true)
  assert.notEqual(observed.generation, 'abandoned-generation')
  assert.notEqual(submitted[0].url, 'https://chatgpt.com/c/previous')
})

test('a pending blank conversation can resume on a recreated about:blank page', async () => {
  const { session, driver, saved, submitted } = fixture()
  saved.set('chatgpt:A', { url: '', pending: true, generation: 'before-restart', needsContext: true })
  await driver.open('about:blank')
  let observed
  await session.ask('task after restart', { sessionKey: 'A', onConversation(info) { observed = info } })
  assert.equal(observed.newConversation, true)
  assert.notEqual(observed.generation, 'before-restart')
  assert.match(submitted[0].url, /chatgpt\.com\/c\/new-/)
})

test('manual newChat clears only its session mapping and persists an empty conversation before the next send', async () => {
  const { session, saved, submitted, queues } = fixture()
  await session.ask('A first', { sessionKey: 'A' })
  await session.ask('B first', { sessionKey: 'B' })
  const oldA = { ...session.conversations.get('chatgpt:A') }
  const oldB = { ...session.conversations.get('chatgpt:B') }
  const notices = []
  await session.newChat({ sessionKey: 'A', onConversation(info) { notices.push(info) } })
  assert.equal(queues.at(-1), 'chatgpt:A')
  assert.equal(saved.get('chatgpt:A').url, '')
  assert.equal(saved.get('chatgpt:A').pending, true)
  assert.notEqual(saved.get('chatgpt:A').generation, oldA.generation)
  assert.deepEqual(session.conversations.get('chatgpt:B'), oldB)
  let next
  await session.ask('A after reset', { sessionKey: 'A', prepareMessage(info) { next = info; return 'A full again' } })
  assert.equal(next.newConversation, true)
  assert.equal(next.reason, 'manual-reset')
  assert.notEqual(submitted.at(-1).url, oldA.url)
  assert.equal(notices[0].reason, 'manual-reset')
})

test('system TXT quota skip is reported to onSubmitted and the final result without claiming delivery', async () => {
  const { session, uploads } = fixture()
  session.uploadState = async () => ({ problem: { code: 'attachment-quota-exceeded', message: 'quota' } })
  let submitted
  const result = await session.ask('task', {
    sessionKey: 'A', attachment: { name: 'dsh-context.txt', content: 'system' },
    onSubmitted(info) { submitted = info },
  })
  for (const value of [submitted, result]) {
    assert.equal(value.contextAttachmentDelivered, false)
    assert.equal(value.contextAttachmentSkipped, true)
  }
  assert.equal(uploads(), 0)
})

test('quota after upload resets the conversation and prepares a full-context message without uploading again', async () => {
  const { session, submitted, uploads, releases } = fixture()
  await session.ask('existing task', { sessionKey: 'A' })
  const old = { ...session.conversations.get('chatgpt:A') }
  session.waitUploads = async () => { throw Object.assign(new Error('quota'), { code: 'attachment-quota-exceeded' }) }
  const observations = []
  let delivered
  const result = await session.ask('next task', {
    sessionKey: 'A', attachment: { name: 'dsh-context.txt', content: 'system' },
    onConversation(info) { observations.push({ ...info }) },
    prepareMessage(info) {
      return { text: info.reset ? 'FULL_CONTEXT_REFERENCE' : 'DELTA_CONTEXT_REFERENCE', attachment: { name: 'dsh-context.txt', content: 'system' } }
    },
    onSubmitted(info) { delivered = info },
  })
  assert.deepEqual(observations.map(info => info.reset), [false, true])
  assert.equal(observations[1].reason, 'attachment-quota')
  assert.notEqual(observations[1].generation, old.generation)
  assert.notEqual(submitted.at(-1).url, old.url)
  assert.equal(submitted.at(-1).text, 'FULL_CONTEXT_REFERENCE')
  assert.equal(result.submittedText, 'FULL_CONTEXT_REFERENCE')
  assert.equal(delivered.conversation.reason, 'attachment-quota')
  assert.equal(result.contextAttachmentDelivered, false)
  assert.equal(result.contextAttachmentSkipped, true)
  assert.equal(uploads(), 1)
  assert.equal(releases(), 1)
})

test('an attachment supplied by prepareMessage is staged and reported as delivered', async () => {
  const { session, events, uploads, releases } = fixture()
  let delivered
  const result = await session.ask('task', {
    sessionKey: 'A',
    prepareMessage() { return { text: 'prepared task', attachment: { name: 'context.txt', content: 'context' } } },
    onSubmitted(info) { delivered = info },
  })
  assert.ok(events.indexOf('prepare-uploads') < events.indexOf('fill:prepared task'))
  assert.equal(uploads(), 1)
  assert.equal(releases(), 1)
  assert.equal(delivered.contextAttachmentDelivered, true)
  assert.equal(result.contextAttachmentDelivered, true)
  assert.equal(result.contextAttachmentSkipped, false)
})

test('failure to prepare context stops before submitting a user task', async () => {
  const { session, submitted } = fixture()
  await assert.rejects(session.ask('task', { sessionKey: 'A', prepareMessage() { throw new Error('context unavailable') } }), /context unavailable/)
  assert.equal(submitted.length, 0)
})

test('metadata fingerprint and automatic refresh detect server instruction changes without tool changes', async () => {
  const { WebBridgeSetup } = await import('../src/setup.js')
  const bridge = { instructions: 'first instructions', catalog: () => [{ name: 'same-tool' }], status: () => ({}) }
  let refreshes = 0
  const controller = new WebBridgeSetup({
    settings: {}, bridge,
    driver: { busy: false, exclusive: operation => operation() },
    tunnel: { state: { status: 'connected' }, status: () => ({}), redact: value => value },
    browser: { saved: { pluginId: 'plugin-test' }, auth: {}, async observeAccount() {}, async persist() {}, async refresh() { refreshes++ } },
  })
  controller.fingerprint = controller.catalogFingerprint()
  await controller.autoRefresh()
  assert.equal(refreshes, 0)
  bridge.instructions = 'updated instructions'
  assert.notEqual(controller.catalogFingerprint(), controller.fingerprint)
  await controller.autoRefresh()
  assert.equal(refreshes, 1)
  assert.equal(controller.fingerprint, controller.catalogFingerprint())
})
