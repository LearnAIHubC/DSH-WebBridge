import assert from 'node:assert/strict'
import test from 'node:test'
import { ContextStore } from '../src/context.js'
import { createToolScope } from '../src/dsh.js'

const text = value => [{ type: 'text', text: value }]
const injection = (id, kind = 'plugin-context', content = text(id)) => ({
  id, role: 'user', source: { kind, form: 'instructions' }, content,
})

function fixture({ contextStore = new ContextStore(), execute } = {}) {
  const listeners = new Map()
  const declarations = []
  const calls = []
  const directoryCalls = []
  let scope
  const agents = ['session-A', 'session-B'].map(id => {
    const nextStep = []
    const agent = {
      id,
      session: {
        id,
        append(type, data, options) {
          declarations.push({ sessionId: id, type, data, options })
          listeners.get('session/event')?.(agent.session, { type, data })
          return { seq: declarations.length }
        },
      },
      inbox: {
        nextStep,
        splice(target, index, remove, messages) {
          assert.equal(target, 'next-step')
          nextStep.splice(index, remove, ...messages)
        },
      },
      ctx: {
        tools: {
          schemas: () => ['read', 'write', 'edit', 'lookup', 'dsh_get_context'].map(name => ({ name, parameters: {} })),
          async execute(input) {
            const call = input.calls[0]
            const args = JSON.parse(call.arguments)
            calls.push({ agentId: id, call, args, signal: input.signal })
            if (call.name === 'dsh_get_context') {
              try {
                const value = await scope.readContext(args, { agent })
                return { results: [{ result: { content: text(JSON.stringify(value)) } }] }
              } catch (error) {
                return { results: [{ result: { content: text(`${error.code}: ${error.message}`), isError: true } }] }
              }
            }
            return execute ? execute({ agent, call, args, listeners, signal: input.signal }) : { results: [{ result: { content: text('tool completed') } }] }
          },
        },
      },
    }
    return agent
  })
  const ctx = {
    inject(services, callback) {
      const available = {
        agents: { list: () => agents },
        attachments: { imageHostPath: ref => `/images/${ref.attachmentId}` },
        workingDirectory: { async ensure(agent, signal) { directoryCalls.push({ agent, signal }); return `/projects/${agent.id}` } },
      }
      callback(Object.fromEntries(services.map(name => [name, available[name]])))
    },
    on: (name, callback) => listeners.set(name, callback),
    tools: { schemas: () => [] },
  }
  scope = createToolScope(ctx, () => {}, { contextStore })
  const prepare = (id, turn = 1, step = 1, provider = 'webbridge-chatgpt') => listeners.get('agent/request')({
    agent: agents.find(agent => agent.id === id), turn, step, signal: new AbortController().signal,
  }, async () => ({ provider, model: 'chatgpt-web' }))
  const captureOriginal = (id, messages, toolHistory) => listeners.get('llm/stream')({
    provider: 'webbridge-chatgpt', sessionId: id, messages, toolHistory,
  }, () => undefined)
  const nativeRequest = (id, operation, reference = contextStore.capture({ sessionId: id, messages: [] })) =>
    scope.withSession(id, operation, undefined, { contextReference: reference })
  return { scope, agents, listeners, calls, declarations, directoryCalls, contextStore, prepare, captureOriginal, nativeRequest }
}

test('pre-projection requests preserve cloned messages, blocks and tool history', () => {
  const { scope, captureOriginal } = fixture()
  const messages = [
    { id: 'system', role: 'system', content: text('instructions') },
    { id: 'image', role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'one' } }] },
    injection('future', 'unknown-future-plugin'),
  ]
  const toolHistory = { tools: [{ name: 'read' }], updates: [{ messageId: 'registry', additions: [] }] }
  captureOriginal('session-A', messages, toolHistory)
  messages[0].content[0].text = 'mutated by another middleware'
  messages[1].content = text('projected image handle')
  toolHistory.tools[0].name = 'changed'
  const original = scope.originalRequest('session-A')
  assert.equal(original.messages[0].content[0].text, 'instructions')
  assert.equal(original.messages[1].content[0].type, 'image')
  assert.equal(original.messages[2].source.kind, 'unknown-future-plugin')
  assert.equal(original.toolHistory.tools[0].name, 'read')
  assert.equal(scope.originalMessage('session-A', messages[1]).content[0].type, 'image')
  original.messages[0].content = []
  assert.equal(scope.originalRequest('session-A').messages[0].content[0].text, 'instructions')
  assert.equal(scope.originalRequest('session-B'), undefined)
})

