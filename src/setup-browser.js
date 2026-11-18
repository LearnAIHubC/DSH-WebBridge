import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BridgeError } from './envelope.js'
import { SetupControls } from './setup-controls.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Manual sign-in and account observation through WebBridge's native browser. Every web resource is created by the person; nothing is auto-provisioned. */
export class SetupBrowser {
  constructor({ settings, driver, stage = () => {} }) {
    this.settings = settings; this.driver = driver
    this.controls = new SetupControls(driver)
    this.stage = text => { this.currentStage = text; stage(text) }
    this.path = join(settings.stateDir, 'setup.json'); this.saved = {}
    this.auth = { chatgpt: 'unknown', console: 'unknown' }
  }
  async load() {
    try { this.saved = JSON.parse(await readFile(this.path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (this.saved.auth) Object.assign(this.auth, this.saved.auth)
  }
  async observeAccount() {
    if (this.driver.context === null || this.driver.pages?.size === 0) return this.saved.accountTier || 'unknown'
    const state = await this.driver.state()
    const url = String(state.url || '')
    if (url.startsWith('https://platform.openai.com/')) {
      const ready = state.authenticated === true
      if (ready && this.auth.console !== 'ready') { this.auth.console = 'ready'; await this.persist({ auth: { ...this.auth } }) }
      return this.saved.accountTier || 'unknown'
    }
    if (!url.startsWith('https://chatgpt.com/')) return this.saved.accountTier || 'unknown'
    if (state.manualAuth?.required || state.login?.likely) {
      this.auth.chatgpt = 'needs-login'; await this.persist({ auth: { ...this.auth } })
      return this.saved.accountTier || 'unknown'
    }
    const tier = await this.value(`(() => {
      const buttons = [...document.querySelectorAll('button[aria-label="打开个人资料菜单"], button[aria-label="Open profile menu"], button[data-testid="accounts-profile-button"]')];
      const label = buttons.filter(button=>button.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).map(button=>button.innerText || '').join(' ');
      if (/免费版|\\bfree\\b/i.test(label)) return 'free';
      if (/\\bplus\\b/i.test(label)) return 'plus';
      if (/\\bpro\\b/i.test(label)) return 'pro';
      if (/business|enterprise|企业版/i.test(label)) return 'business';
      return 'unknown';
    })()`)
    const loggedIn = state.authenticated === true
    if (loggedIn && this.auth.chatgpt !== 'ready') { this.auth.chatgpt = 'ready'; await this.persist({ auth: { ...this.auth } }) }
    if (tier && tier !== 'unknown' && tier !== this.saved.accountTier) await this.persist({ accountTier: tier })
    return tier === 'unknown' ? this.saved.accountTier || 'unknown' : tier
  }
  async persist(patch) {
    const save = async () => {
      Object.assign(this.saved, patch)
      const temporary = `${this.path}.${randomUUID()}.tmp`
      await writeFile(temporary, JSON.stringify(this.saved, null, 2), { mode: 0o600 })
      await rename(temporary, this.path)
    }
    this.writes = (this.writes || Promise.resolve()).then(save, save)
    await this.writes
  }
  async value(expression) { return (await this.driver.eval(expression)).result }
  async wait(selector, timeoutMs = 45000) {
    try { return await this.driver.run('wait', [selector, '--timeout', String(timeoutMs)], { timeoutMs: timeoutMs + 5000 }) }
    catch (error) {
      if (/timeout/i.test(error.code || '') || /timeout/i.test(error.message || '')) throw new BridgeError('setup-page-timeout', `${this.currentStage || '配置网页插件'}时，网页加载超过 ${timeoutMs / 1000} 秒，请检查浏览器后重试。`)
      throw error
    }
  }
  async waitFor(expression, message, timeoutMs = 10000) {
    const until = Date.now() + timeoutMs
    do {
      const state = await this.driver.state()
      this.guard(state)
      const value = await this.value(expression)
      if (value) return value
      await sleep(500)
    } while (Date.now() < until)
    throw new BridgeError('setup-step-timeout', `${this.currentStage || '配置网页插件'}：${message}`)
  }
  guard(state) {
    if (state?.manualAuth?.required || state?.challenge?.likely || state?.login?.likely) {
      const site = String(state.url || '').includes('chatgpt.com') ? 'chatgpt' : 'console'
      this.auth[site] = 'needs-login'
      throw new BridgeError('manual-auth-required', '请在已打开的浏览器完成账号登录或验证，然后再次点击连接隧道。')
    }
  }
  async open(url, readyExpression) {
    await this.driver.open(url)
    let state = await this.driver.state()
    if (state.manualAuth?.required && state.headless) {
      await this.driver.open(url, { headed: true })
      state = await this.driver.state()
    }
    this.guard(state)
    if (readyExpression) await this.waitFor(readyExpression, '网页未完成加载，请检查浏览器页面。')
    return state
  }
  async login(site) {
    this.stage(site === 'chatgpt' ? '请在浏览器登录 ChatGPT' : '请在浏览器登录 OpenAI 控制台')
    const url = site === 'chatgpt' ? 'https://chatgpt.com/' : 'https://platform.openai.com/settings/organization/api-keys'
    // Give an already signed-in SPA time to render before opening a login window.
    await this.driver.open(url)
    let current = await this.driver.waitLogin(5000).catch(error => {
      if (error.code !== 'manual-auth-timeout') throw error
      return null
    })
    if (!current) {
      await this.driver.open(url, { headed: true })
      this.auth[site] = 'needs-login'
      await this.persist({ auth: { ...this.auth } })
      this.stage('等待手动登录，完成后会自动确认')
      current = await this.driver.waitLogin(300000)
    }
    this.guard(current)
    this.auth[site] = 'ready'
    if (site === 'chatgpt') await this.observeAccount()
    await this.driver.switchToHeadless?.({ allowCurrentOperation: true })
    await this.persist({ auth: { ...this.auth } })
    return { site, status: this.auth[site], url: current.url }
  }
  async refresh(pluginId = this.saved.pluginId) {
    if (!pluginId) throw new Error('请先连接并安装网页插件。')
    this.stage('正在刷新网页工具目录')
    await this.open(`https://chatgpt.com/settings/plugins-settings/${pluginId}`)
    await this.controls.refresh()
    await this.persist({ toolsRefreshedAt: new Date().toISOString() })
  }
}
