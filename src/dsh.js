/**
 * Reaching the *agent-scoped* tool layer from a Host plugin.
 *
 * A plugin mounted in the profile root sees `ctx.tools` = the global layer only
 * (measured: 16 tools). Everything useful — read, grep, bash, web_search — is
 * registered in an agent scope. `@deepseek-ai/dsh-agent` exposes the live agents
 * as the `agents` service, and each Agent carries its own scoped `ctx`, so
 * `agent.ctx.tools` is the registry those tools actually live in.
 *
 * Everything here is defensive: a missing service or a throwing agent must
 * degrade to the global layer, never break the plugin.
 */

import { randomUUID } from 'node:crypto'
import { mentionedFiles } from './attachments.js'

/** Declare a real web-model MCP request before the host executor logs it. */
export function nativeToolDeclaration(call, position) {
  const block = { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }
  const time = Date.now()
  return {
    turn: position.turn,
    step: position.step,
    message: {
      role: 'assistant', id: randomUUID(), content: [block],
      source: { kind: 'model', provider: position.provider, model: position.model },
    },
    stream: [
      { type: 'chunk', time, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } },
      { type: 'chunk', time, chunk: { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments } },
      { type: 'chunk', time, chunk: { type: 'block-end', index: 0, block } },
      { type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'tool-use' } } },
    ],
  }
}