test('workspace metadata comes from the requested live agent working-directory service', async () => {
  const { scope, directoryCalls } = fixture()
  const signal = new AbortController().signal
  assert.deepEqual(await scope.workspaceFor('session-B', signal), { cwd: '/projects/session-B' })
  assert.equal(directoryCalls[0].agent.id, 'session-B')
  assert.equal(directoryCalls[0].signal, signal)
  assert.deepEqual(await scope.workspaceFor('unknown'), {})
})

test('context reading requires the executor agent and refuses foreign snapshots', async () => {
  const { scope, agents, contextStore } = fixture()
  const reference = contextStore.capture({ sessionId: 'session-A', messages: [injection('a')] })
  await scope.withSession('session-A', async () => {})
  assert.throws(() => scope.readContext(reference, {}), error => error.code === 'context-scope-required')
  assert.throws(() => scope.readContext(reference, { agent: agents[1] }), error => error.code === 'context-scope-mismatch')
  assert.equal(scope.readContext(reference, { agent: agents[0] }).data.session_id, 'session-A')
})

test('active context binding cannot be replaced by a newer queued snapshot', async () => {
  const { scope, agents, contextStore } = fixture()
  const first = contextStore.capture({ sessionId: 'session-A', messages: [injection('first')] })
  const future = contextStore.capture({ sessionId: 'session-A', messages: [injection('future')] })
  await scope.withSession('session-A', async () => {
    assert.deepEqual(scope.activeContextReference, first)
    assert.equal(contextStore.latestReference('session-A').context_id, future.context_id)
    assert.equal(scope.readContext(first, { agent: agents[0] }).data.messages[0].id, 'first')
    assert.throws(() => scope.readContext(future, { agent: agents[0] }), error => error.code === 'context-request-mismatch')
    await scope.withSession('session-A', async () => {
      assert.throws(() => scope.activeContextReference, error => error.code === 'ambiguous-context-scope')
      assert.throws(() => scope.readContext(first, { agent: agents[0] }), error => error.code === 'ambiguous-context-scope')
    }, undefined, { contextReference: future })
    assert.deepEqual(scope.activeContextReference, first)
  }, undefined, { contextReference: first })
  assert.equal(scope.activeContextReference, null)
})

test('request context binding rejects a foreign session before starting its operation', async () => {
  const { scope, contextStore } = fixture()
  const reference = contextStore.capture({ sessionId: 'session-B', messages: [] })
  let invoked = false
  await assert.rejects(scope.withSession('session-A', () => { invoked = true }, undefined, { contextReference: reference }),
    error => error.code === 'context-scope-mismatch')
  assert.equal(invoked, false)
  assert.equal(scope.hasActiveRequests, false)
  assert.equal(scope.activeContextReference, null)
})

test('successful context calls register only their precise call id for later folding', async () => {
  const { scope, calls, contextStore } = fixture()
  const reference = contextStore.capture({ sessionId: 'session-A', messages: [injection('a')] })
  const outcome = await scope.withSession('session-A', () => scope.execute('dsh_get_context', reference))
  assert.equal(outcome.ok, true)
  assert.equal(scope.hasContextCheckpoint('session-A'), false)
  const callId = calls[0].call.id
  assert.equal(contextStore.deliveryCalls.has(callId), true)
  const next = contextStore.capture({ sessionId: 'session-A', messages: [{
    id: 'result', role: 'user', source: { kind: 'tool', callId }, content: text(outcome.body),
  }] })
  const messages = contextStore.read(next, { sessionId: 'session-A' }).data.messages
  assert.ok(JSON.stringify(messages).includes('context-delivery-receipt'))
  assert.ok(!JSON.stringify(messages).includes('page_count'))
})

