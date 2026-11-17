/**
 * dsh-webbridge — drive a signed-in web chat from DSH, and let a web-hosted
 * model call DSH back over MCP.
 *
 * Surfaces:
 *   - DSH tools: webbridge_* (M1)
 *   - MCP endpoint: http://127.0.0.1:<port>/mcp, Bearer token (M4)
 *
 * Everything the tools do lives in src/ops.js so the MCP server and the DSH
 * tools cannot drift apart. Browser control is owned by WebBridge's native
 * Playwright driver; BrowserOperator and its Codex profile remain untouched.
 */
import { resolveSettings, ensureDirs } from './src/config.js'
import { BrowserDriver } from './src/driver.js'
import { ChatSession } from './src/session.js'
import { createOps } from './src/ops.js'
import { McpBridge } from './src/mcp.js'
import { defineTool } from './src/tool.js'
import { ok, toFailure, auditRecord, BridgeError } from './src/envelope.js'
import { runAgentLoop, createMetaTools, parseReply } from './src/agent.js'
import { writeActivation } from './src/activation.js'
import { createToolScope } from './src/dsh.js'
import { WebChatAdapter } from './src/provider.js'
import { WebBridgeSetup, mountSetupService } from './src/setup.js'
import { ChatgptModels } from './src/chatgpt-models.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-webbridge'
export const inject = ['tools']

const VERSION = '0.2.2'

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

const TOOLS = [
  {
    name: 'webbridge_status',
    op: 'status',
    description:
      'Report the web chat bridge state: browser driver availability, daemon state, active site and profile, adapter calibration, and whether the MCP endpoint is running.',
    parameters: {},
  },
  {
    name: 'webbridge_open',
    op: 'open',
    description:
      'Open a web chat site in the persistent browser profile and report whether sign-in or verification is required. Sign-in is always completed by the user in the visible browser.',
    parameters: {
      site: { type: 'string', description: 'Site key: chatgpt or deepseek. Defaults to the configured site.' },
      url: { type: 'string', description: 'Explicit URL to open instead of the site default.' },
      headed: { type: 'boolean', description: 'Show the browser window, needed for manual sign-in.' },
    },
  },
  {
    name: 'webbridge_ask',
    op: 'ask',
    description:
      'Send one message to the web chat and wait for the complete reply. Returns the reply text, whether it was truncated, and timing.',
    parameters: {
      message: { type: 'string', required: true, description: 'Message to type into the chat input.' },
      site: { type: 'string', description: 'Site key. Defaults to the configured site.' },
      timeoutMs: { type: 'number', description: 'Optional reply wait budget in milliseconds. Zero means unlimited (default).' },
    },
  },
  {
    name: 'webbridge_send',
    op: 'send',
    description: 'Send one message without waiting for the reply; use webbridge_read afterwards.',
    parameters: {
      message: { type: 'string', required: true, description: 'Message to type into the chat input.' },
      site: { type: 'string', description: 'Site key. Defaults to the configured site.' },
    },
  },
  {
    name: 'webbridge_read',
    op: 'read',
    description: 'Read the current last assistant reply without sending anything.',
    parameters: { site: { type: 'string', description: 'Site key. Defaults to the configured site.' } },
  },
  {
    name: 'webbridge_new_chat',
    op: 'newChat',
    description: 'Start a fresh conversation on the site, dropping the previous context.',
    parameters: { site: { type: 'string', description: 'Site key. Defaults to the configured site.' } },
  },
  {
    name: 'webbridge_adapter',
    op: 'adapter',
    description:
      'Inspect or calibrate the selectors that map a site to its input box, send button and reply container. Run with probe first, then save the confirmed selectors.',
    parameters: {
      site: { type: 'string', description: 'Site key. Defaults to the configured site.' },
      inputSelector: { type: 'string', description: 'CSS selector for the message input.' },
      sendSelector: { type: 'string', description: 'CSS selector for the send button; empty means press Enter.' },
      messageSelector: { type: 'string', description: 'CSS selector matching assistant reply containers.' },
      streamingSelector: { type: 'string', description: 'CSS selector present only while the reply streams.' },
      probe: { type: 'boolean', description: 'Query the live page for candidate inputs and reply nodes.' },
      save: { type: 'boolean', description: 'Persist the provided selectors and mark the adapter verified.' },
    },
  },
  {
    name: 'webbridge_debug_mode',
    op: 'debugMode',
    description: 'Toggle visible Chrome windows for all WebBridge sessions. Disabled means headless; enabled means headed debugging.',
    parameters: { enabled: { type: 'boolean', required: true, description: 'true shows every WebBridge browser page; false returns to headless mode.' } },
  },
  {
    name: 'webbridge_browser',
    op: 'browser',
    description: 'Low-level browser escape hatch: run one raw browser command when the higher-level tools cannot express the step.',
    parameters: {
      action: { type: 'string', required: true, description: 'One of: state, open, click, fill, press, eval, screenshot, stop, pages, console, network, debug. Read-only diagnostics also work while a conversation is running.' },
      selector: { type: 'string', description: 'Target selector for click and fill.' },
      value: { type: 'string', description: 'Text for fill, or the key name for press.' },
      expression: { type: 'string', description: 'JavaScript expression for eval.' },
      url: { type: 'string', description: 'URL for open.' },
      pageId: { type: 'string', description: 'Optional page ID from pages, console, network, or debug.' },
      limit: { type: 'number', description: 'Maximum recent diagnostic entries; default 30.' },
      filter: { type: 'string', description: 'Filter console or network entries by text.' },
      errors: { type: 'boolean', description: 'Only failed requests or console warnings/errors.' },
      type: { type: 'string', description: 'Network resource type or console severity filter.' },
      clear: { type: 'boolean', description: 'Clear the selected in-memory diagnostic records after reading.' },
    },
  },
]

