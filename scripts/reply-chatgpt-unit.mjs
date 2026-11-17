/** Replies must belong to the user turn that was just submitted. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForReply } from '../src/detect.js'

const old = { count: 1, text: 'OLD_ANSWER', userTurnKey: 'old-turn', userText: 'OLD_QUESTION', replyTurnKey: 'old-turn', replyId: 'old-reply' }
const fresh = { count: 2, text: 'NEW_ANSWER', userTurnKey: 'new-turn', userText: '用户：NEW_QUESTION Nexus DSH', replyTurnKey: 'new-turn', replyId: 'new-reply' }
function wait(sequence, overrides = {}) {
  let index = 0
  return waitForReply({
    driver: { eval: async () => ({ result: sequence[Math.min(index++, sequence.length - 1)] }) },
    adapter: { messageSelector: '.reply', matchReplyToUserTurn: true, requireCountGrowth: true },
    baseline: old,
    settings: { replyTimeoutMs: 1000, pollIntervalMs: 1, stableSamples: 1 },
    expectedText: '用户：NEW_QUESTION',
    ...overrides,
  })
}

test('a reappearing old answer cannot complete the next DSH turn', async () => {
  const answer = await wait([old, old, { ...fresh, replyTurnKey: 'old-turn', text: 'OLD_ANSWER' }, fresh, fresh])
  assert.equal(answer.text, 'NEW_ANSWER')
  assert.equal(answer.replyId, 'new-reply')
})

test('a hydrated old conversation is ignored even if the baseline looked empty', async () => {
  const answer = await wait([old, old, fresh, fresh], { baseline: { count: 0, text: '' } })
  assert.equal(answer.text, 'NEW_ANSWER')
})

test('a new reply is accepted when virtualization keeps the reply count unchanged', async () => {
  const reply = { ...fresh, count: 1 }
  assert.equal((await wait([reply, reply])).text, 'NEW_ANSWER')
})

test('identical answer text on a different user turn still counts as a new reply', async () => {
  const reply = { ...fresh, text: 'OLD_ANSWER', count: 1 }
  const answer = await wait([reply, reply])
  assert.equal(answer.replyId, 'new-reply')
  assert.equal(answer.userTurnKey, 'new-turn')
})

test('a stale reply times out instead of being returned as a partial answer', async () => {
  await assert.rejects(wait([old], { settings: { replyTimeoutMs: 25, pollIntervalMs: 1, stableSamples: 1 } }),
    (error) => error.code === 'reply-timeout')
})

test('streaming content must settle within the matching user turn', async () => {
  const answer = await wait([{ ...fresh, text: 'WORKING', streaming: true }, { ...fresh, streaming: true }, fresh, fresh])
  assert.equal(answer.text, 'NEW_ANSWER')
  assert.equal(answer.sawStreaming, true)
})

test('unlimited waits survive more than the old 90 second budget and report real elapsed time', async () => {
  const start = Date.now()
  const now = Date.now
  let polls = 0
  try {
    Date.now = () => start + polls * 100000
    const answer = await wait([], {
      driver: { async eval() { polls++; return { result: polls < 3 ? old : fresh } } },
      settings: { replyTimeoutMs: 0, pollIntervalMs: 1, stableSamples: 1 },
    })
    assert.equal(answer.text, 'NEW_ANSWER')
    assert.equal(answer.truncated, false)
    assert.ok(answer.elapsedMs > 90000)
    assert.ok(Number.isFinite(answer.elapsedMs))
  } finally { Date.now = now }
})

test('an unlimited wait stops immediately when DSH cancels, including during a long polling delay', async () => {
  const controller = new AbortController()
  const pending = wait([old], { signal: controller.signal, settings: { replyTimeoutMs: 0, pollIntervalMs: 60000, stableSamples: 1 } })
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(pending, error => error.code === 'aborted')
})

test('an unlimited wait preserves a manual-login error instead of retrying it forever', async () => {
  const failure = Object.assign(new Error('Sign in manually'), { code: 'manual-auth-required' })
  await assert.rejects(wait([], { driver: { eval: async () => { throw failure } }, settings: { replyTimeoutMs: 0, pollIntervalMs: 1, stableSamples: 1 } }), error => error === failure)
})

test('the captured submitted turn accepts the real reply even when an app mention changes visible prompt text', async () => {
  const answer = await wait([fresh, fresh], { expectedText: 'A prompt whose last character was moved around an app mention', expectedTurnKey: 'new-turn' })
  assert.equal(answer.text, 'NEW_ANSWER')
  assert.equal(answer.replyTurnKey, 'new-turn')
})

test('a completed short prompt with an inline app mention finishes before its submitted turn key was captured', async () => {
  const reply = { ...fresh, userText: '检查子智能体以及 mcp Nexus DSH 等', completed: true, generationKnown: true }
  const answer = await wait([reply, reply], {
    baseline: { count: 0, text: '' }, expectedText: '检查子智能体以及mcp等', expectedTurnKey: '',
    adapter: { matchReplyToUserTurn: true, requireCountGrowth: true, pluginName: 'Nexus DSH' },
  })
  assert.equal(answer.text, 'NEW_ANSWER')
  assert.equal(answer.replyTurnKey, 'new-turn')
})

test('an inline app mention cannot make a different completed prompt belong to the current request', async () => {
  const reply = { ...fresh, userText: '另一个问题 Nexus DSH', completed: true, generationKnown: true }
  await assert.rejects(wait([reply], {
    baseline: { count: 0, text: '' }, expectedText: '检查子智能体以及mcp等', expectedTurnKey: '',
    adapter: { matchReplyToUserTurn: true, requireCountGrowth: true, pluginName: 'Nexus DSH' },
    settings: { replyTimeoutMs: 25, pollIntervalMs: 1, stableSamples: 1 },
  }), error => error.code === 'reply-timeout')
})

test('a captured submitted turn never accepts a different prompt on another user turn', async () => {
  await assert.rejects(wait([fresh], { expectedText: 'A_DIFFERENT_QUESTION', expectedTurnKey: 'another-turn', settings: { replyTimeoutMs: 25, pollIntervalMs: 1, stableSamples: 1 } }), error => error.code === 'reply-timeout')
})

test('an optimistic post-send turn key can change without losing the current completed answer', async () => {
  const answer = await wait([{ ...fresh, completed: true, generationKnown: true }, { ...fresh, completed: true, generationKnown: true }], { expectedTurnKey: 'optimistic-client-key' })
  assert.equal(answer.text, 'NEW_ANSWER')
  assert.equal(answer.userTurnKey, 'new-turn')
})

test('a finished webpage retries reading and accepts the current reply after DOM hydration', async () => {
  const unreadable = { ...fresh, text: '', replyTurnKey: '', completed: true, generationKnown: true }
  const result = await wait([unreadable, unreadable, { ...fresh, completed: true, generationKnown: true }, { ...fresh, completed: true, generationKnown: true }], { expectedTurnKey: 'new-turn', settings: { replyTimeoutMs: 0, pollIntervalMs: 1, stableSamples: 1 } })
  assert.equal(result.text, 'NEW_ANSWER')
})

test('known ongoing generation is allowed to pause its text until the final controls appear', async () => {
  const answer = await wait([{ ...fresh, text: 'PARTIAL', generationKnown: true }, { ...fresh, text: 'PARTIAL', generationKnown: true }, { ...fresh, generationKnown: true, completed: true }, { ...fresh, generationKnown: true, completed: true }])
  assert.equal(answer.text, 'NEW_ANSWER')
})

test('current reply snapshots are forwarded during generation', async () => {
  const progress = []
  await wait([{ ...fresh, text: 'A', streaming: true }, { ...fresh, text: 'AB', streaming: true }, { ...fresh, text: 'ABC', completed: true, generationKnown: true }, { ...fresh, text: 'ABC', completed: true, generationKnown: true }], { onProgress: value => progress.push(value.text) })
  assert.deepEqual(progress, ['A', 'AB', 'ABC'])
})

test('a trusted webpage stop ends the wait instead of returning a normal completed answer', async () => {
  await assert.rejects(wait([{ ...fresh, webStopped: true }]), error => error.code === 'web-generation-stopped')
})

test('long answers keep streaming when the bound user row is virtualized out of the page', async () => {
  const progress = []
  const hiddenUser = { ...fresh, userTurnKey: '', userText: '', streaming: true, generationKnown: true, text: 'AB' }
  const finished = { ...hiddenUser, streaming: false, completed: true, text: 'ABC' }
  const answer = await wait([{ ...fresh, text: 'A', streaming: true }, hiddenUser, finished, finished], { onProgress: value => progress.push(value.text) })
  assert.deepEqual(progress, ['A', 'AB', 'ABC'])
  assert.equal(answer.text, 'ABC')
  assert.equal(answer.userTurnKey, 'new-turn')
})

test('a provisional fallback turn rebinds to the owned streaming reply when the user row is absent', async () => {
  const progress = []
  const growing = { ...fresh, userTurnKey: '', userText: '', replyTurnKey: 'persisted-turn', replyId: 'persisted-reply', requestActive: true, streaming: true, generationKnown: true, text: 'A' }
  const done = { ...growing, text: 'AB', streaming: false, completed: true }
  const reply = await wait([growing, done, done], { expectedTurnKey: 'fallback-turn-0', onProgress: value => progress.push(value.text) })
  assert.deepEqual(progress, ['A', 'AB'])
  assert.equal(reply.replyTurnKey, 'persisted-turn')
})

test('one web turn preserves earlier public reply segments when a later segment starts', async () => {
  const first = { ...fresh, text: 'Reading files.', streaming: true, replyParts: [{ id: 'one', text: 'Reading files.' }] }
  const second = { ...fresh, text: 'Final answer.', streaming: true, replyParts: [{ id: 'two', text: 'Final answer.' }] }
  const done = { ...second, streaming: false, completed: true, generationKnown: true }
  const progress = []
  const result = await wait([first, second, done, done], { onProgress: part => progress.push(part.text) })
  assert.equal(result.text, 'Reading files.\n\nFinal answer.')
  assert.ok(progress.includes('Reading files.\n\nFinal answer.'))
})

test('native replies stream without selection-message attributes or a surviving page watch', async () => {
  const progress = []
  const growing = { ...fresh, replyId: '', userTurnKey: '', userText: '', requestActive: false,
    replyTurnKey: 'real-native-turn', streaming: true, generationKnown: true, text: 'A' }
  const done = { ...growing, text: 'AB', streaming: false, completed: true }
  let index = 0
  const states = [growing, done, done]
  const driver = {
    generations: new Map([['native-session', 'owned-request']]), currentKey: () => 'native-session',
    eval: async () => ({ result: states[Math.min(index++, states.length - 1)] }),
  }
  const result = await wait([], { driver, expectedTurnKey: '', onProgress: value => progress.push(value.text) })
  assert.deepEqual(progress, ['A', 'AB'])
  assert.equal(result.replyTurnKey, 'real-native-turn')
})

test('a provisional reply part acquiring its final message ID never duplicates the answer', async () => {
  const first = { ...fresh, text: '001. A', streaming: true, replyParts: [{ id: 'stream-part-0', text: '001. A' }] }
  const done = { ...fresh, text: '1. A\n\n2. B', completed: true, generationKnown: true,
    replyParts: [{ id: 'real-message-id', text: '1. A\n\n2. B', formattedText: '1. **A**\n\n2. B' }] }
  const result = await wait([first, done, done])
  assert.equal(result.text, '1. **A**\n\n2. B')
})