test('failed or cross-session context reads do not create a delivery-call receipt', async () => {
  const { scope, contextStore } = fixture()
  const reference = contextStore.capture({ sessionId: 'session-B', messages: [injection('b')] })
  const outcome = await scope.withSession('session-A', () => scope.execute('dsh_get_context', reference))
  assert.equal(outcome.ok, false)
  assert.match(outcome.body, /context-scope-mismatch/)
  assert.equal(contextStore.deliveryCalls.size, 0)
})

test('native additional contexts reach the model and the durable next-step inbox in order', async () => {
  const updates = [
    injection('skill', 'skill-invocation', [{ type: 'text', text: '<skill_content>complete instructions</skill_content>' }]),
    { id: 'registry', role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'new-tool' }] },
    injection('future', 'not-yet-known-kind'),
  ]
  const { scope, agents } = fixture({ execute: () => ({ results: [{ result: { content: text('done') } }], additionalContexts: updates }) })
  const outcome = await scope.withSession('session-A', () => scope.execute('lookup', {}))
  assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.context_updates, updates)
  assert.deepEqual(agents[0].inbox.nextStep, updates)
  assert.deepEqual(agents[1].inbox.nextStep, [])
  assert.match(outcome.body, /complete instructions/)
  assert.match(outcome.body, /tool-addition/)
  const again = await scope.withSession('session-A', () => scope.execute('lookup', {}))
  assert.equal(again.context_updates, undefined)
  assert.equal(agents[0].inbox.nextStep.length, 3)
})

test('additional contexts are retained for an error result', async () => {
  const update = injection('failure-help', 'tool-guidance')
  const { scope, agents } = fixture({ execute: () => ({
    results: [{ result: { content: text('operation failed'), isError: true } }], additionalContexts: [update],
  }) })
  const outcome = await scope.withSession('session-A', () => scope.execute('lookup', {}))
  assert.equal(outcome.ok, false)
  assert.deepEqual(outcome.context_updates, [update])
  assert.deepEqual(agents[0].inbox.nextStep, [update])
})

test('partial tool-batch failure cannot discard generated context', async () => {
  const update = injection('partial-context')
  const { scope } = fixture({ execute: () => { throw Object.assign(new Error('batch failed'), {
    partial: { additionalContexts: [update] }, cause: new Error('actual tool failure'),
  }) } })
  const outcome = await scope.withSession('session-A', () => scope.execute('lookup', {}))
  assert.equal(outcome.ok, false)
  assert.match(outcome.body, /actual tool failure/)
  assert.deepEqual(outcome.context_updates, [update])
})

test('committed context updates are scoped, de-duplicated and superseded by a fresh request', async () => {
  const { scope, agents, listeners, captureOriginal } = fixture()
  const known = injection('already-in-snapshot')
  const own = injection('new-A', 'future-context')
  const other = injection('new-B', 'future-context')
  captureOriginal('session-A', [known])
  listeners.get('session/event')(agents[0].session, { type: 'user/message', data: known })
  listeners.get('session/event')(agents[0].session, { type: 'user/message', data: own })
  listeners.get('session/event')(agents[1].session, { type: 'user/message', data: other })
  const a = await scope.withSession('session-A', () => scope.execute('lookup', {}))
  assert.deepEqual(a.context_updates, [own])
  const b = await scope.withSession('session-B', () => scope.execute('lookup', {}))
  assert.deepEqual(b.context_updates, [other])
  captureOriginal('session-A', [known, own])
  const next = await scope.withSession('session-A', () => scope.execute('lookup', {}))
  assert.equal(next.context_updates, undefined)
})

test('repeated injected content is not queued again just because its ID changed', async () => {
  const original = injection('first-id', 'plugin-rules', text('same rules'))
  const duplicate = { ...original, id: 'new-id', source: { ...original.source, turn: 4, step: 9, timestamp: 12345 } }
  const { scope, agents, captureOriginal } = fixture({ execute: () => ({ results: [{ result: { content: text('done') } }], additionalContexts: [duplicate] }) })
  captureOriginal('session-A', [original])
  const result = await scope.withSession('session-A', () => scope.execute('lookup', {}))
  assert.equal(result.context_updates, undefined)
  assert.deepEqual(agents[0].inbox.nextStep, [])
})

