/**
 * Offline test of the DSH-session <-> web-conversation mapping.
 * A stubbed driver answers the DOM polling so no browser is touched.
 *
 * Run: node scripts/session-isolation-unit.mjs
 */
import assert from 'node:assert/strict'
import { ChatSession } from '../src/session.js'
import { resolveSettings } from '../src/config.js'

const settings = resolveSettings({ site: 'deepseek', stateDir: '', replyTimeoutMs: 5000, pollIntervalMs: 10, stableSamples: 1 })

function makeSession(sequence) {
  const opened = []
  const newChats = []
  let readsSinceSend = 0
  let blank = false
  const driver = {
    state: async () => ({ url: `https://chat.deepseek.com/a/chat/s/${sequence[Math.min(Math.max(0, newChats.length - 1), sequence.length - 1)]}` }),
    open: async (url) => {
      opened.push(url)
      return { url }
    },
    fillLong: async () => {
      blank = false
      readsSinceSend = 0
      return {}
    },
    press: async () => ({}),
    click: async (selector) => { blank = true; newChats.push(selector); return {} },
    eval: async () => {
      if (blank) return { result: { count: 0, text: '', streaming: false, url: '' } }
      readsSinceSend += 1
      // The first read after a send is the pre-send baseline; later reads show
      // a grown reply so the completion detector settles.
      return readsSinceSend <= 1
        ? { result: { count: 1, text: 'old', streaming: false, url: '' } }
        : { result: { count: 2, text: '鏂扮殑鍥炲', streaming: false, url: '' } }
    },
  }
  const session = new ChatSession({ settings, driver, log: () => {} })
  session.ensurePage = async () => ({})
  session.ensureReasoning = async () => ({})
  return { session, opened, newChats }
}

let passed = 0
const test = async (name, fn) => {
  await fn()
  passed++
  console.log(`ok - ${name}`)
}

await test('first call records the conversation URL for the session key', async () => {
  const { session } = makeSession(['chatA'])
  await session.ask('hello', { sessionKey: 'A' })
  assert.equal(session.conversations.get('deepseek:A')?.url, 'https://chat.deepseek.com/a/chat/s/chatA')
})

await test('second call with the same key reopens that conversation', async () => {
  const { session, opened, newChats } = makeSession(['chatA'])
  await session.ask('one', { sessionKey: 'A' })
  await session.ask('two', { sessionKey: 'A' })
  assert.deepEqual(opened, []) // The already-correct page must not be reloaded.
  assert.equal(newChats.length, 1)
})

await test('a fresh key starts a new web conversation instead of reusing the tab', async () => {
  const { session, opened, newChats } = makeSession(['chatA', 'chatB'])
  await session.ask('one', { sessionKey: 'A' })
  await session.ask('two', { sessionKey: 'B' })
  assert.equal(session.conversations.get('deepseek:A')?.url, 'https://chat.deepseek.com/a/chat/s/chatA')
  assert.equal(session.conversations.get('deepseek:B')?.url, 'https://chat.deepseek.com/a/chat/s/chatB')
  assert.equal(opened.length, 0)
  assert.equal(newChats.length, 2)
})

await test('no sessionKey keeps the legacy single-tab behaviour', async () => {
  const { session, opened } = makeSession(['chatA'])
  await session.ask('one')
  await session.ask('two')
  assert.equal(session.conversations.size, 0)
  assert.equal(opened.length, 0)
})

console.log(`\n${passed} isolation checks passed`)

