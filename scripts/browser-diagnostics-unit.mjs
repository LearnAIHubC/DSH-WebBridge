import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BrowserDiagnostics, diagnosticText, diagnosticUrl } from '../src/browser-diagnostics.js'
import { parseDebugQuery } from '../src/setup-contract.js'
import { BrowserDriver } from '../src/driver.js'

test('browser diagnostics redact credentials, query values, emails, and local user paths', () => {
  const url = diagnosticUrl('https://user:secret@example.test/api?token=private&email=person@example.test#private')
  assert.ok(!url.includes('private') && !url.includes('secret') && !url.includes('person'))
  assert.ok(!diagnosticText('Bearer test-token sk-abc123 wbr_abc123 person@example.test /Users/test/private').includes('test-token'))
  assert.equal(diagnosticText('{"apiKey":"private"}'), '[sensitive console data omitted]')
  assert.equal(diagnosticText('Cookie: session=private'), '[sensitive console data omitted]')
  assert.equal(diagnosticUrl('data:text/html,private'), 'data:[redacted]')
})

test('bounded records support page, failure, resource-type, and text filters and clearing', () => {
  const diagnostics = new BrowserDiagnostics()
  for (let index = 0; index < 600; index++) diagnostics.push('network', { pageId: index % 2 ? 'A' : 'B', url: `/request-${index}`, ok: index % 3 !== 0, resourceType: 'fetch' })
  assert.equal(diagnostics.records.network.length, 500)
  const found = diagnostics.read('network', { pageId: 'A', errors: true, type: 'fetch', filter: 'request-5', limit: 4 })
  assert.equal(found.entries.length, 4)
  assert.ok(found.entries.every(entry => entry.pageId === 'A' && entry.ok === false))
  assert.equal(diagnostics.read('network', { pageId: 'A', clear: true }).entries.length, 0)
  assert.ok(diagnostics.read('network').entries.every(entry => entry.pageId === 'B'))
})

test('network failures are recorded in their own active request trace without unrelated traffic or challenge URLs', () => {
  const driver = new BrowserDriver({ stateDir: '' })
  const records = []
  driver.sessionPages.set('session-A', 'page-A')
  driver.sessionPages.set('session-B', 'page-B')
  driver.activities.set('session-A', { emit: (...record) => records.push(record) })
  const entry = { pageId: 'page-A', resourceType: 'fetch', url: 'https://chatgpt.com/backend-api/f/conversation', status: 0, ok: false, failed: 'net::ERR_ABORTED' }
  driver.diagnostics.push('network', entry)
  driver.diagnostics.push('network', { ...entry, pageId: 'page-B' })
  driver.diagnostics.push('network', { ...entry, ok: true, url: 'https://chatgpt.com/telemetry' })
  driver.diagnostics.push('network', { ...entry, url: 'https://challenges.cloudflare.com/challenge/PRIVATE_CHALLENGE' })
  assert.equal(records.length, 1)
  assert.equal(records[0][0], 'network.failed')
  assert.equal(records[0][2].code, 'net::ERR_ABORTED')
})

test('page observers attach once and dismiss dialogs without accepting them', async () => {
  const diagnostics = new BrowserDiagnostics()
  const page = new EventEmitter()
  page.url = () => 'https://example.test/?token=private'
  diagnostics.watch(page, () => 'A'); diagnostics.watch(page, () => 'A')
  page.emit('console', { type: () => 'error', text: () => 'safe failure', location: () => ({ url: 'https://example.test/app.js?key=private', lineNumber: 1 }) })
  let dismissed = false
  page.emit('dialog', { type: () => 'confirm', message: () => 'Continue?', dismiss: async () => { dismissed = true } })
  assert.equal(diagnostics.read('console').entries.length, 1)
  assert.equal(diagnostics.read('dialogs').entries[0].policy, 'dismiss')
  assert.equal(dismissed, true)
})

test('debug remote queries validate limits and retain only supported fields', () => {
  assert.deepEqual(parseDebugQuery({ action: 'console', pageId: 'A', limit: 50, runtimeApiKey: 'private' }), { action: 'console', pageId: 'A', limit: 50 })
  assert.throws(() => parseDebugQuery({ action: 'open' }))
  assert.throws(() => parseDebugQuery({ action: 'network', limit: 1000 }))
  assert.throws(() => parseDebugQuery({ action: 'network', clear: 'true' }))
})
