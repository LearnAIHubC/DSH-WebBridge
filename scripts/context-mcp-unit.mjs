import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { ContextStore, CONTEXT_INSTRUCTIONS, CONTEXT_PARAMETERS, CONTEXT_TOOL_NAME } from '../src/context.js'
import { createToolScope } from '../src/dsh.js'
import { McpBridge } from '../src/mcp.js'

const text = value => [{ type: 'text', text: value }]
const message = (id, value, role = 'user', kind = 'plugin-context') => ({
  id, role, source: { kind, form: 'instructions' }, content: text(value),
})
const contextSchema = {
  name: CONTEXT_TOOL_NAME,
  description: CONTEXT_INSTRUCTIONS,
  parameters: CONTEXT_PARAMETERS,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}
const schema = name => ({
  name, description: `Fixture ${name}`,
  parameters: { file_path: { type: 'string' }, value: { type: 'string' } },
})
const resultText = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')

function expectError(result, code) {
  assert.equal(result.isError, true, resultText(result))
  assert.match(resultText(result), new RegExp(`^${code}:`))
  return resultText(result)
}

async function fixture(t, { pageChars = 12000, allowTools = ['*'], deniedTools = [] } = {}) {
  const contextStore = new ContextStore({ pageChars })
  const listeners = new Map()
  const declarations = []
  const records = []
  const denied = new Set(deniedTools)
  const schemas = [contextSchema, ...['lookup', 'read', 'write'].map(schema)]
  let toolScope
  const agents = ['session-A', 'session-B'].map(id => {
    const nextStep = []
    const agent = {
      id,
      session: {
        id,
        append(type, data, options) {
          declarations.push({ agentId: id, type, data, options })
          listeners.get('session/event')?.(agent.session, { type, data })
          return { seq: declarations.length - 1 }
        },
      },
      inbox: {
        nextStep,
        splice(target, index, count, messages) {
          assert.equal(target, 'next-step')
          nextStep.splice(index, count, ...messages)
        },
      },
      ctx: { tools: {
        schemas: () => schemas,
        async execute({ calls, agent: executorAgent, signal, log }) {
          assert.equal(executorAgent, agent, 'The scoped registry must receive its real agent')
          assert.ok(signal instanceof AbortSignal)
          assert.equal(calls.length, 1)
          const call = calls[0]
          const args = JSON.parse(call.arguments)
          if (log) {
            const declaration = declarations.find(entry => entry.agentId === id &&
              entry.data.message.content.some(block => block.type === 'tool-call' && block.id === call.id))
            assert.ok(declaration, 'The assistant tool declaration must precede registry execution')
            assert.equal(declaration.data.message.content[0].arguments, call.arguments)
          }
          records.push({ agentId: id, call, args, signal, log })
          if (denied.has(call.name)) {
            return { results: [{ result: { content: text('policy-denied: The registry denied this tool.'), isError: true } }] }
          }
          try {
            const body = call.name === CONTEXT_TOOL_NAME
              ? JSON.stringify(await toolScope.readContext(args, { agent, signal }))
              : `${call.name} executed for ${id}`
            return { results: [{ result: { content: text(body) } }] }
          } catch (error) {
            return { results: [{ result: { content: text(`${error.code || 'tool-error'}: ${error.message}`), isError: true } }] }
          }
        },
      } },
    }
    return agent
  })
  const ctx = {
    inject(services, callback) {
      const available = {
        agents: { list: () => agents },
        attachments: {},
        workingDirectory: { ensure: async agent => `/projects/${agent.id}` },
      }
      callback(Object.fromEntries(services.map(name => [name, available[name]])))
    },
    on: (name, callback) => listeners.set(name, callback),
    tools: { schemas: () => [contextSchema] },
  }
  toolScope = createToolScope(ctx, () => {}, { contextStore })
  const stateDir = mkdtempSync(join(tmpdir(), 'webbridge-context-mcp-unit-'))
  const bridge = new McpBridge({
    ctx, toolScope, contextStore, ops: {},
    settings: {
      stateDir,
      mcp: { port: 0, token: 'context-unit-test-token', requestsPerMinute: 2000, allowTools, exposeAgent: false },
    },
  })
  t.after(async () => {
    await bridge.stop()
    assert.equal(dirname(resolve(stateDir)), resolve(tmpdir()))
    assert.match(basename(stateDir), /^webbridge-context-mcp-unit-/)
    rmSync(stateDir, { recursive: true, force: true })
  })
  const status = await bridge.start()
  let rpcId = 0
  let mcpSessionId
  const rpc = async (method, params = {}) => {
    const id = ++rpcId
    const response = await fetch(status.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: 'Bearer context-unit-test-token',
        ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    assert.equal(response.status, 200)
    const returnedSession = response.headers.get('mcp-session-id')
    if (returnedSession) mcpSessionId = returnedSession
    const outcome = await response.json()
    assert.equal(outcome.id, id)
    assert.equal(outcome.jsonrpc, '2.0')
    assert.equal(outcome.error, undefined, JSON.stringify(outcome.error))
    return outcome.result
  }
  const statelessRpc = async (method, params = {}) => {
    const id = ++rpcId
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'context-mcp-modern-unit', version: '1' },
      ...(params._meta || {}),
    }
    const response = await fetch(status.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer context-unit-test-token',
        'mcp-protocol-version': '2026-07-28',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params: { ...params, _meta: meta } }),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('mcp-session-id'), null, 'modern MCP must remain stateless')
    const outcome = await response.json()
    assert.equal(outcome.id, id)
    assert.equal(outcome.jsonrpc, '2.0')
    assert.equal(outcome.error, undefined, JSON.stringify(outcome.error))
    return outcome.result
  }
  const initialization = await rpc('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'context-mcp-unit', version: '1' },
  })
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args })
  const statelessCall = (name, args = {}) => statelessRpc('tools/call', { name, arguments: args })
  const bind = (sessionId, reference, operation, signal) => toolScope.withSession(sessionId, operation, signal, { contextReference: reference })
  const request = (sessionId, turn = 1, step = 1, signal = new AbortController().signal) => listeners.get('agent/request')({
    agent: agents.find(agent => agent.id === sessionId), turn, step, signal,
  }, async () => ({ provider: 'webbridge-chatgpt', model: 'chatgpt-web' }))
  const capture = (sessionId, messages = [message('instructions', `Instructions for ${sessionId}`, 'system')], extra = {}) => {
    listeners.get('llm/stream')({ provider: 'webbridge-chatgpt', sessionId, messages, toolHistory: extra.toolHistory }, () => undefined)
    return contextStore.capture({ sessionId, messages, workspace: { cwd: `/projects/${sessionId}` }, ...extra })
  }
  const readPage = async (reference, args = {}) => {
    const result = await call(CONTEXT_TOOL_NAME, { context_id: reference.context_id, ...args })
    assert.notEqual(result.isError, true, resultText(result))
    const page = JSON.parse(resultText(result))
    assert.equal(page.context_id, reference.context_id)
    assert.equal(page.revision, reference.revision)
    return page
  }
  const load = async (reference, args = {}) => {
    const pages = []
    let cursor
    for (let index = 0; index < 100; index++) {
      const page = await readPage(reference, { ...args, ...(cursor ? { cursor } : {}) })
      pages.push(page)
      if (page.completeness.complete) {
        const document = page.page_count === 1 ? page.data : JSON.parse(pages.map(entry => entry.fragment).join(''))
        return { pages, document }
      }
      cursor = page.completeness.next_cursor
      assert.ok(cursor, 'An incomplete snapshot must remain traversable')
    }
    assert.fail('The context pagination did not complete')
  }
  const statelessLoad = async reference => {
    const pages = []
    let cursor
    for (let index = 0; index < 100; index++) {
      const result = await statelessCall(CONTEXT_TOOL_NAME, {
        context_id: reference.context_id,
        ...(cursor ? { cursor } : {}),
      })
      assert.notEqual(result.isError, true, resultText(result))
      const page = JSON.parse(resultText(result))
      pages.push(page)
      if (page.completeness.complete) {
        const document = page.page_count === 1 ? page.data : JSON.parse(pages.map(entry => entry.fragment).join(''))
        return { pages, document }
      }
      cursor = page.completeness.next_cursor
      assert.ok(cursor, 'An incomplete stateless snapshot must remain traversable')
    }
    assert.fail('The stateless context pagination did not complete')
  }
  return {
    bridge, toolScope, contextStore, agents, records, declarations, denied, initialization,
    rpc, call, statelessRpc, statelessCall, bind, request, capture, readPage, load, statelessLoad,
  }
}