test('identical text from a different instruction scope remains a real update', async () => {
  const original = { ...injection('scope-A', 'plugin-rules', text('same text')), source: { kind: 'plugin-rules', scope: '/project/A' } }
  const update = { ...original, id: 'scope-B', source: { kind: 'plugin-rules', scope: '/project/B' } }
  const { scope, captureOriginal } = fixture({ execute: () => ({ results: [{ result: { content: text('done') } }], additionalContexts: [update] }) })
  captureOriginal('session-A', [original])
  const result = await scope.withSession('session-A', () => scope.execute('lookup', {}))
  assert.deepEqual(result.context_updates, [update])
})

test('a rule reverting to an earlier value is delivered once and replayed inbox entries stay quiet', async () => {
  let version = 'A'
  let counter = 0
  const { scope, agents } = fixture({ execute: () => ({
    results: [{ result: { content: text('done') } }],
    additionalContexts: [{ ...injection(`update-${counter++}`, 'plugin-rules', text(version)), source: { kind: 'plugin-rules', scope: '/project' } }],
  }) })
  for (const next of ['A', 'B', 'A']) {
    version = next
    const result = await scope.withSession('session-A', () => scope.execute('lookup', {}))
    assert.equal(result.context_updates.length, 1)
    assert.deepEqual(result.context_updates[0].content, text(next))
  }
  const duplicate = await scope.withSession('session-A', () => scope.execute('lookup', {}))
  assert.equal(duplicate.context_updates, undefined)
  assert.equal(agents[0].inbox.nextStep.length, 3)
})

test('unchanged rules in the same directory do not create a repeated checkpoint', async () => {
  const { scope, agents, prepare, captureOriginal, nativeRequest } = fixture()
  const rules = injection('rules-1', 'agent-instructions', text('same rules'))
  captureOriginal('session-A', [rules])
  await prepare('session-A', 1, 1)
  await nativeRequest('session-A', () => scope.execute('read', { file_path: '/project/src/a.js' }))
  assert.equal(agents[0].inbox.nextStep.length, 1)
  assert.match(agents[0].inbox.nextStep[0].source.fingerprint, /^[a-f0-9]{64}$/)
  agents[0].inbox.nextStep.splice(0)
  await prepare('session-A', 1, 2)
  captureOriginal('session-A', [{ ...rules, id: 'rules-2' }])
  const next = await nativeRequest('session-A', () => scope.execute('read', { file_path: '/project/src/b.js' }))
  assert.equal(next.ok, true)
  assert.equal(scope.hasContextCheckpoint('session-A'), false)
  assert.deepEqual(agents[0].inbox.nextStep, [])
  captureOriginal('session-A', [{ ...rules, id: 'rules-3', content: text('changed rules') }])
  await nativeRequest('session-A', () => scope.execute('read', { file_path: '/project/src/c.js' }))
  assert.equal(scope.hasContextCheckpoint('session-A'), true)
})

test('a successful file touch requests a real step boundary and never fabricates step/end', async () => {
  const { scope, agents, declarations, prepare, contextStore, calls, nativeRequest } = fixture()
  const reference = contextStore.capture({ sessionId: 'session-A', messages: [injection('a')] })
  await prepare('session-A', 3, 2)
  const result = await nativeRequest('session-A', () => scope.execute('read', { file_path: '/project/nested/file.js' }), reference)
  assert.equal(result.ok, true)
  assert.equal(scope.hasContextCheckpoint('session-A'), true)
  assert.equal(agents[0].inbox.nextStep.length, 1)
  assert.equal(agents[0].inbox.nextStep[0].source.kind, 'webbridge-context-checkpoint')
  assert.match(result.body, /Do not repeat it/)
  assert.equal(declarations.some(record => record.type === 'step/end'), false)
  await assert.rejects(scope.withSession('session-A', () => scope.execute('edit', { file_path: '/project/nested/file.js' })), error => error.code === 'context-checkpoint-required')
  assert.equal(calls.length, 1)
  assert.throws(() => scope.readContext(reference, { agent: agents[0] }), error => error.code === 'context-checkpoint-required')
  await prepare('session-A', 3, 2)
  assert.equal(scope.hasContextCheckpoint('session-A'), true, 'same-step retries must not claim refreshed rules')
  await prepare('session-A', 3, 3)
  assert.equal(scope.hasContextCheckpoint('session-A'), false)
  const resumed = await scope.withSession('session-A', () => scope.execute('lookup', {}))
  assert.equal(resumed.ok, true)
})

