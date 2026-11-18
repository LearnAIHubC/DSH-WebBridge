// Port of Nexus's OpenAI Secure MCP Tunnel supervisor (AGPL-3.0).
// See THIRD_PARTY_NOTICES.md and docs/licenses/Nexus-AGPL-3.0.txt.
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import { SecretVault } from './vault.js'
import { installMacRuntime, runtimeFiles } from '../scripts/prepare-tunnel-runtime.mjs'

const runFile = promisify(execFile)
const BACKOFF = [5000, 10000, 20000, 30000, 60000]
const runtimeScript = fileURLToPath(new URL('../scripts/prepare-tunnel-runtime.ps1', import.meta.url))

export function normalizeProxy(raw) {
  const parts = String(raw || '').trim().split(';').map(value => value.trim())
  const value = (parts.find(part => part.startsWith('https=')) || parts.find(part => part.startsWith('http=')) || parts[0]).replace(/^https?=/, '')
  const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error('代理地址应为不含账号密码的 http://主机:端口。')
  }
  return url.origin
}

export function macSystemProxy(text) {
  const value = name => text.match(new RegExp(`^\\s*${name}\\s*:\\s*([^\\r\\n]+)`, 'm'))?.[1].trim()
  for (const scheme of ['HTTPS', 'HTTP']) {
    if (value(`${scheme}Enable`) !== '1') continue
    const host = value(`${scheme}Proxy`)
    const port = Number(value(`${scheme}Port`))
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('macOS 系统代理地址或端口无效。')
    return normalizeProxy(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`)
  }
  if (value('ProxyAutoConfigEnable') === '1' || value('ProxyAutoDiscoveryEnable') === '1') throw new Error('当前系统使用 PAC 代理，请选择自定义代理地址。')
  if (value('SOCKSEnable') === '1') throw new Error('当前系统仅配置 SOCKS 代理，请选择自定义 HTTP 代理地址。')
  return null
}

export async function systemProxy() {
  if (process.platform !== 'win32') {
    const value = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    if (value) return normalizeProxy(value)
    if (process.platform === 'darwin') {
      const { stdout } = await runFile('/usr/sbin/scutil', ['--proxy'])
      return macSystemProxy(stdout)
    }
    return null
  }
  const { stdout } = await runFile('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { windowsHide: true })
  const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/.test(stdout)
  const server = stdout.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/)?.[1]
  if (enabled && server) return normalizeProxy(server)
  if (/AutoConfigURL\s+REG_SZ\s+\S/.test(stdout)) throw new Error('当前系统使用 PAC 代理，请选择自定义代理地址。')
  return null
}

export function tunnelCommand(config, { runtimePath, mcpUrl, mcpToken, proxy, env = process.env }) {
  const args = [
    'run', '--log.level=info', '--log.format=struct-text',
    `--health.listen-addr=127.0.0.1:${config.healthPort}`,
    `--control-plane.tunnel-id=${config.tunnelId}`,
    '--control-plane.api-key=env:CONTROL_PLANE_API_KEY',
    `--mcp.server-url=${mcpUrl}`, '--mcp.extra-headers=Authorization: env:LOCALBRIDGE_MCP_AUTH',
    '--harpoon.additional-transport=http-streamable', '--harpoon.allow-plaintext-http',
    '--harpoon.max-response-bytes=102400',
  ]
  if (proxy) args.push(`--control-plane.http-proxy=${proxy}`)
  const childEnv = { ...env }
  for (const name of Object.keys(childEnv)) {
    if (/^(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|TUNNEL_CLIENT_HTTP_PROXY|CONTROL_PLANE_HTTP_PROXY|NO_PROXY)$/i.test(name)) delete childEnv[name]
  }
  // Keep the companion path in the separator style of the runtime path itself;
  // path.join would rewrite POSIX-style input into Windows separators.
  const cloudflaredName = runtimePath.endsWith('.exe') ? 'cloudflared.exe' : 'cloudflared'
  const separator = runtimePath.includes('/') ? '/' : '\\'
  Object.assign(childEnv, {
    CONTROL_PLANE_API_KEY: config.runtimeApiKey, CONTROL_PLANE_TUNNEL_ID: config.tunnelId,
    MCP_SERVER_URL: mcpUrl, LOCALBRIDGE_MCP_AUTH: `Bearer ${mcpToken}`,
    MCP_EXTRA_HEADERS: 'Authorization: env:LOCALBRIDGE_MCP_AUTH',
    HARPOON_ADDITIONAL_TRANSPORTS: 'http-streamable', HARPOON_ALLOW_PLAINTEXT_HTTP: 'true',
    HARPOON_MAX_RESPONSE_BYTES: '102400', HEALTH_LISTEN_ADDR: `127.0.0.1:${config.healthPort}`,
    CLOUDFLARED_PATH: `${dirname(runtimePath)}${separator}${cloudflaredName}`, NO_PROXY: '127.0.0.1,localhost,::1',
  })
  if (proxy) childEnv.CONTROL_PLANE_HTTP_PROXY = proxy
  return { args, options: { env: childEnv, cwd: dirname(runtimePath), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] } }
}

export function pollMetrics(text) {
  const metric = name => Number(text.match(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([\\d.eE+-]+)`, 'm'))?.[1] || 0)
  return { lastPoll: metric('commands_poll_last_successful_timestamp_seconds'), pollErrors: metric('commands_poll_errors_total') }
}

