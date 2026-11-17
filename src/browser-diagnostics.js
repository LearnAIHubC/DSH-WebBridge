export function diagnosticUrl(value) {
  try {
    const url = new URL(String(value))
    if (!['http:', 'https:', 'about:'].includes(url.protocol)) return `${url.protocol}[redacted]`
    if (url.username) url.username = '[redacted]'
    if (url.password) url.password = '[redacted]'
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]')
    url.hash = ''
    return url.toString()
  } catch { return '[invalid URL]' }
}

export function diagnosticText(value) {
  const text = String(value || '')
  if (/\b(?:authorization|cookie|password|access_token|refresh_token|api[_-]?key)["']?\s*[=:]/i.test(text)) return '[sensitive console data omitted]'
  if (/^\s*[\[{]/.test(text) && text.length > 100) return '[structured console payload omitted]'
  return text.replace(/https?:\/\/[^\s<>"']+/g, diagnosticUrl)
    .replace(/\bBearer\s+\S+|\bsk-[\w-]+|\bwbr_[\w-]+/gi, '[redacted]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s:]+/gi, '<path>').slice(0, 4000)
}

export class BrowserDiagnostics {
  constructor() {
    this.records = { console: [], network: [], dialogs: [] }
    this.watched = new WeakSet()
    this.starts = new WeakMap()
  }
  push(kind, entry) {
    const records = this.records[kind]
    records.push({ ts: Date.now(), ...entry })
    const maximum = kind === 'console' ? 300 : kind === 'network' ? 500 : 100
    if (records.length > maximum) records.splice(0, records.length - maximum)
  }
  watch(page, pageId = () => '') {
    if (this.watched.has(page)) return
    this.watched.add(page)
    const context = () => ({ pageId: pageId(), page: diagnosticUrl(page.url()) })
    page.on('console', message => this.push('console', { ...context(), type: message.type(), text: diagnosticText(message.text()), location: { ...message.location(), url: diagnosticUrl(message.location()?.url || page.url()) } }))
    page.on('pageerror', error => this.push('console', { ...context(), type: 'pageerror', text: diagnosticText(error.stack || error.message) }))
    page.on('dialog', dialog => {
      this.push('dialogs', { ...context(), type: dialog.type(), message: diagnosticText(dialog.message()), policy: 'dismiss' })
      dialog.dismiss().catch(() => {})
    })
    page.on('request', request => this.starts.set(request, Date.now()))
    page.on('response', response => {
      const request = response.request()
      this.push('network', { ...context(), method: request.method(), url: diagnosticUrl(response.url()), resourceType: request.resourceType(), status: response.status(), ok: response.ok(), durationMs: Date.now() - (this.starts.get(request) || Date.now()) })
    })
    page.on('requestfailed', request => this.push('network', { ...context(), method: request.method(), url: diagnosticUrl(request.url()), resourceType: request.resourceType(), status: 0, ok: false, failed: diagnosticText(request.failure()?.errorText), durationMs: Date.now() - (this.starts.get(request) || Date.now()) }))
  }
  read(kind, { limit = 30, filter = '', errors = false, type, pageId, clear = false } = {}) {
    const records = this.records[kind]
    if (!records) throw new Error('未知的浏览器调试记录类型。')
    if (clear) this.records[kind] = pageId ? records.filter(entry => entry.pageId !== pageId) : []
    const selected = this.records[kind].filter(entry => {
      const isError = kind === 'console' ? ['error', 'warning', 'pageerror'].includes(entry.type) : entry.ok === false
      return (!pageId || entry.pageId === pageId) && (!errors || isError) && (!type || entry.resourceType === type || entry.type === type) && (!filter || JSON.stringify(entry).toLowerCase().includes(String(filter).toLowerCase()))
    })
    const result = { entries: selected.slice(-Math.max(1, Math.min(Number(limit) || 30, 500))), total: selected.length }
    return result
  }
}