test('same-session native calls wait for the preceding file-rule checkpoint', async () => {
  let unblock
  let began
  const pending = new Promise(resolve => { unblock = resolve })
  const started = new Promise(resolve => { began = resolve })
  const { scope, calls, prepare, nativeRequest } = fixture({ execute: async ({ call }) => {
    if (call.name === 'read') { began(); await pending }
    return { results: [{ result: { content: text('done') } }] }
  } })
  await prepare('session-A')
  await nativeRequest('session-A', async () => {
    const read = scope.execute('read', { file_path: '/project/file.js' })
    const edit = scope.execute('edit', { file_path: '/project/file.js' })
    const rejected = assert.rejects(edit, error => error.code === 'context-checkpoint-required')
    await started
    assert.equal(calls.length, 1)
    unblock()
    assert.equal((await read).ok, true)
    await rejected
    assert.equal(calls.length, 1, 'the queued edit must never execute before rules are refreshed')
  })
})

for (const endReason of ['aborted', 'ended']) {
  test(`a queued call from an ${endReason} request cannot borrow a same-step retry's scope`, async () => {
    let releaseTool
    let startedTool
    let releaseRequest
    let originalRun
    let queuedRejection
    const toolReady = new Promise(resolve => { startedTool = resolve })
    const heldTool = new Promise(resolve => { releaseTool = resolve })
    const heldRequest = new Promise(resolve => { releaseRequest = resolve })
    const { scope, calls, prepare, contextStore } = fixture({ execute: async ({ args }) => {
      if (args.hold) { startedTool(); await heldTool }
      return { results: [{ result: { content: text('completed') } }] }
    } })
    await prepare('session-A', 2, 4)
    const originalReference = contextStore.capture({ sessionId: 'session-A', messages: [injection('old')] })
    const originalController = new AbortController()
    const originalRequest = scope.withSession('session-A', async () => {
      originalRun = scope.execute('lookup', { hold: true })
      queuedRejection = assert.rejects(scope.execute('edit', { file_path: '/project/file.js' }), error =>
        error.code === (endReason === 'aborted' ? 'aborted' : 'context-request-changed'))
      await heldRequest
    }, originalController.signal, { contextReference: originalReference })
    await toolReady
    if (endReason === 'aborted') originalController.abort()
    releaseRequest()
    await originalRequest

    // A browser retry can reuse the same DSH turn/step. The request token, not
    // the numerical step alone, decides whether old queued work is still valid.
    await prepare('session-A', 2, 4)
    const retryReference = contextStore.capture({ sessionId: 'session-A', messages: [injection('new')] })
    const retryController = new AbortController()
    await scope.withSession('session-A', async () => {
      releaseTool()
      await originalRun
      await queuedRejection
      assert.equal(calls.length, 1, 'the old queued edit must not reach the executor')
      assert.equal(calls[0].signal, originalController.signal)
      const fresh = await scope.execute('lookup', {})
      assert.equal(fresh.ok, true)
      assert.equal(calls.length, 2)
      assert.equal(calls[1].signal, retryController.signal)
      assert.equal(scope.hasContextCheckpoint('session-A'), false)
    }, retryController.signal, { contextReference: retryReference })
  })
}

test('unbound callers retain their explicit signal and legacy execution behavior', async () => {
  const { scope, calls } = fixture()
  const signal = new AbortController().signal
  const result = await scope.execute('lookup', {}, signal)
  assert.equal(result.ok, true)
  assert.equal(calls[0].signal, signal)
})

