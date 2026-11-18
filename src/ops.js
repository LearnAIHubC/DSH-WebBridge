import { SITE_PRESETS } from './config.js'
import { loadAdapter, saveAdapter, listAdapters, buildProbeExpression } from './adapters.js'
import { annotateOverlayExpression, annotateReadExpression, ANNOTATE_ROLES } from './annotate.js'
import { BridgeError } from './envelope.js'
import { ChatSession } from './session.js'

/**
 * Operations shared by both surfaces: the DSH tools registered in index.js and
 * the MCP server used by ChatGPT (mode B). Keeping one implementation is the
 * Nexus lesson about a single source of truth 鈥?two code paths for the same
 * capability drift and then disagree about policy.
 */
export function createOps({ settings, driver, session, log }) {
  let setupInstance = null
  const scoped = timeoutMs => timeoutMs === undefined || timeoutMs === null ? settings : { ...settings, replyTimeoutMs: Math.max(0, Number(timeoutMs) || 0) }

  return {
    /** Late-bound by index.js once WebBridgeSetup exists; the MCP
     *  webbridge_tunnel tool routes here so an AI can prefill credentials the
     *  same encrypted way the settings page does. Keys never travel back. */
    bindSetup(instance) { setupInstance = instance },
    async tunnel(args, signal) {
      const action = String(args.action || '')
      if (!['save', 'connect'].includes(action)) throw new BridgeError('bad-request', 'action 必须是 save 或 connect。')
      const command = { action }
      if (typeof args.tunnelId === 'string' && args.tunnelId.trim()) command.tunnelId = args.tunnelId.trim().slice(0, 200)
      else throw new BridgeError('bad-request', '缺少 tunnelId（渠道 Tunnel ID）。')
      if (typeof args.runtimeApiKey === 'string' && args.runtimeApiKey.trim()) command.runtimeApiKey = args.runtimeApiKey.trim().slice(0, 512)
      if (!setupInstance) throw new BridgeError('setup-unavailable', '设置服务尚未就绪，无法保存渠道配置。')
      return setupInstance.execute(command)
    },

    async debugMode(args) {
      if (typeof args.enabled !== 'boolean') throw new BridgeError('bad-request', 'enabled 必须是布尔值。')
      return driver.setDebugMode(args.enabled)
    },

    async status() {
      let daemon = { running: false }
      try {
        const status = await driver.run('status', [], { timeoutMs: 15000 })
        daemon = { running: Boolean(status.running), profile: status.profile, health: status.health ?? null }
      } catch (err) {
        daemon = { running: false, error: err?.code || 'unknown' }
      }
      const adapter = loadAdapter(settings, settings.site)
      return {
        version: settings.version,
        settings: {
          site: settings.site,
          browserProfileDir: settings.browserProfileDir,
          debugMode: Boolean(driver.debugMode),
          headless: driver.headless,
          modeChangePending: Boolean(driver.modeChangePending),
          sites: Object.keys(SITE_PRESETS),
          replyTimeoutMs: settings.replyTimeoutMs,
          pollIntervalMs: settings.pollIntervalMs,
          stableSamples: settings.stableSamples,
        },
        driver: { type: 'native-playwright', available: driver.available, profileDir: driver.profileDir, pageCount: driver.pages?.size || 0, headless: driver.headless, modeChangePending: Boolean(driver.modeChangePending) },
        daemon,
        adapter: {
          source: adapter.source,
          verified: Boolean(adapter.verified),
          inputSelector: adapter.inputSelector,
          messageSelector: adapter.messageSelector,
        },
        calibratedSites: listAdapters(settings),
        mcp: { enabled: Boolean(settings.mcp?.enabled), port: settings.mcp?.port },
      }
    },

    async open(args, signal) {
      return driver.exclusive(async () => {
      const site = args.site || settings.site
      const preset = SITE_PRESETS[site]
      if (!preset && !args.url) {
        throw new BridgeError('unknown-site', `Unknown site "${site}". Known: ${Object.keys(SITE_PRESETS).join(', ')}`)
      }
      const opened = await driver.open(args.url || preset.url, { headed: args.headed, signal })
      let manualAuth = null
      let authenticated = false
      try {
        const state = await driver.state()
        manualAuth = state.manualAuth ?? null
        authenticated = state.authenticated === true
      } catch {}
      if (args.headed && authenticated && !driver.debugMode) await driver.switchToHeadless?.()
      return {
        site,
        url: opened.url ?? args.url ?? preset.url,
        manualAuth,
        actionRequired: manualAuth?.required === true,
      }
      }, '__webbridge_default__')
    },

    async ask(args, signal) {
      const scopedSettings = scoped(args.timeoutMs)
      const runner = scopedSettings === settings ? session : new ChatSession({ settings: scopedSettings, driver, log })
      const result = await runner.ask(String(args.message), { site: args.site, signal })
      return {
        site: result.site,
        reply: result.reply,
        truncated: Boolean(result.truncated),
        elapsedMs: result.elapsedMs,
        totalMs: result.totalMs,
        messageCount: result.count,
      }
    },

    async send(args, signal) {
      const result = await session.send(String(args.message), { site: args.site, signal })
      return { site: result.site, sentAt: result.sentAt, baselineCount: result.baseline?.count ?? 0 }
    },

    async read(args, signal) {
      const result = await session.read({ site: args.site, signal })
      return { site: result.site, reply: result.text, messageCount: result.count, streaming: result.streaming }
    },

    async newChat(args, signal) {
      const result = await session.newChat({ site: args.site, signal })
      return { site: result.site, url: result.url }
    },

    async adapter(args, signal) {
      return driver.exclusive(async () => {
      const site = args.site || settings.site
      const annotate = String(args.annotate || '')
      if (annotate === 'start') {
        const installed = await driver.eval(annotateOverlayExpression(), { timeoutMs: 20000, signal })
        return { site, annotate: 'started', roles: ANNOTATE_ROLES.map(role => role.key), ...(installed.result ?? {}) }
      }
      if (annotate === 'read') {
        const read = await driver.eval(annotateReadExpression(), { timeoutMs: 20000, signal })
        const payload = read?.result ?? {}
        const fields = { input: 'inputSelector', send: 'sendSelector', message: 'messageSelector', streaming: 'streamingSelector' }
        const patch = {}
        for (const box of payload.boxes || []) {
          if (box.selector && box.unique !== false && fields[box.role]) patch[fields[box.role]] = box.selector
        }
        let saved = null
        if (args.save && Object.keys(patch).length) saved = saveAdapter(settings, site, { ...patch, verified: true })
        return { site, annotate: 'read', ...payload, patch, saved: Boolean(saved), adapter: saved ?? loadAdapter(settings, site) }
      }
      if (args.save) {
        const saved = saveAdapter(settings, site, {
          inputSelector: args.inputSelector,
          sendSelector: args.sendSelector,
          messageSelector: args.messageSelector,
          streamingSelector: args.streamingSelector,
          verified: true,
        })
        return { site, saved: true, adapter: saved }
      }
      const adapter = loadAdapter(settings, site)
      if (!args.probe) return { site, adapter }
      const probe = await driver.eval(buildProbeExpression(adapter), { timeoutMs: 20000, signal })
      return { site, adapter, probe: probe.result ?? null }
      }, '__webbridge_default__')
    },

    async browser(args, signal) {
      if (['console', 'network', 'debug', 'pages'].includes(args.action)) return { action: args.action, result: await driver.inspect(args.action, args) }
      return driver.exclusive(async () => {
      const action = String(args.action || '')
      switch (action) {
        case 'state':
          return { action, result: await driver.state() }
        case 'open':
          return {
            action,
            result: await driver.open(String(args.url || SITE_PRESETS[settings.site]?.url || ''), { signal }),
          }
        case 'click':
          return { action, result: await driver.click(String(args.selector || ''), { signal }) }
        case 'fill':
          return { action, result: await driver.fillLong(String(args.selector || ''), String(args.value ?? ''), { signal }) }
        case 'press':
          return { action, result: await driver.press(String(args.value || 'Enter'), { signal }) }
        case 'eval':
          return { action, result: (await driver.eval(String(args.expression || ''), { signal })).result ?? null }
        case 'screenshot': {
          const shot = await driver.run('screenshot', [], { timeoutMs: 30000, signal })
          return { action, path: shot.path ?? null }
        }
        case 'stop':
          return { action, result: await driver.stop({ signal }) }
        default:
          throw new BridgeError('unknown-action', `Unsupported action "${action}"`)
      }
      }, '__webbridge_default__')
    },
  }
}

