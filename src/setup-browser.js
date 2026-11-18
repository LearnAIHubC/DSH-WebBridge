import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BridgeError } from './envelope.js'
import { SetupControls } from './setup-controls.js'
import { SITE_PRESETS } from './config.js'
import { loadAdapter } from './adapters.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Domain families per non-ChatGPT site; used to attribute the current page
 *  to a site for login observation. */
const SITE_HOSTS = {
  bigmodel: ['bigmodel.cn'], chatglm: ['chatglm.cn'], zai: ['z.ai'],
  deepseek: ['deepseek.com'], kimi: ['kimi.com', 'kimi.moonshot.cn', 'kimi.ai'],
  doubao: ['doubao.com'], duckai: ['duck.ai', 'duckduckgo.com'],
  qwen: ['qwen.ai', 'tongyi.aliyun.com'], dola: ['dola.com'],
  gemini: ['gemini.google.com'], aistudio: ['aistudio.google.com'],
}

/** Manual sign-in and account observation through WebBridge's native browser. Every web resource is created by the person; nothing is auto-provisioned. */
export class SetupBrowser {
  constructor({ settings, driver, stage = () => {} }) {
    this.settings = settings; this.driver = driver
    this.controls = new SetupControls(driver)
    this.stage = text => { this.currentStage = text; stage(text) }
    this.path = join(settings.stateDir, 'setup.json'); this.saved = {}
    this.auth = { chatgpt: 'unknown', console: 'unknown', bigmodel: 'unknown', chatglm: 'unknown', zai: 'unknown', deepseek: 'unknown', kimi: 'unknown', doubao: 'unknown', duckai: 'unknown', qwen: 'unknown', dola: 'unknown', gemini: 'unknown', aistudio: 'unknown' }
    // Set by the host after login status flips, so model menus can refresh.
    this.onAuthChanged = null
  }
  async load() {
    try { this.saved = JSON.parse(await readFile(this.path, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (this.saved.auth) Object.assign(this.auth, this.saved.auth)
  }
  async observeAccount() {
    if (this.driver.context === null || this.driver.pages?.size === 0) return this.saved.accountTier || 'unknown'
    const state = await this.driver.state()
    const url = String(state.url || '')
    // Non-ChatGPT web sites carry their own login signal: a visible composer
    // means usable, a login control or login path means manual sign-in needed.
    for (const site of Object.keys(SITE_PRESETS)) {
      if (site === 'chatgpt') continue
      if (!this.webSiteMatches(site, url)) continue
      const expression = this.siteStatusExpression(site)
      if (!expression) continue
      const status = await this.value(expression).catch(() => 'unknown')
      if (status !== 'unknown' && this.auth[site] !== status) {
        this.auth[site] = status
        await this.persist({ auth: { ...this.auth } })
        this.onAuthChanged?.(site)
      }
      return this.saved.accountTier || 'unknown'
    }
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
  async login(site, manualTimeoutMs) {
    if (site !== 'chatgpt' && site !== 'console') return this.loginWebSite(site, manualTimeoutMs)
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
  /** True when the URL belongs to a non-ChatGPT web site preset. */
  webSiteMatches(site, url) {
    const host = (() => { try { return new URL(url).hostname.toLowerCase() } catch { return '' } })()
    const domains = SITE_HOSTS[site] || []
    return domains.some(domain => host === domain || host.endsWith(`.${domain}`))
  }

  /**
   * Page expression with the site's own login signal: a visible composer and
   * no login control means ready; a login control or /login path means the
   * person still has to sign in.
   */
  siteStatusExpression(site) {
    const preset = SITE_PRESETS[site]
    if (!preset) return null
    const adapter = loadAdapter(this.settings, site)
    const inputSelector = JSON.stringify(adapter.inputSelector || '')
    return `(() => {
      const visible = el => { const b = el && el.getBoundingClientRect(); return Boolean(b && b.width > 20 && b.height > 8 && el.checkVisibility && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) }
      const loginControls = [...document.querySelectorAll('button, a, [role="button"]')].filter(el => visible(el) && /^(登录|登陆|登录\\s*\\/\\s*注册|注册\\s*\\/\\s*登录|log\\s?in|sign\\s?in|login)$/i.test((el.innerText || '').trim()))
      const composer = ${inputSelector} ? [...document.querySelectorAll(${inputSelector})] : []
      // Needs-login signals win: the un-hydrated SPA shell can briefly render
      // a composer before the login wall takes over, so check them first.
      if (loginControls.length || location.pathname.startsWith('/login') || /^\\/sign[-_]?in/i.test(location.pathname)) return 'needs-login'
      if (composer.some(el => visible(el))) return 'ready'
      return 'unknown'
    })()`
  }

  /** Wait for the SPA to stop navigating. Zhipu's login wall is a client-side
   *  redirect: before it lands, the un-hydrated shell briefly shows a composer
   *  that a naive probe would misread as signed in. */
  async settleUrl({ minimumMs = 3000, stableSamples = 3, timeoutMs = 20000 } = {}) {
    const startedAt = Date.now()
    let last = ''
    let stable = 0
    while (Date.now() - startedAt < timeoutMs) {
      const url = String((await this.driver.state().catch(() => null))?.url || '')
      if (url === last) stable += 1
      else { stable = 0; last = url }
      if (stable >= stableSamples && Date.now() - startedAt >= minimumMs) return last
      await sleep(600)
    }
    return last
  }

  /** Manual sign-in for a non-ChatGPT web site: open, escalate to headed, poll. */
  async loginWebSite(site, manualTimeoutMs = 300000) {
    const preset = SITE_PRESETS[site]
    if (!preset) throw new BridgeError('unknown-site', `未知站点：${site}`)
    this.stage(`请在浏览器登录 ${preset.label}`)
    const check = this.siteStatusExpression(site)
    const probe = async () => (await this.value(check).catch(() => 'unknown'))
    await this.driver.open(preset.url)
    await this.settleUrl()
    // Ready must hold across two probes on a settled page.
    let readyStreak = 0
    for (let attempt = 0; attempt < 2 && readyStreak < 2; attempt++) {
      const status = await probe()
      readyStreak = status === 'ready' ? readyStreak + 1 : 0
      if (readyStreak < 2) await sleep(1500)
    }
    if (readyStreak < 2) {
      await this.driver.open(preset.url, { headed: true })
      await this.settleUrl()
      if (this.auth[site] !== 'needs-login') {
        this.auth[site] = 'needs-login'
        await this.persist({ auth: { ...this.auth } })
        this.onAuthChanged?.(site)
      }
      this.stage('等待手动登录，完成后会自动确认')
      const until = Date.now() + manualTimeoutMs
      readyStreak = 0
      while (Date.now() < until) {
        const status = await probe()
        readyStreak = status === 'ready' ? readyStreak + 1 : 0
        if (readyStreak >= 2) break
        await sleep(1500)
      }
      if (readyStreak < 2) {
        throw new BridgeError('manual-auth-timeout', `等待登录超时（${Math.round(manualTimeoutMs / 1000)} 秒），未检测到 ${preset.label} 的已登录状态；可在设置中重试。`)
      }
    }
    this.auth[site] = 'ready'
    this.onAuthChanged?.(site)
    await this.driver.switchToHeadless?.({ allowCurrentOperation: true })
    await this.persist({ auth: { ...this.auth } })
    return { site, status: this.auth[site], url: preset.url }
  }

  async refresh(pluginId = this.saved.pluginId) {
    if (!pluginId) throw new Error('请先连接并安装网页插件。')
    this.stage('正在刷新网页工具目录')
    await this.open(`https://chatgpt.com/settings/plugins-settings/${pluginId}`)
    await this.controls.refresh()
    await this.persist({ toolsRefreshedAt: new Date().toISOString() })
  }
}
