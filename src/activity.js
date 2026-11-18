import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { diagnosticText } from './browser-diagnostics.js'

const MAX_BYTES = 1024 * 1024
const warned = new Set()

/** Describe a transport payload without retaining its values. */
export function payloadShape(value) {
  return {
    type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
    ...(value && typeof value === 'object' ? { keys: Object.keys(value).slice(0, 40) } : {}),
    bytes: Buffer.byteLength(JSON.stringify(value) ?? ''),
  }
}

export function createActivity(settings, log = () => {}, { sessionId = '', site = settings.site } = {}) {
  const requestId = randomUUID()
  const session = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)
  const started = Date.now()
  return {
    emit(event, message, details = {}) {
      const record = { at: new Date().toISOString(), requestId, session, site, event, message, elapsedMs: Date.now() - started, ...details }
      // Callers supply only identifiers, selectors, counters and payload shapes.
      const line = JSON.stringify(record, (_key, value) => typeof value === 'string' ? diagnosticText(value) : value)
      if (settings.stateDir) {
        const path = join(settings.stateDir, 'activity.log')
        try {
          mkdirSync(settings.stateDir, { recursive: true })
          if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) + 1 > MAX_BYTES) {
            rmSync(`${path}.2`, { force: true })
            if (existsSync(`${path}.1`)) renameSync(`${path}.1`, `${path}.2`)
            renameSync(path, `${path}.1`)
          }
          appendFileSync(path, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
        } catch (error) {
          if (!warned.has(path)) {
            warned.add(path)
            try { log(`[webbridge:flow] 无法写入流程日志（${error.code || 'io-error'}）`) } catch {}
          }
        }
      }
      try { log(`[webbridge:flow] ${line}`) } catch {}
    },
  }
}