test('legacy initialize and modern discovery advertise the context routing contract', async t => {
  const { bridge, initialization, rpc, statelessRpc } = await fixture(t)
  assert.equal(initialization.instructions, CONTEXT_INSTRUCTIONS)
  assert.equal(bridge.instructions, CONTEXT_INSTRUCTIONS)
  assert.match(initialization.instructions, /next_cursor/)
  assert.match(initialization.instructions, /dsh_context_id/)
  assert.match(initialization.instructions, /new chat must load a full snapshot/)

  const { tools } = await rpc('tools/list')
  const context = tools.find(tool => tool.name === CONTEXT_TOOL_NAME)
  const lookup = tools.find(tool => tool.name === 'lookup')
  assert.ok(context)
  assert.ok(lookup)
  assert.equal(tools.filter(tool => tool.name === CONTEXT_TOOL_NAME).length, 1)
  assert.deepEqual(context.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false })
  assert.deepEqual(context.inputSchema.required, ['context_id'])
  assert.deepEqual(Object.keys(context.inputSchema.properties).sort(), ['context_id', 'cursor', 'since_context_id'])
  assert.equal(lookup.inputSchema.properties.dsh_context_id.type, 'string')

  const discover = await statelessRpc('server/discover')
  assert.ok(discover.supportedVersions.includes('2026-07-28'))
  assert.deepEqual(discover.capabilities, { tools: { listChanged: false } })
  assert.equal(discover.ttlMs, 0)
  assert.equal(discover.cacheScope, 'private')
  assert.equal(discover.resultType, 'complete')
  assert.equal(discover._meta['io.modelcontextprotocol/serverInfo'].name, 'dsh-webbridge')
  assert.match(discover.instructions, /dsh_context_id/)

  const modernList = await statelessRpc('tools/list')
  assert.equal(modernList.ttlMs, 0)
  assert.equal(modernList.cacheScope, 'private')
  assert.equal(modernList.resultType, 'complete')
  assert.ok(modernList.tools.find(tool => tool.name === 'lookup').inputSchema.properties.dsh_context_id)
})

