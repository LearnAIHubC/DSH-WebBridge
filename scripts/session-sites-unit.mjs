/** Generic (non-ChatGPT) site submission: confirm without turn keys, no live account. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSettings, SITE_PRESETS } from '../src/config.js'
import { ChatSession } from '../src/session.js'
import { BigmodelTrialModels } from '../src/models/bigmodel.js'

/** In-memory browser shaped like a generic chat site (bigmodel): no
 *  data-content-search-unit-key turn markers, submit clears the composer. */
function fixture() {
  const url = 'https://bigmodel.cn/trialcenter/modeltrial/text?modelCode=glm-5.3'
  const replies = []
  const submitted = []
  const clicked = []
  let draft = ''
  const driver = {
    async state() { return { url, title: 'trial', manualAuth: { required: false } } },
    async open() { return { url } },
    async click(selector) {
      clicked.push(selector)
      if (selector.includes('submit-btn') && draft) {
        submitted.push(draft)
        replies.push(`GLM 回复：${draft}`)
        draft = ''
      }
    },
    async fillLong(_selector, text) { draft = text },
    async eval(expression) {
      if (expression.includes('composerText')) return { result: { composerCount: 1, composerText: draft } }
      return { result: {
        count: replies.length, text: replies.at(-1) || '', streaming: false, url,
        // Generic sites expose no ChatGPT turn keys at all.
        userTurnKey: '', userText: '', replyTurnKey: '', replyId: '',
      } }
    },
  }
  const settings = resolveSettings({ site: 'bigmodel', stateDir: '', replyTimeoutMs: 1000, commandTimeoutMs: 30, pollIntervalMs: 1, stableSamples: 1 })
  const session = new ChatSession({ settings, driver, log: () => {} })
  session.adapter = () => ({ ...SITE_PRESETS.bigmodel.adapter })
  return { session, driver, submitted, clicked }
}

test('a generic site send is confirmed without turn keys and never double-sent', async () => {
  const { session, submitted, clicked } = fixture()
  const answer = await session.ask('你好', { sessionKey: 'generic-1', site: 'bigmodel' })
  assert.match(answer.text, /GLM 回复：你好/)
  // Exactly one send: the generic confirmation must not fall back to resending.
  assert.equal(submitted.length, 1)
  assert.equal(clicked.filter(selector => selector.includes('submit-btn')).length, 1)
})

test('a generic site send that never leaves the composer is retried and reported', async () => {
  const { session } = fixture()
  session.driver.click = async () => {} // the send click does nothing
  await assert.rejects(
    session.ask('这条不会被发出', { sessionKey: 'generic-2', site: 'bigmodel' }),
    // A silent no-op click ends as message-not-sent; a real page where the
    // click times out ends as send-not-ready. Both mean "never delivered".
    error => ['send-not-ready', 'message-not-sent', 'message-send-uncertain', 'composer-not-ready'].includes(error.code),
  )
})

test('the bigmodel channel derives its catalog from the trial URL and never switches silently', async () => {
  let notified = 0
  const source = new BigmodelTrialModels({ settings: {}, driver: { context: null, pages: new Map() }, log: () => {}, onChange: () => { notified += 1 } })
  const catalog = await source.list()
  assert.equal(catalog.length, 1)
  assert.equal(catalog[0].modelName, 'GLM-5.3')
  assert.equal(catalog[0].power, 0)
  assert.equal(catalog[0].preferred, true)
  // The initial empty→derived catalog change may notify once; a re-read of the
  // same derived catalog must not notify again.
  await new Promise(resolve => setTimeout(resolve, 0))
  const baseline = notified
  await source.list()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(notified, baseline)
  // Only the model the conversation already uses may be "selected".
  const accepted = await source.select({ modelName: 'GLM-5.3', label: 'GLM-5.3' })
  assert.equal(accepted.modelName, 'GLM-5.3')
  await assert.rejects(source.select({ modelName: 'GLM-4.5' }), error => error.code === 'model-unavailable')
})
