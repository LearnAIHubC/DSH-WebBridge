import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { ContextStore } from '../src/context.js'
import { createToolScope } from '../src/dsh.js'
import { McpBridge } from '../src/mcp.js'
import { WebChatAdapter } from '../src/provider.js'
import { WebBridgeSetup } from '../src/setup.js'
import { parseSyncRequest } from '../src/setup-contract.js'

test('sync request accepts only an explicit WebBridge session and provider', () => {
  assert.deepEqual(parseSyncRequest({ sessionId: ' session-A ', provider: 'webbridge-chatgpt' }), {
    sessionId: 'session-A', provider: 'webbridge-chatgpt',
  })
  assert.throws(() => parseSyncRequest({ sessionId: '', provider: 'webbridge-chatgpt' }), /sessionId/)
  assert.throws(() => parseSyncRequest({ sessionId: 'session-A', provider: 'other-provider' }), /不是 WebBridge/)
})

test('provider sync starts a fresh web conversation and drops its incremental cursor', async () => {
  const calls = []
  const adapter = new WebChatAdapter({
    providerId: 'webbridge-chatgpt',
    displayName: 'ChatGPT',
    modelId: 'chatgpt-web',
    settings: { site: 'chatgpt', providers: {} },
    session: {
      async newChat(options) {
        calls.push(options)
        return { conversation: { generation: 'fresh', reset: true } }
      },
    },
  })
  adapter.sessionState.set('session-A', {
    bootstrapped: true, contextDelivered: true, sentMessages: 8,
    sentUserKeys: ['old'], toolContext: 'old', contextReference: { context_id: 'old' },
  })

  const result = await adapter.syncSession('session-A')
  assert.deepEqual(calls, [{ site: 'chatgpt', sessionKey: 'session-A' }])
  assert.equal(adapter.sessionState.has('session-A'), false)
  assert.equal(result.provider, 'webbridge-chatgpt')
  assert.equal(result.conversation.reset, true)
})

test('tool-scope sync reset expires old DSH context and refuses an active request', async () => {
  const contextStore = new ContextStore()
  const listeners = new Map()
  const ctx = {
    inject(services, callback) {
      const available = {
        agents: { list: () => [] },
        attachments: {},
        workingDirectory: {},
      }
      callback(Object.fromEntries(services.map(name => [name, available[name]])))
    },
    on(name, callback) { listeners.set(name, callback) },
    tools: { schemas: () => [] },
  }
  const scope = createToolScope(ctx, () => {}, { contextStore })
  const reference = contextStore.capture({ sessionId: 'session-A', messages: [] })
  assert.equal(contextStore.has(reference.context_id), true)

  await scope.withSession('session-A', async () => {
    assert.throws(() => scope.resetSession('session-A'), error => error.code === 'session-busy')
  })

  const result = scope.resetSession('session-A')
  assert.equal(result.contextCleared, true)
  assert.equal(contextStore.has(reference.context_id), false)
})

test('MCP sync clears only bindings for the selected DSH session', () => {
  const bridge = new McpBridge({
    ctx: { tools: { schemas: () => [] } },
    settings: { stateDir: '', mcp: { allowTools: [] } },
    ops: {},
  })
  bridge.sessions.set('mcp-A', { id: 'mcp-A', dshSessionId: 'session-A', contextId: 'ctx-A', lastActive: 1 })
  bridge.sessions.set('mcp-B', { id: 'mcp-B', dshSessionId: 'session-B', contextId: 'ctx-B', lastActive: 1 })

  const result = bridge.resetSessionBinding('session-A')
  assert.equal(result.bindingsReset, 1)
  assert.equal(bridge.sessions.get('mcp-A').dshSessionId, null)
  assert.equal(bridge.sessions.get('mcp-A').contextId, null)
  assert.equal(bridge.sessions.get('mcp-B').dshSessionId, 'session-B')
})

test('setup sync remote delegates the validated request', async () => {
  const received = []
  const setup = new WebBridgeSetup({
    settings: {},
    driver: {},
    bridge: { status: () => ({ exposed: { dsh: [] } }) },
    tunnel: { status: () => ({}) },
    browser: { auth: {}, saved: {} },
    syncSession: async request => { received.push(request); return { ok: true, ...request } },
  })
  const result = await setup.sync({ sessionId: 'session-A', provider: 'webbridge-chatgpt' })
  assert.deepEqual(received, [{ sessionId: 'session-A', provider: 'webbridge-chatgpt' }])
  assert.equal(result.ok, true)
})

test('client registers the sync control beside the model picker and loads model selection support', async () => {
  const client = await readFile(new URL('../src/client.js', import.meta.url), 'utf8')
  const built = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const source of [client, built]) {
    assert.match(source, /conversation\.input\.right/)
    assert.match(source, /webbridge-session-sync/)
    assert.match(source, /provider\.startsWith\('webbridge-'\)/)
    assert.match(source, /remote\.webbridgeSetup\.sync/)
  }
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-model-selection'))
})

test('built client renders sync only for WebBridge models and routes the current session id', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  let contribution
  runInNewContext(source, { window: { __ModuleLoader__: { load(value) { contribution = value } } } })
  assert.equal(contribution.id, '@local/dsh-webbridge')

  const states = []
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) { return { type, props: props || {}, children } },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useState(initial) { const state = typeof initial === 'function' ? initial() : initial; states.push(state); return [state, () => {}] },
    useEffect(effect) { effect() },
    useRef(value) { return { current: value } },
  }
  const module = contribution.factory(name => {
    if (name === 'react') return React
    throw new Error(`unexpected browser dependency: ${name}`)
  })
  let provider = 'webbridge-chatgpt'
  const syncCalls = []
  const registrations = []
  const store = {
    subscribe() { return () => {} },
    getSnapshot() { return { current: { provider } } },
  }
  const slots = {
    inject(_name, callback) { callback() },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  }
  const uiScope = {
    slots,
    modelDirectories: { directoryFor: () => ({ store, async load() {} }) },
  }
  const remote = {
    $mount: async () => {},
    webbridgeSetup: {
      read: async () => ({ ok: true, value: {} }),
      execute: async () => ({ ok: true, value: {} }),
      debug: async () => ({ ok: true, value: {} }),
      sync: async request => { syncCalls.push(request); return { ok: true, value: { synced: true } } },
    },
  }
  const scope = {
    remote, slots,
    inject(services, callback) { if (services.includes('modelDirectories')) callback(uiScope) },
  }
  const ctx = {
    remote, slots,
    effect(callback) { callback() },
    inject(services, callback) { if (services.includes('remote.webbridgeSetup')) callback(scope) },
  }
  module.apply(ctx)
  const registration = registrations.find(entry => entry.options.id === 'webbridge-session-sync')
  assert.ok(registration)
  assert.equal(registration.options.name, 'conversation.input.right')
  assert.equal(registration.options.order, -1000)

  const props = registration.options.inject('session-current')
  const rendered = registration.component(props)
  assert.ok(rendered)
  const findButton = node => !node || typeof node !== 'object' ? null
    : node.type === 'button' ? node
      : (node.children || []).map(findButton).find(Boolean) || null
  const button = findButton(rendered)
  assert.ok(button)
  assert.equal(button.props['aria-label'], '同步网页会话')
  await button.props.onClick()
  assert.equal(syncCalls.length, 1)
  assert.equal(syncCalls[0].sessionId, 'session-current')
  assert.equal(syncCalls[0].provider, 'webbridge-chatgpt')

  provider = 'other-provider'
  assert.equal(registration.component(props), null)
})
