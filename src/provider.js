/**
 * Web-chat model providers for DSH.
 *
 * Two routes share one implementation, differing in how tool calls are executed:
 *
 *   webbridge-deepseek  prompt -> web chat -> we parse tool calls -> DSH runs them
 *   webbridge-chatgpt   prompt -> web chat -> ChatGPT calls our MCP endpoint,
 *                       which executes DSH tools synchronously on its side
 *
 * Chunk vocabulary (measured from @deepseek-ai/dsh-llm BlockAssembler):
 *   {type:'block-start', index, blockType:'text'|'reasoning'|'tool-call'}
 *   {type:'text-delta', index, text}
 *   {type:'tool-call-delta', index, id, name?, argumentsDelta}
 *   {type:'block-end', index, block}
 *   {type:'usage', usage}
 *   {type:'finish', reason:{kind}}
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BridgeError, digest } from './envelope.js'
import { snapshotDelta, streamPreview } from './stream-text.js'

/** Flatten DSH messages into one prompt the web chat can accept. */
export function flattenMessages(messages) {
  const parts = []
  for (const message of messages || []) {
    const role = message?.role || 'user'
    const content = message?.content
    let text = ''
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .map((block) => {
          if (typeof block === 'string') return block
          if (!block || typeof block !== 'object') return ''
          if (block.type === 'text') return block.text || ''
          if (block.type === 'tool-result') return `[tool ${block.name || ''}] ${typeof block.result === 'string' ? block.result : JSON.stringify(block.result ?? '')}`
          return ''
        })
        .filter(Boolean)
        .join('\n')
    }
    if (!text) continue
    text = stripReminders(text)
    if (!text) continue
    parts.push(role === 'assistant' ? `助手：${text}` : role === 'system' ? `[系统]\n${text}` : `用户：${text}`)
  }
  return parts.join('\n\n')
}

/** Tool definitions the web model may call, rendered compactly (A+ protocol). */
export function renderTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const compact = tools.map((tool) => ({
    name: tool.name,
    description: String(tool.description || '').split('\n')[0].slice(0, 140),
    parameters: tool.parameters || tool.inputSchema || {},
  }))
  return [
    '【工具调用规则】下面是你此刻唯一可以使用的工具清单：',
    '<<<NEXUS_TOOLS>>>',
    JSON.stringify(compact),
    '<<<END_NEXUS_TOOLS>>>',
    '',
    '要调用工具时，你必须只输出下面这种格式，不要加任何解释、不要用 XML、不要用函数语法：',
    '<<<TOOL_CALLS>>>',
    '[{"name":"<工具名>","arguments":{"<参数名>":"<参数值>"}}]',
    '<<<END_TOOL_CALLS>>>',
    '',
    '给出最终答复时，把答复包在 <<<FINAL>>> 与 <<<END_FINAL>>> 之间。',
    '如果你不调用工具也能回答，就直接用 <<<FINAL>>> 包裹答复。',
  ].join('\n')
}

/** DSH injects harness metadata as ordinary messages; never forward it. */
const HARNESS_NOISE = [
  'Time sampled while preparing',
  'Browser time zone for this request',
  'Elapsed since the preceding',
  'Current DeepSeek Harness implementation checkout',
  '收到时间记录',
]

/**
 * DSH appends `<system-reminder>` blocks (skill catalogue, environment notes)
 * *inside* the user message. They are harness bookkeeping, not user speech, and
 * they were landing verbatim in the web composer.
 */
export function stripReminders(text) {
  let out = String(text || '')
  // Remove every system-reminder block, including the nested available_skills list.
  out = out.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
  // Stray fragments when a block is split across messages.
  out = out.replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, ' ')
  out = out.replace(/<\/?system-reminder>/gi, ' ')
  return out.trim()
}

/** Flatten a message's content into plain text, whatever shape it arrived in. */
export function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return stripReminders(content)
  if (Array.isArray(content)) {
    return stripReminders(
      content
        .map((block) => (typeof block === 'string' ? block : block && block.type === 'text' ? String(block.text || '') : ''))
        .join('\n'),
    )
  }
  return ''
}

/**
 * Harness metadata is usually a whole message, but it also arrives wrapped in
 * arrays or prefixed with other text, so match anywhere in the flattened text
 * instead of only at the start.
 */
