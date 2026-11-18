import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserDriver } from '../src/driver.js'
import { ChatgptModels } from '../src/models/chatgpt.js'

const root = await mkdtemp(join(tmpdir(), 'wb-paid-picker-'))
const driver = new BrowserDriver({ stateDir: root, browserProfileDir: join(root, 'profile') })
let definitions = [{ name: 'Account model Alpha', labels: ['Instant', 'Deep', 'Maximum'] }, { name: 'Account model Beta', labels: ['Auto', 'Full'] }]
function boot(definitions) {
  let model = 1, power = 1, view = 'simple', opened = false
  window.trustedKeys = []
  const make = (tag, attrs = {}, text = '') => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
    node.textContent = text
    return node
  }
  const trigger = document.querySelector('form button')
  function render() {
    trigger.setAttribute('aria-expanded', String(opened))
    trigger.textContent = `Thinking effort ${definitions[model].labels[power]}`
    const holder = document.querySelector('#picker')
    holder.replaceChildren()
    if (!opened) return
    const root = make('div', { 'data-model-picker-view': view })
    const simple = make('div', view === 'simple' ? {} : { inert: '', hidden: '' })
    const toggle = make('div', { 'data-model-picker-view-toggle': '' })
    toggle.append(make('span', { 'data-effort-only': '' }, definitions[model].labels[power]))
    toggle.onclick = () => { view = 'advanced'; render() }
    const slider = make('div', { 'data-reasoning-slider': '', tabindex: '0' })
    slider.append(make('span', { role: 'slider', 'aria-valuemin': '0', 'aria-valuemax': String(definitions[model].labels.length - 1), 'aria-valuenow': String(power) }))
    slider.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
      trustedKeys.push(event.isTrusted)
      power = Math.max(0, Math.min(definitions[model].labels.length - 1, power + (event.key === 'ArrowRight' ? 1 : -1)))
      render()
    }
    simple.append(toggle, slider)
    const advanced = make('div', view === 'advanced' ? {} : { inert: '', hidden: '' })
    for (const [index, entry] of definitions.entries()) {
      const option = make('div', { role: 'menuitemradio', 'aria-checked': String(index === model) })
      const row = make('div', { 'data-menu-row-content': '' })
      row.append(make('span', {}, entry.name)); option.append(row)
      option.onclick = () => { model = index; power = Math.min(power, definitions[model].labels.length - 1); view = 'simple'; render() }
      advanced.append(option)
    }
    root.append(simple, advanced); holder.append(root)
  }
  trigger.onclick = () => { opened = !opened; render() }
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { opened = false; render() } })
  render()
}
const fixture = () => `<style>[data-reasoning-slider]{min-height:20px}</style><button data-testid="accounts-profile-button">Account</button><button type="button" data-composer-navigation-target="reasoning" aria-haspopup="menu" data-selected-reasoning-effort="max">Header model</button><form><button type="button" data-composer-navigation-target="reasoning" aria-haspopup="menu"></button></form><div id="picker"></div><script>(${boot.toString()})(${JSON.stringify(definitions)})</script>`
try {
  const context = await driver.ensureContext()
  await context.route('https://chatgpt.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture() }))
  const changes = []
  const models = new ChatgptModels({ settings: { stateDir: root }, driver, onChange: () => changes.push(true) })
  const catalog = await models.list(true)
  assert.equal(catalog.length, 5)
  assert.deepEqual(catalog.map(entry => entry.label), ['Instant', 'Deep', 'Maximum', 'Auto', 'Full'])
  await driver.exclusive(async () => {
    const page = await driver.currentPage()
    assert.equal(await page.locator('button[data-composer-navigation-target="reasoning"]').count(), 2)
    assert.equal(await page.locator('form button').getAttribute('aria-expanded'), 'false')
    assert.ok((await page.locator('form button').innerText()).includes('Full'))
    assert.ok((await page.evaluate(() => trustedKeys)).every(Boolean))
  }, '__webbridge_model_catalog__')
  await driver.exclusive(async () => {
    await driver.open('https://chatgpt.com/')
    await models.select(catalog[1])
    const page = await driver.currentPage()
    assert.ok((await page.locator('form button').innerText()).includes('Deep'))
    assert.equal(await page.locator('form button').getAttribute('aria-expanded'), 'false')
    await assert.rejects(() => models.select({ ...catalog[1], modelName: 'Unavailable model' }), error => error.code === 'model-unavailable')
    assert.equal((await models.list()).length, 5)
  }, 'paid-test-session')
  definitions = [...definitions, { name: 'New account model', labels: ['Low', 'Balanced', 'High', 'Special'] }]
  const refreshed = await models.list(true)
  assert.equal(refreshed.length, 9)
  assert.equal(refreshed[1].key, catalog[1].key)
  assert.equal(changes.length, 2)

  const page = await driver.currentPage()
  await context.route('https://diagnostics.test/**', route => route.fulfill({ status: 503, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'simulated failure' }))
  await page.evaluate(async () => {
    console.warn('simulated browser warning')
    console.log('Authorization: Bearer dummy-secret')
    await fetch('https://diagnostics.test/failure?token=dummy-secret')
    alert('test dialog')
  })
  const network = await driver.inspect('network', { errors: true, type: 'fetch' })
  assert.ok(network.entries.some(entry => entry.status === 503))
  assert.ok(!JSON.stringify(network).includes('dummy-secret'))
  const debug = await driver.inspect('debug')
  assert.ok(debug.screenshot.path.endsWith('.png'))
  assert.ok(debug.dialogs.entries.some(entry => entry.policy === 'dismiss'))
  assert.ok(!JSON.stringify(debug).includes('dummy-secret'))
  await driver.exclusive(async () => assert.ok((await driver.inspect('console')).entries.length > 0), 'active-debug-test')
  console.log('PAID_MODELS_BROWSER_OK: dynamic catalogs, trusted keyboard selection, restored preferences, refresh, diagnostics, and screenshots')
} catch (error) {
  console.error(JSON.stringify(driver.diagnostics.read('console')))
  throw error
} finally { await driver.stop(); await rm(root, { recursive: true, force: true }) }
