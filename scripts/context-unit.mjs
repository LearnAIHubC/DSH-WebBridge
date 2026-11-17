import assert from 'node:assert/strict'
import test from 'node:test'
import { ContextStore, CONTEXT_INSTRUCTIONS, CONTEXT_PARAMETERS, CONTEXT_TOOL_NAME } from '../src/context.js'

const scope = { sessionId: 'session-A' }
const message = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })

function readAll(store, reference, args = {}, session = scope) {
  const pages = []
  let page = store.read({ context_id: reference.context_id, ...args }, session)
  pages.push(page)
  while (!page.completeness.complete) {
    assert.ok(page.completeness.next_cursor)
    page = store.read({ context_id: reference.context_id, cursor: page.completeness.next_cursor }, session)
    pages.push(page)
  }
  if (pages[0].data) return { data: pages[0].data, pages }
  const data = JSON.parse(pages.sort((a, b) => a.page_index - b.page_index).map(page => page.fragment).join(''))
  return { data, pages }
}

function applyDelta(base, delta) {
  const counts = new Map()
  for (const entry of base.messages) if (typeof entry?.id === 'string' && entry.id) counts.set(entry.id, (counts.get(entry.id) || 0) + 1)
  const keyed = new Map(base.messages.map((entry, index) => [typeof entry?.id === 'string' && counts.get(entry.id) === 1 ? `id:${entry.id}` : `index:${index}`, entry]))
  for (const key of delta.removed_keys) keyed.delete(key)
  for (const entry of delta.messages) keyed.set(entry.key, entry.message)
  const result = {
    ...base,
    context_id: delta.context_id,
    revision: delta.revision,
    workspace: delta.workspace,
    messages: delta.message_order.map(key => keyed.get(key)),
    ...(delta.replace_tool_history ? { tool_history: delta.tool_history } : {}),
  }
  if (delta.remove_tool_history) delete result.tool_history
  return result
}

test('bootstrap metadata explains full context, pagination and refresh in the first 512 characters', () => {
  assert.equal(CONTEXT_TOOL_NAME, 'dsh_get_context')
  assert.equal(CONTEXT_PARAMETERS.context_id.required, true)
  assert.match(CONTEXT_INSTRUCTIONS.slice(0, 512), /project path/)
  assert.match(CONTEXT_INSTRUCTIONS.slice(0, 512), /next_cursor/)
  assert.match(CONTEXT_INSTRUCTIONS.slice(0, 512), /new context_id/)
})

test('preserves every role, source, content block, message order and effective history', () => {
  const store = new ContextStore({ pageChars: 100000 })
  const messages = [
    { id: 's', role: 'system', content: [{ type: 'text', text: 'Harness policy <system-reminder>keep this</system-reminder>' }] },
    { id: 'd', role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'new_tool' }] },
    { id: 'r', role: 'user', source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'working-directory', text: '/project' }] }, content: '<system-reminder>cwd=/project</system-reminder>' },
    { id: 'k', role: 'user', source: { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'skill', description: 'text' }] }, content: '<available_skills>skill</available_skills>' },
    { id: 'u', role: 'user', source: { kind: 'future-plugin-context', custom: [1, 2] }, content: [{ type: 'unknown-plugin-block', value: { nested: true } }] },
    { id: 'a', role: 'assistant', content: [{ type: 'text', text: 'Previous decision' }, { type: 'tool-call', id: 'call-real', name: 'read', arguments: '{"file_path":"x"}' }] },
    { id: 't', role: 'tool', content: [{ type: 'tool-result', callId: 'call-real', result: { success: true } }] },
    { id: 'm', role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'img', mediaType: 'image/png' } }, { type: 'file', attachment: { attachmentId: 'file', name: 'requirements.txt' } }] },
  ]
  const toolHistory = [{ type: 'tool-result', callId: 'call-real', result: { text: 'real tool context' } }]
  const workspace = { cwd: '/project/sub', root: '/project' }
  const reference = store.capture({ ...scope, messages, toolHistory, workspace, signal: new AbortController().signal, apiKey: 'not part of model input' })
  const { data } = readAll(store, reference)
  assert.deepEqual(data.messages, messages)
  assert.deepEqual(data.tool_history, toolHistory)
  assert.deepEqual(data.workspace, workspace)
  assert.equal(data.session_id, scope.sessionId)
  assert.equal(Object.hasOwn(data, 'signal'), false)
  assert.equal(Object.hasOwn(data, 'apiKey'), false)
})