export function isHarnessNoise(message) {
  const text = messageText(message).trim()
  if (!text) return false
  if (HARNESS_NOISE.some((needle) => text.includes(needle))) return true
  // A message that is nothing but a timestamp/zone note carries no user intent.
  const stripped = text.replace(/[\s\S]*?(用户|User)\s*[:：]/, '')
  return /^\s*(Time sampled|Browser time zone|Elapsed since)/i.test(stripped)
}

/** Derive a short session title locally instead of asking the web model. */
export function deriveTitle(messages) {
  const texts = []
  for (const message of messages || []) {
    if (!message || message.role !== 'user') continue
    const text = messageText(message)
    if (!text) continue
    // The title producer embeds its input as a JSON array of human messages.
    const match = text.match(/\[\s*\{[\s\S]*\}\s*\]/)
    if (match) {
      try {
        const parsed = JSON.parse(match[0])
        for (const item of parsed) if (item && typeof item.text === 'string') texts.push(stripReminders(item.text))
        continue
      } catch {}
    }
    texts.push(text)
  }
  const first = (texts.find((entry) => entry && !isHarnessNoise({ content: entry })) || '')
    .replace(/(^|\s)@(?:[A-Za-z]:[\\/]|\/)\S+\s*/g, '$1').trim()
  if (!first) return '新会话'
  return first.replace(/\s+/g, ' ').slice(0, 18)
}

export class WebChatAdapter {
  constructor({ providerId, displayName, modelId, session, settings, log, parseReply, toolScope, accountTier }) {
    this.providerId = providerId
    this.displayName = displayName
    this.modelId = modelId
    this.session = session
    this.settings = settings
    this.log = log || (() => {})
    this.parseReply = parseReply
    this.toolScope = toolScope
    this.accountTier = accountTier
    /**
     * Per DSH-session bookkeeping. One DSH session already maps to one web
     * conversation, so initial history is sent once and tool definitions are
     * refreshed only when they change. Later turns send just the new messages.
     * Resending everything made each message enormous and is what tripped the
     * site's abuse checks.
     */
    this.sessionState = new Map()
  }

