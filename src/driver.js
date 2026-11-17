import { chromium } from 'playwright-core'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { BridgeError } from './envelope.js'
import { buildFingerprintScript, buildUaMetadata, buildUserAgent, defaultFingerprint } from './browser-fingerprint.js'

const DEFAULT_SESSION = '__webbridge_default__'
const STOP_SELECTOR = 'button[data-testid="stop-button"],button[aria-label="停止"],button[aria-label="停止生成"],button[aria-label="停止流式传输"],button[aria-label="Stop"],button[aria-label="Stop generating"],button[aria-label="Stop streaming"]'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function detectChromeVersion(executablePath, fallback = '') {
  const directories = [dirname(executablePath)]
  if (process.platform === 'darwin') directories.push(join(dirname(executablePath), '..', 'Frameworks', 'Google Chrome Framework.framework', 'Versions'))
  for (const directory of directories) {
    try {
      const versions = readdirSync(directory).filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name))
      versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      if (versions.length) return versions[0]
    } catch {}
  }
  return fallback
}

/**
 * WebBridge-owned persistent browser runtime. A single Chrome Context holds
 * independent Pages; AsyncLocalStorage routes every command to its DSH session.
 * Session queues are isolated, so one session never serializes another.
 */
export class BrowserDriver {
  constructor(settings, log = () => {}) {
    this.settings = settings
    this.log = log
    this.storage = new AsyncLocalStorage()
    this.queues = new Map()
    this.pages = new Map()
    this.sessionPages = new Map()
    this.sessions = new Map()
    this.context = null
    this.contextPromise = null
    this.registryLoaded = false
    this.registryWrites = Promise.resolve()
    this.stateDir = settings.stateDir || join(homedir(), '.dsh', 'webbridge')
    this.registryPath = join(this.stateDir, 'sessions.json')
    this.modePath = join(this.stateDir, 'browser-mode.json')
    this.debugMode = Boolean(settings.debugMode)
    this.active = 0
    this.lastMode = null
    this.generations = new Map()
  }

  get busy() { return this.active > 0 }
  get available() { return Boolean(this.executablePath) }
  get profileDir() { return this.settings.browserProfileDir || join(homedir(), '.dsh', 'webbridge', 'chrome-profile') }
  get headless() { return !this.debugMode && !this.lastMode?.headed }