test('snapshots are detached from input and returned data, with independent delivery identities', () => {
  const store = new ContextStore()
  const messages = [message('one', 'before')]
  const reference = store.capture({ ...scope, messages })
  messages[0].content[0].text = 'after'
  const first = store.read({ context_id: reference.context_id }, scope)
  assert.equal(first.data.messages[0].content[0].text, 'before')
  first.data.messages[0].content[0].text = 'changed by consumer'
  assert.equal(store.read({ context_id: reference.context_id }, scope).kind, 'context-delivery-receipt')
  store.resetDelivery(reference.context_id, scope)
  assert.equal(store.read({ context_id: reference.context_id }, scope).data.messages[0].content[0].text, 'before')
  const other = store.capture({ ...scope, messages: [message('one', 'before')] })
  assert.notEqual(reference.context_id, other.context_id)
  assert.equal(reference.revision, other.revision)
  assert.equal(store.isDelivered(reference.context_id), true)
  assert.equal(store.isDelivered(other.context_id), false)
})

test('refresh keeps a delivered context id while updating its full recovery snapshot', () => {
  const store = new ContextStore()
  const reference = store.capture({ ...scope, messages: [message('one', 'before')] })
  readAll(store, reference)
  const refreshed = store.refresh(reference.context_id, { ...scope, messages: [message('one', 'after'), message('two', 'new history')] })
  assert.equal(refreshed.context_id, reference.context_id)
  assert.notEqual(refreshed.revision, reference.revision)
  assert.equal(store.read(refreshed, scope).kind, 'context-delivery-receipt')
  store.resetDelivery(refreshed.context_id, scope)
  assert.deepEqual(readAll(store, refreshed).data.messages.map(entry => entry.content[0].text), ['after', 'new history'])
})

test('requires a verified matching session for read and metadata lookup', () => {
  const store = new ContextStore()
  const reference = store.capture({ ...scope, messages: [message('secret', 'A only')] })
  assert.throws(() => store.read(reference), error => error.code === 'context-session-required')
  assert.throws(() => store.read(reference, { sessionId: 'session-B' }), error => error.code === 'context-scope-mismatch')
  assert.throws(() => store.getReference(reference.context_id), error => error.code === 'context-session-required')
  assert.throws(() => store.getReference(reference.context_id, { sessionId: 'session-B' }), error => error.code === 'context-scope-mismatch')
  assert.deepEqual(store.getReference(reference.context_id, scope), reference)
  assert.deepEqual(store.latestReference(scope.sessionId), reference)
  assert.throws(() => store.read({ context_id: 'unknown' }, scope), error => error.code === 'context-not-found')
})

test('pages one huge message completely, including unicode and unknown blocks', () => {
  const store = new ContextStore({ pageChars: 173 })
  const messages = [{ role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: '😀中文\\\n'.repeat(300) }, { type: 'binary-reference', data: 'x'.repeat(1000) }] }]
  const reference = store.capture({ ...scope, messages })
  const first = store.read(reference, scope)
  assert.equal(first.completeness.complete, false)
  assert.ok(first.page_count > 10)
  assert.equal(store.isDelivered(reference.context_id), false)
  const { data, pages } = readAll(store, reference)
  assert.deepEqual(data.messages, messages)
  assert.equal(store.isDelivered(reference.context_id), true)
  assert.equal(pages.at(-1).completeness.next_cursor, null)
  assert.ok(pages.every(page => page.completeness.omitted.length === 0 && page.fragment.length <= 173))
})

test('rejects cursors from another snapshot without marking delivery complete', () => {
  const store = new ContextStore({ pageChars: 200 })
  const a = store.capture({ ...scope, messages: [message('a', 'x'.repeat(1000))] })
  const b = store.capture({ ...scope, messages: [message('b', 'y'.repeat(1000))] })
  const page = store.read(a, scope)
  assert.throws(() => store.read({ ...b, cursor: page.completeness.next_cursor }, scope), error => error.code === 'context-cursor-invalid')
  assert.equal(store.isDelivered(b.context_id), false)
  assert.throws(() => store.read({ ...a, cursor: 'invented' }, scope), error => error.code === 'context-cursor-invalid')
})

test('a fully delivered snapshot returns a receipt until a fresh conversation resets delivery', () => {
  const store = new ContextStore({ pageChars: 200 })
  const reference = store.capture({ ...scope, messages: [message('large', 'X'.repeat(1200))] })
  const firstRead = readAll(store, reference)
  const receipt = store.read(reference, scope)
  assert.equal(receipt.kind, 'context-delivery-receipt')
  assert.equal(receipt.status, 'already-delivered')
  assert.equal(receipt.completeness.complete, true)
  assert.equal(receipt.completeness.next_cursor, null)

  store.resetDelivery(reference.context_id, scope)
  const secondRead = readAll(store, reference)
  assert.deepEqual(secondRead.data, firstRead.data)
  assert.equal(secondRead.pages.length, firstRead.pages.length)
})

