import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BridgeError } from './envelope.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const quote = value => JSON.stringify(String(value))
const NAME = 'Nexus DSH'

/** UI-only setup through WebBridge's native browser. Account authentication stays manual. */
export class SetupBrowser {
  constructor({ settings, driver, stage = () => {} }) {
    this.settings = settings; this.driver = driver
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
      const ready = await this.value('Boolean([...document.querySelectorAll("button")].find(button => /Create new secret key|Create tunnel/.test(button.innerText || "")))')
      if (ready && this.auth.console !== 'ready') { this.auth.console = 'ready'; await this.persist({ auth: { ...this.auth } }) }
      return this.saved.accountTier || 'unknown'
    }
    if (!url.startsWith('https://chatgpt.com/')) return this.saved.accountTier || 'unknown'
    if (state.manualAuth?.required || state.login?.likely) {
      this.auth.chatgpt = 'needs-login'; await this.persist({ auth: { ...this.auth } })
      return this.saved.accountTier || 'unknown'
    }
    const tier = await this.value(`(() => {
      const buttons = [...document.querySelectorAll('button[aria-label="打开个人资料菜单"], button[aria-label="Open profile menu"]')];
      const label = buttons.filter(button=>button.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).map(button=>button.innerText || '').join(' ');
      if (/免费版|\\bfree\\b/i.test(label)) return 'free';
      if (/\\bplus\\b/i.test(label)) return 'plus';
      if (/\\bpro\\b/i.test(label)) return 'pro';
      if (/business|enterprise|企业版/i.test(label)) return 'business';
      return 'unknown';
    })()`)
    const loggedIn = await this.value('Boolean([...document.querySelectorAll(\'button[aria-label="打开个人资料菜单"],button[aria-label="Open profile menu"]\')].some(button=>button.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}) && button.innerText.trim()))')
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
  async waitFor(expression, message, timeoutMs = 45000) {
    const until = Date.now() + timeoutMs
    do {
      const state = await this.driver.state()
      this.guard(state)
      const value = await this.value(expression)
      if (value) return value
      await sleep(500)
    } while (Date.now() < until)
    throw new Error(message)
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
    const state = await this.driver.open(url, { headed: true })
    await sleep(1500)
    const current = await this.driver.state()
    try {
      this.guard(current)
      const ready = current.authenticated === true
      this.auth[site] = ready ? 'ready' : 'needs-login'
    } catch (error) { if (error.code !== 'manual-auth-required') throw error }
    if (site === 'chatgpt' && this.auth[site] === 'ready') await this.observeAccount()
    if (this.auth[site] === 'ready') await this.driver.switchToHeadless?.({ allowCurrentOperation: true })
    await this.persist({ auth: { ...this.auth } })
    return { site, status: this.auth[site], url: state.url }
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
      await this.open('https://platform.openai.com/settings/organization/tunnels', 'Boolean([...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Create tunnel"))')
      this.auth.console = 'ready'
      await this.driver.click('button:has-text("Create tunnel")')
      await this.wait('[role="dialog"] input[placeholder="e.g. West Coast MCP tunnel"]')
      await this.driver.fill('[role="dialog"] input[placeholder="e.g. West Coast MCP tunnel"]', name)
      await this.driver.fill('[role="dialog"] textarea', 'DSH WebBridge: connect ChatGPT to this device through an OpenAI Secure MCP Tunnel.')
      await this.wait('[role="dialog"] [role="button"]:has-text("Search workspaces")')
      await this.driver.click('[role="dialog"] [role="button"]:has-text("Search workspaces")')
      const choices = await this.waitFor('Array.from(document.querySelectorAll("[role=option]")).map(e=>({id:e.getAttribute("data-option-id"),selected:e.getAttribute("aria-selected")})).filter(e=>e.id).length && Array.from(document.querySelectorAll("[role=option]")).map(e=>({id:e.getAttribute("data-option-id"),selected:e.getAttribute("aria-selected")}))', '没有找到可用的 ChatGPT 工作区。')
      const choice = workspaceId ? choices.find(option => option.id === workspaceId) : choices.length === 1 ? choices[0] : null
      if (!choice) throw new Error('账号有多个 ChatGPT 工作区，请在高级设置中填写目标工作区 ID。')
      if (choice.selected !== 'true') await this.driver.click(`[role="option"][data-option-id=${quote(choice.id)}]`)
      if (await this.value('Boolean(document.querySelector(\'[role="dialog"][data-side][data-state="open"]\'))')) await this.driver.press('Escape')
      await this.wait('[role="dialog"] button:has-text("Create")')
      await this.driver.click('[role="dialog"] button:has-text("Create")')
      id = await this.waitFor(`(() => {
        const row = [...document.querySelectorAll('tr,[role="row"]')].find(e=>e.textContent.includes(${quote(name)}));
        return row?.innerText.match(/tunnel_[A-Za-z0-9]+/)?.[0] || '';
      })()`, '隧道创建后未能读取 Tunnel ID，请查看控制台。')
      await this.persist({ resourceTunnelId: id })
    }
    this.stage(testKey ? '正在创建一天有效的测试 API Key' : '正在创建永不过期的 Runtime API Key')
    await this.open('https://platform.openai.com/settings/organization/api-keys', 'Boolean([...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="Create new secret key"))')
    this.auth.console = 'ready'
    await this.persist({ auth: { ...this.auth } })
    await this.driver.click('button:has-text("Create new secret key")')
    await this.waitFor('Boolean(document.querySelector(\'[role="dialog"] button[role="radio"]\'))', 'API Key 表单没有完成加载。')
    await this.driver.fill('[role="dialog"] input[placeholder="My Test Key"]', `${name}-Runtime`)
    await this.driver.click('[role="dialog"] [role="button"]:has-text("Select project")')
    await this.wait(`[role="option"]:has-text(${quote(projectName)})`)
    await this.driver.click(`[role="option"]:has-text(${quote(projectName)})`)
    await this.driver.click('[role="dialog"] [role="button"]:has-text("有效期")')
    await this.driver.click(`[role="option"][data-option-id="${testKey ? '1' : 'never'}"]`)
    await this.driver.click('[role="dialog"] button[role="radio"]:has-text("Restricted")')
    await this.driver.click('[role="dialog"] div:has(> button:has-text("Tunnels")) > [role="button"]')
    for (const permission of ['read', 'use']) {
      await this.driver.click(`[role="option"][data-option-id="api.organization.tunnel.${permission}"][aria-selected="false"]`)
    }
    await this.driver.press('Escape')
    // Persist the attempt before the irreversible remote submit. A later read,
    // storage, or connection failure must never mint another key on retry.
    await this.persist({ resourceKeyPending: true })
    await this.driver.click('[role="dialog"] button[type="submit"]:has-text("Create secret key")')
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
    await this.driver.click('[role="dialog"] button:has-text("Done")').catch(() => this.driver.press('Escape'))
    return { tunnelId: id, keyExpiresAt: result.keyExpiresAt }
  }
  async findPlugins() {
    await this.open(`https://chatgpt.com/plugins?directoryTab=personal&search=${encodeURIComponent(NAME)}`)
    await this.waitFor('Boolean(document.querySelector("#plugins-store-page-search"))', '插件目录未加载。')
    await sleep(2000)
    return this.value(`Array.from(document.querySelectorAll('a[href^="/plugins/plugin_"]')).filter(a=>{
      const label = a.getAttribute('aria-label') || (a.getAttribute('aria-labelledby') || '').split(' ').map(id=>document.getElementById(id)?.textContent || '').join(' ') || a.textContent;
      return label.trim() === ${quote(NAME)};
    }).map(a=>({href:a.getAttribute('href'),id:a.getAttribute('href')?.match(/plugin_[A-Za-z0-9_]+/)?.[0]})).filter(a=>a.id)`)
  }
  async removeExisting() {
    const existing = await this.findPlugins()
    for (const plugin of existing) {
      this.stage('正在卸载并删除旧的 Nexus DSH 插件')
      await this.open(`https://chatgpt.com/settings/plugins-settings/${plugin.id}`)
      await this.waitFor('Boolean([...document.querySelectorAll("button")].find(e=>/卸载|删除应用/.test(e.textContent)))', '未找到旧插件管理入口。')
      if (await this.value('Boolean([...document.querySelectorAll("button")].find(e=>e.textContent.trim()==="卸载"))')) {
        await this.driver.click('button:text-is("卸载")')
        await this.driver.click('[role="dialog"] button[type="submit"]:has-text("卸载")')
        await this.persist({ pluginInstalled: false, permissionsAll: false })
        await sleep(750)
      }
      await this.findPlugins()
      await this.driver.click(`a[href^="/plugins/${plugin.id}"]`)
      await this.wait('button[aria-label="更多操作"]')
      await this.driver.click('button[aria-label="更多操作"]')
      await this.wait('[role="menuitem"]:has-text("删除插件")')
      await this.driver.click('[role="menuitem"]:has-text("删除插件")')
      await this.wait('[role="dialog"] button[type="submit"]:has-text("删除插件")')
      await this.driver.click('[role="dialog"] button[type="submit"]:has-text("删除插件")')
      await this.waitFor('location.pathname === "/plugins"', '旧个人插件尚未删除，请检查网页。')
    }
    await this.persist({ pluginId: '', pluginInstalled: false, permissionsAll: false })
  }
  async install(tunnelId) {
    await this.removeExisting()
    this.stage('正在通过官方隧道重新安装 Nexus DSH')
    await this.open('https://chatgpt.com/plugins')
    await this.wait('button[aria-label="添加"]')
    await this.driver.click('button[aria-label="添加"]')
    await this.wait('[role="menuitem"]:has-text("添加自定义 MCP 服务器")')
    await this.driver.click('[role="menuitem"]:has-text("添加自定义 MCP 服务器")')
    await this.wait('[role="dialog"] input[placeholder="自定义工具"]')
    await this.driver.fill('[role="dialog"] input[placeholder="自定义工具"]', NAME)
    await this.driver.fill('[role="dialog"] textarea', '通过 OpenAI 官方隧道动态调用当前 DSH 会话的全部可用工具。')
    await this.driver.click('[role="dialog"] button:has-text("隧道")')
    await this.driver.fill('[role="dialog"] input[aria-label="隧道 ID"]', tunnelId)
    await this.driver.run('select', ['[role="dialog"] select', 'NONE'])
    await this.driver.click('[role="dialog"] button[role="checkbox"]')
    await this.driver.click('[role="dialog"] button[type="submit"]:has-text("创建为插件")')
    await this.wait(`button:has-text("连接 ${NAME}")`, 60000)
    await this.driver.click(`button:has-text("连接 ${NAME}")`)
    await this.waitFor(`Boolean(document.querySelector('a[href^="/plugins/plugin_"]')) || document.body.innerText.includes('现已连接')`, '网页插件安装尚未完成。', 60000)
    const plugins = await this.findPlugins()
    const plugin = plugins[0]
    if (!plugin) throw new Error('插件已创建，但未能读取新的插件 ID。')
    await this.persist({ pluginId: plugin.id, pluginInstalled: true })
    await this.allowAll(plugin.id)
    await this.refresh(plugin.id)
    return plugin.id
  }
  async allowAll(pluginId = this.saved.pluginId) {
    this.stage('正在设置允许全部工具')
    await this.open(`https://chatgpt.com/settings/plugins-settings/${pluginId}/permissions`)
    await this.wait('input[type="radio"][aria-label^="允许使用所有工具"]')
    await this.driver.click('input[type="radio"][aria-label^="允许使用所有工具"]')
    await sleep(700)
    await this.open(`https://chatgpt.com/settings/plugins-settings/${pluginId}`)
    await this.waitFor('document.body.innerText.includes("全部允许")', '全部工具权限没有保存成功。')
    await this.persist({ permissionsAll: true })
  }
  async refresh(pluginId = this.saved.pluginId) {
    if (!pluginId) throw new Error('请先连接并安装网页插件。')
    this.stage('正在刷新网页工具目录')
    await this.open(`https://chatgpt.com/settings/plugins-settings/${pluginId}`)
    await this.wait('button:has-text("刷新工具")')
    await this.driver.press('End')
    await this.driver.click('button:text-is("刷新工具")')
    await sleep(800)
    await this.waitFor(`(() => {
      const text = document.body.innerText;
      if (/无法更新应用|更新失败/.test(text)) throw new Error('网页工具刷新失败');
      const button = [...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='刷新工具');
      return Boolean(button && !button.disabled);
    })()`, '工具刷新超时。', 60000)
    await this.persist({ toolsRefreshedAt: new Date().toISOString() })
  }
}
