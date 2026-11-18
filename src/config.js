import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { defaultFingerprint } from './browser-fingerprint.js'

/** Expand a leading ~ and return an absolute path. */
export function expandHome(value) {
  if (typeof value !== 'string' || !value) return value
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

export const DEFAULTS = {
  enabled: true,

  /** Native WebBridge-owned Chrome runtime; BrowserOperator remains untouched. */
  browserProfileDir: '~/.dsh/webbridge/chrome-profile',
  browserExecutablePath: '',
  /** Debug mode shows browser tasks on demand; normal mode is headless. */
  debugMode: false,
  chromeVersion: '157.0.8103.52',
  fingerprint: defaultFingerprint(),
  site: 'chatgpt',

  /** Reply completion detection. Zero waits until the reply finishes or is stopped. */
  replyTimeoutMs: 0,
  pollIntervalMs: 250,
  stableSamples: 3,
  /** How long a single browser command may take before it is killed. */
  commandTimeoutMs: 60000,

  /** Where per-site selectors are persisted (calibration survives restarts). */
  adapterDir: '~/.dsh/webbridge/adapters',
  stateDir: '~/.dsh/webbridge',

  /** Mode A+ defaults. `defaultTools` empty means webbridge_agent requires an explicit list. */
  agent: {
    defaultTools: [],
    maxTurns: 6,
  },

  /** Web chats registered as DSH model providers. */
  providers: {
    enabled: true,
    contextWindow: 32000,
  },

  tunnel: {
    runtimePath: '',
  },

  /** MCP exposure (M4, currently disabled). */
  mcp: {
    enabled: false,
    port: 17877,
    token: '',
    allowTools: [],
    exposeAgent: false,
    requestsPerMinute: 60,
    allowedHosts: [],
  },
}

export const SITE_PRESETS = {
  chatgpt: {
    label: 'ChatGPT',
    url: 'https://chatgpt.com/',
    adapter: {
      inputSelector: 'div.ProseMirror',
      sendSelector: 'button[data-testid="send-button"], form button[type="submit"]',
      messageSelector: '[class*="MarkdownRoot"]',
      streamingSelector: '',
      stripPrompt: false,
      requireCountGrowth: true,
      matchReplyToUserTurn: true,
      pluginName: 'Nexus DSH',
      reasoning: {
        selector: 'button[aria-pressed]',
        labels: ['思考', 'Think'],
        clickSelector: 'button[aria-pressed]:has-text("思考"), button[aria-pressed]:has-text("Think")',
        selectedAttribute: 'aria-pressed',
      },
      newChatSelector: '',
      verified: true,
      notes: 'Composer is div.ProseMirror; assistant replies render as [class*="MarkdownRoot"]. The 2026 UI has no data-message-author-role / article / stop-button nodes, so completion relies on text stability.',
    },
    newChatShortcut: process.platform === 'darwin' ? 'Meta+Shift+KeyO' : 'Control+Shift+KeyO',
    readTitle: true,
  },
}

export function resolveSettings(config = {}) {
  const merged = {
    ...DEFAULTS,
    ...config,
    fingerprint: { ...DEFAULTS.fingerprint, ...(config.fingerprint || {}) },
    agent: { ...DEFAULTS.agent, ...(config.agent || {}) },
    providers: { ...DEFAULTS.providers, ...(config.providers || {}) },
    mcp: { ...DEFAULTS.mcp, ...(config.mcp || {}) },
    tunnel: { ...DEFAULTS.tunnel, ...(config.tunnel || {}) },
  }
  // Older installations may still persist `site: deepseek`. The site is no
  // longer supported, so migrate stale configuration to the only available
  // preset instead of leaving the plugin unable to start.
  if (!SITE_PRESETS[merged.site]) merged.site = DEFAULTS.site
  merged.browserProfileDir = expandHome(merged.browserProfileDir)
  merged.browserExecutablePath = expandHome(merged.browserExecutablePath)
  merged.adapterDir = expandHome(merged.adapterDir)
  merged.stateDir = expandHome(merged.stateDir)
  return merged
}

export function ensureDirs(settings) {
  for (const dir of [settings.adapterDir, settings.stateDir, settings.browserProfileDir]) {
    try { if (dir) mkdirSync(dir, { recursive: true }) } catch {}
  }
}
