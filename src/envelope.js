/** Unified tool result envelope and errors.
 *
 * Adapted from Nexus (`apps/server/src/mcp/errors.ts:65-126`,
 * `sanitizeMcpOutput`): every tool returns one shape, errors carry a stable
 * code, and absolute paths never leak into model-facing text.
 */

/** Absolute Windows / POSIX home paths replaced with <path>. */
export function sanitizeText(text) {
  if (!text) return ''
  return String(text)
    .replace(/[a-zA-Z]:\\[^"'\n\r<>|?*]+/g, '<path>')
    .replace(/\/(Users|home|root|var|etc)\/[^"'\n\r<>|?*]+/g, '<path>')
}

export class BridgeError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.details = details
  }
}

export function ok(data = {}) {
  return JSON.stringify({ ok: true, ...data }, null, 2)
}

export function fail(code, message, details) {
  const body = {
    ok: false,
    error: {
      code,
      message: sanitizeText(message),
      ...(details ? { details } : {}),
    },
  }
  return JSON.stringify(body, null, 2)
}

export function toFailure(err) {
  if (err instanceof BridgeError) return fail(err.code, err.message, err.details)
  return fail('internal-error', err?.message || String(err))
}

/** Deterministic short digest used for audit records instead of raw arguments.
 *  Same intent as Nexus `canonicalPayloadHash` (packages/shared/src/crypto.ts). */
export function digest(value) {
  const canon = canonicalJson(value)
  let hash = 0x811c9dc5
  for (let i = 0; i < canon.length; i++) {
    hash ^= canon.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

/** Audit record with an explicit whitelist: no message text, no page content,
 *  no tokens (Nexus `McpContext.logAudit`, apps/server/src/mcp/context.ts:611). */
export function auditRecord(event, fields) {
  return {
    event,
    at: new Date().toISOString(),
    site: fields.site,
    profile: fields.profile,
    tool: fields.tool,
    argsDigest: fields.args ? digest(fields.args) : undefined,
    durationMs: fields.durationMs,
    result: fields.result,
    code: fields.code,
  }
}