  get executablePath() {
    const explicit = this.settings.browserExecutablePath || process.env.CHROME_PATH
    if (explicit && existsSync(explicit)) return explicit
    const candidates = process.platform === 'win32'
      ? [join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'), join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')]
      : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    return candidates.find(path => path && existsSync(path))
  }

  async loadRegistry() {
    if (this.registryLoaded) return
    this.registryLoaded = true
    try {
      const saved = JSON.parse(await readFile(this.registryPath, 'utf8'))
      for (const [key, value] of Object.entries(saved.sessions || {})) {
        if (!value || typeof value !== 'object') continue
        this.sessions.set(key, { ...value })
        if (value.pageId) this.sessionPages.set(key, value.pageId)
      }
    } catch (error) { if (error.code !== 'ENOENT') this.log(`[webbridge] session registry read failed: ${error.message}`) }
    try {
      const mode = JSON.parse(await readFile(this.modePath, 'utf8'))
      this.debugMode = mode.debugMode === true
    } catch {}
  }

  async persistRegistry() {
    const snapshot = { version: 1, updatedAt: new Date().toISOString(), sessions: Object.fromEntries(this.sessions) }
    this.registryWrites = this.registryWrites.then(async () => {
      await mkdir(this.stateDir, { recursive: true })
      const tmp = this.registryPath + '.tmp'
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 })
      await rm(this.registryPath, { force: true })
      const { rename } = await import('node:fs/promises')
      await rename(tmp, this.registryPath)
    }).catch(error => this.log(`[webbridge] session registry write failed: ${error.message}`))
    return this.registryWrites
  }

  async setDebugMode(enabled) {
    await this.loadRegistry()
    if (this.busy) throw new BridgeError('browser-busy', '浏览器正在处理会话，请等当前请求结束后再切换调试模式。')
    this.debugMode = Boolean(enabled)
    await mkdir(this.stateDir, { recursive: true })
    await writeFile(this.modePath, JSON.stringify({ debugMode: this.debugMode, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
    const reopen = this.context !== null
    const sessions = [...this.sessions.entries()]
    const activeKey = this.storage.getStore() || DEFAULT_SESSION
    const activePage = this.pages.get(this.sessionPages.get(activeKey))
    const activeUrl = activePage && !activePage.isClosed() ? activePage.url() : ''
    if (reopen) {
      await this.closeContext()
      await this.ensureContext()
      for (const [key, meta] of sessions) {
        const page = await this.getPageFor(key)
        const url = key === activeKey && activeUrl ? activeUrl : meta.url
        if (url && url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
      }
    }
    return { debugMode: this.debugMode, headless: !this.debugMode, restarted: reopen }
  }

  async ensureContext(forceHeaded = false) {
    await this.loadRegistry()
    if (this.context && this.context.browser()?.isConnected()) return this.context
    if (this.contextPromise) return this.contextPromise
    this.contextPromise = (async () => {
      await mkdir(this.profileDir, { recursive: true })
      const executablePath = this.executablePath
      if (!executablePath) throw new BridgeError('chrome-not-found', '找不到 Chrome，请安装 Google Chrome 或设置 browserExecutablePath。')
      const fingerprint = this.settings.fingerprint || defaultFingerprint()
      const version = detectChromeVersion(executablePath, this.settings.chromeVersion || '157.0.8103.52')
      const userAgent = this.settings.userAgent || buildUserAgent(version)
      const locale = this.settings.locale || Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
      const timezone = this.settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
      const args = [
        '--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check',
        '--disable-infobars', '--disable-dev-shm-usage', '--ignore-certificate-errors',
      ]
      if (this.settings.restoreSession) args.push('--restore-last-session')
      const headed = forceHeaded || this.debugMode
      this.context = await chromium.launchPersistentContext(this.profileDir, {
        headless: !headed, executablePath, viewport: { width: 1440, height: 900 },
        acceptDownloads: true, locale, ...(timezone ? { timezoneId: timezone } : {}),
        ignoreHTTPSErrors: true, args,
      })
      const context = this.context
      const applyUa = async page => {
        try {
          const cdp = await context.newCDPSession(page)
          await cdp.send('Emulation.setUserAgentOverride', { userAgent, userAgentMetadata: buildUaMetadata(version) })
        } catch {}
      }
      for (const page of context.pages()) await applyUa(page)
      context.on('page', page => { applyUa(page).catch(() => {}) })
      await context.addInitScript(buildFingerprintScript(fingerprint, userAgent, locale))
      context.on('close', () => { if (this.context === context) this.context = null })
      this.lastMode = { headed, at: Date.now() }
      this.log(`[webbridge] native Chrome started mode=${headed ? 'headed' : 'headless'} profile=${this.profileDir}`)
      return context
    })().finally(() => { this.contextPromise = null })
    return this.contextPromise
  }

  async restoreSessions() {
    await this.loadRegistry()
    if (!this.sessions.size) return { restored: 0 }
    await this.ensureContext()
    let restored = 0
    for (const key of this.sessions.keys()) {
      await this.getPageFor(key)
      restored++
    }
    this.log(`[webbridge] restored ${restored} registered session page(s)`)
    return { restored }
  }

  async getPageFor(sessionKey = DEFAULT_SESSION) {
    const context = await this.ensureContext()
    let pageId = this.sessionPages.get(sessionKey)
    let page = pageId ? this.pages.get(pageId) : null
    if (page && !page.isClosed()) return page
    page = await context.newPage()
    pageId = `wb-${createHash('sha256').update(String(sessionKey)).digest('hex').slice(0, 20)}`
    this.pages.set(pageId, page)
    this.sessionPages.set(sessionKey, pageId)
    const old = this.sessions.get(sessionKey) || {}
    this.sessions.set(sessionKey, { ...old, pageId, createdAt: old.createdAt || new Date().toISOString() })
    const savedUrl = old.url
    if (savedUrl && savedUrl !== 'about:blank') {
      await page.goto(savedUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(error => this.log(`[webbridge] restore ${sessionKey} failed: ${error.message}`))
    }
    page.on('close', () => { this.pages.delete(pageId) })
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) {
        const watchId = this.generations.get(sessionKey)
        if (watchId) this.installGenerationWatch(page, watchId).catch(() => {})
        const meta = this.sessions.get(sessionKey) || {}
        this.sessions.set(sessionKey, { ...meta, pageId, url: page.url(), updatedAt: new Date().toISOString() })
        this.persistRegistry().catch(() => {})
      }
    })
    await this.persistRegistry()
    return page
  }

  currentKey() { return this.storage.getStore() || DEFAULT_SESSION }
  async getSessionInfo(key) { await this.loadRegistry(); const value = this.sessions.get(String(key)); return value ? { ...value } : null }
  async updateSessionInfo(key, patch = {}) {
    await this.loadRegistry()
    const current = this.sessions.get(String(key)) || {}
    this.sessions.set(String(key), { ...current, ...patch, pageId: this.sessionPages.get(String(key)) || current.pageId, updatedAt: new Date().toISOString() })
    await this.persistRegistry()
  }
  async currentPage() { return this.getPageFor(this.currentKey()) }

  exclusive(operation, sessionKey = DEFAULT_SESSION) {
    const key = String(sessionKey || DEFAULT_SESSION)
    const previous = this.queues.get(key) || Promise.resolve()
    const run = previous.then(async () => {
      this.active++
      try { return await this.storage.run(key, operation) }
      finally { this.active-- }
    }, async () => {
      this.active++
      try { return await this.storage.run(key, operation) }
      finally { this.active-- }
    })
    this.queues.set(key, run.catch(() => {}))
    return run
  }

  async run(command, positional = [], options = {}) {
    if (command === 'status') return { ok: true, running: Boolean(this.context), profile: 'webbridge', health: 'native-playwright', pages: this.pages.size, headless: this.headless }
    const page = await this.currentPage()
    const timeout = options.timeoutMs ?? this.settings.commandTimeoutMs ?? 60000
    const selector = String(positional[0] || '')
    switch (command) {
      case 'state': return { ok: true, ...(await this.state()) }
      case 'query': {
        const items = await page.locator(selector).evaluateAll(nodes => nodes.map(el => {
          const r = el.getBoundingClientRect()
          return { text: (el.innerText || el.textContent || '').slice(0, 500), rect: { x:r.x,y:r.y,width:r.width,height:r.height }, tag: el.tagName, visible: !!(r.width && r.height) }
        }))
        return { ok: true, items }
      }
      case 'wait': await page.locator(selector).waitFor({ state: 'visible', timeout }); return { ok: true }
      case 'select': await page.locator(selector).selectOption(positional[1], { timeout }); return { ok: true }
      case 'screenshot': {
        const path = join(this.stateDir, 'screenshots', `webbridge-${Date.now()}.png`)
        await mkdir(join(this.stateDir, 'screenshots'), { recursive: true })
        await page.screenshot({ path, fullPage: false })
        return { ok: true, path }
      }
      case 'upload': {
        const files = positional.slice(1)
        await page.locator(selector).last().setInputFiles(files, { timeout })
        return { ok: true, files: files.length }
      }
      default: throw new BridgeError('unsupported-command', `不支持的浏览器命令：${command}`)
    }
  }

  async state() {
    const page = await this.currentPage()
    const url = page.url()
    const title = await page.title().catch(() => '')
    const parsedUrl = new URL(url || 'about:blank')
    const authUrl = parsedUrl.hostname.toLowerCase() === 'auth.openai.com' || ['/login', '/signin', '/sign-in', '/auth'].some(part => parsedUrl.pathname.toLowerCase().startsWith(part))
    const controls = await page.evaluate(() => {
      const visible = node => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      const buttons = [...document.querySelectorAll('button,a')].filter(visible)
      const signedIn = buttons.some(node => /^(打开个人资料菜单|Open profile menu)$/i.test(node.getAttribute('aria-label') || '') || node.getAttribute('data-testid') === 'accounts-profile-button')
        || location.hostname === 'platform.openai.com' && buttons.some(node => /^(Create new secret key|Create tunnel|创建新密钥|创建隧道)$/i.test((node.innerText || '').trim()))
      const login = buttons.some(node => /^(登录|Log in|Sign in)$/.test((node.innerText || '').trim()))
      const password = [...document.querySelectorAll('input[type="password"]')].some(visible)
      const challenge = [...document.querySelectorAll('iframe[src*="captcha"],iframe[src*="challenges.cloudflare.com"],#challenge-running,#challenge-stage,[data-testid="captcha"]')].some(visible)
        || !signedIn && [...document.querySelectorAll('h1,h2')].filter(visible).some(node => /verify you are human|人机验证|访问验证|Just a moment/i.test(node.textContent || ''))
      return { signedIn, login, password, challenge }
    }).catch(() => ({ signedIn: false }))
    const challenge = Boolean(controls.challenge)
    const loginRequired = Boolean(authUrl || challenge || controls.password || controls.login && !controls.signedIn)
    const manualAuth = { required: loginRequired, kind: challenge ? 'verification' : 'login', reasons: loginRequired ? [challenge ? 'verification-page' : authUrl ? 'login-url' : 'login-control'] : [] }
    const result = { url, title, headless: !this.lastMode?.headed, authenticated: Boolean(controls.signedIn && !loginRequired), manualAuth }
    return result
  }

  async open(url, options = {}) {
    const page = await this.currentPage()
    if (options.headed && !this.debugMode && this.lastMode?.headed !== true) {
      if (this.active > 1 || this.generations.size) throw new BridgeError('browser-busy', '其他会话仍在生成，请等待结束后再打开登录窗口。')
      // Login is the only operation allowed to request a temporary visible browser.
      const current = page.url()
      await this.closeContext()
      await this.ensureContext(true)
      const headedPage = await this.currentPage()
      if (current && current !== 'about:blank') await headedPage.goto(current, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {})
      return this.open(url, { ...options, headed: false })
    }
    const response = await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: options.timeoutMs || 45000 })
    return { url: page.url(), status: response?.status() ?? null }
  }

  async click(selector, options = {}) { const page = await this.currentPage(); await page.locator(selector).filter({ visible: true }).first().click({ timeout: options.timeoutMs || 20000 }); return { ok: true } }
  async fill(selector, value, options = {}) { const page = await this.currentPage(); const loc = page.locator(selector).filter({ visible: true }).first(); if (options.append) await loc.pressSequentially(String(value), { timeout: options.timeoutMs || 30000 }); else await loc.fill(String(value), { timeout: options.timeoutMs || 30000 }); return { ok: true } }
  async fillLong(selector, value, options = {}) { return this.fill(selector, value, options) }
  async press(key, options = {}) { const page = await this.currentPage(); await page.keyboard.press(String(key), { timeout: options.timeoutMs || 10000 }); return { ok: true } }
  async eval(expression, options = {}) { const page = await this.currentPage(); const result = await page.evaluate(String(expression)); return { result } }
  async attachTextFile(name, content) {
    const page = await this.currentPage()
    const payload = { name: basename(String(name)), content: String(content).slice(0, 20000) }
    const result = await page.evaluate(({ name, content }) => {
      const input = [...document.querySelectorAll('input[type="file"]')].at(-1)
      if (!input) return { ok: false, reason: 'no-file-input' }
      const dt = new DataTransfer()
      dt.items.add(new File([content], name, { type: 'text/plain' }))
      input.files = dt.files
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, files: input.files.length }
    }, payload)
    return result
  }
  async attachFiles(files, options = {}) {
    const root = join(this.stateDir, 'uploads')
    await mkdir(root, { recursive: true })
    const temporary = await import('node:fs/promises').then(fs => fs.mkdtemp(join(root, 'webbridge-')))
    try {
      const paths = []
      for (const [i, file] of files.entries()) {
        const dir = join(temporary, String(i)); await mkdir(dir)
        const name = basename(String(file.name || `attachment-${i + 1}`)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        const path = join(dir, name)
        if (file.path) await copyFile(file.path, path)
        else if (typeof file.content === 'string') await writeFile(path, file.content, { mode: 0o600 })
        else throw new BridgeError('attachment-unavailable', `无法读取附件 ${name}`)
        paths.push(path)
      }
      await this.run('upload', ['input[type="file"]', ...paths], { timeoutMs: options.timeoutMs || 60000, signal: options.signal })
      return { ok: true, release: () => rm(temporary, { recursive: true, force: true }) }
    } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error }
  }
  async prepareUploads() {}
  async composerBlank(inputSelector) { const page = await this.currentPage(); return await page.locator(inputSelector).evaluateAll(nodes => nodes.length > 0 && nodes.every(el => !(el.value ?? el.textContent ?? '').trim())) }
  async startGenerationWatch(id) {
    this.generations.set(this.currentKey(), id)
    await this.installGenerationWatch(await this.currentPage(), id)
  }
  async installGenerationWatch(page, id) {
    await page.evaluate(`(() => {
      if (window.__webbridgeGenerationWatch?.id === ${JSON.stringify(id)} && window.__webbridgeGenerationWatch.active && window.__webbridgeStopListener) return true;
      if (window.__webbridgeStopListener) document.removeEventListener('click', window.__webbridgeStopListener, true);
      const watch = window.__webbridgeGenerationWatch = { id: ${JSON.stringify(id)}, active: true, stopped: false };
      window.__webbridgeStopListener = event => {
        if (event.isTrusted && watch.active && event.target?.closest?.(${JSON.stringify(STOP_SELECTOR)})) watch.stopped = true;
      };
      document.addEventListener('click', window.__webbridgeStopListener, true);
      return true;
    })()`)
  }
  async stopGeneration(id) {
    const page = await this.currentPage()
    const own = this.generations.get(this.currentKey()) === id || await page.evaluate(id => Boolean(window.__webbridgeGenerationWatch?.active && window.__webbridgeGenerationWatch.id === id), id)
    if (own) {
      const button = page.locator(STOP_SELECTOR).filter({ visible: true }).first()
      if (await button.count()) {
        await button.click()
        await button.waitFor({ state: 'hidden', timeout: 10000 })
      }
    }
  }
  async endGenerationWatch(id) {
    try { await this.eval(`(() => {
      if(window.__webbridgeGenerationWatch?.id === ${JSON.stringify(id)}) {
        window.__webbridgeGenerationWatch.active = false;
        if (window.__webbridgeStopListener) document.removeEventListener('click', window.__webbridgeStopListener, true);
      }
      return true;
    })()`) } finally { if (this.generations.get(this.currentKey()) === id) this.generations.delete(this.currentKey()) }
  }
  async waitLogin(timeoutMs, options = {}) { const end = Date.now() + timeoutMs; while(Date.now() < end) { const s = await this.state(); if(s.authenticated) return s; if (options.signal?.aborted) throw new BridgeError('aborted', '等待登录已取消。'); await sleep(1000) } throw new BridgeError('manual-auth-timeout','等待登录超时。') }
  async switchToHeadless({ allowCurrentOperation = false } = {}) {
    if (this.debugMode || !this.lastMode?.headed) return { changed: false, headless: !this.lastMode?.headed }
    if (this.active > (allowCurrentOperation ? 1 : 0) || this.generations.size) return { changed: false, headless: false, pending: true }
    const saved = [...this.sessions.entries()].map(([key, value]) => [key, value.url])
    await this.closeContext()
    await this.ensureContext(false)
    for (const [key, url] of saved) {
      if (!url || url === 'about:blank') continue
      const page = await this.getPageFor(key)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(error => this.log(`[webbridge] headless restore failed for ${key}: ${error.message}`))
    }
    return { changed: true, headless: true }
  }
  async stop() { await this.persistRegistry(); await this.closeContext(); return { ok: true } }
  async closeContext() {
    const context = this.context
    this.context = null
    if (context) await context.close().catch(() => {})
    this.pages.clear()
    this.lastMode = null
    this.generations.clear()
  }
}
