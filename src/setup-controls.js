import { BridgeError } from './envelope.js'

// These contracts describe control structure and machine values, never translated labels.
export class SetupControls {
  constructor(driver) { this.driver = driver }
  async page() { return this.driver.currentPage() }
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
  async refresh() {
    const control = await this.action('browserPluginSettings.refreshActions', '定位工具刷新按钮')
    await control.click({ timeout: 10000 })
    await control.waitFor({ state: 'visible', timeout: 10000 })
    const page = await this.page()
    await page.waitForFunction(node => !node.disabled && node.getAttribute('aria-busy') !== 'true', await control.elementHandle(), { timeout: 60000 })
    if (await page.locator('[role="alert"]').filter({ visible: true }).count()) throw new BridgeError('setup-refresh-failed', '网页报告工具刷新失败，请查看网页提示。')
  }
}
