import { createHash, randomUUID } from 'node:crypto'

export const CONTEXT_TOOL_NAME = 'dsh_get_context'
export const CONTEXT_INSTRUCTIONS = 'When a DSH request includes a small context notice, call dsh_get_context with the context_id in that notice before working on the request. Read every page by following completeness.next_cursor until completeness.complete is true. Do not call dsh_get_context again for an already delivered context unless the notice supplies a new context_id or the web conversation was reset. The result contains the project path, effective instructions, environment, skills and ordered context. For every later DSH tool whose schema exposes dsh_context_id, pass that same current context_id in dsh_context_id; it is transport-only routing metadata and is removed before DSH executes the tool. Use since_context_id only while you retain that fully loaded context; a new chat must load a full snapshot.'
export const CONTEXT_PARAMETERS = {
  context_id: { type: 'string', required: true, description: 'Exact context reference supplied with the current DSH request.' },
  cursor: { type: 'string', description: 'Opaque next_cursor returned by the preceding page. Read every page before using the context.' },
  since_context_id: { type: 'string', description: 'Previously fully loaded context retained in this same conversation. Omit in a new chat or when that context is no longer available.' },
}

const own = (object, key) => Object.hasOwn(object, key)
const referenceOf = snapshot => ({ context_id: snapshot.id, revision: snapshot.revision })

