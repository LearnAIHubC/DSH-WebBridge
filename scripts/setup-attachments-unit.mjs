import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tunnelCommand, normalizeProxy, pollMetrics, TunnelSupervisor, controlPlaneAuthFailure } from '../src/tunnel.js'
import { SecretVault } from '../src/vault.js'
import { BrowserDriver } from '../src/driver.js'
import { createToolScope, nativeToolDeclaration } from '../src/dsh.js'
import { WebChatAdapter } from '../src/provider.js'
import { WebBridgeSetup } from '../src/setup.js'
import { SetupBrowser } from '../src/setup-browser.js'
import { mentionedFiles, uploadProblem } from '../src/attachments.js'

test('Nexus tunnel arguments keep both secrets out of argv and proxy only control-plane traffic', () => {
  const spec = tunnelCommand({ tunnelId: 'tunnel_test', runtimeApiKey: 'test-runtime-secret', healthPort: 18484 }, {
    runtimePath: 'C:/runtime/tunnel-client-runtime-cloudflared.exe', mcpUrl: 'http://127.0.0.1:17877/mcp', mcpToken: 'test-local-secret', proxy: 'http://127.0.0.1:7897',
    env: { HTTP_PROXY: 'http://wrong-proxy', https_proxy: 'http://wrong-proxy', ALL_PROXY: 'http://wrong-proxy', CONTROL_PLANE_HTTP_PROXY: 'http://wrong-proxy' },
  })
  assert.ok(!spec.args.join(' ').includes('test-runtime-secret'))
  assert.ok(!spec.args.join(' ').includes('test-local-secret'))
  assert.ok(spec.args.includes('--harpoon.additional-transport=http-streamable'))
  assert.equal(spec.options.env.CONTROL_PLANE_API_KEY, 'test-runtime-secret')
  assert.equal(spec.options.env.LOCALBRIDGE_MCP_AUTH, 'Bearer test-local-secret')
  assert.equal(spec.options.env.NO_PROXY, '127.0.0.1,localhost,::1')
  assert.equal(spec.options.env.CONTROL_PLANE_HTTP_PROXY, 'http://127.0.0.1:7897')
  assert.equal(spec.options.env.HTTP_PROXY, undefined)
  assert.equal(spec.options.env.https_proxy, undefined)
  assert.equal(spec.options.windowsHide, true)
})

test('system proxy mapping matches Nexus and rejects embedded credentials', () => {
  assert.equal(normalizeProxy('http=127.0.0.1:1234;https=127.0.0.1:7897'), 'http://127.0.0.1:7897')
  assert.throws(() => normalizeProxy('http://user:secret@localhost:8080'))
  assert.throws(() => normalizeProxy('http://localhost:8080/path'))
})

test('official runtime metrics accept scientific notation and OpenTelemetry labels', () => {
  assert.deepEqual(pollMetrics('commands_poll_last_successful_timestamp_seconds{otel_scope_name="controlplane"} 1.794889714e+09\ncommands_poll_errors_total{error="true"} 3'), { lastPoll: 1794889714, pollErrors: 3 })
})

test('local MCP OAuth 401/403 warnings do not falsely disconnect the OpenAI tunnel', () => {
  assert.equal(controlPlaneAuthFailure('component=oauth msg="OAuth discovery failed" error="status 401"'), false)
  assert.equal(controlPlaneAuthFailure('component=mcpclient error="HTTP 403 forbidden"'), false)
  assert.equal(controlPlaneAuthFailure('component=controlplane error="HTTP 401 unauthorized"'), true)
  assert.equal(controlPlaneAuthFailure('component=controlplane error="HTTP 403 permission denied"'), true)
})

test('expired test credentials stop before starting the runtime', async () => {
  const supervisor = new TunnelSupervisor({ settings: {}, bridge: {}, vault: {}, spawnProcess: () => { throw new Error('must not spawn') } })
  supervisor.config = { tunnelId: 'tunnel_test', runtimeApiKey: 'private-test-value', keyExpiresAt: '2000-01-01T00:00:00Z', autoReconnect: true }
  await assert.rejects(() => supervisor.start(), /过期/)
  assert.equal(supervisor.status().status, 'authentication-error')
  assert.equal(supervisor.desired, false)
  assert.ok(!JSON.stringify(supervisor.status()).includes('private-test-value'))
  await supervisor.stop()
})