test('folds only registered self-delivery results and keeps neighboring blocks and declarations', () => {
  const store = new ContextStore({ pageChars: 100000 })
  const first = store.capture({ ...scope, messages: [message('seed', 'Seed data')] })
  store.registerDeliveryCall('self-call', first)
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'self-call', name: CONTEXT_TOOL_NAME, arguments: '{}' }] },
    { role: 'tool', content: [
      { type: 'text', text: 'Independent additional context' },
      { type: 'tool-result', callId: 'self-call', result: { hugeOldSnapshot: 'do not nest' } },
      { type: 'tool-result', callId: 'normal-call', result: { text: 'keep this' } },
    ] },
    { role: 'user', source: { kind: 'tool', callId: 'self-call' }, content: [{ type: 'text', text: 'full old context payload' }, { type: 'image', attachment: { attachmentId: 'keep-image' } }] },
    { role: 'user', content: `This user's code mentions ${CONTEXT_TOOL_NAME} and self-call; preserve it.` },
  ]
  const reference = store.capture({ ...scope, messages })
  const { data } = readAll(store, reference)
  assert.deepEqual(data.messages[0], messages[0])
  assert.deepEqual(data.messages[1].content[0], messages[1].content[0])
  assert.equal(data.messages[1].content[1].result.kind, 'context-delivery-receipt')
  assert.deepEqual(data.messages[1].content[2], messages[1].content[2])
  assert.equal(JSON.parse(data.messages[2].content[0].text).context_id, first.context_id)
  assert.deepEqual(data.messages[2].content[1], messages[2].content[1])
  assert.deepEqual(data.messages[3], messages[3])
  assert.doesNotMatch(JSON.stringify(data), /hugeOldSnapshot|full old context payload/)
  const foreign = store.capture({ sessionId: 'session-B', messages })
  assert.deepEqual(readAll(store, foreign, {}, { sessionId: 'session-B' }).data.messages, messages)
})

test('repeated bootstrap results stay bounded instead of nesting prior snapshots', () => {
  const store = new ContextStore({ maxSnapshotsPerSession: 3 })
  let messages = [message('seed', 'Seed')]
  let maxSize = 0
  for (let n = 0; n < 12; n++) {
    const reference = store.capture({ ...scope, messages })
    const { data } = readAll(store, reference)
    const callId = `self-${n}`
    store.registerDeliveryCall(callId, reference)
    messages.push({ role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'text', text: JSON.stringify(data) }] })
    maxSize = Math.max(maxSize, JSON.stringify(data).length)
  }
  assert.ok(maxSize < 10000)
})

test('a fresh store folds durable context transport after restart and preserves appended instructions', () => {
  const old = new ContextStore({ pageChars: 100000 })
  const reference = old.capture({ ...scope, messages: [message('large', 'old context '.repeat(4000))] })
  const payload = old.read(reference, scope)
  const call = { role: 'assistant', source: { kind: 'model', provider: 'webbridge-chatgpt' }, content: [
    { type: 'tool-call', id: 'durable-call', name: CONTEXT_TOOL_NAME, arguments: JSON.stringify({ context_id: reference.context_id }) },
  ] }
  const result = { role: 'tool', source: { kind: 'tool', callId: 'durable-call' }, content: [{ type: 'text', text: JSON.stringify(payload) + '\n\n[DSH context updates]\nadditional project instructions' }] }
  const restarted = new ContextStore({ pageChars: 100000 })
  const next = restarted.capture({ ...scope, messages: [call, result, message('user', `Keep user mentions of ${CONTEXT_TOOL_NAME}`)] })
  const data = readAll(restarted, next).data
  assert.ok(JSON.stringify(data).length < 3000)
  assert.match(data.messages[1].content[0].text, /context-delivery-receipt/)
  assert.match(data.messages[1].content[0].text, /additional project instructions/)
  assert.match(data.messages[2].content[0].text, /Keep user mentions/)
  const unmatched = { ...call, content: [{ ...call.content[0], arguments: '{"context_id":"different"}' }] }
  const unverified = new ContextStore({ pageChars: 100000 })
  assert.deepEqual(readAll(unverified, unverified.capture({ ...scope, messages: [unmatched, result] })).data.messages[1], result)
  const userSpoof = { ...call, role: 'user' }
  const untrusted = new ContextStore({ pageChars: 100000 })
  assert.deepEqual(readAll(untrusted, untrusted.capture({ ...scope, messages: [userSpoof, result] })).data.messages[1], result)
})

