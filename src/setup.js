import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { TunnelSupervisor } from './tunnel.js'
import { SetupBrowser } from './setup-browser.js'
import { SITE_PRESETS, visibleSites } from './config.js'
import { parseDebugQuery, parseSetupCommand, parseSyncRequest, setupRemote, SETUP_SERVICE } from './setup-contract.js'

export class WebBridgeSetup {
  constructor({ settings, driver, bridge, log = () => {}, onReinstall = () => {}, syncSession, tunnel, browser, models }) {
    this.settings = settings; this.driver = driver; this.bridge = bridge; this.log = log; this.onReinstall = onReinstall
    this.syncSession = syncSession || (async () => { throw new Error('会话同步服务尚未就绪。') })
    this.tunnel = tunnel || new TunnelSupervisor({ settings, bridge, log })
    this.models = models
    this.browser = browser || new SetupBrowser({ settings, driver, stage: text => { this.job.stage = text } })
    this.job = { busy: false, action: '', stage: '', error: '', completedAt: '' }
    this.preferences = { autoRefreshTools: true, workspaceId: '', projectName: 'Default project' }
    this.fingerprint = ''
  }
  async initialize() {
    await this.browser.load()
    try { await this.driver.restoreSessions?.() } catch (error) { this.log(`[webbridge] saved browser sessions could not be restored: ${error.message}`) }
    if (this.disposed) return
    Object.assign(this.preferences, this.browser.saved.preferences || {})
    // The default web model is a preference, so the picker survives restarts.
    if (this.preferences.defaultSite && SITE_PRESETS[this.preferences.defaultSite]) this.settings.site = this.preferences.defaultSite
    try { await this.tunnel.load() }
    catch (error) {
      this.storageError = '本地已有的隧道密钥无法解密或读取。请恢复本地配置或填写已有密钥；不会自动创建新隧道或 API Key。'
      this.job.error = this.storageError
      this.tunnel.state.status = 'error'
      return
    }
    if (this.tunnel.config?.autoReconnect) this.tunnel.start().catch(error => { this.job.error = this.tunnel.redact(error.message) })
    if (this.disposed) return
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
      browser: { debugMode: Boolean(this.driver.debugMode), headless: this.driver.headless, modeChangePending: Boolean(this.driver.modeChangePending), profileDir: this.driver.profileDir },
      visibleSites: visibleSites(this.settings),
      accountTier: this.browser.saved.accountTier || 'unknown',
      models: this.models ? { count: this.models.catalog.length, checkedAt: this.models.checkedAt ? new Date(this.models.checkedAt).toISOString() : '' } : { count: 0, checkedAt: '' },
    }
  }
  async debug(input) {
    const query = parseDebugQuery(input)
    const result = await this.driver.inspect(query.action, query)
    if (result.screenshot?.path) {
      const bytes = await readFile(result.screenshot.path)
      result.screenshot.dataUrl = `data:image/png;base64,${bytes.toString('base64')}`
    }
    return result
  }
  async sync(input) {
    return this.syncSession(parseSyncRequest(input))
  }
  execute(input) {
    const command = parseSetupCommand(input)
    if (this.job.busy) throw new Error('设置操作正在执行，请等待当前步骤完成。')
    Object.assign(this.job, { busy: true, action: command.action, stage: '等待浏览器空闲', error: '' })
    // Return immediately so settings polling stays responsive during browser work.
    this.pending = this.perform(command).then(() => {
      this.job.stage = command.action === 'loginSite' ? '登录成功，该网页模型已可用'
        : command.action === 'setDefaultSite' ? '默认网页模型已切换'
        : /login/.test(command.action) ? '登录成功，可以连接隧道'
        : command.action === 'disconnect' ? '隧道已断开'
        : command.action === 'save' ? '配置已加密保存'
        : command.action === 'setDebugMode' ? this.driver.modeChangePending
          ? `已保存，当前网页任务结束后会自动切换为${command.debugMode ? '可见调试模式' : '无头模式'}`
          : command.debugMode ? '调试模式已开启，下一次网页任务会显示浏览器窗口' : '调试模式已关闭，后续网页任务使用无头模式'
        : '配置完成'
      this.job.completedAt = new Date().toISOString()
    }).catch(error => {
      this.job.error = this.tunnel.redact(error.message)
      this.job.stage = error.code === 'manual-auth-required' ? '等待手动登录' : '操作失败，可重试'
    }).finally(() => { this.job.busy = false })
    return this.read()
  }
  async perform(command) {
    if (command.action === 'refreshModels') {
      if (!this.models) throw new Error('网页模型控制尚未就绪。')
      this.job.stage = '正在读取网页模型和思考档位'
      const choices = await this.models.list(true)
      if (choices.length && this.browser.saved.accountTier === 'free') await this.browser.persist({ accountTier: 'unknown' })
      return
    }
    if (command.action === 'setDebugMode') return this.driver.setDebugMode(command.debugMode)
    if (command.action === 'setDefaultSite') {
      if (!SITE_PRESETS[command.site]) throw new Error(`未知站点：${command.site}`)
      this.preferences.defaultSite = command.site
      this.settings.site = command.site
      await this.browser.persist({ preferences: this.preferences })
      return
    }
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
      if (command.action === 'loginSite') return this.browser.login(command.site)
      if (command.action === 'loginConsole') return this.browser.login('console')
      if (command.action === 'refreshTools') {
        await this.browser.refresh()
        this.fingerprint = this.catalogFingerprint()
        return
      }
      // The person provisions every web resource themselves: the OpenAI
      // tunnel, the Runtime API Key, and the ChatGPT plugin. Connecting only
      // stores the submitted credentials and starts the official tunnel
      // client; nothing is created or changed on the OpenAI or ChatGPT side.
      if (command.tunnelId || command.runtimeApiKey || command.networkMode || command.healthPort) {
        if ((command.runtimeApiKey || this.tunnel.config?.runtimeApiKey) && (command.tunnelId || this.tunnel.config?.tunnelId)) {
          await this.tunnel.configure(command)
          this.storageError = ''
        }
      }
      if (!this.tunnel.status().configured) {
        throw new Error('需要先填写渠道（Tunnel ID）和 Runtime API Key。隧道、密钥和 ChatGPT 网页插件都由你自行创建，步骤见帮助文档「如何获取渠道与 API Key」。')
      }
      this.job.stage = '正在连接 OpenAI 官方隧道'
      await this.tunnel.start()
      await this.tunnel.waitReady()
      this.onReinstall()
      this.fingerprint = this.catalogFingerprint()
    })
  }
  catalogFingerprint() {
    return createHash('sha256').update(JSON.stringify({ tools: this.bridge.catalog(), instructions: this.bridge.instructions || '' })).digest('hex')
  }
  async autoRefresh() {
    if (this.driver.context === null || this.driver.pages?.size === 0) return
    if (!this.job.busy && !this.driver.busy) await this.browser.observeAccount()
    if (!this.preferences.autoRefreshTools || !this.browser.saved.pluginId || this.job.busy || this.driver.busy || this.tunnel.state.status !== 'connected') return
    const next = this.catalogFingerprint()
    if (!this.fingerprint) { this.fingerprint = next; return }
    if (next === this.fingerprint) return
    this.execute({ action: 'refreshTools' })
    await this.pending
  }
  async dispose() { this.disposed = true; clearInterval(this.timer); await this.pending; await this.tunnel.stop(); await this.driver.dispose?.(); if (!this.driver.dispose) await this.driver.stop?.() }
}

/** Public Cordis provider and Typert descriptors; no installed SDK path needed. */
export function mountSetupService(ctx, controller) {
  const service = {
    read: () => controller.read(), execute: command => controller.execute(command), debug: query => controller.debug(query), sync: request => controller.sync(request),
  }
  service.typertRemote = Object.freeze({ service, serviceKey: SETUP_SERVICE, namespace: SETUP_SERVICE })
  ctx.reflect.provide(SETUP_SERVICE, service)
  ctx.inject(['typert'], scope => scope.effect(() => scope.typert.register({
    package: setupRemote.package, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: setupRemote.descriptors,
  })))
}