export function apply(ctx, config = {}) {
  const settings = { ...resolveSettings(config), version: VERSION }
  ensureDirs(settings)

  const log = makeLogger(ctx, settings)
  const driver = new BrowserDriver(settings, log)
  const models = new ChatgptModels({ settings, driver, log, onChange: () => ctx.emit('llm/models-updated', 'webbridge-chatgpt') })
  const session = new ChatSession({ settings, driver, log, modelControl: models })
  const ops = createOps({ settings, driver, session, log })
  const toolScope = createToolScope(ctx, log)
  const providers = new Map()
  const chatSessions = new Set([session])
  const adapters = new Set()
  const bridge = new McpBridge({ ctx, settings, ops, log, toolScope })
  const setup = new WebBridgeSetup({ settings, driver, bridge, log, models, onReinstall: () => {
    for (const item of chatSessions) item.conversations.clear()
    for (const item of adapters) item.sessionState.clear()
  } })
  mountSetupService(ctx, setup)
  ctx.effect(() => {
    setup.initialize().catch(error => log(`[webbridge:setup] ${error.message}`))
    return () => setup.dispose()
  })

  // Surface scope reachability in webbridge_status: the difference between the
  // global layer and the agent layer is the single most confusing thing about
  // this plugin, so it must be observable without reading code.
  const baseStatus = ops.status.bind(ops)
  ops.status = async (...args) => ({
    ...(await baseStatus(...args)),
    registry: {
      agentScopes: toolScope.agentCount,
      totalTools: toolScope.schemas().length,
      hasAgentsService: toolScope.hasAgentsService,
      scopes: toolScope.diagnostics(),
    },
    setup: setup.read(),
  })

  /** Shared by the DSH tool and the MCP-exposed variant. */
  const runAgentTask = async (args, signal) => {
    const requested = Array.isArray(args.tools) && args.tools.length > 0 ? args.tools : settings.agent.defaultTools
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new BridgeError('no-tools', 'Pass tools: ["name", ...] to authorize which DSH tools the web model may call.')
    }
    const catalog = toolScope.schemas().filter((schema) => requested.includes(schema.name))
    if (catalog.length === 0) {
      throw new BridgeError('no-tools', `None of the requested tools exist: ${requested.join(', ')}`)
    }

    const agentSettings = { ...settings, replyTimeoutMs: settings.replyTimeoutMs > 0 ? Math.max(settings.replyTimeoutMs, 240000) : 0 }
    const agentSession = new ChatSession({ settings: agentSettings, driver, log })
    // Start from a clean conversation: a protocol run inherits nothing useful
    // from the previous chat, and stale context makes completion detection and
    // model behaviour unpredictable.
    if (args.newChat !== false) {
      await agentSession.newChat({ site: args.site })
    }

    // Nexus-style: many tools -> expose two meta tools instead of every schema.
    const metaSetting = settings.agent.metaTools
    const useMetaTools = metaSetting === true || (metaSetting !== false && catalog.length > 6)
    let promptTools = catalog
    let executeTool = (call) => toolScope.execute(call.name, call.arguments, signal)
    if (useMetaTools) {
      const meta = createMetaTools(catalog)
      promptTools = meta.toolDefs
      executeTool = (call) => meta.execute(call, (real) => toolScope.execute(real.name, real.arguments, signal))
    }

    const result = await runAgentLoop({
      task: String(args.task),
      toolDefs: promptTools,
      maxTurns: Number(args.maxTurns) || settings.agent.maxTurns,
      signal,
      log,
      send: async (text) => (await agentSession.ask(text, { site: args.site, signal })).reply,
      executeTool,
    })
    return {
      final: result.final,
      stopReason: result.stopReason,
      turns: result.turns,
      mode: useMetaTools ? 'meta-tools' : 'direct-tools',
      authorizedTools: catalog.map((definition) => definition.name),
    }
  }
  ops.runAgentTask = runAgentTask

  const invoke = async (toolName, args, exec, body) => {
    const started = Date.now()
    try {
      const data = await body()
      log(JSON.stringify(auditRecord('tool.completed', {
        tool: toolName,
        site: args?.site || settings.site,
        profile: settings.browserProfileDir,
        args,
        durationMs: Date.now() - started,
        result: 'ok',
      })))
      return ok({ tool: toolName, ...data })
    } catch (err) {
      log(JSON.stringify(auditRecord('tool.failed', {
        tool: toolName,
        site: args?.site || settings.site,
        profile: settings.browserProfileDir,
        args,
        durationMs: Date.now() - started,
        result: 'error',
        code: err?.code || 'internal-error',
      })))
      return toFailure(err)
    }
  }

  for (const definition of TOOLS) {
    ctx.effect(() => {
      const dispose = ctx.tools.register(
        defineTool({
          ...definition,
          output: OUTPUT,
          async execute(args, exec) {
            return invoke(definition.name, args, exec, () => ops[definition.op](args || {}, exec?.signal))
          },
        }),
      )
      return () => {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {}
      }
    })
  }

  ctx.effect(() => {
    const dispose = ctx.tools.register(
      defineTool({
        name: 'webbridge_mcp',
        description:
          'Start, stop or inspect the local MCP endpoint that lets a web-hosted model call these tools and allowlisted DSH tools. The endpoint is loopback-only and requires a bearer token.',
        parameters: {
          action: { type: 'string', required: true, description: 'One of: start, stop, status.' },
        },
        output: OUTPUT,
        async execute(args, exec) {
          return invoke('webbridge_mcp', args, exec, async () => {
            const action = String(args.action || 'status')
            if (action === 'start') return { action, ...(await bridge.start()) }
            if (action === 'stop') return { action, ...(await bridge.stop()) }
            return { action: 'status', ...bridge.status() }
          })
        },
      }),
    )
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {}
    }
  })

  ctx.effect(() => {
    const dispose = ctx.tools.register(
      defineTool({
        name: 'webbridge_agent',
        description:
          'Let the web chat model work on a task by calling the listed DSH tools through a text protocol. Executes each requested tool through the DSH registry, so policy and approval still apply.',
        parameters: {
          task: { type: 'string', required: true, description: 'Task for the web model to perform.' },
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tool names the web model may call. Defaults to the agent.defaultTools setting.',
          },
          maxTurns: { type: 'number', description: 'Maximum model turns. Defaults to 6.' },
          site: { type: 'string', description: 'Site key. Defaults to the configured site.' },
        },
        output: OUTPUT,
        async execute(args, exec) {
          return invoke('webbridge_agent', args, exec, () => runAgentTask(args, exec?.signal))
        },
      }),
    )
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {}
    }
  })

  // Stop the listener when the plugin unloads; a half-dead endpoint is worse
  // than none because the user cannot tell whether it is reachable.
  ctx.effect(() => () => {
    bridge.stop().catch(() => {})
  })

  const activation = writeActivation({ settings, ctx, driver, bridge, toolScope })
  log(`[webbridge] activated v${VERSION}: registry=${activation.registry?.count ?? '?'} driver=${driver.available}`)

  // --- model providers -----------------------------------------------------
  // Two routes, one adapter implementation. DeepSeek parses tool calls from the
  // reply and lets DSH run them; ChatGPT executes tools itself through the MCP
  // connector, so its route only forwards the prompt and reads the answer.
  if (settings.providers?.enabled !== false) {
    ctx.inject(['llm'], (scoped) => {
      const routes = [
        { id: 'webbridge-deepseek', name: 'DeepSeek 网页版', site: 'deepseek', modelId: 'deepseek-web', withTools: true },
        // Nexus DSH supplies the full native MCP catalog in ChatGPT. Sending a
        // second truncated text catalog would hide tools and conflict with it.
        { id: 'webbridge-chatgpt', name: 'ChatGPT 网页版', site: 'chatgpt', modelId: 'chatgpt-web', withTools: false },
      ]
      const registered = []
      const errors = []
      for (const route of routes) {
        try {
          const routeSettings = { ...settings, site: route.site }
          const routeSession = new ChatSession({ settings: routeSettings, driver, log, modelControl: route.site === 'chatgpt' ? models : undefined })
          chatSessions.add(routeSession)
          const adapter = new WebChatAdapter({
            providerId: route.id,
            displayName: route.name,
            modelId: route.modelId,
            session: routeSession,
            settings: routeSettings,
            log,
            parseReply: route.withTools ? parseReply : null,
            toolScope,
            modelCatalog: route.site === 'chatgpt' ? () => models.list() : undefined,
            accountTier: async () => {
              try { return await setup.browser.observeAccount() } catch { return setup.browser.saved.accountTier || 'unknown' }
            },
          })
          const handle = scoped.llm.registerAdapter([route.id], adapter)
          adapters.add(adapter)
          registered.push({ id: route.id, model: route.modelId, name: route.name, withTools: route.withTools })
          log(`[webbridge] provider registered: ${route.id} (${route.name})`)
          // Keep the handle so a future config change can replace the route.
          providers.set(route.id, handle)
        } catch (err) {
          errors.push({ id: route.id, message: String(err?.message || err) })
          log(`[webbridge] provider ${route.id} registration failed: ${err.message}`)
        }
      }
      try {
        writeFileSync(
          join(settings.stateDir, 'providers.json'),
          JSON.stringify({ at: new Date().toISOString(), registered, errors }, null, 2),
          'utf8',
        )
      } catch {}
    })
  }


  // MCP self-healing: start on activation, then keep it alive. A crashed or
  // never-started listener must not require the user to do anything.
  if (settings.mcp?.enabled) {
    const ensureBridge = async (reason) => {
      if (bridge.running) return
      try {
        await bridge.start()
        log(`[webbridge] MCP listening (${reason})`)
        writeActivation({ settings, ctx, driver, bridge, toolScope })
      } catch (err) {
        log(`[webbridge] MCP start failed (${reason}): ${err.message}`)
      }
    }
    ensureBridge('activation')
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (!bridge.running) ensureBridge('watchdog')
      }, 30000)
      return () => clearInterval(timer)
    })
  }
}

function makeLogger(ctx, settings) {
  const verbose = Boolean(settings.verbose)
  const logger = ctx?.logger
  const sink =
    typeof logger === 'function'
      ? (line) => {
          try {
            logger(line)
          } catch {}
        }
      : logger && typeof logger.info === 'function'
        ? (line) => {
            try {
              logger.info(line)
            } catch {}
          }
        : null
  return (line) => {
    if (sink) return sink(line)
    if (verbose) console.log(line)
  }
}
