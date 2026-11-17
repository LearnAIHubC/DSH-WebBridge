import http from 'node:http'
import crypto from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { BridgeError } from './envelope.js'
import { dslToJsonSchema } from './tool.js'
import { CONTEXT_TOOL_NAME, CONTEXT_INSTRUCTIONS } from './context.js'

const LEGACY_PROTOCOL_VERSION = '2025-06-18'
const MODERN_PROTOCOL_VERSION = '2026-07-28'
const ROUTE_CONTEXT_ARGUMENT = 'dsh_context_id'
const MAX_BODY = 4 * 1024 * 1024

/**
 * Mode B: a small Streamable-HTTP MCP server that lets a web-hosted model call
 * DSH back.
 *
 * Security choices are copied from Nexus, because this is the same threat: a
 * public HTTPS endpoint that executes local capabilities.
 *   - loopback bind by default; Host allowlist against DNS rebinding
 *   - bearer token compared in constant time, stored 0600 outside the package
 *   - an explicit tool allowlist; everything else is refused
 *   - execution goes through ctx.tools.execute(), so DSH policy and approval
 *     still decide 鈥?this server never calls a tool body directly
 */
export class McpBridge {
  constructor({ ctx, settings, ops, log, toolScope, contextStore }) {
    this.ctx = ctx
    this.settings = settings
    this.ops = ops
    this.log = log || (() => {})
    this.toolScope = toolScope ?? null
    this.contextStore = contextStore ?? null
    this.server = null
    this.sessions = new Map()
    this.token = ''
    this.hits = []
    this.definitions = [
      {
        name: 'webbridge_ask',
        description: 'Send one message to the local signed-in web chat and wait for the complete reply.',
        parameters: {
          message: { type: 'string', required: true, description: 'Message to type into the chat input.' },
          site: { type: 'string', description: 'Site key: chatgpt or deepseek.' },
          timeoutMs: { type: 'number', description: 'Optional reply wait budget in milliseconds. Zero means unlimited (default).' },
        },
      },
      {
        name: 'webbridge_send',
        description: 'Send one message without waiting for the reply.',
        parameters: {
          message: { type: 'string', required: true, description: 'Message to type into the chat input.' },
          site: { type: 'string', description: 'Site key.' },
        },
      },
      {
        name: 'webbridge_read',
        description: 'Read the current last assistant reply without sending anything.',
        parameters: { site: { type: 'string', description: 'Site key.' } },
      },
      {
        name: 'webbridge_status',
        description: 'Report browser driver, daemon, site, adapter and MCP status.',
        parameters: {},
      },
      {
        name: 'webbridge_open',
        description: 'Open the web chat site and report whether sign-in is required.',
        parameters: {
          site: { type: 'string', description: 'Site key.' },
          url: { type: 'string', description: 'Explicit URL.' },
          headed: { type: 'boolean', description: 'Show the browser window.' },
        },
      },
    ]

    if (settings.mcp?.exposeAgent) {
      this.definitions.push({
        name: 'webbridge_agent',
        description:
          'Let the web chat model work on a task by calling listed DSH tools. Executes each call through the DSH registry, so policy and approval still apply.',
        parameters: {
          task: { type: 'string', required: true, description: 'Task for the web model.' },
          tools: { type: 'array', items: { type: 'string' }, description: 'Authorized DSH tool names.' },
          maxTurns: { type: 'number', description: 'Maximum model turns.' },
        },
      })
    }
  }

  get running() {
    return Boolean(this.server)
  }

  catalog(sessionId) { return this.#toolList(sessionId) }

  get instructions() { return this.contextStore ? CONTEXT_INSTRUCTIONS : '' }

  get loopbackUrl() {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  async start() {
    if (this.server) return this.status()
    this.port = this.settings.mcp?.port === 0 ? 0 : Number(this.settings.mcp?.port) || 17877
    this.token = this.#ensureToken()
    this.server = http.createServer((req, res) => {
      this.#handle(req, res).catch((err) => {
        this.#json(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32603, message: err.message } })
      })
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', resolve)
    })
    this.port = this.server.address().port
    this.log(`[webbridge] MCP listening on ${this.loopbackUrl}`)
    return this.status()
  }

  async stop() {
    if (!this.server) return { running: false }
    await new Promise((resolve) => this.server.close(resolve))
    this.server = null
    return { running: false }
  }