export function controlPlaneAuthFailure(line) {
  return /component[=:]["']?(?:controlplane|control-plane)\b/i.test(line) &&
    (/invalid.api.key|authentication.failed|unauthorized|\b401\b/i.test(line) || /\b403\b/.test(line) && /permission|scope|forbidden|denied/i.test(line))
}

export class TunnelSupervisor {
  constructor({ settings, bridge, log = () => {}, vault, spawnProcess = spawn }) {
    this.settings = settings; this.bridge = bridge; this.log = log; this.spawnProcess = spawnProcess
    this.vault = vault || new SecretVault(join(settings.stateDir, 'tunnel-config.enc'))
    this.config = null; this.child = null; this.desired = false; this.attempt = 0; this.retryAt = 0
    this.state = { status: 'not-configured', error: '', lastPoll: 0, pollErrors: 0, activeProxy: '' }
  }
  async load() { this.config = await this.vault.read(); return this.status() }
  status() {
    const config = this.config
    return {
      ...this.state, configured: Boolean(config?.tunnelId && config?.runtimeApiKey),
      tunnelId: config?.tunnelId || '', hasApiKey: Boolean(config?.runtimeApiKey),
      networkMode: config?.networkMode || 'system', customProxy: config?.customProxy || '',
      autoReconnect: config?.autoReconnect !== false, healthPort: config?.healthPort || 18484,
      keyExpiresAt: config?.keyExpiresAt || '', reconnectAttempts: this.attempt, pid: this.child?.pid || null,
    }
  }
  async configure(input) {
    const tunnelId = String(input.tunnelId || this.config?.tunnelId || '').match(/tunnel_[a-zA-Z0-9]+/)?.[0]
    const runtimeApiKey = String(input.runtimeApiKey || this.config?.runtimeApiKey || '').trim()
    if (!tunnelId || !runtimeApiKey) throw new Error('需要 Tunnel ID 和 Runtime API Key。')
    const networkMode = input.networkMode || this.config?.networkMode || 'system'
    if (!['direct', 'system', 'custom'].includes(networkMode)) throw new Error('无效的隧道网络模式。')
    const customProxy = networkMode === 'custom' ? normalizeProxy(input.customProxy || this.config?.customProxy) : ''
    const healthPort = Number(input.healthPort || this.config?.healthPort || 18484)
    if (!Number.isInteger(healthPort) || healthPort < 1024 || healthPort > 65535) throw new Error('无效的健康检查端口。')
    const keyExpiresAt = input.keyExpiresAt !== undefined ? input.keyExpiresAt
      : input.runtimeApiKey && input.runtimeApiKey !== this.config?.runtimeApiKey ? '' : this.config?.keyExpiresAt || ''
    const config = { tunnelId, runtimeApiKey, networkMode, customProxy, healthPort, autoReconnect: input.autoReconnect ?? this.config?.autoReconnect ?? true, keyExpiresAt }
    if (this.config && Object.entries(config).every(([key, value]) => this.config[key] === value)) return this.status()
    await this.stop()
    await this.vault.write(config)
    this.config = config; this.state.status = 'stopped'; this.state.error = ''
    return this.status()
  }
  async runtime() {
    const { runtime: runtimeName, cloudflared } = runtimeFiles()
    const candidates = [
      this.settings.tunnel?.runtimePath,
      fileURLToPath(new URL(`../resources/tunnel/${runtimeName}`, import.meta.url)),
      join(this.settings.stateDir, 'tunnel-runtime', runtimeName),
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Nexus', 'resources', 'tunnel', runtimeName),
    ].filter(Boolean)
    const path = candidates.find(value => existsSync(value) && existsSync(join(dirname(value), cloudflared)))
    if (path) return path
    this.state.status = 'installing-runtime'
    if (process.platform === 'darwin') {
      const proxy = this.config?.networkMode === 'custom' ? normalizeProxy(this.config.customProxy)
        : this.config?.networkMode === 'direct' ? null : await systemProxy()
      return installMacRuntime(join(this.settings.stateDir, 'tunnel-runtime'), { proxy })
    }
    if (process.platform !== 'win32') throw new Error('隧道自动安装目前支持 Windows 和 macOS。')
    await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runtimeScript, '-DestinationPath', join(this.settings.stateDir, 'tunnel-runtime')], { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 })
    return join(this.settings.stateDir, 'tunnel-runtime', runtimeName)
  }
  start() {
    if (this.starting) return this.starting
    if (this.child) return Promise.resolve(this.status())
    this.desired = true
    this.starting = this.launch().catch(error => {
      this.state.error = this.redact(error.message); this.state.status = this.state.status === 'authentication-error' ? this.state.status : 'error'
      this.retryAt = Date.now() + BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]
      throw error
    }).finally(() => { this.starting = null; this.monitor() })
    return this.starting
  }
  async launch() {
    if (!this.config) await this.load()
    if (!this.config) { this.desired = false; throw new Error('请先配置隧道。') }
    if (this.config.keyExpiresAt && Date.parse(this.config.keyExpiresAt) < Date.now()) {
      this.state.status = 'authentication-error'; this.desired = false; throw new Error('测试 API Key 已过期，请创建新的 Runtime API Key。')
    }
    await this.bridge.start()
    this.state.status = 'starting'; this.state.error = ''
    const runtimePath = await this.runtime()
    const proxy = this.config.networkMode === 'custom' ? normalizeProxy(this.config.customProxy) : this.config.networkMode === 'system' ? await systemProxy() : null
    this.state.activeProxy = proxy || ''
    await new Promise((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', () => reject(new Error(`健康检查端口 ${this.config.healthPort} 已被占用，请更换端口。`)))
      probe.listen(this.config.healthPort, '127.0.0.1', () => probe.close(resolve))
    })
    if (!this.desired) return this.status()
    const spec = tunnelCommand(this.config, { runtimePath, mcpUrl: this.bridge.loopbackUrl, mcpToken: this.bridge.token, proxy })
    const child = this.spawnProcess(runtimePath, spec.args, spec.options)
    this.child = child; this.state.lastPoll = 0; this.authFailure = false; this.authFailureAt = 0
    let pending = ''
    const onData = chunk => {
      pending += String(chunk)
      const lines = pending.split(/\r?\n/); pending = lines.pop().slice(-4096)
      for (const line of lines) {
        if (controlPlaneAuthFailure(line)) {
          this.authFailure = true
          this.authFailureAt = Date.now() / 1000
          this.state.status = 'authentication-error'; this.state.error = 'Runtime API Key 无效、过期或缺少 Tunnels Read / Use 权限。'
        }
        this.log(`[webbridge:tunnel] ${this.redact(line)}`)
      }
    }
    child.stdout?.on('data', onData); child.stderr?.on('data', onData)
    child.once('error', error => { this.state.error = this.redact(error.message) })
    child.once('close', () => {
      if (this.child !== child) return
      this.child = null
      if (this.desired && this.config.autoReconnect && this.state.status !== 'authentication-error') {
        this.state.status = 'reconnecting'; this.retryAt = Date.now() + BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)]
      } else if (this.state.status !== 'authentication-error') this.state.status = 'stopped'
    })
    this.state.status = 'connecting'
    return this.status()
  }
  redact(value) {
    let text = String(value || '')
    for (const secret of [this.config?.runtimeApiKey, this.bridge.token]) if (secret) text = text.split(secret).join('[redacted]')
    return text.replace(/sk-[\w-]+|wbr_[\w-]+/g, '[redacted]')
  }
  monitor() {
    if (this.timer) return
    this.timer = setInterval(() => this.tick().catch(error => { this.state.error = this.redact(error.message) }), 1000)
    this.timer.unref?.()
  }
  async tick() {
    if (this.ticking) return
    this.ticking = true
    try {
      if (!this.child) {
        if (this.desired && this.config?.autoReconnect && !this.starting && Date.now() >= this.retryAt && this.state.status !== 'authentication-error') await this.start().catch(() => {})
        return
      }
      const base = `http://127.0.0.1:${this.config.healthPort}`
      const [ready, metrics] = await Promise.all([fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1500) }), fetch(`${base}/metrics`, { signal: AbortSignal.timeout(1500) })])
      if (!this.desired) return
      Object.assign(this.state, pollMetrics(await metrics.text()))
      if (ready.ok && this.state.lastPoll > Date.now() / 1000 - 90 && this.state.lastPoll >= (this.authFailureAt || 0) - 1) {
        this.state.status = 'connected'; this.state.error = ''; this.attempt = 0; this.authFailure = false
      } else this.state.status = this.authFailure ? 'authentication-error' : 'connecting'
    } finally { this.ticking = false }
  }
  async waitReady(timeoutMs = 60000) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (this.state.status === 'connected') return this.status()
      if (!this.desired || this.state.status === 'authentication-error') throw new Error(this.state.error || '隧道已停止。')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new Error('隧道连接超时，请检查网络代理和 Runtime API Key 权限。')
  }
  async stop() {
    this.desired = false; clearInterval(this.timer); this.timer = null
    if (this.starting) await this.starting.catch(() => {})
    clearInterval(this.timer); this.timer = null
    const child = this.child; this.child = null
    if (child?.pid) {
      if (process.platform === 'win32') await runFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
      else child.kill()
    }
    this.state.status = this.config ? 'stopped' : 'not-configured'; this.attempt = 0
    return this.status()
  }
}
