import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { McpBridge } from '../src/mcp.js'
import { createOps } from '../src/ops.js'
import { createToolScope } from '../src/dsh.js'
import { dslToJsonSchema } from '../src/tool.js'
import { createActivity } from '../src/activity.js'

const schema = (name) => ({ name, description: name, parameters: { value: { type: 'string' } } })

async function fixture(t, { names = ['read', 'write', 'pwsh'], exposeAgent = true, allowTools = ['*'] } = {}) {
  const records = []
  const declarations = []
  const listeners = new Map()
  const agents = ['session-A', 'session-B'].map((id) => ({ id, session: { id, append: (type, data, options) => { declarations.push({ agent: id, type, data, options }); return { seq: declarations.length - 1 } } }, ctx: { tools: {
    schemas: () => names.map(schema),
    async execute({ calls, agent, signal, log }) {
      assert.ok(signal)
      if (log) {
        const advertised = declarations.find(entry => entry.agent === agent.id && entry.data.message.content.some(block => block.type === 'tool-call' && block.id === calls[0].id))
        assert.ok(advertised, 'A persisted tool/call must have an advertised assistant lifecycle')
        assert.equal(advertised.data.message.content[0].arguments, calls[0].arguments)
      }
      records.push({ agent: agent.id, calls, signal, log })
      return { results: [{ result: { content: [{ type: 'text', text: `executed:${agent.id}` }] } }] }
    },
  } } }))
  const ctx = { inject: (_services, callback) => callback({ agents: { list: () => agents } }),
    on: (name, callback) => listeners.set(name, callback),
    tools: { schemas: () => [schema('webbridge_agent')] } }
  const toolScope = createToolScope(ctx)
  const stateDir = mkdtempSync(join(tmpdir(), 'webbridge-mcp-unit-'))
  const bridge = new McpBridge({ ctx, toolScope, ops: { browser: async args => ({ action: args.action }), runAgentTask: () => { throw new Error('must not start a recursive browser loop') } },
    settings: { stateDir, mcp: { port: 0, token: 'unit-test-token', allowTools, exposeAgent } } })
  const status = await bridge.start()
  t.after(async () => {
    await bridge.stop()
    assert.ok(resolve(stateDir).startsWith(resolve(tmpdir(), 'webbridge-mcp-unit-')))
    rmSync(stateDir, { recursive: true, force: true })
  })
  const rpc = async (method, params = {}) => {
    const response = await fetch(status.url, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer unit-test-token' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return response.json()
  }
  const request = (id, turn, step, signal = new AbortController().signal) =>
    listeners.get('agent/request')({ agent: agents.find(a => a.id === id), turn, step, signal }, async () => ({ provider: 'webbridge-chatgpt', model: 'chatgpt-web' }))
  const idle = (id) => listeners.get('agent/status')({ agent: agents.find(a => a.id === id), status: 'idle' })
  return { toolScope, rpc, records, request, idle, declarations }
}

test('MCP lists the complete DSH catalog without a 32-tool cutoff', async (t) => {
  const names = [...Array.from({ length: 65 }, (_, index) => `tool_${index}`), 'write']
  const { rpc } = await fixture(t, { names })
  const listed = (await rpc('tools/list')).result.tools.map((tool) => tool.name)
  for (const name of names) assert.ok(listed.includes(name), name)
  assert.equal(new Set(listed).size, listed.length)
})

test('DSH webbridge-prefixed tools without local ops execute through the scoped registry', async (t) => {
  const { rpc, toolScope, records } = await fixture(t, { names: ['webbridge_mcp'] })
  const listed = (await rpc('tools/list')).result.tools.map((tool) => tool.name)
  assert.ok(listed.includes('webbridge_mcp'))
  const outcome = await toolScope.withSession('session-B', () => rpc('tools/call', {
    name: 'webbridge_mcp', arguments: { value: 'status' },
  }))
  assert.notEqual(outcome.result.isError, true)
  assert.equal(records[0].agent, 'session-B')
  assert.deepEqual(JSON.parse(records[0].calls[0].arguments), { value: 'status' })
})

test('dynamic DSH JSON schemas retain real argument names and nested definitions', () => {
  const parameters = { type: 'object', properties: {
    file_path: { type: 'string' }, commands: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  }, required: ['file_path'], additionalProperties: false }
  assert.deepEqual(dslToJsonSchema(parameters), parameters)
  assert.ok(!Object.hasOwn(dslToJsonSchema(parameters).properties, 'properties'))
  assert.deepEqual(dslToJsonSchema({ file_path: { type: 'string', required: true } }).required, ['file_path'])
})

test('disabled browser-agent tools are not advertised through a wildcard allowlist', async (t) => {
  const { rpc } = await fixture(t, { exposeAgent: false })
  const names = (await rpc('tools/list')).result.tools.map((tool) => tool.name)
  assert.ok(!names.includes('webbridge_agent'))
})

test('native MCP execution uses the DSH session that initiated the web request', async (t) => {
  const { rpc, toolScope, records } = await fixture(t)
  const outcome = await toolScope.withSession('session-B', () => rpc('tools/call', { name: 'write', arguments: { value: 'hello' } }))
  assert.notEqual(outcome.result.isError, true)
  assert.equal(records[0].agent, 'session-B')
  assert.deepEqual(JSON.parse(records[0].calls[0].arguments), { value: 'hello' })
})

test('MCP receives and returns results under the owning request trace without argument or result values', async t => {
  const { rpc, toolScope } = await fixture(t)
  const records = []
  const activity = createActivity({}, line => records.push(JSON.parse(line.slice('[webbridge:flow] '.length))), { sessionId: 'session-B' })
  const result = await toolScope.withSession('session-B', () => rpc('tools/call', {
    name: 'read', arguments: { value: 'PRIVATE_TOOL_ARGUMENT' },
  }), undefined, { activity })
  assert.notEqual(result.result.isError, true)
  assert.deepEqual(records.map(record => record.event), ['mcp.received', 'mcp.executing', 'mcp.output'])
  assert.equal(new Set(records.map(record => record.requestId)).size, 1)
  assert.equal(new Set(records.map(record => record.callId)).size, 1)
  assert.deepEqual(records[0].argumentsShape.keys, ['value'])
  assert.ok(records[2].outputChars > 0)
  assert.equal(toolScope.activityFor('session-B'), undefined)
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_TOOL_ARGUMENT|executed:session-B/)
})