  #state(sessionId) {
    const key = sessionId || 'default'
    let state = this.sessionState.get(key)
    if (!state) {
      state = { bootstrapped: false, sentMessages: 0, toolContext: '' }
      this.sessionState.set(key, state)
    }
    return state
  }

  providerInfo(provider) {
    return { id: provider, name: this.displayName }
  }

  /** The registry validates these even when a route declares no policy. */
  providerRetryPolicy() {
    return undefined
  }

  imageRequestPricing() {
    return undefined
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image?.width, height: image?.height, maxBytes: image?.bytes }
  }

  async listModels(provider) {
    // The registry validates every entry: provider/id/name must be non-empty
    // strings and `provider` must equal the route, or the catalog is rejected
    // with INVALID_CATALOG ("invalid or duplicate model metadata").
    const tier = this.accountTier ? await this.accountTier() : 'unknown'
    if (this.settings.site === 'chatgpt' && tier === 'free') {
      return [
        { provider, id: this.modelId, name: `${this.displayName}（思考）`, contextWindow: this.settings.providers?.contextWindow || 32000, supportsTools: true, inputModalities: ['text', 'image'] },
        { provider, id: `${this.modelId}-instant`, name: `${this.displayName}（非思考）`, contextWindow: this.settings.providers?.contextWindow || 32000, supportsTools: true, inputModalities: ['text', 'image'] },
      ]
    }
    return [
      {
        provider,
        id: this.modelId,
        name: this.displayName,
        description: `${this.displayName}（浏览器驱动，无需 API Key）`,
        contextWindow: this.settings.providers?.contextWindow || 32000,
        supportsTools: true,
        inputModalities: ['text', 'image'],
      },
    ]
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: this.settings.site === 'chatgpt' ? `${this.displayName}（${model === `${this.modelId}-instant` ? '非思考' : '思考'}）` : this.displayName,
      contextWindow: this.settings.providers?.contextWindow || 32000,
      supportsTools: true,
      inputModalities: ['text', 'image'],
    }
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.generate(options),
    }
  }

  stream(options) {
    return this.generate(options)
  }

  /** One provider attempt: one browser round trip, emitted as DSH chunks. */
  async *generate(options) {
    const purpose = typeof options.purpose === 'string' ? options.purpose : ''
    const isMainChat = !purpose || purpose === 'chat'
    const messages = Array.isArray(options.messages) ? options.messages : []
    let allMessages = messages.filter((message) => message && !isHarnessNoise(message))
    const firstUser = allMessages.find((message) => message.role === 'user' && messageText(message))
    // Omitted session IDs use the first real user message, excluding timestamps
    // and reminders. Hash the full text so a shared prefix cannot merge chats.
    const baseSessionId = options.sessionId == null ? `anon-${digest(messageText(firstUser))}` : String(options.sessionId)
    // Restore real user blocks captured before DSH converts files into tool
    // path handles. The web upload carries these bytes directly.
    if (isMainChat && this.toolScope?.originalMessage) allMessages = allMessages.map(message => this.toolScope.originalMessage(baseSessionId, message))
    // Auxiliary producers (session-title, compaction) must not touch the user's
    // web conversation: give them their own conversation key, and never inject
    // tools or the context attachment there.
    const sessionId = isMainChat ? baseSessionId : `${baseSessionId}#${purpose}`
    const state = this.#state(sessionId)

    // One-shot payload dump: the web UI showed a long system prompt reaching the
    // composer, so record exactly what the harness hands us (roles + prefixes).
    try {
      const dump = {
        at: new Date().toISOString(),
        purpose,
        sessionId: sessionId ?? null,
        messages: messages.map((m) => ({
          role: m?.role,
          type: typeof m?.content,
          len: messageText(m).length,
          head: messageText(m).slice(0, 100),
        })),
        tools: (options.tools || []).length,
      }
      writeFileSync(join(this.settings.stateDir, 'provider-debug.json'), JSON.stringify(dump, null, 2), 'utf8')
    } catch {}

    // Session titles are computed locally: asking the web model created an
    // extra visible conversation for every DSH session and cluttered the account.
    if (purpose.includes('title')) {
      const title = deriveTitle(messages)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    // First turn carries only the tool block plus the user's own message: the
    // DSH system prompt is huge and the web chat already has its own system
    // instructions, so sending it just bloats the composer and invites abuse
    // checks. Later turns send only the new messages.
    // DSH appends runtime-context and skill-catalog messages after the user's
    // input. They can become empty after stripReminders; exclude them before
    // choosing the final message or advancing the incremental history cursor.
    // Flattening also preserves tool results whose messageText() is empty.
    const nativeMcp = this.settings.site === 'chatgpt' && typeof this.parseReply !== 'function'
    const userMessages = allMessages.filter((message) => message.role !== 'system' && message.role !== 'assistant' &&
      !(nativeMcp && String(message.source?.callId || '').startsWith('wb_mcp_')) &&
      (flattenMessages([message]) || this.toolScope?.hasAttachments?.(baseSessionId, message)))
    const delta = state.bootstrapped ? userMessages.slice(state.sentMessages) : userMessages.slice(-1)
    // Auxiliary tasks need their system instructions and complete input on
    // every request; they do not receive the main chat's context attachment.
    let prompt = flattenMessages(isMainChat ? (delta.length > 0 ? delta : userMessages.slice(-1)) : allMessages)
    const attachments = isMainChat ? await this.toolScope?.attachmentsFor?.(baseSessionId, delta.length > 0 ? delta : userMessages.slice(-1)) || [] : []
    for (const file of attachments) if (file.mention) prompt = prompt.split(file.mention).join(`[附件：${file.name}]`)
    if (!prompt.trim() && attachments.length) prompt = '用户上传了附件，请结合附件回复。'
    if (!prompt.trim()) {
      throw new BridgeError('empty-message', `[${this.providerId}] No message text remains after removing DSH context reminders.`)
    }
    const maxChars = Number(this.settings.providers?.maxPromptChars) || 12000
    if (prompt.length > maxChars) {
      const head = prompt.slice(0, Math.floor(maxChars * 0.3))
      const tail = prompt.slice(-Math.floor(maxChars * 0.65))
      prompt = `${head}\n\n[…较早的对话已省略…]\n\n${tail}`
    }

    const tools = (Array.isArray(options.tools) ? options.tools : []).slice(0, Number(this.settings.providers?.maxPromptTools) || 16)
    const withTools = isMainChat && tools.length > 0 && typeof this.parseReply === 'function'
    const toolContext = withTools ? renderTools(tools) : ''
    const updateTools = withTools && toolContext !== state.toolContext

    // Keep the composer short: on the first turn the bulky material (DSH system
    // prompt, tool list, earlier history) is attached as a text file, so the
    // input box only carries the user's own sentence.
    let attachment = null
    if (isMainChat) {
      const background = [
        !state.bootstrapped ? flattenMessages(allMessages.filter((message) => message.role === 'system')) : '',
        updateTools ? toolContext : '',
        !state.bootstrapped ? flattenMessages(userMessages.slice(0, -1)) : '',
      ]
        .filter(Boolean)
        .join('\n\n')
      if (background) {
        attachment = {
          name: 'dsh-context.txt',
          content: `【背景上下文】以下是 DSH 的系统提示、工具清单与历史对话；请结合它回答输入框里的最后一条用户消息。\n\n${background}`,
        }
      }
    }
    // The attachment must be uploaded *inside* the session flow, after the new
    // chat exists: ChatGPT creates the conversation only when the message is
    // sent, so attaching beforehand landed it in the previous conversation.
    const message = prompt

    let reply = ''
    let streamedText = ''
    let lastSnapshot = ''
    let streamStarted = false
    let inputInterrupted = false
    const interrupt = new AbortController()
    const signal = nativeMcp && options.signal ? AbortSignal.any([options.signal, interrupt.signal]) : nativeMcp ? interrupt.signal : options.signal
    let unwatch
    const markSubmitted = () => {
      state.bootstrapped = true
      state.sentMessages = userMessages.length
      if (withTools) state.toolContext = toolContext
    }
    try {
      if (nativeMcp && isMainChat) unwatch = this.toolScope?.watchUserInput?.(baseSessionId, () => { inputInterrupted = true; interrupt.abort() })
      let nextText = null
      let wake
      const publish = ({ text }) => { nextText = streamPreview(text); const notify = wake; wake = null; notify?.() }
      const ask = () => this.session.ask(message, {
        signal,
        sessionKey: sessionId,
        attachment,
        onSubmitted: markSubmitted,
        ...(nativeMcp ? { onProgress: publish } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(this.settings.site === 'chatgpt' ? { reasoning: options.model === `${this.modelId}-instant` ? 'off' : 'on' } : {}),
      })
      const operation = this.toolScope && isMainChat ? this.toolScope.withSession(baseSessionId, ask, signal) : ask()
      let result
      if (nativeMcp) {
        let done = false
        let failure
        const finished = operation.then(value => { result = value }, error => { failure = error }).finally(() => { done = true; const notify = wake; wake = null; notify?.() })
        while (!done || nextText !== null) {
          if (nextText !== null) {
            const text = nextText
            nextText = null
            const delta = snapshotDelta(lastSnapshot, text)
            if (delta !== null) lastSnapshot = text
            if (delta) {
              if (!streamStarted) { yield { type: 'block-start', index: 0, blockType: 'text' }; streamStarted = true }
              yield { type: 'text-delta', index: 0, text: delta }
              streamedText += delta
            }
          } else if (!done) await new Promise(resolve => { wake = resolve; if (done || nextText !== null) resolve() })
        }
        await finished
        if (failure) throw failure
      } else result = await operation
      reply = result.reply
      markSubmitted()
    } catch (err) {
      if (inputInterrupted || err.code === 'web-generation-stopped' || err.code === 'aborted' || options.signal?.aborted) {
        if (err.code === 'web-generation-stopped') this.toolScope?.cancelSession?.(baseSessionId)
        if (streamStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text: streamedText } }
        yield { type: 'finish', reason: inputInterrupted && !options.signal?.aborted
          ? { kind: 'stop' }
          : { kind: 'aborted', failure: { code: 'ABORTED', message: err.code === 'web-generation-stopped' ? '网页生成已中止。' : '请求已中止。' } } }
        return
      }
      const error = new Error(err.code === 'attachment-quota-exceeded' ? err.message : `[${this.providerId}] ${err.code || 'error'}: ${err.message}`)
      error.cause = err
      throw error
    } finally { unwatch?.() }

    if (withTools) {
      const parsed = this.parseReply(reply)
      if (parsed.kind === 'calls' && parsed.calls.length > 0) {
        let index = 0
        for (const call of parsed.calls) {
          const id = `wb_${Date.now()}_${index}`
          const args = JSON.stringify(call.arguments || {})
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: args }
          yield { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: args } }
          index += 1
        }
        yield { type: 'finish', reason: { kind: 'tool-use' } }
        return
      }
      if (parsed.kind === 'final') reply = parsed.text
    }

    if (!streamStarted) yield { type: 'block-start', index: 0, blockType: 'text' }
    {
      const rest = streamStarted ? snapshotDelta(lastSnapshot, reply) : reply
      if (rest) yield { type: 'text-delta', index: 0, text: rest }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
