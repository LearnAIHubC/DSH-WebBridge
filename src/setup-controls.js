import { BridgeError } from './envelope.js'

// These contracts describe control structure and machine values, never translated labels.
export class SetupControls {
  constructor(driver) { this.driver = driver }
  async page() { return this.driver.currentPage() }
  async one(selector, purpose, { root, timeout = 10000 } = {}) {
    const page = await this.page()
    const locator = (root || page).locator(selector).filter({ visible: true })
    try { await locator.waitFor({ state: 'visible', timeout }) }
    catch {
      const count = await locator.count()
      throw new BridgeError('setup-ui-changed', `${purpose}：预期 1 个控件，实际 ${count} 个（${new URL(page.url()).pathname}）。页面结构可能已变化，尚未执行此步骤。`)
    }
    return locator
  }
  async click(selector, purpose, options) { await (await this.one(selector, purpose, options)).click({ timeout: 10000 }) }
  async fill(selector, value, purpose) { await (await this.one(selector, purpose)).fill(value, { timeout: 10000 }) }
  async action(id, purpose) {
    const page = await this.page()
    const controls = page.locator('button,[role="menuitem"]').filter({ visible: true })
    const deadline = Date.now() + 10000
    do {
      const matches = await controls.evaluateAll((nodes, actionId) => {
        // Some settings buttons expose no DOM ID. Inspect only their rendered
        // message ID, then use a normal Playwright click; fail if it disappears.
        const contains = (value, depth = 0) => {
          if (!value || depth > 10) return false
          if (Array.isArray(value)) return value.some(child => contains(child, depth + 1))
          if (typeof value !== 'object') return false
          return value.props?.id === actionId || contains(value.props?.children, depth + 1)
        }
        return nodes.flatMap((node, index) => {
          const key = Object.keys(node).find(key => key.startsWith('__reactProps$'))
          return contains(node[key]?.children) ? [index] : []
        })
      }, id)
      if (matches.length === 1) return controls.nth(matches[0])
      if (matches.length > 1) throw new BridgeError('setup-ui-changed', `${purpose}：内部动作 ID ${id} 对应多个控件，未执行。`)
      await new Promise(resolve => setTimeout(resolve, 250))
    } while (Date.now() < deadline)
    throw new BridgeError('setup-ui-changed', `${purpose}：未找到内部动作 ID ${id}，页面结构可能已变化。`)
  }
  async submit(purpose) {
    const submit = await this.one('[role="dialog"] button[type="submit"]', purpose)
    const valid = await submit.evaluate(node => (node.form || node.closest('form'))?.checkValidity() !== false)
    if (!valid) throw new BridgeError('setup-form-invalid', `${purpose}：表单存在未通过验证的字段，尚未提交。`)
    await submit.click({ timeout: 10000 })
  }
  async primaryDialog(purpose) {
    const page = await this.page()
    const main = page.locator('main, [role="main"]').filter({ visible: true })
    const root = await main.count() === 1 ? main : page.locator('body')
    await this.click('button[aria-haspopup="dialog"], button:has(svg use[href*="plus"])', purpose, { root })
  }
  async chooseOptions(ids, { text, single = false } = {}) {
    const page = await this.page()
    const triggers = page.locator('[role="dialog"] [aria-haspopup="listbox"], [role="dialog"] [role="combobox"], [role="dialog"] [role="button"][aria-controls]').filter({ visible: true })
    const count = await triggers.count()
    for (let index = 0; index < count; index++) {
      await triggers.nth(index).click({ timeout: 5000 })
      const options = page.locator('[role="option"][data-option-id]').filter({ visible: true })
      try { await options.first().waitFor({ state: 'visible', timeout: 1500 }) }
      catch { await page.keyboard.press('Escape'); continue }
      const choices = await options.evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-option-id'), selected: node.getAttribute('aria-selected') === 'true', text: (node.textContent || '').trim() })))
      const selected = ids?.length ? choices.filter(choice => ids.includes(choice.id))
        : text ? choices.filter(choice => choice.text === text) : single && choices.length === 1 ? choices : []
      if (!selected.length || ids?.length && selected.length !== ids.length) { await page.keyboard.press('Escape'); continue }
      for (const choice of selected) {
        if (!choice.selected) await page.locator(`[role="option"][data-option-id=${JSON.stringify(choice.id)}]`).click({ timeout: 5000 })
      }
      if (await options.count()) await page.keyboard.press('Escape')
      return selected.map(choice => choice.id)
    }
    throw new BridgeError('setup-option-missing', '未找到所需的内部选项 ID；尚未提交表单。请检查账号可用的项目、工作区或页面结构。')
  }
  async restrictedKey() {
    const page = await this.page()
    const explicit = page.locator('[role="dialog"] [role="radio"][value="restricted"], [role="dialog"] input[type="radio"][value="restricted"]').filter({ visible: true })
    if (await explicit.count() === 1) { await explicit.click(); return }
    // Platform's three permission modes are all / restricted / read-only.
    const radios = page.locator('[role="dialog"] button[role="radio"]').filter({ visible: true })
    if (await radios.count() !== 3) throw new BridgeError('setup-ui-changed', 'API Key 权限控件结构不符，尚未创建密钥。')
    await radios.nth(1).click()
  }
  async openMcpForm() {
    const page = await this.page()
    await this.click('main button[aria-haspopup="menu"], [role="main"] button[aria-haspopup="menu"]', '打开插件新增菜单')
    const menu = await this.one('[role="menu"]', '读取插件新增菜单')
    // The MCP entry uses an inline paperclip icon; archive upload has a different sprite.
    // Match the inspected icon geometry rather than menu order or translated text.
    await this.click('[role="menuitem"]:has(svg[viewBox="0 0 24 24"] path[d^="M11.0514 2.79347"])', '定位自定义 MCP 入口', { root: menu })
    await this.one('[role="dialog"] input[type="url"]', '等待 MCP 表单')
  }
  async useTunnel() {
    const fieldset = await this.one('[role="dialog"] fieldset:has(input[type="url"])', '定位 MCP 连接方式')
    const buttons = fieldset.locator('button').filter({ visible: true })
    if (await buttons.count() !== 2) throw new BridgeError('setup-ui-changed', 'MCP 连接方式结构不符，尚未创建插件。')
    await buttons.nth(1).click()
    await this.one('[role="dialog"] input[placeholder="tunnel_..."]', '等待隧道 ID 输入框')
  }
  async allowAll() {
    const radio = await this.one('input[type="radio"][value="full_access"], button[role="radio"][value="full_access"]', '等待全部工具授权选项')
    await radio.click()
    return radio
  }
  async refresh() {
    const control = await this.action('browserPluginSettings.refreshActions', '定位工具刷新按钮')
    await control.click({ timeout: 10000 })
    await control.waitFor({ state: 'visible', timeout: 10000 })
    const page = await this.page()
    await page.waitForFunction(node => !node.disabled && node.getAttribute('aria-busy') !== 'true', await control.elementHandle(), { timeout: 60000 })
    if (await page.locator('[role="alert"]').filter({ visible: true }).count()) throw new BridgeError('setup-refresh-failed', '网页报告工具刷新失败，请查看网页提示。')
  }
}