test('MCP keeps the last bound DSH scope after the web request completes', async (t) => {
  const { rpc, toolScope, records } = await fixture(t)
  await toolScope.withSession('session-B', async () => {})
  await rpc('tools/call', { name: 'read', arguments: { value: 'file' } })
  assert.equal(records[0].agent, 'session-B')
})

test('MCP calls publish native DSH tool history in the active model step', async (t) => {
  const { toolScope, rpc, records, request, idle, declarations } = await fixture(t)
  const abort = new AbortController()
  await request('session-B', 4, 2, abort.signal)
  await toolScope.withSession('session-B', () => rpc('tools/call', { name: 'read', arguments: { value: 'file' } }))
  assert.deepEqual(records[0].log, { turn: 4, step: 2 })
  assert.equal(records[0].signal, abort.signal)
  assert.match(records[0].calls[0].id, /^wb_mcp_/)
  assert.equal(records.length, 1)
  assert.equal(declarations.length, 1)
  assert.equal(declarations[0].type, 'assistant/message')
  assert.equal(declarations[0].options.surfaceOp, 'append')
  assert.equal(declarations[0].data.stream.at(-1).chunk.reason.kind, 'tool-use')
  idle('session-B')
  await rpc('tools/call', { name: 'read', arguments: { value: 'file' } })
  assert.equal(records[1].log, undefined)
})

test('concurrent web requests cannot silently select the wrong DSH scope', async (t) => {
  const { toolScope } = await fixture(t)
  await toolScope.withSession('session-A', () => toolScope.withSession('session-B', () =>
    assert.rejects(toolScope.execute('read', {}), (error) => error.code === 'ambiguous-tool-scope')))
})

test('a native connector cannot recursively navigate the browser serving its request', async (t) => {
  const { rpc, toolScope } = await fixture(t)
  const outcome = await toolScope.withSession('session-B', () => rpc('tools/call', { name: 'webbridge_agent', arguments: { task: 'create a file' } }))
  assert.equal(outcome.result.isError, true)
  assert.match(outcome.result.content[0].text, /browser-busy/)
})

test('two active web sessions still block recursive browser calls when their single activeSessionId is null', async (t) => {
  const { rpc, toolScope } = await fixture(t)
  await toolScope.withSession('session-A', () => toolScope.withSession('session-B', async () => {
    for (const name of ['webbridge_agent', 'webbridge_ask', 'webbridge_send', 'webbridge_open', 'webbridge_browser', 'webbridge_debug_mode']) {
      const outcome = await rpc('tools/call', { name, arguments: {} })
      assert.equal(outcome.result.isError, true)
      assert.match(outcome.result.content[0].text, /browser-busy/)
    }
  }))
})

test('read-only browser diagnostics remain available during active conversations', async t => {
  const { rpc, toolScope } = await fixture(t)
  await toolScope.withSession('session-A', async () => {
    for (const action of ['pages', 'console', 'network', 'debug']) {
      const result = (await rpc('tools/call', { name: 'webbridge_browser', arguments: { action } })).result
      assert.notEqual(result.isError, true)
      assert.equal(JSON.parse(result.content[0].text).action, action)
    }
    const blocked = (await rpc('tools/call', { name: 'webbridge_browser', arguments: { action: 'click' } })).result
    assert.equal(blocked.isError, true)
    assert.match(blocked.content[0].text, /browser-busy/)
  })
})

test('explicit exclusions still apply to an otherwise complete MCP catalog', async (t) => {
  const { rpc } = await fixture(t, { allowTools: ['*', '!pwsh'] })
  const names = (await rpc('tools/list')).result.tools.map((tool) => tool.name)
  assert.ok(names.includes('write'))
  assert.ok(!names.includes('pwsh'))
  assert.equal((await rpc('tools/call', { name: 'pwsh', arguments: {} })).result.isError, true)
})

test('the tunnel op validates input and routes through the bound setup instance', async () => {
  const ops = createOps({ settings: {}, driver: {}, session: {} })
  await assert.rejects(ops.tunnel({ action: 'nope', tunnelId: 'tunnel_x' }), /save 或 connect/)
  await assert.rejects(ops.tunnel({ action: 'save' }), /tunnelId/)
  await assert.rejects(ops.tunnel({ action: 'save', tunnelId: 'tunnel_x' }), /尚未就绪/)
  const received = []
  ops.bindSetup({ execute: command => { received.push(command); return { job: { busy: false }, tunnel: { status: 'configured' } } } })
  const state = await ops.tunnel({ action: 'save', tunnelId: ' tunnel_abc123 ', runtimeApiKey: 'sk-test' })
  assert.equal(received.length, 1)
  assert.equal(received[0].action, 'save')
  assert.equal(received[0].tunnelId, 'tunnel_abc123')
  assert.equal(received[0].runtimeApiKey, 'sk-test')
  assert.equal(state.tunnel.status, 'configured')
  // Omitting the key keeps the saved one: the command carries no runtimeApiKey.
  await ops.tunnel({ action: 'save', tunnelId: 'tunnel_abc123' })
  assert.equal('runtimeApiKey' in received[1], false)
})