test('replayed pages continue at the first unread page instead of starting parallel full traversals', () => {
  const store = new ContextStore({ pageChars: 200 })
  const reference = store.capture({ ...scope, messages: [message('large', 'X'.repeat(2000))] })
  const first = store.read(reference, scope)
  const second = store.read({ ...reference, cursor: first.completeness.next_cursor }, scope)
  const repeatedFirst = store.read(reference, scope)
  assert.equal(repeatedFirst.page_index, 0)
  assert.equal(repeatedFirst.fragment, first.fragment)
  assert.equal(repeatedFirst.page_already_delivered, true)
  assert.equal(repeatedFirst.completeness.next_cursor, second.completeness.next_cursor)
  let page = second
  while (!page.completeness.complete) page = store.read({ ...reference, cursor: page.completeness.next_cursor }, scope)
  const repeatedSecond = store.read({ ...reference, cursor: first.completeness.next_cursor }, scope)
  assert.equal(repeatedSecond.completeness.complete, true)
  assert.equal(repeatedSecond.completeness.next_cursor, null)
  store.resetDelivery(reference.context_id, scope)
  assert.equal(readAll(store, reference).data.messages[0].content[0].text, 'X'.repeat(2000))
})

test('delta reconstructs reordered, removed, modified and new messages exactly', () => {
  const store = new ContextStore({ pageChars: 100000 })
  const previous = [message('a', 'A'), message('b', 'B'), message('c', 'C')]
  const before = store.capture({ ...scope, messages: previous, workspace: { cwd: '/old' }, toolHistory: [{ name: 'read' }] })
  const baseline = readAll(store, before).data
  const messages = [message('c', 'C'), message('b', 'B modified'), message('d', 'D')]
  const after = store.capture({ ...scope, messages, workspace: { cwd: '/new' }, toolHistory: [{ name: 'edit' }] })
  const { data: delta, pages } = readAll(store, after, { since_context_id: before.context_id })
  assert.equal(pages[0].mode, 'delta')
  assert.deepEqual(delta.messages.map(entry => entry.message.id), ['b', 'd'])
  assert.deepEqual(delta.removed_ids, ['a'])
  assert.deepEqual(delta.removed_indices, [0])
  assert.equal(delta.replace_tool_history, true)
  const restored = applyDelta(baseline, delta)
  store.resetDelivery(after.context_id, scope)
  assert.deepEqual(restored, readAll(store, after).data)
})

test('delta remains lossless for absent and duplicate message ids', () => {
  const store = new ContextStore({ pageChars: 100000 })
  const before = store.capture({ ...scope, messages: [message('same', 'first'), message('same', 'second'), { role: 'assistant', content: 'third' }] })
  const baseline = readAll(store, before).data
  const after = store.capture({ ...scope, messages: [{ role: 'user', content: 'new first' }, message('same', 'second'), { role: 'assistant', content: 'third' }] })
  const delta = readAll(store, after, { since_context_id: before.context_id }).data
  store.resetDelivery(after.context_id, scope)
  assert.deepEqual(applyDelta(baseline, delta), readAll(store, after).data)
})

test('delta distinguishes omitted, null and replaced tool histories', () => {
  const store = new ContextStore({ pageChars: 100000 })
  const variants = [
    { toolHistory: { tools: [{ name: 'read' }], updates: [] } },
    {},
    { toolHistory: null },
    { toolHistory: { tools: [], updates: [] } },
    {},
  ]
  let before = store.capture({ ...scope, messages: [], ...variants[0] })
  let baseline = readAll(store, before).data
  for (const variant of variants.slice(1)) {
    const after = store.capture({ ...scope, messages: [], ...variant })
    const delta = readAll(store, after, { since_context_id: before.context_id }).data
    const restored = applyDelta(baseline, delta)
    store.resetDelivery(after.context_id, scope)
    const full = readAll(store, after).data
    assert.deepEqual(restored, full)
    if (!Object.hasOwn(variant, 'toolHistory')) {
      assert.equal(delta.remove_tool_history, true)
      assert.equal(Object.hasOwn(delta, 'tool_history'), false)
    } else {
      assert.equal(delta.replace_tool_history, true)
      assert.deepEqual(delta.tool_history, variant.toolHistory)
    }
    before = after
    baseline = full
  }
})