test('reusing a tunnel configuration preserves the live connection; replacing a key clears its old expiry', async () => {
  let writes = 0
  const supervisor = new TunnelSupervisor({ settings: {}, bridge: {}, vault: { async write() { writes++ } } })
  supervisor.config = { tunnelId: 'tunnel_test', runtimeApiKey: 'old-test-key', healthPort: 18484, networkMode: 'direct', customProxy: '', autoReconnect: true, keyExpiresAt: '2030-01-01T00:00:00Z' }
  supervisor.desired = true; supervisor.state.status = 'connected'
  await supervisor.configure({ tunnelId: 'tunnel_test' })
  assert.equal(supervisor.desired, true)
  assert.equal(supervisor.status().status, 'connected')
  assert.equal(writes, 0)
  await supervisor.configure({ runtimeApiKey: 'replacement-permanent-key' })
  assert.equal(writes, 1)
  assert.equal(supervisor.config.keyExpiresAt, '')
})

test('connection waits pass the actual timeout to BrowserOperator instead of retaining its 15 second default', async () => {
  let args
  const browser = new SetupBrowser({ settings: { stateDir: '.' }, driver: { async run(command, positional) { args = [command, ...positional] } } })
  await browser.wait('button:has-text("连接 Nexus DSH")', 60000)
  assert.deepEqual(args.slice(-2), ['--timeout', '60000'])
})

