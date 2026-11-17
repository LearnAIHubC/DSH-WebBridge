/** ChatGPT conversation tests using an in-memory browser. No live account is used. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSettings, SITE_PRESETS } from '../src/config.js'
import { ChatSession } from '../src/session.js'
import { WebChatAdapter } from '../src/provider.js'

function fixture({ initialUrl = 'https://chatgpt.com/c/previous', customNewChatButton = false, rejectSubmission = false, withPlugin = false } = {}) {
  const previous = 'https://chatgpt.com/c/previous'
  const root = 'https://chatgpt.com/'
  const threads = new Map([[previous, ['old reply']]])
  const submitted = []
  let currentUrl = initialUrl
  let pendingText = ''
  let nextThread = 0
  const keys = []
  const clicked = []
  let pluginSelected = false
  let attachment = null
  const startNewChat = () => { currentUrl = root; pluginSelected = false; attachment = null }
  const submitPending = () => {
    if (rejectSubmission) return
    if (currentUrl === root) {
      currentUrl = `${root}c/unit-${++nextThread}`
      threads.set(currentUrl, [])
    }
    threads.get(currentUrl).push(pendingText)
    submitted.push({ url: currentUrl, text: pendingText, plugin: pluginSelected, attachment })
    pendingText = ''
    attachment = null
  }
  const driver = {
    async state() { return { url: currentUrl, title: 'ChatGPT', manualAuth: { required: false } } },
    async open(url) {
      // ChatGPT restores the previous conversation when its root is reopened.
      currentUrl = url === root ? previous : url
      return this.state()
    },
    async click(selector) {
      clicked.push(selector)
      if (selector === SITE_PRESETS.chatgpt.adapter.sendSelector) return submitPending()
      if (selector === 'button[data-testid="composer-plus-btn"], form button:has(svg use[href*="plus"])') return
      if (selector === 'button[data-plugin-impression-id]:has-text("Nexus DSH")') { pluginSelected = true; return }
      if (customNewChatButton && selector === 'button[data-new-chat]') return startNewChat()
      throw new Error('sidebar control is hidden')
    },
    async fillLong(_selector, text) { pendingText = text; pluginSelected = false },
    async attachTextFile(name, content) { attachment = { name, content }; return { ok: true } },
    async press(key) {
      keys.push(key)
      if (key === (process.platform === 'darwin' ? 'Meta+Shift+KeyO' : 'Control+Shift+KeyO')) {
        if (customNewChatButton) throw new Error('shortcut unavailable')
        if (currentUrl.startsWith(root)) startNewChat()
      } else if (key === 'Enter') {
        return submitPending()
      }
    },
    async eval(expression) {
      if (expression.includes('pluginSelected')) return { result: { pluginSelected } }
      if (expression.includes('composerText')) return { result: { composerText: pendingText } }
      const replies = threads.get(currentUrl) || []
      const turn = replies.length ? `${currentUrl}:turn-${replies.length}` : ''
      return { result: { count: replies.length, text: replies.at(-1) || '', streaming: false, url: currentUrl,
        userTurnKey: turn, userText: replies.at(-1) || '', replyTurnKey: turn, replyId: turn } }
    },
  }
  const settings = resolveSettings({ site: 'chatgpt', stateDir: '', replyTimeoutMs: 1000, commandTimeoutMs: 30, pollIntervalMs: 1, stableSamples: 1 })
  const session = new ChatSession({ settings, driver })
  session.adapter = () => ({
    ...SITE_PRESETS.chatgpt.adapter,
    pluginName: withPlugin ? 'Nexus DSH' : '',
    ...(customNewChatButton ? { newChatSelector: 'button[data-new-chat]' } : {}),
  })
  const provider = new WebChatAdapter({
    providerId: 'webbridge-chatgpt', displayName: 'ChatGPT', modelId: 'chatgpt-web',
    settings: { providers: {} }, session,
  })
  return { session, provider, submitted, previous, keys, clicked }
}

async function send(provider, sessionId, content) {
  let text = ''
  for await (const chunk of provider.stream({ sessionId, messages: [{ role: 'user', content }] })) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

test('ChatGPT sessions get distinct conversations and resume their original conversation', async () => {
  const { provider, session, submitted, previous } = fixture()
  assert.match(await send(provider, 'A', '苹果'), /苹果/)
  const urlA = session.conversations.get('chatgpt:A')?.url
  assert.notEqual(urlA, previous)
  assert.match(await send(provider, 'B', '香蕉'), /香蕉/)
  const urlB = session.conversations.get('chatgpt:B')?.url
  assert.ok(urlA && urlB && urlA !== urlB)
  assert.match(await send(provider, 'A', '继续苹果'), /继续苹果/)
  assert.equal(submitted[2].url, urlA)
  assert.equal(session.conversations.get('chatgpt:A')?.url, urlA)
})

test('a first ChatGPT request starts a new conversation when another site was active', async () => {
  const { provider, session, previous } = fixture({ initialUrl: 'https://example.com/' })
  assert.match(await send(provider, 'from-other-site', '苹果'), /苹果/)
  const url = session.conversations.get('chatgpt:from-other-site')?.url
  assert.ok(url?.startsWith('https://chatgpt.com/c/'))
  assert.notEqual(url, previous)
})

test('ChatGPT can start a conversation with a calibrated new-chat button', async () => {
  const { provider, session, previous } = fixture({ customNewChatButton: true })
  await send(provider, 'custom-button', '苹果')
  const url = session.conversations.get('chatgpt:custom-button')?.url
  assert.ok(url)
  assert.notEqual(url, previous)
})

test('unkeyed ChatSession calls preserve the current ChatGPT conversation', async () => {
  const { session, submitted, previous } = fixture()
  await session.ask('第一句')
  await session.ask('第二句')
  assert.equal(session.conversations.size, 0)
  assert.deepEqual(submitted.map((entry) => entry.url), [previous, previous])
})

test('legacy ChatGPT calibration still submits with the visible send button', async () => {
  const { session, submitted, clicked, keys } = fixture()
  const adapter = session.adapter()
  session.adapter = () => ({ ...adapter, sendSelector: '' })
  await session.ask('MESSAGE_WITH_ATTACHMENT', { attachment: { name: 'context.txt', content: 'system context' } })
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].text, 'MESSAGE_WITH_ATTACHMENT')
  assert.ok(clicked.includes(SITE_PRESETS.chatgpt.adapter.sendSelector))
  assert.ok(!keys.includes('Enter'))
})

test('a failed submission reports the draft staying in the composer without waiting for a reply', async () => {
  const { session, submitted } = fixture({ rejectSubmission: true })
  await assert.rejects(session.ask('UNSENT_MESSAGE'), (error) => error.code === 'message-not-sent')
  assert.equal(submitted.length, 0)
})

test('the first web message includes its attachment, user text, and Nexus DSH mention', async () => {
  const { session, submitted, clicked } = fixture({ withPlugin: true })
  const attachment = { name: 'dsh-context.txt', content: 'SYSTEM_CONTEXT' }
  await session.ask('FIRST_USER_TEXT', { sessionKey: 'plugin-chat', attachment })
  await session.ask('SECOND_USER_TEXT', { sessionKey: 'plugin-chat' })
  assert.equal(submitted[0].text, 'FIRST_USER_TEXT')
  assert.equal(submitted[0].plugin, true)
  assert.deepEqual(submitted[0].attachment, attachment)
  assert.equal(submitted[1].text, 'SECOND_USER_TEXT')
  assert.equal(submitted[1].attachment, null)
  assert.equal(submitted[1].url, submitted[0].url)
  assert.equal(clicked.filter((selector) => selector.includes('data-plugin-impression-id')).length, 1)
})

test('exhausted attachment quota skips only the system TXT and still sends user text with the app', async () => {
  const { session, submitted } = fixture({ withPlugin: true })
  const calls = []
  session.uploadState = async () => ({ problem: { code: 'attachment-quota-exceeded', message: '你已达到文件附件数量限制' } })
  session.dismissUploadNotice = async () => { calls.push('cancel') }
  const reply = await session.ask('USER_TEXT_WITHOUT_SYSTEM_FILE', { sessionKey: 'quota-fallback', attachment: { name: 'dsh-context.txt', content: 'SYSTEM_CONTEXT' } })
  assert.equal(calls[0], 'cancel')
  assert.equal(submitted[0].text, 'USER_TEXT_WITHOUT_SYSTEM_FILE')
  assert.equal(submitted[0].attachment, null)
  assert.equal(submitted[0].plugin, true)
  assert.equal(reply.reply, 'USER_TEXT_WITHOUT_SYSTEM_FILE')
})

test('a user image or file blocked by quota preserves the exact OpenAI notice and is not silently omitted', async () => {
  const { session, submitted } = fixture({ withPlugin: true })
  const notice = '你已达到文件附件数量限制\n升级订阅即可立即添加更多文件，或在 11月18日 0:53 后重试'
  session.uploadState = async () => ({ problem: { code: 'attachment-quota-exceeded', message: notice } })
  await assert.rejects(session.ask('READ_MY_IMAGE', { sessionKey: 'quota-image', attachment: { name: 'dsh-context.txt', content: 'context' }, attachments: [{ name: 'image.png', path: 'C:/image.png' }] }), error => error.code === 'attachment-quota-exceeded' && error.message === notice)
  assert.equal(submitted.length, 0)
})