  status() {
    return {
      running: Boolean(this.server),
      url: this.loopbackUrl,
      tokenHint: this.token ? `${this.token.slice(0, 4)}鈥?{this.token.slice(-4)}` : '',
      tokenFile: this.#tokenFile(),
      allowTools: this.settings.mcp?.allowTools ?? [],
      exposed: {
        webbridge: this.definitions.map((d) => d.name),
        dsh: this.#allowedDshSchemas().map((s) => s.name),
      },
    }
  }

  /** Clear hosted MCP routing that still points at one DSH session. */
  resetSessionBinding(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) throw new BridgeError('session-required', '同步 MCP 会话需要当前 DSH sessionId。')
    let reset = 0
    for (const session of this.sessions.values()) {
      if (String(session.dshSessionId || '') !== id) continue
      session.dshSessionId = null
      session.contextId = null
      session.lastActive = Date.now()
      reset++
    }
    return { sessionId: id, bindingsReset: reset }
  }

  // ------------------------------------------------------------- internals --

  #tokenFile() {
    return join(this.settings.stateDir, 'mcp-token.key')
  }

  #ensureToken() {
    const configured = String(this.settings.mcp?.token || '').trim()
    if (configured) return configured
    const file = this.#tokenFile()
    try {
      if (existsSync(file)) {
        const saved = readFileSync(file, 'utf8').trim()
        if (saved) return saved
      }
    } catch {}
    const token = `wbr_${crypto.randomBytes(32).toString('hex')}`
    try {
      mkdirSync(this.settings.stateDir, { recursive: true })
      writeFileSync(file, token, { mode: 0o600 })
    } catch (err) {
      this.log(`[webbridge] could not persist MCP token: ${err.message}`)
    }
    return token
  }

  #hostAllowed(req) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase()
    const base = ['127.0.0.1', 'localhost', '[::1]', '::1']
    const extra = (this.settings.mcp?.allowedHosts ?? []).map((h) => String(h).toLowerCase())
    if ([...base, ...extra].includes(host)) return true
    // Tunnel domains rotate. A wildcard entry such as "*.lhr.life" keeps the
    // allowlist meaningful without editing config on every restart. A leading
    // "*." means "any subdomain depth", which is what tunnel providers issue
    // (e.g. bc2127a2626da6.app.lhr.life).
    return extra.some((rule) => {
      if (!rule.includes('*')) return false
      if (rule.startsWith('*.')) {
        const suffix = rule.slice(2)
        return host === suffix || host.endsWith(`.${suffix}`)
      }
      const pattern = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      return new RegExp(`^${pattern}$`).test(host)
    })
  }

  #authorized(req, pathToken = '') {
    if (!this.#hostAllowed(req)) return false
    let provided = String(pathToken || '')
    const auth = String(req.headers.authorization || '')
    if (!provided && auth.toLowerCase().startsWith('bearer ')) provided = auth.slice(7).trim()
    if (!provided) {
      // Hosted chat connectors often cannot set request headers. Accept the
      // same secret as a query parameter so the URL itself carries the key.
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        provided = (url.searchParams.get('key') || url.searchParams.get('token') || '').trim()
      } catch {}
    }
    if (!provided) return false
    const expected = this.token
    const a = Buffer.from(provided)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  }

  #rateLimited() {
    const now = Date.now()
    this.hits = this.hits.filter((at) => now - at < 60_000)
    const limit = Number(this.settings.mcp?.requestsPerMinute) || 60
    if (this.hits.length >= limit) return true
    this.hits.push(now)
    return false
  }

  #cors(res) {
    res.setHeader('access-control-allow-origin', '*')
    res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader(
      'access-control-allow-headers',
      'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id',
    )
    res.setHeader(
      'access-control-expose-headers',
      'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version, Content-Type',
    )
  }

  #json(res, status, body, headers = {}) {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      ...headers,
    })
    res.end(payload)
  }

  #rpcError(res, id, code, message) {
    this.#json(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  }

  /** Session id from the header or the query, mirroring Nexus bridge behaviour. */
  #incomingSession(req) {
    const header = req.headers['mcp-session-id']
    if (header) return String(header)
    try {
      const url = new URL(req.url || '/', 'http://localhost')
      return url.searchParams.get('sessionId') || url.searchParams.get('mcpSessionId') || null
    } catch {
      return null
    }
  }

  #requestProtocolVersion(req, message) {
    const header = req.headers['mcp-protocol-version']
    if (header) return String(header)
    const meta = message?.params?._meta
    return typeof meta?.['io.modelcontextprotocol/protocolVersion'] === 'string'
      ? meta['io.modelcontextprotocol/protocolVersion']
      : null
  }

  #modernResult(result, { cacheable = false } = {}) {
    return {
      ...result,
      ...(cacheable ? { ttlMs: 0, cacheScope: 'private' } : {}),
      resultType: result?.resultType || 'complete',
      _meta: {
        ...(result?._meta || {}),
        'io.modelcontextprotocol/serverInfo': {
          name: 'dsh-webbridge',
          version: this.settings.version || '0.2.0',
        },
      },
    }
  }

  #newSession() {
    const id = `wbs_${crypto.randomUUID()}`
    this.sessions.set(id, {
      id,
      createdAt: Date.now(),
      lastActive: Date.now(),
      dshSessionId: null,
      contextId: null,
    })
    // Bound the map: a hosted connector reconnecting forever must not leak.
    if (this.sessions.size > 64) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastActive - b.lastActive)[0]
      if (oldest) this.sessions.delete(oldest.id)
    }
    return id
  }

  #boundDshSession(mcpSessionId) {
    if (!mcpSessionId) return null
    return this.sessions.get(String(mcpSessionId))?.dshSessionId || null
  }

  #bindContextSession(mcpSessionId, contextId) {
    if (!this.contextStore || typeof contextId !== 'string' || !contextId) return this.#boundDshSession(mcpSessionId)
    const dshSessionId = this.contextStore.sessionFor(contextId)
    const session = mcpSessionId ? this.sessions.get(String(mcpSessionId)) : null
    if (session) {
      session.dshSessionId = dshSessionId
      session.contextId = contextId
      session.lastActive = Date.now()
    }
    return dshSessionId
  }

  /**
   * Short-lived SSE stream: valid headers and one comment, then it closes.
   * Long enough to look like a working stream, short enough that a validation
   * probe cannot sit on it waiting for a notification that will never come.
   */
  #sseShort(res, sessionId) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    })
    try {
      res.write(': connected\n\n')
    } catch {}
    const timer = setTimeout(() => {
      try {
        res.end()
      } catch {}
    }, 3000)
    res.on('close', () => clearTimeout(timer))
    return undefined
  }

  /** Open an SSE stream so a client that asks for one does not hang or error. */
  #sse(res, sessionId) {    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    })
    try {
      res.write(': connected\n\n')
    } catch {}
    const timer = setInterval(() => {
      try {
        res.write(': ping\n\n')
      } catch {}
    }, 15000)
    res.on('close', () => clearInterval(timer))
    return undefined
  }

  async #handle(req, res) {
    this.#cors(res)
    // Entry log: tells us whether a hosted validator ever reaches us at all,
    // and with what method/User-Agent. Without it a silent UI failure is
    // indistinguishable from a network block.
    try {
      mkdirSync(this.settings.stateDir, { recursive: true })
      appendFileSync(
        join(this.settings.stateDir, 'mcp.log'),
        `${new Date().toISOString()} REQ ${req.method} host=${req.headers.host || '-'} ua=${String(req.headers['user-agent'] || '-').slice(0, 80)}\n`,
        'utf8',
      )
    } catch {}
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    // Connectors may normalise away the query string, so the token is also
    // accepted as a path segment: /mcp/<token>.
    let pathToken = ''
    if (url.pathname.startsWith('/mcp/')) {
      pathToken = decodeURIComponent(url.pathname.slice('/mcp/'.length)).replace(/\/+$/, '')
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }

    if (url.pathname === '/health') {
      return this.#json(res, 200, {
        ok: true,
        server: 'dsh-webbridge',
        version: this.settings.version || '0.2.0',
        sessions: this.sessions.size,
        tools: this.#toolList().length,
      })
    }

    if (url.pathname !== '/mcp' && !url.pathname.startsWith('/mcp/')) {
      return this.#json(res, 404, { error: 'not-found', hint: 'POST /mcp' })
    }

    if (req.method === 'DELETE') {
      if (this.#requestProtocolVersion(req) === MODERN_PROTOCOL_VERSION) {
        res.setHeader('allow', 'POST, OPTIONS')
        return this.#json(res, 405, { error: 'method-not-allowed' })
      }
      const sid = this.#incomingSession(req)
      if (sid && this.sessions.has(sid)) this.sessions.delete(sid)
      res.writeHead(204, sid ? { 'mcp-session-id': sid } : {}).end()
      return
    }

    if (req.method === 'GET') {
      if (this.#requestProtocolVersion(req) === MODERN_PROTOCOL_VERSION) {
        res.setHeader('allow', 'POST, OPTIONS')
        return this.#json(res, 405, { error: 'method-not-allowed' })
      }
      if (!this.#authorized(req, pathToken)) {
        return this.#json(res, 401, { error: 'UNAUTHORIZED' }, { 'www-authenticate': 'Bearer realm="dsh-webbridge"' })
      }
      // Hosted validators open the SSE stream right before tools/list. A 405
      // makes some of them abort, while an endless stream makes them time out;
      // answer with a short, well-formed stream that closes on its own.
      const sid = this.#incomingSession(req)
      return this.#sseShort(res, sid)
    }

    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST, GET, DELETE, OPTIONS')
      return this.#json(res, 405, { error: 'method-not-allowed' })
    }

    if (!this.#hostAllowed(req)) {
      return this.#json(res, 403, { error: 'HOST_NOT_ALLOWED' })
    }
    if (!this.#authorized(req, pathToken)) {
      return this.#json(res, 401, { error: 'UNAUTHORIZED' }, { 'www-authenticate': 'Bearer realm="dsh-webbridge"' })
    }
    if (this.#rateLimited()) {
      return this.#json(res, 429, { error: 'rate-limited' })
    }

    const body = await readBody(req)
    if (!body) return this.#json(res, 400, { error: 'empty-body' })
    let message
    try {
      message = JSON.parse(body)
    } catch {
      return this.#json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    }

    const id = message.id ?? null
    try {
      appendFileSync(
        join(this.settings.stateDir, 'mcp.log'),
        `${new Date().toISOString()} RPC ${String(message.method || '-')} id=${String(id ?? '-').slice(0, 12)} ua=${String(req.headers['user-agent'] || '-').slice(0, 40)}\n`,
        'utf8',
      )
    } catch {}
    const incoming = this.#incomingSession(req)
    const requestedProtocol = this.#requestProtocolVersion(req, message)
    const modern = message.method === 'server/discover' || requestedProtocol === MODERN_PROTOCOL_VERSION

    // Legacy clients may opt into a stateful Streamable-HTTP session. Modern
    // 2026-07-28 requests are intentionally stateless and never mint or echo it.
    const sessionId = modern
      ? null
      : message.method === 'initialize'
        ? this.#newSession()
        : incoming && this.sessions.has(incoming)
          ? (this.sessions.get(incoming).lastActive = Date.now(), incoming)
          : incoming || null

    const respond = (status, payload) =>
      this.#json(res, status, payload, !modern && sessionId ? { 'mcp-session-id': sessionId } : {})
    const result = (value, options) => modern ? this.#modernResult(value, options) : value

    try {
      switch (message.method) {
        case 'initialize':
          return respond(200, {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: message.params?.protocolVersion || LEGACY_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'dsh-webbridge', version: this.settings.version || '0.2.0' },
              ...(this.instructions ? { instructions: this.instructions } : {}),
            },
          })
        case 'notifications/initialized':
        case 'notifications/cancelled':
          res.writeHead(202, !modern && sessionId ? { 'mcp-session-id': sessionId } : {}).end()
          return
        case 'ping':
          return respond(200, { jsonrpc: '2.0', id, result: result({}) })
        case 'server/discover':
          return respond(200, {
            jsonrpc: '2.0',
            id,
            result: this.#modernResult({
              supportedVersions: [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION],
              capabilities: { tools: { listChanged: false } },
              ...(this.instructions ? { instructions: this.instructions } : {}),
            }, { cacheable: true }),
          })
        case 'tools/list':
          return respond(200, {
            jsonrpc: '2.0',
            id,
            result: result({ tools: this.#toolList(this.#boundDshSession(sessionId)) }, { cacheable: true }),
          })
        case 'tools/call':
          return respond(200, {
            jsonrpc: '2.0',
            id,
            result: result(await this.#call(message.params || {}, sessionId)),
          })
        default:
          return respond(200, { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } })
      }
    } catch (err) {
      return respond(200, { jsonrpc: '2.0', id, error: { code: -32603, message: String(err.message || err) } })
    }
  }

  #allowedDshSchemas(sessionId) {
    const allow = this.settings.mcp?.allowTools ?? []
    if (!Array.isArray(allow) || allow.length === 0) return []
    let schemas = []
    try {
      schemas = (this.toolScope ? this.toolScope.schemas(sessionId) : this.ctx.tools.schemas()) || []
    } catch (err) {
      this.log(`[webbridge] tool schema lookup failed: ${err.message}`)
      return []
    }

    // Dynamic by design: the DSH registry is re-read on every request, so tools
    // that appear or disappear (agent scopes come and go) are reflected at once.
    // Rules are include patterns plus `!` exclusions; "*" means "whatever DSH
    // currently exposes".
    const includes = allow.filter((rule) => !String(rule).startsWith('!'))
    const excludes = allow.filter((rule) => String(rule).startsWith('!')).map((rule) => String(rule).slice(1))
    const matches = (rule, name) =>
      rule === '*' || rule === name || (String(rule).endsWith('*') && name.startsWith(String(rule).slice(0, -1)))

    return schemas
      .filter((schema) => {
        const name = schema.name
        if (excludes.some((rule) => matches(rule, name))) return false
        return includes.some((rule) => matches(rule, name))
      })
  }

  #toolList(sessionId) {
    const local = this.definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: dslToJsonSchema(definition.parameters),
    }))
    const remote = this.#allowedDshSchemas(sessionId).map((schema) => {
      const inputSchema = dslToJsonSchema(schema.parameters || {})
      const routedSchema = schema.name === CONTEXT_TOOL_NAME ? inputSchema : {
        ...inputSchema,
        properties: {
          ...(inputSchema.properties || {}),
          [ROUTE_CONTEXT_ARGUMENT]: {
            type: 'string',
            description: 'Opaque DSH routing handle. Pass the current context_id from dsh_get_context. MCP removes this field before the DSH tool executes; required when the client has no legacy MCP session binding.',
          },
        },
      }
      return {
        name: schema.name,
        description: schema.description,
        inputSchema: routedSchema,
        ...(schema.name === CONTEXT_TOOL_NAME && this.contextStore
          ? { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }
          : schema.annotations ? { annotations: schema.annotations } : {}),
      }
    })
    const seen = new Set()
    return [...local, ...remote].filter((tool) => {
      // The registry may contain webbridge_agent even when the connector is
      // deliberately not allowed to start another browser agent loop.
      if (tool.name === 'webbridge_agent' && !this.settings.mcp?.exposeAgent) return false
      if (seen.has(tool.name)) return false
      seen.add(tool.name)
      return true
    })
  }

  async #call(params, mcpSessionId) {
    const name = String(params.name || '')
    let args = params.arguments
    if (typeof args === 'string') {
      // Hosted clients sometimes send arguments as a JSON string.
      try {
        args = JSON.parse(args)
      } catch {
        args = {}
      }
    }
    if (!args || typeof args !== 'object') args = {}
    // The context reference is the routing authority. Legacy MCP connections
    // remember it after bootstrap; stateless 2026-07-28 callers pass the same
    // handle back as dsh_context_id. Strip that transport-only field before any
    // DSH schema, policy, history, or executor sees the business arguments.
    let routeContextId = null
    if (name !== CONTEXT_TOOL_NAME && Object.hasOwn(args, ROUTE_CONTEXT_ARGUMENT)) {
      routeContextId = typeof args[ROUTE_CONTEXT_ARGUMENT] === 'string' ? args[ROUTE_CONTEXT_ARGUMENT] : ''
      args = { ...args }
      delete args[ROUTE_CONTEXT_ARGUMENT]
    }
    let routedSessionId = this.#boundDshSession(mcpSessionId)
    const started = Date.now()
    try {
      if (name === CONTEXT_TOOL_NAME && typeof args.context_id === 'string') {
        routeContextId = args.context_id
        routedSessionId = this.#bindContextSession(mcpSessionId, routeContextId)
      } else if (routeContextId) {
        routedSessionId = this.#bindContextSession(mcpSessionId, routeContextId)
      }
      const readOnlyDebug = name === 'webbridge_browser' && ['console', 'network', 'debug', 'pages'].includes(args.action)
      if (!readOnlyDebug && (this.toolScope?.hasActiveRequests || this.toolScope?.activeSessionId) && ['webbridge_agent', 'webbridge_ask', 'webbridge_send', 'webbridge_open', 'webbridge_new_chat', 'webbridge_browser', 'webbridge_debug_mode'].includes(name)) {
        throw new BridgeError('browser-busy', 'This browser is already serving a DSH conversation. Use the exposed DSH tools directly for local operations.')
      }
      if (name.startsWith('webbridge_')) {
        if (name === 'webbridge_agent') {
          if (!this.settings.mcp?.exposeAgent) {
            throw new BridgeError('tool-not-allowed', 'webbridge_agent is disabled over MCP')
          }
          const data = await this.ops.runAgentTask(args)
          this.#logCall(name, started, true)
          return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
        }
        const op = name.slice('webbridge_'.length)
        const fn = this.ops[op]
        if (typeof fn !== 'function') throw new BridgeError('unknown-tool', `Unknown tool "${name}"`)
        const data = await fn(args, undefined)
        this.#logCall(name, started, true)
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      }

      if (this.toolScope?.hasActiveRequests && routedSessionId && !this.toolScope.isSessionActive?.(routedSessionId)) {
        if (this.toolScope.activeSessionId) {
          throw new BridgeError('context-request-mismatch', 'Use the context_id supplied with the currently active DSH request.')
        }
        throw new BridgeError('context-session-inactive', 'The MCP context belongs to a DSH session that is not serving this web request.')
      }
      if (this.toolScope?.hasActiveRequests && !routedSessionId && !this.toolScope.activeSessionId) {
        throw new BridgeError('ambiguous-tool-scope', 'More than one DSH session is active. Initialize this MCP connection with the current DSH context before calling DSH tools.')
      }
      if (!this.#allowedDshSchemas(routedSessionId).some((schema) => schema.name === name)) {
        throw new BridgeError('tool-not-allowed', `Tool "${name}" is not in the MCP allowlist`)
      }
      // Executes through the registry that owns the tool: DSH allow/deny/ask
      // policy still applies. `signal` is mandatory for the executor.
      if (!this.toolScope) {
        throw new BridgeError('tool-scope-unavailable', 'The DSH tool scope is not available')
      }
      const activeSession = routedSessionId || this.toolScope.activeSessionId
      if (this.contextStore && activeSession) {
        if (this.toolScope.hasContextCheckpoint?.(activeSession)) {
          throw new BridgeError('context-checkpoint-required', this.toolScope.contextCheckpointMessage?.(activeSession) || 'The preceding tool already completed. End this web response now; DSH will automatically continue after refreshing project instructions at its real step boundary. Do not repeat the completed tool or read the stale context snapshot.')
        }
        // Bind the gate to the snapshot this routed web request was actually
        // given. Other concurrent DSH sessions cannot make this ambiguous.
        const reference = this.toolScope.contextReferenceFor?.(activeSession) || this.toolScope.activeContextReference
        if (reference && routeContextId && routeContextId !== reference.context_id) {
          throw new BridgeError('context-request-mismatch', 'Use the context_id supplied with the currently active DSH request.')
        }
        if (reference && name !== CONTEXT_TOOL_NAME && !this.contextStore.isDelivered(reference.context_id)) {
          throw new BridgeError('context-required', `Read every page of ${CONTEXT_TOOL_NAME} with context_id=${JSON.stringify(reference.context_id)} before using DSH tools. Project paths and effective instructions are in that result.`)
        }
      }
      const outcome = await this.toolScope.execute(name, args, undefined, routedSessionId ? { sessionId: routedSessionId } : undefined)
      this.#logCall(name, started, outcome.ok)
      if (!outcome.ok) {
        return { content: [{ type: 'text', text: outcome.body || 'tool failed' }], isError: true }
      }
      return { content: [{ type: 'text', text: outcome.body }] }
    } catch (err) {
      this.#logCall(name, started, false, `${err.code || 'error'}: ${err.message}`)
      return {
        content: [{ type: 'text', text: `${err.code || 'error'}: ${err.message || String(err)}` }],
        isError: true,
      }
    }
  }

  /** Append one line per tool call so a hosted-client failure is diagnosable. */
  #logCall(name, started, ok, error) {
    try {
      mkdirSync(this.settings.stateDir, { recursive: true })
      appendFileSync(
        join(this.settings.stateDir, 'mcp.log'),
        `${new Date().toISOString()} ${ok ? 'ok  ' : 'FAIL'} ${name} ${Date.now() - started}ms${error ? ` ${error}` : ''}\n`,
        'utf8',
      )
    } catch {}
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
