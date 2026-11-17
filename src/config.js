import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

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
  /** Debug mode shows every WebBridge page; normal mode is headless. */
  debugMode: false,
  chromeVersion: '157.0.8103.52',
  fingerprint: {
    seed: '4cb98f09fbe92eba8bcf6b6527d7056c', platform: 'Win32', vendor: 'Google Inc.',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvasNoise: true, audioNoise: true, webgl: 'auto', navigator: false, devtoolsFix: true,
  },
  site: 'deepseek',

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
      sendSelector: 'button[aria-label="发送"]',
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
    newChatShortcut: 'Control+Shift+KeyO',
    readTitle: true,
  },
  deepseek: {
    label: 'DeepSeek',
    url: 'https://chat.deepseek.com/',
    adapter: {
      inputSelector: 'textarea',
      sendSelector: '',
      messageSelector: '.ds-assistant-message-main-content',
      streamingSelector: '',
      newChatSelector: '',
      reasoning: {
        selector: 'div.ds-toggle-button',
        text: '深度思考',
        selectedClass: 'ds-toggle-button--selected',
      },
      verified: true,
      notes: 'Verified on chat.deepseek.com. Enter sends. The chat renders through a virtual list, so older assistant nodes leave the DOM — never count messages to detect completion.',
    },
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