test('HTTP business tools stay gated until every context page has reached the model', async t => {
  const f = await fixture(t, { pageChars: 450 })
  const messages = [
    message('system', 'Effective system instructions', 'system'),
    message('large-project-rules', 'project rule with Unicode 项目 😀\n'.repeat(50)),
    message('future-plugin', 'Unknown source kinds remain in the ordered context', 'developer', 'future-source-kind'),
  ]
  const toolHistory = { tools: [{ name: 'lookup' }], updates: [{ messageId: 'registry-version', additions: [] }] }
  const reference = f.capture('session-A', messages, { toolHistory })
  await f.bind('session-A', reference, async () => {
    const blocked = expectError(await f.call('lookup', { value: 'before context' }), 'context-required')
    assert.ok(blocked.includes(reference.context_id))
    assert.equal(f.records.length, 0)
    const pages = []
    let cursor
    do {
      const page = await f.readPage(reference, cursor ? { cursor } : {})
      pages.push(page)
      assert.deepEqual(page.completeness.omitted, [])
      const count = f.records.length
      if (!page.completeness.complete) {
        assert.equal(f.contextStore.isDelivered(reference.context_id), false)
        expectError(await f.call('lookup'), 'context-required')
        assert.equal(f.records.length, count, 'A gated call must not reach the registry')
      }
      cursor = page.completeness.next_cursor
    } while (cursor)
    assert.ok(pages.length > 2)
    assert.equal(pages.at(-1).completeness.complete, true)
    assert.equal(f.contextStore.isDelivered(reference.context_id), true)
    const document = JSON.parse(pages.map(page => page.fragment).join(''))
    assert.deepEqual(document.messages, messages)
    assert.deepEqual(document.tool_history, toolHistory)
    assert.deepEqual(document.workspace, { cwd: '/projects/session-A' })
    const business = await f.call('lookup', { value: 'after context' })
    assert.notEqual(business.isError, true)
    assert.equal(resultText(business), 'lookup executed for session-A')
    assert.equal(f.records.at(-1).call.name, 'lookup')
  })
})