test('delta pagination resumes without repeating base and cannot silently switch bases', () => {
  const store = new ContextStore({ pageChars: 200 })
  const before = store.capture({ ...scope, messages: [message('a', 'A')] })
  readAll(store, before)
  const after = store.capture({ ...scope, messages: [message('a', 'A'), message('b', 'B'.repeat(1500))] })
  const first = store.read({ ...after, since_context_id: before.context_id }, scope)
  assert.equal(first.mode, 'delta')
  assert.equal(store.isDelivered(after.context_id), false)
  assert.throws(() => store.read({ ...after, cursor: first.completeness.next_cursor, since_context_id: 'different' }, scope), error => error.code === 'context-cursor-invalid')
  const { data, pages } = readAll(store, after, { since_context_id: before.context_id })
  assert.ok(pages.length > 2)
  assert.equal(data.messages[0].message.id, 'b')
  assert.equal(store.isDelivered(after.context_id), true)
})

test('missing or incompletely delivered bases explicitly fall back to full, foreign bases reject', () => {
  const store = new ContextStore({ pageChars: 100000 })
  const unread = store.capture({ ...scope, messages: [message('a', 'A')] })
  const current = store.capture({ ...scope, messages: [message('b', 'B')] })
  const foreign = store.capture({ sessionId: 'session-B', messages: [message('private', 'B')] })
  assert.equal(store.read({ ...current, since_context_id: unread.context_id }, scope).fallback_reason, 'base-not-fully-delivered')
  store.resetDelivery(current.context_id, scope)
  assert.equal(store.read({ ...current, since_context_id: 'missing' }, scope).fallback_reason, 'base-unavailable')
  store.resetDelivery(current.context_id, scope)
  assert.equal(store.read({ ...current, since_context_id: 'missing' }, scope).mode, 'full')
  assert.throws(() => store.read({ ...current, since_context_id: foreign.context_id }, scope), error => error.code === 'context-scope-mismatch')
})

test('memory caps expire old snapshots explicitly and session cleanup also removes receipts', () => {
  const store = new ContextStore({ maxSnapshots: 3, maxSnapshotsPerSession: 2, maxTotalChars: 10000 })
  const first = store.capture({ ...scope, messages: [message('a', 'A')] })
  store.registerDeliveryCall('self', first)
  const second = store.capture({ ...scope, messages: [message('b', 'B')] })
  const third = store.capture({ ...scope, messages: [message('c', 'C')] })
  assert.equal(store.has(first.context_id), false)
  assert.throws(() => store.read(first, scope), error => error.code === 'context-not-found')
  assert.deepEqual(store.latestReference(scope.sessionId), third)
  store.deleteSession(scope.sessionId)
  assert.equal(store.has(second.context_id), false)
  assert.equal(store.has(third.context_id), false)
  assert.equal(store.totalChars, 0)
  assert.equal(store.latestReference(scope.sessionId), null)
  assert.equal(store.deliveryCalls.size, 0)
})

test('oversized and non-JSON snapshots fail explicitly without discarding the current one', () => {
  const store = new ContextStore({ maxTotalChars: 1000 })
  const existing = store.capture({ ...scope, messages: [message('a', 'A')] })
  assert.throws(() => store.capture({ ...scope, messages: [message('huge', 'x'.repeat(10000))] }), error => error.code === 'context-too-large')
  assert.equal(store.has(existing.context_id), true)
  assert.throws(() => store.capture({ ...scope, messages: [{ role: 'user', content: [{ type: 'unknown', data: () => null }] }] }), error => error.code === 'context-invalid')
  assert.throws(() => store.capture({ ...scope, messages: [], toolHistory: new Map([['tool', 'data']]) }), error => error.code === 'context-invalid')
  assert.equal(store.has(existing.context_id), true)
})

test('alternate base views are bounded and expired page cursors fail explicitly', () => {
  const store = new ContextStore({ pageChars: 200 })
  const reference = store.capture({ ...scope, messages: [message('large', 'X'.repeat(1000))] })
  const first = store.read({ ...reference, since_context_id: 'missing-base-0' }, scope)
  for (let index = 1; index < 10; index++) store.read({ ...reference, since_context_id: `missing-base-${index}` }, scope)
  assert.equal(store.snapshots.get(reference.context_id).views.size, 4)
  assert.throws(() => store.read({ ...reference, cursor: first.completeness.next_cursor }, scope), error => error.code === 'context-cursor-invalid')
  assert.equal(store.isDelivered(reference.context_id), false)
  assert.equal(readAll(store, reference).data.messages[0].id, 'large')
})