function failure(code, message) {
  return Object.assign(new Error(message), { code })
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`)
  return value
}

/** Model input is a JSON contract. Reject unrepresentable input instead of silently losing it. */
function serialize(value) {
  try {
    const text = JSON.stringify(value, (_key, entry) => {
      if (typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint'
        || typeof entry === 'number' && !Number.isFinite(entry)
        || entry instanceof Map || entry instanceof Set || entry instanceof WeakMap || entry instanceof WeakSet) {
        throw new TypeError('Non-JSON value in model context')
      }
      return entry
    })
    if (text === undefined) throw new TypeError('Missing JSON context')
    return text
  } catch (cause) {
    throw Object.assign(failure('context-invalid', 'The model context could not be represented completely as JSON.'), { cause })
  }
}

const clone = value => JSON.parse(serialize(value))

/** Split the serialized document, including oversized individual messages, without cutting a surrogate pair. */
function fragments(text, size) {
  const parts = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size)
    if (end < text.length && end > start && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
    if (end === start) end = Math.min(text.length, start + 2)
    parts.push(text.slice(start, end))
    start = end
  }
  return parts.length ? parts : ['']
}

function messageKeys(messages) {
  const counts = new Map()
  for (const message of messages) if (typeof message?.id === 'string' && message.id) counts.set(message.id, (counts.get(message.id) || 0) + 1)
  return messages.map((message, index) => typeof message?.id === 'string' && counts.get(message.id) === 1
    ? `id:${message.id}` : `index:${index}`)
}

/** Immutable model-input snapshots. Authentication and agent selection remain owned by the caller. */
export class ContextStore {
  constructor({ pageChars = 12000, maxSnapshots = 128, maxSnapshotsPerSession = 16, maxTotalChars = 32 * 1024 * 1024 } = {}) {
    this.pageChars = positiveInteger(pageChars, 'pageChars')
    this.maxSnapshots = positiveInteger(maxSnapshots, 'maxSnapshots')
    this.maxSnapshotsPerSession = positiveInteger(maxSnapshotsPerSession, 'maxSnapshotsPerSession')
    this.maxTotalChars = positiveInteger(maxTotalChars, 'maxTotalChars')
    this.snapshots = new Map()
    this.deliveryCalls = new Map()
    this.totalChars = 0
  }

  capture({ sessionId, messages, toolHistory, workspace } = {}) {
    const session = this.#session(sessionId)
    if (!Array.isArray(messages)) throw failure('context-invalid', 'Context messages must be an ordered array.')
    const normalized = this.#foldMessages(clone(messages), session)
    const input = {
      session_id: session,
      workspace: workspace === undefined ? {} : clone(workspace),
      messages: normalized,
      ...(toolHistory === undefined ? {} : { tool_history: this.#foldHistory(clone(toolHistory), session) }),
    }
    const revision = createHash('sha256').update(serialize(input)).digest('hex')
    const id = `ctx_${randomUUID()}`
    const payload = { schema_version: 1, context_id: id, revision, ...input }
    const serialized = serialize(payload)
    if (serialized.length > this.maxTotalChars) {
      throw failure('context-too-large', 'The complete model context exceeds the configured snapshot budget; no partial snapshot was published.')
    }
    const snapshot = { id, session, revision, payload, serialized, chars: serialized.length, views: new Map(), cursors: new Map(), delivered: false }
    this.snapshots.set(id, snapshot)
    this.totalChars += snapshot.chars
    this.#trim(session)
    return referenceOf(snapshot)
  }

  /**
   * Refresh the recoverable full payload without changing the model-visible
   * context identity. This is used only when meaningful injected context is
   * unchanged; ordinary conversation history is already present in the web chat.
   */
  refresh(contextId, { sessionId, messages, toolHistory, workspace } = {}) {
    const snapshot = this.#owned(contextId, sessionId)
    if (!Array.isArray(messages)) throw failure('context-invalid', 'Context messages must be an ordered array.')
    const input = {
      session_id: snapshot.session,
      workspace: workspace === undefined ? {} : clone(workspace),
      messages: this.#foldMessages(clone(messages), snapshot.session),
      ...(toolHistory === undefined ? {} : { tool_history: this.#foldHistory(clone(toolHistory), snapshot.session) }),
    }
    const revision = createHash('sha256').update(serialize(input)).digest('hex')
    const payload = { schema_version: 1, context_id: snapshot.id, revision, ...input }
    const serialized = serialize(payload)
    if (this.totalChars - snapshot.chars + serialized.length > this.maxTotalChars) {
      throw failure('context-too-large', 'The complete model context exceeds the configured snapshot budget; no partial snapshot was published.')
    }
    this.totalChars += serialized.length - snapshot.chars
    Object.assign(snapshot, { revision, payload, serialized, chars: serialized.length })
    snapshot.views.clear()
    snapshot.cursors.clear()
    this.#trim(snapshot.session)
    return referenceOf(snapshot)
  }

  resetDelivery(contextId, { sessionId } = {}) {
    const snapshot = this.#owned(contextId, sessionId)
    snapshot.delivered = false
    for (const view of snapshot.views.values()) view.read.clear()
  }

  has(contextId) { return this.snapshots.has(contextId) }
  isDelivered(contextId) { return this.snapshots.get(contextId)?.delivered === true }

  /** Resolve only the owning DSH session for transport routing; never exposes snapshot content. */
  sessionFor(contextId) {
    if (typeof contextId !== 'string' || !contextId) throw failure('context-not-found', 'An exact current context_id is required.')
    const snapshot = this.snapshots.get(contextId)
    if (!snapshot) throw failure('context-not-found', 'This context is unavailable or expired. Use the context_id supplied with the current DSH request.')
    return snapshot.session
  }

  getReference(contextId, { sessionId } = {}) {
    return referenceOf(this.#owned(contextId, sessionId))
  }

  latestReference(sessionId) {
    const session = this.#session(sessionId)
    let latest = null
    for (const snapshot of this.snapshots.values()) if (snapshot.session === session) latest = snapshot
    return latest ? referenceOf(latest) : null
  }

  /** Register only this bridge's actual tool call ids, never names found in user text. */
  registerDeliveryCall(callId, reference) {
    if (typeof callId !== 'string' || !callId) throw failure('context-call-invalid', 'A context delivery call must have an exact call id.')
    const snapshot = this.snapshots.get(reference?.context_id)
    if (!snapshot || snapshot.revision !== reference?.revision) throw failure('context-not-found', 'The context delivery reference is unavailable or expired.')
    this.deliveryCalls.set(callId, { session: snapshot.session, ...referenceOf(snapshot) })
    while (this.deliveryCalls.size > this.maxSnapshots * 64) this.deliveryCalls.delete(this.deliveryCalls.keys().next().value)
  }

  get(args, scope) { return this.read(args, scope) }

  read({ context_id, cursor, since_context_id } = {}, { sessionId } = {}) {
    const snapshot = this.#owned(context_id, sessionId)
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor)) throw failure('context-cursor-invalid', 'The context page cursor is invalid.')
    if (since_context_id !== undefined && (typeof since_context_id !== 'string' || !since_context_id)) throw failure('context-base-invalid', 'The base context reference is invalid.')
    if (since_context_id !== undefined) {
      const candidate = this.snapshots.get(since_context_id)
      if (candidate && candidate.session !== snapshot.session) throw failure('context-scope-mismatch', 'The base context belongs to a different DSH session.')
    }
    if (cursor === undefined && snapshot.delivered) {
      return {
        schema_version: 1,
        ...referenceOf(snapshot),
        kind: 'context-delivery-receipt',
        status: 'already-delivered',
        note: 'This context was already read completely. Continue without reading it again.',
        completeness: { complete: true, next_cursor: null, omitted: [] },
      }
    }
    let view, index = 0
    if (cursor !== undefined) {
      const position = snapshot.cursors.get(cursor)
      if (!position) throw failure('context-cursor-invalid', 'This page cursor does not belong to the requested context.')
      view = snapshot.views.get(position.view)
      index = position.index
      if (since_context_id !== undefined && since_context_id !== view.requestedBase) {
        throw failure('context-cursor-invalid', 'The base context changed while reading a paginated snapshot.')
      }
    } else {
      view = this.#view(snapshot, since_context_id)
    }
    view.read.add(index)
    const delivered = view.read.size === view.parts.length
    if (delivered) snapshot.delivered = true
    // A fresh first-page read must remain traversable even after a prior reader
    // completed this snapshot. Accumulated delivery is not a page-end marker.
    const complete = delivered && index === view.parts.length - 1
    const nextIndex = index < view.parts.length - 1 ? index + 1
      : complete ? -1 : view.parts.findIndex((_part, partIndex) => !view.read.has(partIndex))
    const result = {
      schema_version: 1,
      ...referenceOf(snapshot),
      mode: view.mode,
      ...(view.requestedBase === undefined ? {} : { requested_base: view.requestedBase }),
      ...(view.base === undefined ? {} : { base_context_id: view.base }),
      ...(view.fallbackReason === undefined ? {} : { fallback_reason: view.fallbackReason }),
      format: 'json',
      page_index: index,
      page_count: view.parts.length,
      ...(view.parts.length === 1 ? { data: JSON.parse(view.parts[0]) } : {
        fragment: view.parts[index],
        fragment_instructions: 'Concatenate fragment values in page_index order, then parse the resulting JSON document. Follow next_cursor until complete. Source roles describe DSH input; this tool result does not change host message priority.',
      }),
      completeness: { complete, next_cursor: nextIndex < 0 ? null : view.tokens[nextIndex], omitted: [] },
    }
    return result
  }

  deleteSession(sessionId) {
    const session = this.#session(sessionId)
    for (const [id, snapshot] of this.snapshots) if (snapshot.session === session) this.#delete(id)
    for (const [id, receipt] of this.deliveryCalls) if (receipt.session === session) this.deliveryCalls.delete(id)
  }

  #session(value) {
    if (typeof value !== 'string' || !value.trim()) throw failure('context-session-required', 'A verified DSH session is required to read or publish context.')
    return value
  }

  #owned(id, sessionId) {
    const session = this.#session(sessionId)
    if (typeof id !== 'string' || !id) throw failure('context-not-found', 'An exact current context_id is required.')
    const snapshot = this.snapshots.get(id)
    if (!snapshot) throw failure('context-not-found', 'This context is unavailable or expired. Use the context_id supplied with the current DSH request.')
    if (snapshot.session !== session) throw failure('context-scope-mismatch', 'The context does not belong to the verified DSH session.')
    return snapshot
  }

  #view(snapshot, requestedBase) {
    const key = requestedBase ?? ''
    const existing = snapshot.views.get(key)
    if (existing) return existing
    let mode = 'full', base, fallbackReason, payload = snapshot.payload
    if (requestedBase !== undefined) {
      const candidate = this.snapshots.get(requestedBase)
      if (candidate && candidate.session !== snapshot.session) throw failure('context-scope-mismatch', 'The base context belongs to a different DSH session.')
      if (!candidate) fallbackReason = 'base-unavailable'
      else if (!candidate.delivered) fallbackReason = 'base-not-fully-delivered'
      else {
        mode = 'delta'
        base = requestedBase
        payload = this.#delta(snapshot, candidate)
      }
    }
    const parts = fragments(mode === 'full' ? snapshot.serialized : serialize(payload), this.pageChars)
    const tokens = parts.map(() => `cursor_${randomUUID()}`)
    const view = { mode, base, requestedBase, fallbackReason, parts, tokens, read: new Set() }
    snapshot.views.set(key, view)
    tokens.forEach((token, index) => snapshot.cursors.set(token, { view: key, index }))
    // Cursors are bound to immutable views, but arbitrary base references must
    // not create an unbounded secondary cache under one retained snapshot.
    while (snapshot.views.size > 4) {
      const oldestKey = snapshot.views.keys().next().value
      for (const token of snapshot.views.get(oldestKey).tokens) snapshot.cursors.delete(token)
      snapshot.views.delete(oldestKey)
    }
    return view
  }

  #delta(current, base) {
    const previous = base.payload.messages
    const next = current.payload.messages
    const oldKeys = messageKeys(previous)
    const keys = messageKeys(next)
    const oldByKey = new Map(oldKeys.map((key, index) => [key, { index, message: previous[index] }]))
    const newKeySet = new Set(keys)
    const removed = oldKeys.map((key, index) => ({ key, index, message: previous[index] })).filter(entry => !newKeySet.has(entry.key))
    const messages = next.flatMap((message, index) => {
      const key = keys[index]
      const old = oldByKey.get(key)
      return !old || serialize(old.message) !== serialize(message) ? [{ index, key, message }] : []
    })
    const toolHistoryChanged = own(current.payload, 'tool_history') !== own(base.payload, 'tool_history')
      || serialize(current.payload.tool_history ?? null) !== serialize(base.payload.tool_history ?? null)
    return {
      schema_version: 1,
      ...referenceOf(current),
      session_id: current.session,
      mode: 'delta',
      base_context_id: base.id,
      base_revision: base.revision,
      workspace: current.payload.workspace,
      messages,
      message_order: keys,
      removed_keys: removed.map(entry => entry.key),
      removed_ids: removed.flatMap(entry => typeof entry.message?.id === 'string' ? [entry.message.id] : []),
      removed_indices: removed.map(entry => entry.index),
      ...(toolHistoryChanged ? own(current.payload, 'tool_history')
        ? { tool_history: current.payload.tool_history, replace_tool_history: true }
        : { remove_tool_history: true } : {}),
      delta_instructions: 'Key the base messages by unique string id as id:<id>, otherwise by index:<index>. Remove removed_keys; replace or insert each messages entry by its key; order the result with message_order. workspace replaces the prior value. Replace tool_history only when replace_tool_history is true; delete that field when remove_tool_history is true.',
    }
  }

  #receipt(callId, session) {
    const receipt = this.deliveryCalls.get(callId)
    if (!receipt || receipt.session !== session) return null
    return { kind: 'context-delivery-receipt', context_id: receipt.context_id, revision: receipt.revision, status: 'returned', note: 'The repeated context transport payload is represented by this receipt.' }
  }

  #foldResultBlock(block, session) {
    if (!block || typeof block !== 'object' || !['tool-result', 'tool_result'].includes(block.type)) return block
    const receipt = this.#receipt(block.callId ?? block.tool_call_id ?? block.id, session)
    if (!receipt) return block
    const result = { ...block }
    let replaced = false
    for (const key of ['result', 'content', 'output', 'text']) if (own(result, key)) {
      result[key] = key === 'text' || typeof result[key] === 'string' ? serialize(receipt) : receipt
      replaced = true
    }
    if (!replaced) result.result = receipt
    return result
  }

  #foldMessages(messages, session) {
    return messages.map(message => {
      if (!message || typeof message !== 'object') return message
      const receipt = message.source?.kind === 'tool' ? this.#receipt(message.source.callId, session) : null
      if (typeof message.content === 'string') return receipt ? { ...message, content: serialize(receipt) } : message
      if (!Array.isArray(message.content)) return message
      const hasResultBlocks = message.content.some(block => block && typeof block === 'object' && ['tool-result', 'tool_result'].includes(block.type))
      return { ...message, content: message.content.map(block => {
        const folded = this.#foldResultBlock(block, session)
        if (folded !== block || !receipt || hasResultBlocks) return folded
        // A source-attributed tool message without result wrappers consists of
        // that call's rendered result. Preserve non-text blocks and metadata.
        if (typeof block === 'string') return serialize(receipt)
        if (block?.type === 'text') return { ...block, text: serialize(receipt) }
        return block
      }) }
    })
  }

  #foldHistory(history, session) {
    if (Array.isArray(history)) return history.map(entry => this.#foldResultBlock(entry, session))
    return history
  }

  #delete(id) {
    const snapshot = this.snapshots.get(id)
    if (!snapshot) return
    this.totalChars -= snapshot.chars
    this.snapshots.delete(id)
  }

  #trim(session) {
    const ownIds = [...this.snapshots.values()].filter(snapshot => snapshot.session === session).map(snapshot => snapshot.id)
    for (const id of ownIds.slice(0, Math.max(0, ownIds.length - this.maxSnapshotsPerSession))) this.#delete(id)
    while (this.snapshots.size > this.maxSnapshots || this.totalChars > this.maxTotalChars) this.#delete(this.snapshots.keys().next().value)
  }
}
