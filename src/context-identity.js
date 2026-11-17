import { createHash } from 'node:crypto'

const TRANSIENT_KINDS = new Set(['user', 'tool', 'model', 'time-context', 'webbridge-context-checkpoint', 'repeat-tool-reminder'])

export function contextHash(value) {
  return createHash('sha256').update(JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest('hex')
}

function identity(message) {
  const { id, turn, step, completedCallId, callId, time, timestamp, createdAt, rpcId, baseline, baselineIdentity, ...source } = message?.source || {}
  const scope = {
    role: message?.role, kind: source.kind, scope: source.scope, path: source.path, name: source.name,
    changes: Array.isArray(source.changes) ? source.changes.map(change => ({ scope: change.scope, path: change.path })) : undefined,
    sections: Array.isArray(source.sections) ? source.sections.map(section => section.name) : undefined,
  }
  return { scope: contextHash(scope), hash: contextHash({ role: message?.role, source, content: message?.content }) }
}

export function isRefreshContext(message) {
  if (TRANSIENT_KINDS.has(message?.source?.kind)) return false
  return message?.role === 'system' || message?.role === 'developer' ||
    message?.role === 'user' && typeof message.source?.kind === 'string' && Boolean(message.source.kind)
}

/** Track events separately from content so replay and A → B → A are distinct. */
export class ContextIdentity {
  constructor(messages = []) {
    this.events = new Set()
    this.latest = new Map()
    this.hashes = []
    for (const message of messages) this.accept(message)
  }

  accept(message) {
    const { scope, hash } = identity(message)
    const event = `${message?.id || ''}:${hash}`
    if (this.events.has(event)) return false
    this.events.add(event)
    if (this.latest.get(scope) === hash) return false
    this.latest.set(scope, hash)
    this.hashes.push(hash)
    return true
  }
}

export function contextHashes(messages) {
  return new ContextIdentity((messages || []).filter(isRefreshContext)).hashes
}
