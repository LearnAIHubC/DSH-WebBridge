import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BridgeError } from './envelope.js'
import { SetupControls } from './setup-controls.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = value => JSON.stringify(String(value))
const NAME = 'Nexus DSH'

/** UI-only setup through WebBridge's native browser. Account authentication stays manual. */
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
  async createResources({ tunnelId, testKey = false, upgradeTestKey = false, workspaceId = '', projectName = 'Default project', onKey }) {
    if (this.pendingKey) {
      await onKey(this.pendingKey)
      const result = { tunnelId: this.pendingKey.tunnelId, keyExpiresAt: this.pendingKey.keyExpiresAt }
      await this.persist({ resourceKeyCreated: true, resourceKeyKind: this.pendingKey.keyExpiresAt ? 'test' : 'permanent', resourceKeyPending: false, resourceTunnelId: result.tunnelId })
      this.pendingKey = null
      return result
    }
    const mayUpgrade = upgradeTestKey && !testKey && this.saved.resourceKeyKind !== 'permanent'
    if (this.saved.resourceKeyPending || this.saved.resourceKeyCreated && !mayUpgrade) {
      throw new Error('API Key 已创建或提交过。请恢复已保存的本地密钥，或在设置中填写已有密钥；不会自动重复创建。')
    }
    const name = this.saved.resourceName || `DSH-WebBridge-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`
    await this.persist({ resourceName: name })
    let id = tunnelId || this.saved.resourceTunnelId
    if (!id) {
      this.stage('正在创建 OpenAI 隧道')
      await this.open('https://platform.openai.com/settings/organization/tunnels')
      this.auth.console = 'ready'
      await this.controls.primaryDialog('打开隧道创建表单')
      await this.controls.fill('[role="dialog"] input:not([type="hidden"])', name, '填写隧道名称')
      await this.controls.fill('[role="dialog"] textarea', 'DSH WebBridge: connect ChatGPT to this device through an OpenAI Secure MCP Tunnel.', '填写隧道说明')
      await this.controls.chooseOptions(workspaceId ? [workspaceId] : null, { single: !workspaceId })
      await this.controls.submit('提交隧道创建')
      id = await this.waitFor(`(() => {
        const row = [...document.querySelectorAll('tr,[role="row"]')].find(e=>e.textContent.includes(${quote(name)}));
        return row?.innerText.match(/tunnel_[A-Za-z0-9]+/)?.[0] || '';
      })()`, '隧道创建后未能读取 Tunnel ID，请查看控制台。')
      await this.persist({ resourceTunnelId: id })
    }
    this.stage(testKey ? '正在创建一天有效的测试 API Key' : '正在创建永不过期的 Runtime API Key')
    await this.open('https://platform.openai.com/settings/organization/api-keys')
    this.auth.console = 'ready'
    await this.persist({ auth: { ...this.auth } })
    await this.controls.primaryDialog('打开 API Key 创建表单')
    await this.controls.fill('[role="dialog"] input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([readonly])', `${name}-Runtime`, '填写 Runtime Key 名称')
    await this.controls.chooseOptions(null, { text: projectName })
    await this.controls.chooseOptions([testKey ? '1' : 'never'])
    await this.controls.restrictedKey()
    await this.controls.chooseOptions(['api.organization.tunnel.read', 'api.organization.tunnel.use'])
    // Persist the attempt before the irreversible remote submit. A later read,
    // storage, or connection failure must never mint another key on retry.
    await this.persist({ resourceKeyPending: true })
    await this.controls.submit('提交 Runtime Key 创建')
    // This value is consumed in memory and encrypted before leaving this method.
    const runtimeApiKey = await this.waitFor(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return '';
      const values = [...dialog.querySelectorAll('input,textarea')].map(e=>e.value);
      return values.find(v=>/^sk-[A-Za-z0-9_-]{20,}$/.test(v)) || dialog.textContent.match(/sk-[A-Za-z0-9_-]{20,}/)?.[0] || '';
    })()`, '未能读取新 API Key，请在浏览器确认创建结果。')
    const result = { tunnelId: id, runtimeApiKey, keyExpiresAt: testKey ? new Date(Date.now() + 86400000).toISOString() : '' }
    this.pendingKey = result
    await onKey(result)
    await this.persist({ resourceKeyCreated: true, resourceKeyKind: testKey ? 'test' : 'permanent', resourceKeyPending: false, resourceTunnelId: id })
    this.pendingKey = null
    await this.driver.press('Escape')
    return { tunnelId: id, keyExpiresAt: result.keyExpiresAt }
  }
  async findPlugins() {
    await this.open(`https://chatgpt.com/plugins?directoryTab=personal&search=${encodeURIComponent(NAME)}`)
    await this.waitFor('Boolean(document.querySelector("#plugins-store-page-search"))', '插件目录未加载。')
    await sleep(2000)
    return this.value(`Array.from(new Map(Array.from(document.querySelectorAll('a[href^="/plugins/plugin_"]')).filter(a=>{
      const label = a.getAttribute('aria-label') || (a.getAttribute('aria-labelledby') || '').split(' ').map(id=>document.getElementById(id)?.textContent || '').join(' ') || a.textContent;
      return label.trim() === ${quote(NAME)};
    }).map(a=>({href:a.getAttribute('href'),id:a.getAttribute('href')?.match(/plugin_[A-Za-z0-9_]+/)?.[0]})).filter(a=>a.id).map(plugin=>[plugin.id,plugin])).values())`)
  }
  async install(tunnelId) {
    const savedMatch = this.saved.pluginId && (this.saved.pluginTunnelId || this.saved.resourceTunnelId) === tunnelId
    const existing = savedMatch ? [{ id: this.saved.pluginId }] : await this.findPlugins()
    if (existing.length > 1) throw new BridgeError('setup-plugin-ambiguous', '存在多个同名 Nexus DSH 插件，请先在网页确认保留哪一个。')
    if (existing.length === 1) {
      const plugin = existing[0]
      await this.open(`https://chatgpt.com/settings/plugins-settings/${plugin.id}`)
      const sameTunnel = savedMatch || await this.value(`document.body.textContent.includes(${quote(tunnelId)}) || [...document.querySelectorAll('input')].some(input=>input.value===${quote(tunnelId)})`)
      if (!sameTunnel) throw new BridgeError('setup-plugin-conflict', '已有 Nexus DSH 插件无法确认属于当前隧道，未覆盖或删除。请在网页确认其连接配置。')
      await this.persist({ pluginId: plugin.id, pluginTunnelId: tunnelId, pluginInstalled: true })
      await this.allowAll(plugin.id)
      await this.refresh(plugin.id)
      return plugin.id
    }
    this.stage('正在通过官方隧道安装 Nexus DSH')
    await this.open('https://chatgpt.com/plugins')
    await this.controls.openMcpForm()
    await this.controls.fill('[role="dialog"] label > input[required]', NAME, '填写网页插件名称')
    await this.controls.fill('[role="dialog"] label > textarea[rows="1"]', '通过 OpenAI 官方隧道动态调用当前 DSH 会话的全部可用工具。', '填写网页插件说明')
    await this.controls.useTunnel()
    await this.controls.fill('[role="dialog"] input[placeholder="tunnel_..."]', tunnelId, '填写隧道 ID')
    await this.driver.run('select', ['[role="dialog"] select', 'NONE'])
    if (!await this.value('document.querySelector(\'[role="dialog"] select\')?.value === "NONE"')) throw new BridgeError('setup-auth-not-set', 'MCP 认证方式未设置成功，尚未创建插件。')
    const trusted = await this.controls.one('[role="dialog"] button[role="checkbox"]', '确认本机 MCP 信任选项')
    if (await trusted.getAttribute('aria-checked') !== 'true') await trusted.click()
    await this.controls.submit('提交网页插件创建')
    await this.controls.click(`button:has-text(${quote(NAME)})`, '确认连接 Nexus DSH', { timeout: 60000 })
    const plugins = await this.findPlugins()
    const plugin = plugins[0]
    if (!plugin) throw new Error('插件已创建，但未能读取新的插件 ID。')
    await this.persist({ pluginId: plugin.id, pluginTunnelId: tunnelId, pluginInstalled: true })
    await this.allowAll(plugin.id)
    await this.refresh(plugin.id)
    return plugin.id
  }
  async allowAll(pluginId = this.saved.pluginId) {
    this.stage('正在设置允许全部工具')
    await this.open(`https://chatgpt.com/settings/plugins-settings/${pluginId}/permissions`)
    await this.controls.allowAll()
    await sleep(700)
    await this.open(`https://chatgpt.com/settings/plugins-settings/${pluginId}/permissions`)
    await this.waitFor(`Boolean(document.querySelector('input[type="radio"][value="full_access"]:checked,button[role="radio"][value="full_access"][aria-checked="true"]'))`, '全部工具权限没有保存成功。')
    await this.persist({ permissionsAll: true })
  }
  async refresh(pluginId = this.saved.pluginId) {
    if (!pluginId) throw new Error('请先连接并安装网页插件。')
    this.stage('正在刷新网页工具目录')
    await this.open(`https://chatgpt.com/settings/plugins-settings/${pluginId}`)
    await this.controls.refresh()
    await this.persist({ toolsRefreshedAt: new Date().toISOString() })
  }
}