export function createToolScope(ctx, log = () => {}) {
  let agentsService = null
  let attachmentService = null
  const attachmentMessages = new Map()
  const requests = new Map()
  const requestSignals = new Map()
  const inputWatchers = new Map()
  const steps = new Map()
  let lastSessionId = null
  const targetSession = () => {
    const ids = [...new Set(requests.values())]
    if (ids.length > 1) {
      const error = new Error('More than one DSH session is using the web connector; the target tool scope is ambiguous.')
      error.code = 'ambiguous-tool-scope'
      throw error
    }
    return ids[0] || lastSessionId
  }

  // Reading `ctx.agents` directly throws "cannot get property without inject" on
  // a context that never declared it. The method form declares the dependency
  // for a child context and runs the callback once the service exists, without
  // turning a missing `agents` service into a hard activation dependency.
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject(['agents'], (scoped) => {
        agentsService = scoped.agents
      })
    } catch (err) {
      log(`[webbridge] agents injection unavailable: ${err.message}`)
    }
    ctx.inject(['attachments'], scoped => { attachmentService = scoped.attachments })
  }

  // This is the host's public model-request boundary. Supplying its log
  // position lets the DSH executor publish native tool/call and tool/result
  // events, including progress, presentation metadata, and durable history.
  if (typeof ctx?.on === 'function') {
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (message?.source?.kind !== 'user') return
      for (const callback of inputWatchers.get(String(agent.id)) || []) callback(message)
    })
    // LLM adapters receive file handles after the host projects file blocks to
    // text. Capture the actual references at the public pre-projection hook.
    ctx.on('llm/stream', (options, next) => {
      if (String(options.provider || '').startsWith('webbridge-') && (!options.purpose || options.purpose === 'chat')) {
        attachmentMessages.set(String(options.sessionId), (options.messages || []).filter(message => message.role === 'user' &&
          Array.isArray(message.content) && message.content.some(block => block.type === 'file' || block.type === 'image')))
      }
      return next()
    })
    ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
      const config = await next()
      steps.set(agent.id, { turn, step, signal, provider: config.provider, model: config.model })
      return config
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') steps.delete(agent.id)
    })
    ctx.on('agent/disposed', ({ agent }) => { steps.delete(agent.id); attachmentMessages.delete(String(agent.id)) })
  }

  const agents = () => {
    try {
      const list = agentsService?.list?.() ?? []
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  const scopedTools = () => {
    const found = []
    const sessionId = targetSession()
    for (const agent of agents()) {
      if (sessionId && agent?.id !== sessionId && agent?.session?.id !== sessionId) continue
      const tools = agent?.ctx?.tools
      if (tools && typeof tools.schemas === 'function') found.push({ agent, tools })
    }
    return found
  }

  /** Schemas an agent scope sees. The service needs the agent passed explicitly. */
  const agentSchemas = ({ agent, tools }) => {
    try {
      const explicit = tools.schemas(agent)
      if (Array.isArray(explicit) && explicit.length > 0) return explicit
    } catch {}
    try {
      return tools.schemas() || []
    } catch {
      return []
    }
  }

  return {
    watchUserInput(sessionId, callback) {
      const key = String(sessionId)
      if (!inputWatchers.has(key)) inputWatchers.set(key, new Set())
      inputWatchers.get(key).add(callback)
      return () => { const watchers = inputWatchers.get(key); watchers?.delete(callback); if (!watchers?.size) inputWatchers.delete(key) }
    },
    cancelSession(sessionId) {
      const agent = agents().find(entry => entry.id === sessionId || entry.session?.id === sessionId)
      agent?.cancel?.({ kind: 'user' }, { keepInbox: true })
    },
    originalMessage(sessionId, message) {
      return message.role === 'user' && message.id
        ? attachmentMessages.get(String(sessionId))?.find(raw => raw.id === message.id) || message
        : message
    },
    hasAttachments(sessionId, message) {
      if (Array.isArray(message.content) && message.content.some(block => block.type === 'image' || block.type === 'file')) return true
      return Boolean(message.id && attachmentMessages.get(String(sessionId))?.some(raw => raw.id === message.id))
    },

    async attachmentsFor(sessionId, messages) {
      const originals = attachmentMessages.get(String(sessionId)) || []
      const files = []
      for (const message of messages) {
        if (message.role !== 'user') continue
        const raw = (message.id && originals.find(candidate => candidate.id === message.id)) || message
        for (const block of Array.isArray(raw.content) ? raw.content : []) {
          if (block.type !== 'image' && block.type !== 'file') continue
          const ref = block.attachment
          if (!ref || !attachmentService) throw new Error('DSH 附件服务尚未就绪，无法转发附件。')
          const path = block.type === 'image' ? attachmentService.imageHostPath(ref) : attachmentService.fileHostPath(ref)
          if (!path) throw new Error(`DSH 无法读取附件 ${ref.name || ref.attachmentId}。`)
          const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }[ref.mediaType] || ''
          files.push({ path, name: ref.name || `image-${files.length + 1}${extension}`, mediaType: ref.mediaType })
        }
        const text = typeof raw.content === 'string' ? raw.content : (raw.content || []).filter(block => block.type === 'text').map(block => block.text || '').join('\n')
        for (const file of await mentionedFiles(text)) if (!files.some(existing => existing.path === file.path)) files.push(file)
      }
      return files
    },
    get activeSessionId() {
      const ids = [...new Set(requests.values())]
      return ids.length === 1 ? ids[0] : null
    },
    get hasActiveRequests() { return requests.size > 0 },

    /** Carry the DSH conversation identity across an incoming MCP HTTP call. */
    async withSession(sessionId, operation, signal) {
      const request = Symbol('webbridge-request')
      requests.set(request, sessionId)
      if (signal) requestSignals.set(request, signal)
      lastSessionId = sessionId
      try {
        return await operation()
      } finally {
        requests.delete(request)
        requestSignals.delete(request)
      }
    },

    get agentCount() {
      return agents().length
    },

    get hasAgentsService() {
      return Boolean(agentsService)
    },

    /** Why an agent scope did or did not contribute tools. */
    diagnostics() {
      return agents().map((agent) => {
        try {
          const tools = agent?.ctx?.tools
          const scoped = tools && typeof tools.schemas === 'function' ? tools.schemas(agent) : null
          return {
            hasCtx: Boolean(agent?.ctx),
            hasTools: Boolean(tools),
            schemaCount: Array.isArray(scoped) ? scoped.length : null,
            sample: Array.isArray(scoped) ? scoped.slice(0, 6).map((s) => s.name) : null,
          }
        } catch (err) {
          return { error: String(err.message || err) }
        }
      })
    },

    /** Global layer plus every live agent layer, de-duplicated by tool name. */
    schemas() {
      const byName = new Map()
      try {
        for (const schema of ctx.tools.schemas() || []) byName.set(schema.name, schema)
      } catch (err) {
        log(`[webbridge] global schemas failed: ${err.message}`)
      }
      for (const { agent, tools } of scopedTools()) {
        for (const schema of agentSchemas({ agent, tools })) {
          if (!byName.has(schema.name)) byName.set(schema.name, schema)
        }
      }
      return [...byName.values()]
    },

    /** Find a scope that knows this tool. Agent scopes win over the global one. */
    findScope(name) {
      for (const entry of scopedTools()) {
        try {
          const schema = agentSchemas(entry).find((candidate) => candidate.name === name)
          if (schema) return { ...entry, schema }
        } catch {}
      }
      try {
        const schema = (ctx.tools.schemas() || []).find((entry) => entry.name === name)
        if (schema) return { tools: ctx.tools, schema }
      } catch {}
      return null
    },

    /**
     * Execute one tool through the registry that knows it.
     * Policy and approval still run inside that registry.
     */
    async execute(name, args, signal) {
      const scope = this.findScope(name)
      if (!scope) throw new ToolNotVisibleError(name)
      const position = scope.agent ? steps.get(scope.agent.id) : undefined
      const boundSignal = [...requestSignals].find(([request]) => requests.get(request) === (scope.agent?.id || targetSession()))?.[1]
      const effectiveSignal = signal ?? boundSignal ?? position?.signal ?? new AbortController().signal
      const call = {
        id: `wb_mcp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name,
        arguments: JSON.stringify(args ?? {}),
      }
      const record = position && position.provider && position.model
      if (record) {
        scope.agent.session.append('assistant/message', nativeToolDeclaration(call, position), { surfaceOp: 'append' })
      }
      const settlement = await scope.tools.execute({
        calls: [call],
        signal: effectiveSignal,
        ...(scope.agent ? { agent: scope.agent } : {}),
        ...(record ? { log: { turn: position.turn, step: position.step } } : {}),
      })
      // Settlement entries wrap the tool outcome: { callId, result: { content, isError } }.
      // Older/simpler shapes put content at the top level, so unwrap defensively.
      const entry = settlement?.results?.[0] ?? settlement?.[0]
      if (!entry) return { ok: false, body: 'tool-no-result: the registry returned no outcome for this call' }
      const result = entry.result ?? entry
      return { ok: !result.isError, body: renderResult(result) }
    },
  }
}

export class ToolNotVisibleError extends Error {
  constructor(name) {
    super(`tool "${name}" is not visible in the global or any live agent scope`)
    this.code = 'tool-not-visible'
  }
}

/**
 * Turn whatever the registry returned into text.
 * Some tools answer with content blocks, others only with structuredContent or
 * the canonical value; dropping the latter would look like an empty success.
 */
function renderResult(result) {
  const text = Array.isArray(result.content)
    ? result.content
        .map((item) => (typeof item === 'string' ? item : item?.text ?? ''))
        .filter(Boolean)
        .join('\n')
    : typeof result.content === 'string'
      ? result.content
      : ''
  if (text.trim()) return text
  if (result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent, null, 2)
    } catch {}
  }
  if (result.value !== undefined) {
    return typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2)
  }
  // Last resort: never report an empty success, show the raw outcome shape.
  try {
    return JSON.stringify(result, null, 2).slice(0, 4000)
  } catch {
    return ''
  }
}