for (const route of [
  { name: 'a ChatGPT request without a native context binding', provider: 'webbridge-chatgpt', withSession: true },
  { name: 'the DeepSeek compatibility route', provider: 'webbridge-deepseek', withSession: true },
  { name: 'standalone agent tool execution', provider: 'standalone-agent', withSession: false },
]) {
  test(`${route.name} does not acquire native file-rule checkpoints`, async () => {
    const { scope, agents, calls, contextStore, prepare } = fixture()
    await prepare('session-A', 1, 1, route.provider)
    // A stored snapshot alone must not opt this request into native transport.
    contextStore.capture({ sessionId: 'session-A', messages: [injection('stored-context')] })
    delete agents[0].inbox.splice
    const operation = async () => {
      for (const name of ['read', 'write', 'edit']) {
        const result = await scope.execute(name, { file_path: '/project/file.js' })
        assert.equal(result.ok, true)
        assert.doesNotMatch(result.body, /Finish this web reply|End this web response|automatically continue/)
      }
    }
    if (route.withSession) await scope.withSession('session-A', operation)
    else await operation()
    assert.equal(calls.length, 3)
    assert.equal(scope.hasContextCheckpoint('session-A'), false)
    assert.deepEqual(agents[0].inbox.nextStep, [])
  })
}

test('the bound native reference enables checkpoints without a provider-name heuristic', async () => {
  const { scope, prepare, nativeRequest } = fixture()
  await prepare('session-A', 1, 1, 'another-native-route')
  const result = await nativeRequest('session-A', () => scope.execute('read', { file_path: '/project/file.js' }))
  assert.equal(result.ok, true)
  assert.equal(scope.hasContextCheckpoint('session-A'), true)
})

test('a compatibility context enqueue failure cannot introduce a native checkpoint', async () => {
  const update = injection('compatibility-context')
  const { scope, agents, prepare } = fixture({ execute: () => ({
    results: [{ result: { content: text('action succeeded') } }], additionalContexts: [update],
  }) })
  await prepare('session-A', 1, 1, 'webbridge-deepseek')
  agents[0].inbox.splice = () => { throw new Error('compatibility inbox failure') }
  const result = await scope.withSession('session-A', () => scope.execute('lookup', {}))
  assert.equal(result.ok, true)
  assert.deepEqual(result.context_updates, [update])
  assert.match(result.body, /compatibility inbox failure/)
  assert.doesNotMatch(result.body, /End this web response|automatically continue/)
  assert.equal(scope.hasContextCheckpoint('session-A'), false)
})

test('missing checkpoint inbox support is rejected before a file action', async () => {
  const { scope, agents, calls, prepare, nativeRequest } = fixture()
  await prepare('session-A')
  delete agents[0].inbox.splice
  await assert.rejects(nativeRequest('session-A', () => scope.execute('write', { file_path: '/project/file.js' })), error =>
    error.code === 'context-checkpoint-unavailable' && /No action was performed/.test(error.message))
  assert.equal(calls.length, 0)
  assert.equal(scope.hasContextCheckpoint('session-A'), false)

  const legacy = fixture({ contextStore: null })
  await legacy.prepare('session-A')
  delete legacy.agents[0].inbox.splice
  assert.equal((await legacy.scope.withSession('session-A', () => legacy.scope.execute('write', { file_path: '/project/file.js' }))).ok, true)
  assert.equal(legacy.calls.length, 1)
})

test('a failed checkpoint enqueue preserves the completed file action and blocks further tools', async () => {
  const { scope, agents, calls, prepare, nativeRequest } = fixture()
  await prepare('session-A')
  agents[0].inbox.splice = () => { throw new Error('inbox unavailable after write') }
  const result = await nativeRequest('session-A', () => scope.execute('write', { file_path: '/project/file.js' }))
  assert.equal(result.ok, true)
  assert.match(result.body, /tool completed/)
  assert.match(result.body, /completed successfully\. Do not repeat/)
  assert.match(result.body, /inbox unavailable after write/)
  assert.equal(scope.hasContextCheckpoint('session-A'), true)
  assert.match(scope.contextCheckpointMessage('session-A'), /report the context-refresh failure/)
  await assert.rejects(scope.withSession('session-A', () => scope.execute('edit', { file_path: '/project/file.js' })), error =>
    error.code === 'context-checkpoint-required' && /inbox unavailable after write/.test(error.message))
  assert.equal(calls.length, 1)
  await prepare('session-A', 1, 1)
  assert.equal(scope.hasContextCheckpoint('session-A'), true)
  await prepare('session-A', 1, 2)
  assert.equal(scope.hasContextCheckpoint('session-A'), false)
})