test('Windows DPAPI storage round trips and never writes plaintext', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-vault-test-'))
  try {
    const path = join(dir, 'config.enc')
    const vault = new SecretVault(path)
    const config = { tunnelId: 'tunnel_test', runtimeApiKey: 'local-unit-test-value-20261117' }
    await vault.write(config)
    assert.deepEqual(await vault.read(), config)
    assert.ok(!(await readFile(path)).includes(Buffer.from(config.runtimeApiKey)))
    await vault.write({ ...config, autoReconnect: false })
    assert.equal((await vault.read()).autoReconnect, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('BrowserDriver serializes each session while allowing different sessions to overlap', async () => {
  const settings = { stateDir: 'C:/temp/webbridge-test' }
  const driver = new BrowserDriver(settings)
  const events = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const first = driver.exclusive(async () => { events.push('A-start'); await gate; events.push('A-end') }, 'session-A')
  const second = driver.exclusive(async () => { events.push('B-start'); events.push('B-end') }, 'session-B')
  const third = driver.exclusive(async () => { events.push('A-next') }, 'session-A')
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(events, ['A-start', 'B-start', 'B-end'])
  release(); await Promise.all([first, second, third])
  assert.deepEqual(events, ['A-start', 'B-start', 'B-end', 'A-end', 'A-next'])
})


test('WebBridge debug mode persists across driver restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-debug-mode-'))
  try {
    const first = new BrowserDriver({ stateDir: dir })
    await first.setDebugMode(true)
    const second = new BrowserDriver({ stateDir: dir })
    await second.loadRegistry()
    assert.equal(second.debugMode, true)
    await second.setDebugMode(false)
    const third = new BrowserDriver({ stateDir: dir })
    await third.loadRegistry()
    assert.equal(third.debugMode, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('startup and mode switches keep saved conversations closed until a task uses them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-lazy-pages-'))
  try {
    const sessions = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`session-${index}`, { url: `https://chatgpt.com/c/saved-${index}` }]))
    await writeFile(join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions }))
    const driver = new BrowserDriver({ stateDir: dir })
    driver.ensureContext = async () => { throw new Error('idle actions must not launch Chrome') }
    assert.deepEqual(await driver.restoreSessions(), { restored: 0, saved: 40 })
    await driver.setDebugMode(true)
    assert.equal(driver.context, null)
    assert.equal(driver.pages.size, 0)
    let closed = 0
    driver.context = { close: async () => { closed++ } }
    await driver.setDebugMode(false)
    assert.equal(closed, 1)
    assert.equal(driver.context, null)
    assert.equal(driver.sessions.size, 40)
    driver.context = { close: async () => { closed++ } }
    driver.lastMode = { headed: true }
    assert.equal((await driver.switchToHeadless()).changed, true)
    assert.equal(closed, 2)
    assert.equal(driver.context, null)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('turning off debug mode while busy closes the visible browser after the active task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-debug-pending-'))
  try {
    const driver = new BrowserDriver({ stateDir: dir })
    driver.debugMode = true
    driver.lastMode = { headed: true }
    let closed = 0
    driver.context = { close: async () => { closed++ } }
    let release
    let markStarted
    const started = new Promise(resolve => { markStarted = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const active = driver.exclusive(async () => { markStarted(); await gate }, 'session-active')
    await started

    const result = await driver.setDebugMode(false)
    assert.equal(result.pending, true)
    assert.equal(driver.debugMode, false)
    assert.equal(driver.headless, false)
    assert.equal(closed, 0)

    release()
    await active
    assert.equal(closed, 1)
    assert.equal(driver.context, null)
    assert.equal(driver.headless, true)
    assert.equal(driver.modeChangePending, false)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('temporary headed mode requested by an active task closes when that task finishes', async () => {
  const driver = new BrowserDriver({ stateDir: '' })
  driver.debugMode = false
  driver.lastMode = { headed: true }
  let closed = 0
  driver.context = { close: async () => { closed++ } }

  await driver.exclusive(async () => {
    const result = await driver.switchToHeadless()
    assert.equal(result.pending, true)
    assert.equal(closed, 0)
  }, 'session-active')

  assert.equal(closed, 1)
  assert.equal(driver.context, null)
  assert.equal(driver.headless, true)
})

test('one task reuses Chrome’s initial blank page and closing it retains its conversation address', async () => {
  const driver = new BrowserDriver({ stateDir: '' })
  let closed = false
  const page = { url: () => 'about:blank', isClosed: () => closed, on() {}, async close() { closed = true } }
  driver.ensureContext = async () => ({ pages: () => [page], newPage: async () => { throw new Error('a second page is unnecessary') } })
  driver.persistRegistry = async () => {}
  assert.equal(await driver.getPageFor('session-A'), page)
  driver.sessions.get('session-A').url = 'https://chatgpt.com/c/saved-A'
  await driver.releasePage('session-A')
  assert.equal(closed, true)
  assert.equal(driver.pages.size, 0)
  assert.equal((await driver.getSessionInfo('session-A')).url, 'https://chatgpt.com/c/saved-A')
})

test('native file upload preserves binary bytes, long text, display names, and cleans staging files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-files-test-'))
  try {
    const source = join(dir, 'sha256-object')
    const bytes = Buffer.from([0, 255, 128, 10, 31])
    await writeFile(source, bytes)
    const driver = new BrowserDriver({ profile: 'upload-test', driverScript: 'test', stateDir: dir })
    let staged
    driver.run = async (command, args) => {
      assert.equal(command, 'upload')
      staged = args.slice(1)
      assert.ok(staged[0].endsWith('原图.png'))
      assert.deepEqual(await readFile(staged[0]), bytes)
      assert.equal((await readFile(staged[1], 'utf8')).length, 60000)
      assert.ok(staged[1].endsWith('context-x1f.txt'), 'ordinary letters and the txt extension must survive sanitizing')
      return { ok: true, files: 2 }
    }
    const uploaded = await driver.attachFiles([{ path: source, name: '原图.png' }, { name: 'context-x1f.txt', content: 'x'.repeat(60000) }])
    await access(staged[0])
    await uploaded.release()
    await assert.rejects(() => access(staged[0]))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('pre-projection attachment references survive DSH file-to-text conversion', async () => {
  const hooks = new Map()
  const attachments = { fileHostPath: ref => `C:/store/${ref.attachmentId}`, imageHostPath: ref => `C:/images/${ref.attachmentId}` }
  const scope = createToolScope({
    inject(names, callback) { if (names.includes('attachments')) callback({ attachments }) },
    on(name, callback) { hooks.set(name, callback) }, tools: { schemas: () => [] },
  })
  hooks.get('llm/stream')({ provider: 'webbridge-chatgpt', sessionId: 'chat-1', messages: [
    { id: 'message-1', role: 'user', content: [{ type: 'file', attachment: { attachmentId: 'file-1', name: 'report.pdf' } }, { type: 'image', attachment: { attachmentId: 'image-1', name: 'cat.png', mediaType: 'image/png' } }] },
  ] }, () => 'next')
  const projected = { id: 'message-1', role: 'user', content: [{ type: 'text', text: '[File report.pdf: saved at ...]' }] }
  assert.equal(scope.hasAttachments('chat-1', projected), true)
  assert.equal(scope.originalMessage('chat-1', projected).content[0].type, 'file')
  assert.deepEqual((await scope.attachmentsFor('chat-1', [projected])).map(file => [file.name, file.path]), [['report.pdf', 'C:/store/file-1'], ['cat.png', 'C:/images/image-1']])
  assert.deepEqual(await scope.attachmentsFor('another-chat', [projected]), [])
})

test('native tool declarations contain only lossless JSON data accepted by DSH append', () => {
  const data = nativeToolDeclaration({ id: 'wb_mcp_test', name: 'read', arguments: '{"file_path":"a.txt"}' }, { turn: 1, step: 1, provider: 'webbridge-chatgpt', model: 'chatgpt-web' })
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data)
  assert.deepEqual(structuredClone(data), data)
})

test('a verified free account advertises thinking and non-thinking models and forwards their selection', async () => {
  const sent = []
  const adapter = new WebChatAdapter({ providerId: 'webbridge-chatgpt', displayName: 'ChatGPT 网页版', modelId: 'chatgpt-web', settings: { site: 'chatgpt', providers: {} }, accountTier: async () => 'free', session: { async ask(text, options) { sent.push(options); return { reply: 'ok' } } } })
  const models = await adapter.listModels('webbridge-chatgpt')
  assert.deepEqual(models.map(model => model.name), ['ChatGPT 网页版（思考）', 'ChatGPT 网页版（非思考）'])
  for await (const chunk of adapter.generate({ sessionId: 'thinking', model: 'chatgpt-web', messages: [{ role: 'user', content: 'hello' }] })) {}
  for await (const chunk of adapter.generate({ sessionId: 'instant', model: 'chatgpt-web-instant', messages: [{ role: 'user', content: 'hello' }] })) {}
  assert.deepEqual(sent.map(options => options.reasoning), ['on', 'off'])
})

test('connecting with saved credentials starts the tunnel and never touches web resources', async () => {
  let created = 0, installed = 0, started = 0
  const config = { tunnelId: 'tunnel_existing', runtimeApiKey: 'existing-secret', autoReconnect: false }
  const tunnel = { config, state: { status: 'connected' }, async load() {}, status: () => ({ configured: true }), async start() { started++ }, async waitReady() {}, async stop() {}, redact: value => value }
  const browser = { saved: {}, auth: {}, async load() {}, async persist() {}, async createResources() { created++ }, async install() { installed++ } }
  const controller = new WebBridgeSetup({ settings: {}, driver: { busy: false, exclusive: fn => fn() }, bridge: { status: () => ({}), catalog: () => [] }, tunnel, browser })
  await controller.initialize()
  controller.execute({ action: 'connect' }); await controller.pending
  controller.execute({ action: 'connect' }); await controller.pending
  assert.equal(created, 0)
  assert.equal(installed, 0)
  assert.equal(started, 2)
  await controller.dispose()
})

test('connecting without credentials explains the manual setup instead of provisioning', async () => {
  let created = 0
  const tunnel = { config: null, state: { status: 'not-configured' }, async load() {}, status: () => ({ configured: false }), async start() {}, async waitReady() {}, async stop() {}, redact: value => value }
  const browser = { saved: {}, auth: {}, async load() {}, async persist() {}, async createResources() { created++ } }
  const controller = new WebBridgeSetup({ settings: {}, driver: { busy: false, exclusive: fn => fn() }, bridge: { status: () => ({}), catalog: () => [] }, tunnel, browser })
  controller.execute({ action: 'connect' }); await controller.pending
  assert.equal(created, 0)
  assert.match(controller.read().job.error, /自行创建/)
  await controller.dispose()
})

test('DSH file mentions upload the selected file, including quoted and unquoted paths with spaces', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wb-mentions-test-'))
  try {
    const path = join(dir, 'selected document.txt')
    await writeFile(path, 'file bytes')
    assert.equal((await mentionedFiles(`@${path} Explain this document.`))[0].path, path)
    assert.equal((await mentionedFiles(`@"${path}" Explain this document.`))[0].mention, `@"${path}"`)
    assert.deepEqual(await mentionedFiles('ordinary@example.com https://example.com'), [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('ChatGPT quota errors retain the real retry time and do not expose conversation text', () => {
  const problem = uploadProblem('Private conversation\n你已达到文件附件数量限制\n升级订阅即可立即添加更多文件，或在 11月18日 0:53 后重试\nprivate tail')
  assert.equal(problem.code, 'attachment-quota-exceeded')
  assert.match(problem.message, /11月18日 0:53 后重试/)
  assert.doesNotMatch(problem.message, /Private|private tail/)
  assert.equal(uploadProblem('因网络问题，上传未成功。').code, 'attachment-upload-failed')
  assert.equal(uploadProblem('Normal reply'), null)
})

test('image-only user turns are sent and continuing turns upload only new attachments', async () => {
  const sent = []
  const toolScope = {
    withSession: (_, operation) => operation(),
    hasAttachments: (_, message) => message.id === 'image-1',
    attachmentsFor: (_, messages) => messages.filter(message => message.id === 'image-1').map(() => ({ name: 'image.png', path: 'C:/image.png' })),
  }
  const adapter = new WebChatAdapter({ providerId: 'webbridge-chatgpt', modelId: 'chatgpt-web', settings: { site: 'chatgpt', providers: {} }, toolScope, session: { async ask(message, options) { sent.push({ message, ...options }); return { reply: 'ok' } } } })
  const image = { id: 'image-1', role: 'user', content: [{ type: 'image', attachment: { name: 'image.png' } }] }
  for await (const chunk of adapter.generate({ sessionId: 'image-only', messages: [image] })) {}
  for await (const chunk of adapter.generate({ sessionId: 'image-only', messages: [image, { role: 'assistant', content: 'old answer' }, { id: 'text-2', role: 'user', content: '第二轮问题' }] })) {}
  assert.equal(sent[0].attachments[0].name, 'image.png')
  assert.ok(sent[0].message.includes('附件'))
  assert.equal(sent[1].attachments, undefined)
  assert.equal(sent[1].message, '用户：第二轮问题')
})

test('connect stores submitted credentials and starts the tunnel without creating anything', async () => {
  let created = 0, started = 0
  const tunnel = {
    config: null, state: { status: 'stopped' },
    status() { return { configured: Boolean(this.config?.runtimeApiKey) } },
    async configure(values) { this.config = { tunnelId: 'tunnel_test', ...values } },
    async start() { started++ }, async waitReady() {}, async stop() {}, redact: value => value,
  }
  const browser = { saved: {}, auth: {}, async load() {}, async persist() {}, async createResources() { created++ } }
  const controller = new WebBridgeSetup({ settings: {}, driver: { exclusive: fn => fn() }, bridge: { status: () => ({}), catalog: () => [] }, tunnel, browser })
  controller.execute({ action: 'connect', tunnelId: 'tunnel_test', runtimeApiKey: 'manual-secret' }); await controller.pending
  assert.equal(created, 0)
  assert.equal(started, 1)
  assert.equal(controller.read().job.error, '')
  await controller.dispose()
})