test('bootstrap traverses the scoped registry with the active signal and native tool declaration', async t => {
  const f = await fixture(t)
  const reference = f.capture('session-B')
  const abort = new AbortController()
  await f.request('session-B', 4, 2)
  await f.bind('session-B', reference, () => f.load(reference), abort.signal)
  assert.equal(f.records.length, 1)
  const record = f.records[0]
  assert.equal(record.agentId, 'session-B')
  assert.equal(record.signal, abort.signal)
  assert.deepEqual(record.log, { turn: 4, step: 2 })
  assert.equal(record.call.name, CONTEXT_TOOL_NAME)
  assert.deepEqual(record.args, { context_id: reference.context_id })
  assert.equal(f.declarations.length, 1)
  assert.equal(f.declarations[0].type, 'assistant/message')
  assert.equal(f.declarations[0].options.surfaceOp, 'append')
  assert.equal(f.contextStore.deliveryCalls.has(record.call.id), true)
  assert.equal(f.toolScope.hasContextCheckpoint('session-B'), false)
})

test('registry policy can deny bootstrap without falsely delivering context or opening the gate', async t => {
  const f = await fixture(t, { deniedTools: [CONTEXT_TOOL_NAME] })
  const reference = f.capture('session-A')
  await f.bind('session-A', reference, async () => {
    expectError(await f.call(CONTEXT_TOOL_NAME, { context_id: reference.context_id }), 'policy-denied')
    assert.equal(f.records.length, 1)
    assert.equal(f.contextStore.isDelivered(reference.context_id), false)
    assert.equal(f.contextStore.deliveryCalls.size, 0)
    expectError(await f.call('lookup'), 'context-required')
    assert.equal(f.records.length, 1)
    f.denied.delete(CONTEXT_TOOL_NAME)
    await f.load(reference)
    assert.notEqual((await f.call('lookup')).isError, true)
  })
})

test('HTTP context reads reject another DSH session even with a valid MCP connection', async t => {
  const f = await fixture(t)
  const a = f.capture('session-A')
  const b = f.capture('session-B', [message('private-B', 'session-B-private-rules')])
  await f.bind('session-A', a, async () => {
    const rejected = expectError(await f.call(CONTEXT_TOOL_NAME, { context_id: b.context_id }), 'context-request-mismatch')
    assert.ok(!rejected.includes('session-B-private-rules'))
    assert.equal(f.contextStore.isDelivered(b.context_id), false)
    await f.load(a)
  })
  await f.toolScope.withSession('session-A', async () => {
    expectError(await f.call(CONTEXT_TOOL_NAME, { context_id: b.context_id }), 'context-request-mismatch')
    assert.equal(f.contextStore.isDelivered(b.context_id), false)
  })
})

test('HTTP cursors and delta bases cannot be reused across snapshots or sessions', async t => {
  const f = await fixture(t, { pageChars: 400 })
  const long = id => [message(id, `${id} rules `.repeat(100))]
  const old = f.capture('session-A', long('old'))
  const current = f.capture('session-A', long('current'))
  const foreign = f.capture('session-B', long('foreign'))
  const oldPage = await f.bind('session-A', old, () => f.readPage(old))
  const foreignPage = await f.bind('session-B', foreign, () => f.readPage(foreign))
  assert.ok(oldPage.completeness.next_cursor)
  assert.ok(foreignPage.completeness.next_cursor)
  await f.bind('session-A', current, async () => {
    for (const cursor of [oldPage.completeness.next_cursor, foreignPage.completeness.next_cursor, 'cursor_forged']) {
      expectError(await f.call(CONTEXT_TOOL_NAME, { context_id: current.context_id, cursor }), 'context-cursor-invalid')
      assert.equal(f.contextStore.isDelivered(current.context_id), false)
    }
    expectError(await f.call(CONTEXT_TOOL_NAME, { context_id: current.context_id, since_context_id: foreign.context_id }), 'context-scope-mismatch')
    assert.equal(f.contextStore.isDelivered(current.context_id), false)
    const loaded = await f.load(current)
    assert.equal(loaded.document.messages[0].id, 'current')
  })
  assert.equal(f.contextStore.isDelivered(old.context_id), false)
  assert.equal(f.contextStore.isDelivered(foreign.context_id), false)
})

test('bootstrap honors both explicit inclusion and wildcard exclusions in the MCP allowlist', async t => {
  for (const allowTools of [['lookup'], ['*', `!${CONTEXT_TOOL_NAME}`]]) {
    const f = await fixture(t, { allowTools })
    const reference = f.capture('session-A')
    const { tools } = await f.rpc('tools/list')
    assert.ok(!tools.some(tool => tool.name === CONTEXT_TOOL_NAME))
    await f.bind('session-A', reference, async () => {
      expectError(await f.call(CONTEXT_TOOL_NAME, { context_id: reference.context_id }), 'tool-not-allowed')
      expectError(await f.call('lookup'), 'context-required')
      assert.equal(f.records.length, 0)
      assert.equal(f.contextStore.isDelivered(reference.context_id), false)
    })
  }
})