test('failure to enqueue additional context preserves both a successful result and the context', async () => {
  const update = injection('additional-context')
  const { scope, agents, prepare, nativeRequest } = fixture({ execute: () => ({
    results: [{ result: { content: text('action succeeded') } }], additionalContexts: [update],
  }) })
  await prepare('session-A')
  agents[0].inbox.splice = () => { throw new Error('additional-context inbox failure') }
  const result = await nativeRequest('session-A', () => scope.execute('lookup', {}))
  assert.equal(result.ok, true)
  assert.match(result.body, /action succeeded/)
  assert.match(result.body, /additional-context inbox failure/)
  assert.deepEqual(result.context_updates, [update])
  assert.equal(scope.hasContextCheckpoint('session-A'), true)
})

test('a partial batch with this exact call already successful retains its outcome and checkpoint', async () => {
  const update = injection('partial-success-context')
  const { scope, agents, prepare, nativeRequest } = fixture({ execute: ({ call }) => {
    throw Object.assign(new Error('batch finalization failed'), {
      partial: { results: [{ callId: call.id, result: { content: text('file was written successfully') } }], additionalContexts: [update] },
    })
  } })
  await prepare('session-A')
  const result = await nativeRequest('session-A', () => scope.execute('write', { file_path: '/project/file.js' }))
  assert.equal(result.ok, true)
  assert.match(result.body, /file was written successfully/)
  assert.match(result.body, /batch finalization failed/)
  assert.match(result.body, /Do not repeat it/)
  assert.equal(result.context_updates[0].id, update.id)
  assert.equal(agents[0].inbox.nextStep[0].id, update.id)
  assert.equal(agents[0].inbox.nextStep[1].source.kind, 'webbridge-context-checkpoint')
  assert.equal(scope.hasContextCheckpoint('session-A'), true)
})

test('another call success in a partial batch cannot be claimed for this failed call', async () => {
  const { scope, prepare, nativeRequest } = fixture({ execute: () => {
    throw Object.assign(new Error('current call failed'), {
      partial: {
        results: [{ callId: 'different-call', result: { content: text('unrelated success') } }],
        additionalContexts: [injection('failure-context')],
      },
    })
  } })
  await prepare('session-A')
  const result = await nativeRequest('session-A', () => scope.execute('write', { file_path: '/project/file.js' }))
  assert.equal(result.ok, false)
  assert.match(result.body, /current call failed/)
  assert.doesNotMatch(result.body, /unrelated success/)
  assert.equal(scope.hasContextCheckpoint('session-A'), false)
})

test('file errors and context reads do not request a rule checkpoint', async () => {
  const { scope, prepare, contextStore, nativeRequest } = fixture({ execute: () => ({ results: [{ result: { content: text('missing'), isError: true } }] }) })
  await prepare('session-A')
  await nativeRequest('session-A', () => scope.execute('read', { file_path: '/missing' }))
  assert.equal(scope.hasContextCheckpoint('session-A'), false)
  const reference = contextStore.capture({ sessionId: 'session-A', messages: [] })
  await nativeRequest('session-A', () => scope.execute('dsh_get_context', reference), reference)
  assert.equal(scope.hasContextCheckpoint('session-A'), false)
})

test('disposing an agent removes its raw inputs, updates, checkpoint and snapshots', async () => {
  const { scope, agents, listeners, captureOriginal, contextStore, prepare, nativeRequest } = fixture()
  captureOriginal('session-A', [injection('a')])
  const reference = contextStore.capture({ sessionId: 'session-A', messages: [] })
  await prepare('session-A')
  await nativeRequest('session-A', () => scope.execute('read', { file_path: '/project/file' }), reference)
  listeners.get('agent/disposed')({ agent: agents[0] })
  assert.equal(scope.originalRequest('session-A'), undefined)
  assert.equal(scope.hasContextCheckpoint('session-A'), false)
  assert.equal(contextStore.has(reference.context_id), false)
})
