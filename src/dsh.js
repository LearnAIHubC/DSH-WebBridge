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
import { BridgeError } from './envelope.js'
import { ContextIdentity } from './context-identity.js'

const CONTEXT_TOOL_NAME = 'dsh_get_context'
const CHECKPOINT_TEXT = 'Tool context could not be preserved. End this response and report the failure without repeating completed tools.'

/** Context may use a user role: the source, not the role alone, identifies it. */
function isInjectedContext(message) {
  if (message?.role === 'system' || message?.role === 'developer') return true
  return message?.role === 'user' && typeof message.source?.kind === 'string' &&
    !['user', 'tool', 'model'].includes(message.source.kind)
}

function appendContextUpdates(outcome, updates) {
  if (!updates.length) return outcome
  return {
    ...outcome,
    context_updates: updates,
    body: `${outcome.body || ''}\n\n[DSH context updates]\n${JSON.stringify({ messages: updates }, null, 2)}`,
  }
}

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

export function createToolScope(ctx, log = () => {}, { contextStore } = {}) {
  let agentsService = null
  let attachmentService = null
  let workingDirectoryService = null
  const attachmentMessages = new Map()
  const originalRequests = new Map()
  const pendingContexts = new Map()
  const seenContexts = new Map()
  const contextCheckpoints = new Map()
  const executionQueues = new Map()
  const requests = new Map()
  const requestSignals = new Map()
  const requestContexts = new Map()
  const inputWatchers = new Map()
  const steps = new Map()
  let lastSessionId = null
  const checkpointMessage = sessionId => contextCheckpoints.get(String(sessionId))?.failure || CHECKPOINT_TEXT
  const failedCheckpoint = (agent, position, call, error, succeeded = true) => {
    const failure = (succeeded ? 'The preceding DSH tool completed successfully. Do not repeat it. '
      : 'The preceding DSH tool returned an error. Do not retry it before context has been refreshed. ') +
      `DSH could not enqueue the required context continuation: ${error.message || String(error)}. ` +
      'End this web response and report the context-refresh failure. Do not call more DSH tools; a new DSH request must cross a real step boundary before work can resume.'
    if (agent?.id && position) {
      contextCheckpoints.set(String(agent.id), { turn: position.turn, step: position.step, callId: call.id, failure })
    }
    return failure
  }
  const queueContext = (sessionId, message) => {
    if (!sessionId || !isInjectedContext(message)) return
    const id = String(sessionId)
    if (!seenContexts.has(id)) seenContexts.set(id, new ContextIdentity())
    if (!seenContexts.get(id).accept(message)) return
    if (!pendingContexts.has(id)) pendingContexts.set(id, [])
    pendingContexts.get(id).push(structuredClone(message))
  }
  const collectContextUpdates = (agent) => {
    if (!agent?.id) return []
    const id = String(agent.id)
    // Additional contexts are already materialized by their owning plugins.
    // We do not run pre-step hooks or fabricate step/end to discover more.
    for (const message of agent.inbox?.nextStep || []) queueContext(id, message)
    const pending = pendingContexts.get(id)
    if (!pending?.length) return []
    pendingContexts.delete(id)
    return pending
  }
  const admitAdditionalContexts = (agent, contexts) => {
    if (!agent?.id || !Array.isArray(contexts) || !contexts.length) return
    const id = String(agent.id)
    if (!seenContexts.has(id)) seenContexts.set(id, new ContextIdentity())
    const existing = new ContextIdentity(agent.inbox?.nextStep || [])
    const additions = []
    for (const message of contexts) {
      if (!seenContexts.get(id).accept(message)) continue
      if (!['webbridge-context-checkpoint', 'repeat-tool-reminder'].includes(message.source?.kind) && existing.accept(message)) additions.push(message)
      // Keep the executor's complete messages; they need not use a known kind.
      if (!pendingContexts.has(id)) pendingContexts.set(id, [])
      pendingContexts.get(id).push(structuredClone(message))
    }
    if (additions.length && typeof agent.inbox?.splice === 'function') {
      agent.inbox.splice('next-step', agent.inbox.nextStep.length, 0, additions)
    } else if (additions.length && contextStore) {
      throw new BridgeError('context-inbox-unavailable', 'The agent cannot preserve the additional tool context in its next-step inbox.')
    }
  }
  const targetSession = (explicitSessionId) => {
    if (explicitSessionId !== undefined && explicitSessionId !== null && String(explicitSessionId)) {
      return String(explicitSessionId)
    }
    const ids = [...new Set(requests.values())]
    if (ids.length > 1) {
      const error = new Error('More than one DSH session is using the web connector; the target tool scope is ambiguous.')
      error.code = 'ambiguous-tool-scope'
      throw error
    }
    return ids[0] || lastSessionId
  }
  const contextReferenceFor = (sessionId) => {
    const selected = sessionId === undefined || sessionId === null ? null : String(sessionId)
    const references = new Map(
      [...requestContexts]
        .filter(([request]) => selected === null || String(requests.get(request)) === selected)
        .map(([, reference]) => [reference.context_id, reference]),
    )
    if (references.size > 1) {
      throw new BridgeError('ambiguous-context-scope', 'More than one DSH request context is active for this session; the connector cannot safely select a snapshot.')
    }
    const reference = references.values().next().value
    return reference ? { ...reference } : null
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
    try {
      ctx.inject(['workingDirectory'], scoped => { workingDirectoryService = scoped.workingDirectory })
    } catch (err) {
      log(`[webbridge] working-directory injection unavailable: ${err.message}`)
    }
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
        const id = String(options.sessionId)
        const messages = structuredClone(options.messages || [])
        originalRequests.set(id, {
          messages,
          ...(options.toolHistory === undefined ? {} : { toolHistory: structuredClone(options.toolHistory) }),
        })
        // A newly prepared request is authoritative, including replacements and
        // removals. Its full snapshot supersedes queued updates from older steps.
        pendingContexts.delete(id)
        seenContexts.set(id, new ContextIdentity(messages.filter(isInjectedContext)))
        attachmentMessages.set(String(options.sessionId), messages.filter(message => message.role === 'user' &&
          Array.isArray(message.content) && message.content.some(block => block.type === 'file' || block.type === 'image')))
      }
      return next()
    })
    ctx.on('agent/request', async ({ agent, turn, step, signal }, next) => {
      const config = await next()
      const checkpoint = contextCheckpoints.get(String(agent.id))
      if (checkpoint && (turn > checkpoint.turn || turn === checkpoint.turn && step > checkpoint.step)) {
        contextCheckpoints.delete(String(agent.id))
      }
      steps.set(agent.id, { turn, step, signal, provider: config.provider, model: config.model })
      return config
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') steps.delete(agent.id)
    })
    ctx.on('session/event', (session, event) => {
      const message = event?.type === 'user/message' ? event.data
        : ['system/message', 'developer/message'].includes(event?.type) ? event.data?.message
          : undefined
      queueContext(session?.id, message)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      const id = String(agent.id)
      steps.delete(agent.id)
      attachmentMessages.delete(id)
      originalRequests.delete(id)
      pendingContexts.delete(id)
      seenContexts.delete(id)
      contextCheckpoints.delete(id)
      executionQueues.delete(id)
      contextStore?.deleteSession(id)
      inputWatchers.delete(id)
    })
  }

  const agents = () => {
    try {
      const list = agentsService?.list?.() ?? []
      return Array.isArray(list) ? list : []
    } catch {
      return []
    }
  }

  const scopedTools = (explicitSessionId, { allowAmbiguous = false } = {}) => {
    const found = []
    let sessionId
    try {
      sessionId = targetSession(explicitSessionId)
    } catch (error) {
      if (!allowAmbiguous || explicitSessionId !== undefined && explicitSessionId !== null || error.code !== 'ambiguous-tool-scope') throw error
      // Schema discovery is read-only: when no route exists yet, expose the
      // union so the client can still see dsh_get_context and bootstrap routing.
      sessionId = null
    }
    for (const agent of agents()) {
      if (sessionId && String(agent?.id) !== String(sessionId) && String(agent?.session?.id) !== String(sessionId)) continue
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
    originalRequest(sessionId) {
      const request = originalRequests.get(String(sessionId))
      return request ? structuredClone(request) : undefined
    },
    async workspaceFor(sessionId, signal) {
      const agent = agents().find(entry => String(entry.id) === String(sessionId) || String(entry.session?.id) === String(sessionId))
      if (!agent || typeof workingDirectoryService?.ensure !== 'function') return {}
      const cwd = await workingDirectoryService.ensure(agent, signal ?? new AbortController().signal)
      return typeof cwd === 'string' && cwd ? { cwd } : {}
    },
    readContext(args, exec) {
      const sessionId = exec?.agent?.id ?? exec?.agent?.session?.id
      if (!contextStore) throw new BridgeError('context-unavailable', 'DSH context snapshots are not available.')
      if (!sessionId) throw new BridgeError('context-scope-required', 'Reading DSH context requires an explicit agent scope.')
      if (contextCheckpoints.has(String(sessionId))) {
        throw new BridgeError('context-checkpoint-required', checkpointMessage(sessionId))
      }
      const reference = this.contextReferenceFor(sessionId)
      if (reference && args?.context_id !== reference.context_id) {
        throw new BridgeError('context-request-mismatch', 'Use the context_id supplied with the currently active DSH request.')
      }
      return contextStore.read(args, { sessionId: String(sessionId) })
    },
    hasContextCheckpoint(sessionId) { return contextCheckpoints.has(String(sessionId)) },
    contextCheckpointMessage(sessionId) { return checkpointMessage(sessionId) },
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
    get activeContextReference() {
      return contextReferenceFor()
    },
    contextReferenceFor(sessionId) {
      return contextReferenceFor(sessionId)
    },
    get hasActiveRequests() { return requests.size > 0 },
    isSessionActive(sessionId) {
      return [...requests.values()].some(id => String(id) === String(sessionId))
    },
    resetSession(sessionId) {
      const id = String(sessionId || '').trim()
      if (!id) throw new BridgeError('session-required', '同步网页会话需要当前 DSH sessionId。')
      if ([...requests.values()].some(value => String(value) === id)) {
        throw new BridgeError('session-busy', '当前会话仍在生成，请等待本轮结束后再同步。')
      }
      attachmentMessages.delete(id)
      originalRequests.delete(id)
      pendingContexts.delete(id)
      seenContexts.delete(id)
      contextCheckpoints.delete(id)
      executionQueues.delete(id)
      inputWatchers.delete(id)
      steps.delete(id)
      if (String(lastSessionId || '') === id) lastSessionId = null
      contextStore?.deleteSession(id)
      return { sessionId: id, contextCleared: Boolean(contextStore) }
    },

    /** Carry the DSH conversation identity across an incoming MCP HTTP call. */
    async withSession(sessionId, operation, signal, { contextReference } = {}) {
      const request = Symbol('webbridge-request')
      if (contextReference) {
        if (!contextStore) throw new BridgeError('context-unavailable', 'DSH context snapshots are not available.')
        const verified = contextStore.getReference(contextReference.context_id, { sessionId: String(sessionId) })
        requestContexts.set(request, verified)
      }
      requests.set(request, sessionId)
      if (signal) requestSignals.set(request, signal)
      lastSessionId = sessionId
      try {
        return await operation()
      } finally {
        requests.delete(request)
        requestSignals.delete(request)
        requestContexts.delete(request)
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
    schemas(sessionId) {
      const byName = new Map()
      try {
        for (const schema of ctx.tools.schemas() || []) byName.set(schema.name, schema)
      } catch (err) {
        log(`[webbridge] global schemas failed: ${err.message}`)
      }
      for (const { agent, tools } of scopedTools(sessionId, { allowAmbiguous: true })) {
        for (const schema of agentSchemas({ agent, tools })) {
          if (!byName.has(schema.name)) byName.set(schema.name, schema)
        }
      }
      return [...byName.values()]
    },

    /** Find a scope that knows this tool. Agent scopes win over the global one. */
    findScope(name, sessionId) {
      for (const entry of scopedTools(sessionId)) {
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
    async execute(name, args, signal, { sessionId: routedSessionId } = {}) {
      const route = routedSessionId === undefined || routedSessionId === null ? undefined : String(routedSessionId)
      const scope = this.findScope(name, route)
      if (!scope) throw new ToolNotVisibleError(name)
      const admittedPosition = scope.agent ? steps.get(scope.agent.id) : undefined
      const sessionId = route ?? scope.agent?.id ?? targetSession()
      const bindings = [...requests].filter(([, id]) => String(id) === String(sessionId) ||
        scope.agent?.session?.id != null && String(id) === String(scope.agent.session.id))
      if (contextStore && bindings.length > 1) {
        throw new BridgeError('ambiguous-context-scope', 'More than one DSH request is active for this tool scope; its request identity is ambiguous.')
      }
      const request = bindings[0]?.[0]
      const admittedSessionId = bindings[0]?.[1]
      const admittedReference = requestContexts.get(request)
      const boundSignal = requestSignals.get(request)
      const effectiveSignal = signal ?? boundSignal ?? admittedPosition?.signal ?? new AbortController().signal
      const run = async () => {
        if (contextStore) {
          // Capture ownership before queuing. An old queued call must never
          // borrow a same-step retry's signal or newly initialized context.
          if (effectiveSignal.aborted || boundSignal?.aborted) {
            throw new BridgeError('aborted', 'The DSH request that queued this tool call was cancelled. No action was performed.')
          }
          if (request && (!requests.has(request) || requests.get(request) !== admittedSessionId)) {
            throw new BridgeError('context-request-changed', 'The DSH request that queued this tool call has ended. No action was performed.')
          }
          if (request) {
            const currentReference = requestContexts.get(request)
            const activeReference = this.contextReferenceFor(sessionId)
            if (currentReference?.context_id !== admittedReference?.context_id ||
              currentReference?.revision !== admittedReference?.revision ||
              activeReference?.context_id !== admittedReference?.context_id) {
              throw new BridgeError('context-request-changed', 'The context for this queued tool call is no longer current. Load the active context before continuing.')
            }
          }
        }
        if (scope.agent?.id && contextCheckpoints.has(String(scope.agent.id))) {
          throw new BridgeError('context-checkpoint-required', checkpointMessage(scope.agent.id))
        }
        const position = scope.agent ? steps.get(scope.agent.id) : undefined
        if (contextStore && admittedPosition && (position?.turn !== admittedPosition.turn || position?.step !== admittedPosition.step)) {
          throw new BridgeError('context-request-changed', 'This tool call belongs to an earlier DSH step. Load the new context before continuing.')
        }
        const call = {
          id: `wb_mcp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          name,
          arguments: JSON.stringify(args ?? {}),
        }
        const record = position && position.provider && position.model
        if (record) {
          scope.agent.session.append('assistant/message', nativeToolDeclaration(call, position), { surfaceOp: 'append' })
        }
        let settlement
        let completedEntry
        let executorWarning
        const admitContexts = (contexts, succeeded) => {
          try { admitAdditionalContexts(scope.agent, contexts) }
          catch (error) {
            if (!contextStore) throw error
            if (admittedReference) return failedCheckpoint(scope.agent, position, call, error, succeeded)
            return `DSH could not preserve the additional tool context in its next-step inbox: ${error.message || String(error)}.`
          }
        }
        try {
          settlement = await scope.tools.execute({
            calls: [call],
            signal: effectiveSignal,
            ...(scope.agent ? { agent: scope.agent } : {}),
            ...(record ? { log: { turn: position.turn, step: position.step } } : {}),
          })
        } catch (error) {
          const partialEntry = contextStore && error.partial?.results?.find(entry => entry.callId === call.id)
          if (partialEntry && !(partialEntry.result ?? partialEntry).isError) {
            // A batch may fail after settling this one call. Its recorded
            // success is authoritative; reporting failure would invite replay.
            settlement = error.partial
            completedEntry = partialEntry
            executorWarning = 'The DSH tool completed successfully. Do not repeat it. ' +
              `A later executor error occurred: ${error.code || 'tool-error'}: ${error.cause?.message || error.message || String(error)}`
          } else {
            const contextWarning = admitContexts(error.partial?.additionalContexts, false)
            const updates = collectContextUpdates(scope.agent)
            if (!updates.length && !contextWarning) throw error
            const body = [`${error.code || 'tool-error'}: ${error.cause?.message || error.message || String(error)}`, contextWarning].filter(Boolean).join('\n\n')
            return appendContextUpdates({ ok: false, body }, updates)
          }
        }
        // Settlement entries wrap the tool outcome: { callId, result: { content, isError } }.
        // Older/simpler shapes put content at the top level, so unwrap defensively.
        const entry = completedEntry ?? settlement?.results?.[0] ?? settlement?.[0]
        if (!entry) {
          const contextWarning = admitContexts(settlement?.additionalContexts, false)
          const body = ['tool-no-result: the registry returned no outcome for this call', contextWarning].filter(Boolean).join('\n\n')
          return appendContextUpdates({ ok: false, body }, collectContextUpdates(scope.agent))
        }
        const result = entry.result ?? entry
        const contextWarning = admitContexts(settlement?.additionalContexts, !result.isError)
        if (!result.isError && name === CONTEXT_TOOL_NAME && contextStore && scope.agent?.id && typeof args?.context_id === 'string') {
          // Validate ownership before recording this exact transport call. Never
          // infer a delivery from a tool name or a matching string in user prose.
          const reference = contextStore.getReference(args.context_id, { sessionId: String(scope.agent.id) })
          contextStore.registerDeliveryCall(call.id, reference)
        }
        const body = [renderResult(result), executorWarning, contextWarning].filter(Boolean).join('\n\n')
        return appendContextUpdates({ ok: !result.isError, body }, collectContextUpdates(scope.agent))
      }
      if (!contextStore || !scope.agent?.id) return run()
      const id = String(scope.agent.id)
      // Keep tool outcomes and context admissions in this agent's call order.
      const previous = executionQueues.get(id) || Promise.resolve()
      const operation = previous.catch(() => {}).then(run)
      executionQueues.set(id, operation)
      try { return await operation }
      finally { if (executionQueues.get(id) === operation) executionQueues.delete(id) }
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