test('a completed bootstrap cannot bypass business-tool allowlist exclusions', async t => {
  const f = await fixture(t, { allowTools: ['dsh_*', 'lookup', '!write'] })
  const reference = f.capture('session-A')
  await f.bind('session-A', reference, async () => {
    await f.load(reference)
    expectError(await f.call('write', { file_path: '/projects/session-A/output.txt' }), 'tool-not-allowed')
    assert.equal(f.records.length, 1)
    assert.notEqual((await f.call('lookup')).isError, true)
  })
})

test('a file-rule checkpoint gates HTTP tools and stale context until a genuine later DSH step', async t => {
  const f = await fixture(t)
  const reference = f.capture('session-A')
  await f.request('session-A', 3, 2)
  await f.bind('session-A', reference, async () => {
    await f.load(reference)
    const completed = await f.call('read', { file_path: '/projects/session-A/nested/file.js' })
    assert.notEqual(completed.isError, true)
    assert.match(resultText(completed), /Do not repeat it/)
    assert.equal(f.toolScope.hasContextCheckpoint('session-A'), true)
    assert.equal(f.agents[0].inbox.nextStep.length, 1)
    assert.equal(f.agents[0].inbox.nextStep[0].source.kind, 'webbridge-context-checkpoint')
    assert.equal(f.declarations.some(entry => entry.type === 'step/end'), false)
    const before = f.records.length
    for (const name of ['lookup', 'read', CONTEXT_TOOL_NAME]) {
      expectError(await f.call(name, { context_id: reference.context_id, file_path: '/projects/session-A/nested/file.js' }), 'context-checkpoint-required')
    }
    assert.equal(f.records.length, before, 'Checkpoint rejection must precede registry execution')
    await f.request('session-A', 3, 2)
    expectError(await f.call('lookup'), 'context-checkpoint-required')
  })
  await f.request('session-A', 3, 3)
  assert.equal(f.toolScope.hasContextCheckpoint('session-A'), false)
  const continuation = f.agents[0].inbox.nextStep.splice(0)
  const next = f.capture('session-A', [message('refreshed-rules', 'Nested AGENTS.md is now effective'), ...continuation])
  await f.bind('session-A', next, async () => {
    expectError(await f.call('lookup'), 'context-required')
    const loaded = await f.load(next)
    assert.equal(loaded.document.messages[0].content[0].text, 'Nested AGENTS.md is now effective')
    assert.notEqual((await f.call('lookup')).isError, true)
  })
})

test('a later capture for the same session cannot replace the active HTTP context gate', async t => {
  const f = await fixture(t)
  const current = f.capture('session-A', [message('current', 'Current request instructions')])
  await f.bind('session-A', current, async () => {
    const future = f.capture('session-A', [message('future', 'Queued future request instructions')])
    assert.equal(f.contextStore.latestReference('session-A').context_id, future.context_id)
    const blocked = expectError(await f.call('lookup'), 'context-required')
    assert.ok(blocked.includes(current.context_id))
    assert.ok(!blocked.includes(future.context_id))
    await f.load(current)
    assert.equal(f.contextStore.isDelivered(future.context_id), false)
    assert.notEqual((await f.call('lookup')).isError, true)
    expectError(await f.call(CONTEXT_TOOL_NAME, { context_id: future.context_id }), 'context-request-mismatch')
  })
})

test('delivery of a newer snapshot cannot authorize an unread older active request', async t => {
  const f = await fixture(t)
  const current = f.capture('session-A', [message('current', 'Unread current context')])
  const future = f.capture('session-A', [message('future', 'Already delivered later context')])
  await f.bind('session-A', future, () => f.load(future))
  assert.equal(f.contextStore.isDelivered(future.context_id), true)
  await f.bind('session-A', current, async () => {
    const before = f.records.length
    expectError(await f.call('lookup'), 'context-required')
    assert.equal(f.records.length, before)
    await f.load(current)
    assert.notEqual((await f.call('lookup')).isError, true)
  })
})

