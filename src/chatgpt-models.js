import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BridgeError } from './envelope.js'
import { SetupControls } from './setup-controls.js'

const CATALOG_SESSION = '__webbridge_model_catalog__'
const TRIGGER = 'button[data-composer-navigation-target="reasoning"], form button[aria-haspopup="menu"]'
const ROOT = '[data-model-picker-view]'

export function paidModelKey(modelName, power) {
  return `paid-${createHash('sha256').update(modelName).digest('hex').slice(0, 12)}${power === undefined ? '' : `-${power}`}`
}

/** Read the account's own picker; never infer paid options from API model names. */
export class ChatgptModels {
  constructor({ settings, driver, log = () => {}, onChange = () => {} }) {
    this.driver = driver; this.log = log
    this.onChange = onChange
    this.path = join(settings.stateDir, 'model-catalog.json')
    this.controls = new SetupControls(driver)
    this.catalog = []; this.checkedAt = 0; this.loaded = false
  }
  async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'))
      if (saved.version === 1 && Array.isArray(saved.models)) this.catalog = saved.models.filter(model => typeof model.modelName === 'string' && typeof model.label === 'string' && Number.isInteger(model.power) && model.key === paidModelKey(model.modelName, model.power))
    } catch (error) { if (error.code !== 'ENOENT') this.log('[webbridge:models] saved model catalog could not be read') }
  }
  async list(force = false) {
    await this.load()
    if (this.pending) return this.pending
    if (this.driver.busy) {
      if (force) throw new BridgeError('browser-busy', '浏览器正在处理会话，请稍后刷新模型列表。')
      return this.catalog
    }
    if (!force && Date.now() - this.checkedAt < 300000) return this.catalog
    this.pending = this.driver.exclusive(async () => {
      const page = await this.driver.currentPage()
      await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })
      const state = await this.driver.state()
      if (state.manualAuth?.required) {
        if (force) throw new BridgeError('auth-required:login', '请先在 WebBridge 浏览器中完成 ChatGPT 登录。')
        return this.catalog
      }
      let original
      try {
        await this.open()
        if (!await page.locator(`${ROOT} [data-model-picker-view-toggle]`).count()) return this.catalog
        original = await this.read()
        const names = await this.names()
        const models = []
        for (const modelName of names) {
          await this.chooseModel(modelName)
          const current = await this.read()
          for (let power = current.min; power <= current.max; power++) {
            await this.power(power)
            const selected = await this.read()
            models.push({ key: paidModelKey(modelName, power), modelName, power, label: selected.label, effort: selected.effort, preferred: power === current.power })
          }
        }
        if (models.length) {
          const changed = JSON.stringify(models) !== JSON.stringify(this.catalog)
          this.catalog = models
          await writeFile(this.path, JSON.stringify({ version: 1, models, checkedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
          if (changed) Promise.resolve().then(() => this.onChange()).catch(() => this.log('[webbridge:models] model-change notification failed'))
        }
        this.checkedAt = Date.now()
        return this.catalog
      } finally {
        if (original?.modelName) {
          try { await this.chooseModel(original.modelName); await this.power(original.power) }
          catch { this.log('[webbridge:models] picker preferences could not be restored after discovery') }
        }
        await page.keyboard.press('Escape').catch(() => {})
      }
    }, CATALOG_SESSION).catch(error => {
      this.checkedAt = Date.now()
      this.log(`[webbridge:models] catalog read failed: ${error.code || 'browser-error'}`)
      if (force) throw error
      return this.catalog
    }).finally(() => { this.pending = null })
    return this.pending
  }
  async open() {
    const trigger = await this.controls.one(TRIGGER, '等待 ChatGPT 模型入口')
    if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
    await this.controls.one(ROOT, '等待网页模型菜单')
  }
  async read() {
    const page = await this.driver.currentPage()
    const value = await page.locator(ROOT).evaluate(root => {
      const slider = root.querySelector('[data-reasoning-slider] [role="slider"]')
      const selected = root.querySelector('[role="menuitemradio"][aria-checked="true"]')
      const label = root.querySelector('[data-model-picker-view-toggle] [data-effort-only]')?.textContent?.trim()
      return { modelName: selected?.querySelector('[data-menu-row-content] > span')?.textContent?.trim() || selected?.textContent?.trim(), label, hasRange: Boolean(slider && ['aria-valuenow', 'aria-valuemin', 'aria-valuemax'].every(name => slider.hasAttribute(name))),
        power: Number(slider?.getAttribute('aria-valuenow')), min: Number(slider?.getAttribute('aria-valuemin')), max: Number(slider?.getAttribute('aria-valuemax')) }
    })
    if (!value.modelName || !value.label || !value.hasRange || ![value.power, value.min, value.max].every(Number.isInteger) || value.min < 0 || value.max > 20 || value.max < value.min) throw new BridgeError('model-picker-changed', '网页模型或思考滑块结构不符，尚未发送消息。')
    const trigger = page.locator(TRIGGER)
    return { ...value, effort: await trigger.getAttribute('data-selected-reasoning-effort') || '' }
  }
  async names() {
    const page = await this.driver.currentPage()
    if (await page.locator(ROOT).getAttribute('data-model-picker-view') !== 'advanced') await this.controls.click(`${ROOT} [data-model-picker-view-toggle]`, '打开网页模型列表')
    await page.waitForFunction(() => document.querySelector('[data-model-picker-view]')?.getAttribute('data-model-picker-view') === 'advanced', undefined, { timeout: 10000 })
    return page.locator(`${ROOT} [role="menuitemradio"]`).evaluateAll(nodes => nodes.filter(node => node.getAttribute('aria-disabled') !== 'true' && !node.hasAttribute('data-disabled') && !node.closest('[inert]')).map(node => node.querySelector('[data-menu-row-content] > span')?.textContent?.trim() || node.textContent.trim()))
  }
  async chooseModel(modelName) {
    const page = await this.driver.currentPage()
    await this.open()
    const names = await this.names()
    if (names.filter(name => name === modelName).length !== 1) throw new BridgeError('model-unavailable', `当前网页账号不能选择 ${modelName}，请刷新网页模型列表。`)
    const options = page.locator(`${ROOT} [role="menuitemradio"]`)
    const index = await options.evaluateAll((nodes, name) => nodes.findIndex(node => (node.querySelector('[data-menu-row-content] > span')?.textContent?.trim() || node.textContent.trim()) === name), modelName)
    await options.nth(index).click()
    await page.waitForFunction(name => {
      const root = document.querySelector('[data-model-picker-view]')
      const selected = root?.querySelector('[role="menuitemradio"][aria-checked="true"]')
      return root?.getAttribute('data-model-picker-view') === 'simple' && (selected?.querySelector('[data-menu-row-content] > span')?.textContent?.trim() || selected?.textContent?.trim()) === name
    }, modelName, { timeout: 10000 })
  }
  async power(target) {
    const page = await this.driver.currentPage()
    const current = await this.read()
    if (!Number.isInteger(target) || target < current.min || target > current.max) throw new BridgeError('reasoning-unavailable', '当前模型不支持所选思考档位，尚未发送消息。')
    const slider = await this.controls.one(`${ROOT} [data-reasoning-slider]:not([aria-disabled="true"])`, '等待思考滑块')
    const direction = target > current.power ? 1 : -1
    for (let value = current.power; value !== target; value += direction) {
      await slider.press(direction > 0 ? 'ArrowRight' : 'ArrowLeft')
      await page.waitForFunction(expected => Number(document.querySelector('[data-model-picker-view] [data-reasoning-slider] [role="slider"]')?.getAttribute('aria-valuenow')) === expected, value + direction, { timeout: 5000 })
    }
  }
  async select(choice) {
    const page = await this.driver.currentPage()
    try {
      await this.chooseModel(choice.modelName)
      await this.power(choice.power)
      const selected = await this.read()
      if (selected.modelName !== choice.modelName || selected.power !== choice.power || selected.label !== choice.label) throw new BridgeError('model-not-selected', '网页模型或思考档位与 DSH 选择不符，尚未发送消息。')
      return selected
    } finally { await page.keyboard.press('Escape').catch(() => {}) }
  }
}
