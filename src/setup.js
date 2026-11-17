import { createHash } from 'node:crypto'
import { TunnelSupervisor } from './tunnel.js'
import { SetupBrowser } from './setup-browser.js'
import { parseSetupCommand, setupRemote, SETUP_SERVICE } from './setup-contract.js'

export class WebBridgeSetup {
  constructor({ settings, driver, bridge, log = () => {}, onReinstall = () => {}, tunnel, browser }) {
    this.settings = settings; this.driver = driver; this.bridge = bridge; this.log = log; this.onReinstall = onReinstall
    this.tunnel = tunnel || new TunnelSupervisor({ settings, bridge, log })
    this.browser = browser || new SetupBrowser({ settings, driver, stage: text => { this.job.stage = text } })
    this.job = { busy: false, action: '', stage: '', error: '', completedAt: '' }
    this.preferences = { autoRefreshTools: true, workspaceId: '', projectName: 'Default project' }
    this.fingerprint = ''
  }
  async initialize() {
    await this.browser.load()
    try { await this.driver.restoreSessions?.() } catch (error) { this.log(`[webbridge] saved browser sessions could not be restored: ${error.message}`) }
    Object.assign(this.preferences, this.browser.saved.preferences || {})
    try { await this.tunnel.load() }
    catch (error) {
      this.storageError = '本地已有的隧道密钥无法解密或读取。请恢复本地配置或填写已有密钥；不会自动创建新隧道或 API Key。'
      this.job.error = this.storageError
      this.tunnel.state.status = 'error'
      return
    }
    if (this.tunnel.config?.autoReconnect) this.tunnel.start().catch(error => { this.job.error = this.tunnel.redact(error.message) })
    this.timer = setInterval(() => this.autoRefresh().catch(error => { this.log(`[webbridge:setup] ${this.tunnel.redact(error.message)}`) }), 15000)
    this.timer.unref?.()
  }
  read() {
    return {
      tunnel: this.tunnel.status(), job: { ...this.job }, auth: { ...this.browser.auth },
      pluginId: this.browser.saved.pluginId || '', toolsRefreshedAt: this.browser.saved.toolsRefreshedAt || '',
      pluginInstalled: this.browser.saved.pluginInstalled === true, permissionsAll: this.browser.saved.permissionsAll === true,
      toolCount: this.bridge.status().exposed?.dsh?.length || 0,
      preferences: { ...this.preferences },
      browser: { debugMode: Boolean(this.driver.debugMode), headless: this.driver.headless, profileDir: this.driver.profileDir },
      accountTier: this.browser.saved.accountTier || 'unknown',
    }
  }
  execute(input) {
    const command = parseSetupCommand(input)
    if (this.job.busy) throw new Error('设置操作正在执行，请等待当前步骤完成。')
    Object.assign(this.job, { busy: true, action: command.action, stage: '等待浏览器空闲', error: '' })
    // Return immediately so settings polling stays responsive during browser work.
    this.pending = this.perform(command).then(() => {
      this.job.stage = /login/.test(command.action) ? '请在浏览器完成登录；完成后点击连接隧道' : command.action === 'disconnect' ? '隧道已断开' : command.action === 'save' ? '配置已加密保存' : '配置完成'
      this.job.completedAt = new Date().toISOString()
    }).catch(error => {
      this.job.error = this.tunnel.redact(error.message)
      this.job.stage = error.code === 'manual-auth-required' ? '等待手动登录' : '操作失败，可重试'
    }).finally(() => { this.job.busy = false })
    return this.read()
  }
  async perform(command) {
    if (command.action === 'setDebugMode') return this.driver.setDebugMode(command.debugMode)
    if (command.action === 'disconnect') { await this.tunnel.stop(); return }
    if (this.storageError && ['connect', 'reinstall', 'save'].includes(command.action) && !(command.tunnelId && command.runtimeApiKey)) throw new Error(this.storageError)
    for (const key of ['autoRefreshTools', 'workspaceId', 'projectName']) if (command[key] !== undefined) this.preferences[key] = command[key]
    await this.browser.persist({ preferences: this.preferences })
    if (command.action === 'save') {
      await this.tunnel.configure(command)
      this.storageError = ''
      return
    }
    return this.driver.exclusive(async () => {
      if (command.action === 'loginChatgpt') return this.browser.login('chatgpt')
      if (command.action === 'loginConsole') return this.browser.login('console')
      if (command.action === 'refreshTools') {
        await this.browser.refresh()
        this.fingerprint = this.catalogFingerprint()
        return
      }
      if (command.tunnelId || command.runtimeApiKey || command.networkMode || command.healthPort) {
        // Save existing/manual credentials; missing ones are provisioned below.
        if ((command.runtimeApiKey || this.tunnel.config?.runtimeApiKey) && (command.tunnelId || this.tunnel.config?.tunnelId)) {
          await this.tunnel.configure(command)
          this.storageError = ''
        }
      }
      const upgradeTestKey = Boolean(this.tunnel.config?.runtimeApiKey && this.tunnel.config?.keyExpiresAt)
      if (!this.tunnel.status().configured || upgradeTestKey) {
        await this.browser.createResources({
          ...this.preferences, tunnelId: this.tunnel.config?.tunnelId || command.tunnelId,
          testKey: false, upgradeTestKey,
          onKey: values => this.tunnel.configure({ ...command, ...values }),
        })
      }
      this.job.stage = '正在连接 OpenAI 官方隧道'
      await this.tunnel.start()
      await this.tunnel.waitReady()
      this.job.stage = '正在配置 ChatGPT 网页插件'
      // Clicking connect is an explicit repair/reinstall operation. Deleting the
      // personal definition as well as uninstalling avoids the duplicate-name 409.
      await this.browser.install(this.tunnel.config.tunnelId)
      this.browser.auth.chatgpt = 'ready'
      this.onReinstall()
      this.fingerprint = this.catalogFingerprint()
    })
  }
  catalogFingerprint() {
    return createHash('sha256').update(JSON.stringify(this.bridge.catalog())).digest('hex')
  }
  async autoRefresh() {
    if (!this.job.busy && !this.driver.busy) await this.browser.observeAccount()
    if (!this.preferences.autoRefreshTools || !this.browser.saved.pluginId || this.job.busy || this.driver.busy || this.tunnel.state.status !== 'connected') return
    const next = this.catalogFingerprint()
    if (!this.fingerprint) { this.fingerprint = next; return }
    if (next === this.fingerprint) return
    this.execute({ action: 'refreshTools' })
    await this.pending
  }
  async dispose() { clearInterval(this.timer); await this.pending; await this.tunnel.stop(); await this.driver.stop?.() }
}

/** Public Cordis provider and Typert descriptors; no installed SDK path needed. */
export function mountSetupService(ctx, controller) {
  const service = {
    read: () => controller.read(), execute: command => controller.execute(command),
  }
  service.typertRemote = Object.freeze({ service, serviceKey: SETUP_SERVICE, namespace: SETUP_SERVICE })
  ctx.reflect.provide(SETUP_SERVICE, service)
  ctx.inject(['typert'], scope => scope.effect(() => scope.typert.register({
    package: setupRemote.package, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: setupRemote.descriptors,
  })))
}