test('overlapping references for one session fail explicitly without choosing a context', async t => {
  const f = await fixture(t)
  const first = f.capture('session-A', [message('first', 'First request')])
  const second = f.capture('session-A', [message('second', 'Second request')])
  await f.bind('session-A', first, async () => {
    await f.bind('session-A', second, async () => {
      expectError(await f.call('lookup'), 'ambiguous-context-scope')
      expectError(await f.call(CONTEXT_TOOL_NAME, { context_id: first.context_id }), 'ambiguous-context-scope')
      assert.equal(f.records.length, 0)
      assert.equal(f.contextStore.isDelivered(first.context_id), false)
      assert.equal(f.contextStore.isDelivered(second.context_id), false)
    })
    await f.load(first)
    assert.notEqual((await f.call('lookup')).isError, true)
  })
})

test('overlapping DSH sessions route through the legacy MCP binding without polluting tool arguments', async t => {
  const f = await fixture(t)
  const a = f.capture('session-A')
  const b = f.capture('session-B')
  await f.bind('session-A', a, () => f.bind('session-B', b, async () => {
    assert.equal(f.toolScope.activeSessionId, null)
    assert.equal(f.toolScope.hasActiveRequests, true)

    // Discovery is read-only and must stay available before routing exists.
    const listed = (await f.rpc('tools/list')).tools.map(tool => tool.name)
    assert.ok(listed.includes(CONTEXT_TOOL_NAME))
    assert.ok(listed.includes('lookup'))

    // Before bootstrap there is intentionally no session guess.
    expectError(await f.call('lookup'), 'ambiguous-tool-scope')
    assert.equal(f.records.length, 0)

    // context_id is the routing authority. MCP consumes that identity, binds its
    // own legacy protocol session, and forwards only the original DSH arguments.
    const loadedA = await f.load(a)
    assert.equal(loadedA.document.session_id, 'session-A')
    assert.deepEqual(f.records.at(-1).args, { context_id: a.context_id })
    const lookupA = await f.call('lookup', { value: 'from-A' })
    assert.notEqual(lookupA.isError, true)
    assert.equal(f.records.at(-1).agentId, 'session-A')
    assert.deepEqual(f.records.at(-1).args, { value: 'from-A' })

    // A later bootstrap may deliberately rebind the same legacy MCP connection.
    const loadedB = await f.load(b)
    assert.equal(loadedB.document.session_id, 'session-B')
    assert.deepEqual(f.records.at(-1).args, { context_id: b.context_id })
    const lookupB = await f.call('lookup', { value: 'from-B' })
    assert.notEqual(lookupB.isError, true)
    assert.equal(f.records.at(-1).agentId, 'session-B')
    assert.deepEqual(f.records.at(-1).args, { value: 'from-B' })
  }))
})

test('stateless MCP 2026-07-28 routes every DSH call by dsh_context_id and strips it before execution', async t => {
  const f = await fixture(t)
  const a = f.capture('session-A')
  const b = f.capture('session-B')
  await f.bind('session-A', a, () => f.bind('session-B', b, async () => {
    assert.equal(f.toolScope.activeSessionId, null)

    const listed = await f.statelessRpc('tools/list')
    const lookup = listed.tools.find(tool => tool.name === 'lookup')
    assert.equal(lookup.inputSchema.properties.dsh_context_id.type, 'string')

    // Stateless calls cannot borrow identity from an earlier HTTP request.
    expectError(await f.statelessCall('lookup', { value: 'unrouted' }), 'ambiguous-tool-scope')

    const loadedA = await f.statelessLoad(a)
    assert.equal(loadedA.document.session_id, 'session-A')
    const lookupA = await f.statelessCall('lookup', { value: 'modern-A', dsh_context_id: a.context_id })
    assert.notEqual(lookupA.isError, true)
    assert.equal(f.records.at(-1).agentId, 'session-A')
    assert.deepEqual(f.records.at(-1).args, { value: 'modern-A' })

    const loadedB = await f.statelessLoad(b)
    assert.equal(loadedB.document.session_id, 'session-B')
    const lookupB = await f.statelessCall('lookup', { value: 'modern-B', dsh_context_id: b.context_id })
    assert.notEqual(lookupB.isError, true)
    assert.equal(f.records.at(-1).agentId, 'session-B')
    assert.deepEqual(f.records.at(-1).args, { value: 'modern-B' })
  }))

  // A stale explicit handle from the same DSH session cannot authorize a newer request.
  const newerA = f.capture('session-A', [message('newer-A', 'new request for A')])
  await f.bind('session-A', newerA, async () => {
    expectError(await f.statelessCall('lookup', { value: 'stale', dsh_context_id: a.context_id }), 'context-request-mismatch')
  })
})
