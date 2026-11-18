window.__ModuleLoader__.load({ id: "@local/dsh-webbridge", factory: (require) => {
const SETUP_PACKAGE = '@local/dsh-webbridge'
const SETUP_SERVICE = 'webbridgeSetup'
const ACTIONS = new Set(['loginChatgpt', 'loginSite', 'setDefaultSite', 'loginConsole', 'save', 'connect', 'reinstall', 'refreshTools', 'refreshModels', 'disconnect', 'setDebugMode'])

function parseSetupCommand(value) {
  if (!value || typeof value !== 'object' || !ACTIONS.has(value.action)) throw new Error('未知的 WebBridge 设置操作。')
  const result = { action: value.action }
  for (const key of ['site', 'tunnelId', 'runtimeApiKey', 'networkMode', 'customProxy', 'workspaceId', 'projectName']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || value[key].length > 4096) throw new Error('设置字段格式无效。')
      result[key] = value[key].trim()
    }
  }
  for (const key of ['autoReconnect', 'autoRefreshTools', 'testKey', 'debugMode']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw new Error('设置字段格式无效。')
      result[key] = value[key]
    }
  }
  if (value.healthPort !== undefined) {
    if (!Number.isInteger(value.healthPort) || value.healthPort < 1024 || value.healthPort > 65535) throw new Error('健康端口应在 1024–65535 之间。')
    result.healthPort = value.healthPort
  }
  if ((result.action === 'loginSite' || result.action === 'setDefaultSite') && !result.site) throw new Error(`${result.action} 需要指定站点。`)
  return result
}

function parseSetupState(value) {
  if (!value || typeof value !== 'object' || !value.tunnel || !value.job) throw new Error('WebBridge 设置状态无效。')
  if ('runtimeApiKey' in value || 'runtimeApiKey' in value.tunnel) throw new Error('密钥不能返回到设置状态。')
  return value
}
function parseSyncRequest(value) {
  if (!value || typeof value !== 'object') throw new Error('同步请求格式无效。')
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : ''
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  if (!sessionId || sessionId.length > 500) throw new Error('同步请求缺少有效的 sessionId。')
  if (!provider.startsWith('webbridge-') || provider.length > 200) throw new Error('当前会话不是 WebBridge 网页模型。')
  return { sessionId, provider }
}

function parseDebugQuery(value) {
  if (!value || !['console', 'network', 'debug', 'pages'].includes(value.action)) throw new Error('未知的浏览器调试操作。')
  const query = { action: value.action }
  for (const key of ['pageId', 'filter', 'type']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'string' || value[key].length > 500) throw new Error('调试筛选格式无效。')
      if (value[key]) query[key] = value[key]
    }
  }
  if (value.limit !== undefined) {
    if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 500) throw new Error('调试记录数量应在 1–500 之间。')
    query.limit = value.limit
  }
  for (const key of ['errors', 'clear']) if (value[key] !== undefined) {
    if (typeof value[key] !== 'boolean') throw new Error('调试筛选格式无效。')
    query[key] = value[key]
  }
  return query
}
const codec = (name, parse) => ({ mode: 'strict', typeSymbol: `${SETUP_PACKAGE}#${name}`, schema: { parse }, create: () => ({ parse }) })
const stateCodec = codec('SetupState', parseSetupState)
const setupRemote = {
  package: SETUP_PACKAGE,
  descriptors: [
    { id: `${SETUP_PACKAGE}#${SETUP_SERVICE}/read`, service: SETUP_SERVICE, namespace: SETUP_SERVICE, method: 'read', invocation: { kind: 'direct' }, parameters: [], result: stateCodec },
    { id: `${SETUP_PACKAGE}#${SETUP_SERVICE}/execute`, service: SETUP_SERVICE, namespace: SETUP_SERVICE, method: 'execute', invocation: { kind: 'direct' }, parameters: [{ name: 'command', wire: 'command', source: 'json', codec: codec('SetupCommand', parseSetupCommand) }], result: stateCodec },
    { id: `${SETUP_PACKAGE}#${SETUP_SERVICE}/debug`, service: SETUP_SERVICE, namespace: SETUP_SERVICE, method: 'debug', invocation: { kind: 'direct' }, parameters: [{ name: 'query', wire: 'query', source: 'json', codec: codec('DebugQuery', parseDebugQuery) }], result: codec('DebugResult', value => value) },
    { id: `${SETUP_PACKAGE}#${SETUP_SERVICE}/sync`, service: SETUP_SERVICE, namespace: SETUP_SERVICE, method: 'sync', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('SyncRequest', parseSyncRequest) }], result: codec('SyncResult', value => value) },
  ],
}

const React = require("react");

const h = React.createElement
const inject = ['slots', 'remote']

const css = `
.wb-settings{max-width:760px;margin:0 auto;padding:22px 12px 36px;color:inherit;font:inherit}
.wb-settings h1{font-size:28px;font-weight:650;letter-spacing:-.5px;margin:0 0 18px}.wb-settings p{font-size:13px;line-height:1.7;opacity:.68;margin:7px 0 14px}
.wb-tabs{display:flex;gap:4px;flex-wrap:wrap;padding:4px;border-radius:9px;background:var(--background-secondary,rgba(128,128,128,.08));border:1px solid rgba(128,128,128,.16);margin-bottom:22px}
.wb-tabs button{flex:1;border:0;background:none;color:inherit;padding:8px;border-radius:6px;cursor:pointer}.wb-tabs button[aria-selected=true]{background:var(--background-primary,Canvas);box-shadow:0 0 0 1px rgba(128,128,128,.22);font-weight:600}
.wb-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 0;border-bottom:1px solid rgba(128,128,128,.12)}.wb-row strong{font-weight:550}.wb-row small{display:block;opacity:.6;font-size:12px;line-height:1.65;margin-top:4px}
.wb-settings button.wb-button{border:1px solid rgba(128,128,128,.3);background:var(--background-primary,Canvas);color:inherit;border-radius:7px;padding:7px 12px;white-space:nowrap;font-size:13px;cursor:pointer}.wb-settings button.wb-primary{background:var(--text-primary,#151719);color:var(--background-primary,#fff);border-color:transparent;padding:10px 18px}.wb-settings button:disabled{opacity:.45;cursor:default}
.wb-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:22px}.wb-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 8px;border-radius:20px;background:rgba(128,128,128,.08)}.wb-dot{width:7px;height:7px;border-radius:50%;background:#9ca3af}.wb-dot[data-ready=true]{background:#20b977}
.wb-field{display:block;margin:17px 0;font-size:13px;font-weight:500}.wb-field input,.wb-field select{display:block;box-sizing:border-box;width:100%;border:1px solid rgba(128,128,128,.3);border-radius:7px;color:inherit;background:var(--background-primary,Canvas);padding:9px 11px;margin-top:7px;font:inherit}.wb-field small{display:block;opacity:.6;font-size:12px;font-weight:400;margin-top:6px}
.wb-site-layout{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-top:6px}
.wb-sitelist{display:flex;flex-direction:column;gap:2px;flex:0 1 215px;padding:4px;border-radius:9px;background:var(--background-secondary,rgba(128,128,128,.08));border:1px solid rgba(128,128,128,.16)}
.wb-sitelist button{display:flex;align-items:center;gap:8px;border:0;background:none;color:inherit;padding:8px 10px;border-radius:6px;cursor:pointer;text-align:left;font:inherit;font-size:13px;line-height:1.35}
.wb-sitelist button[aria-selected=true]{background:var(--background-primary,Canvas);box-shadow:0 0 0 1px rgba(128,128,128,.22);font-weight:600}
.wb-sitelist .wb-dot{flex:none}
.wb-dot[data-state=needs-login]{background:#d97706}
.wb-site-panel{flex:1;min-width:280px}
.wb-notice{margin-top:18px;border:1px solid rgba(128,128,128,.18);border-radius:9px;padding:12px 14px;font-size:13px;line-height:1.6}.wb-notice[data-error=true]{color:#b74439;border-color:#b7443945;background:#b7443908}.wb-id{font-family:monospace;font-size:12px;overflow-wrap:anywhere}.wb-settings input[type=checkbox]{accent-color:currentColor;width:16px;height:16px}.wb-section-title{font-size:14px;font-weight:600;margin-top:24px}
.wb-debug-output{max-height:360px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace;padding:12px;border:1px solid rgba(128,128,128,.2);border-radius:8px}.wb-debug-image{display:block;max-width:100%;height:auto;margin-top:16px;border:1px solid rgba(128,128,128,.2);border-radius:8px}
`
const statusNames = { 'not-configured': '未配置', stopped: '已断开', starting: '启动中', 'installing-runtime': '安装隧道客户端', connecting: '连接中', connected: '已连接', reconnecting: '正在重连', error: '连接失败', 'authentication-error': '密钥需要更新' }
const authNames = { unknown: '尚未检查', ready: '已登录', 'needs-login': '请完成登录' }
const WEB_SITES = [
  { site: 'chatgpt', label: 'ChatGPT' },
  { site: 'bigmodel', label: '智谱体验中心 (GLM-5.3)' },
  { site: 'chatglm', label: '智谱清言' },
  { site: 'zai', label: 'Z.ai' },
  { site: 'deepseek', label: 'DeepSeek' },
  { site: 'kimi', label: 'Kimi' },
  { site: 'doubao', label: '豆包' },
  { site: 'duckai', label: 'Duck.ai' },
  { site: 'qwen', label: '通义千问' },
  { site: 'dola', label: 'Dola' },
  { site: 'gemini', label: 'Gemini' },
  { site: 'aistudio', label: 'AI Studio' },
]
const TABS = [
  ['overview', '概览'],
  ['advanced', '高级设置'],
  ['debug', '浏览器调试'],
]

function SyncIcon({ spinning = false }) {
  return h('svg', { viewBox: '0 0 20 20', width: 15, height: 15, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    style: spinning ? { animation: 'wb-sync-spin .8s linear infinite' } : undefined },
  h('path', { d: 'M15.7 6.2A6.4 6.4 0 0 0 4.2 5.6' }), h('path', { d: 'M4.2 2.9v2.8H7' }),
  h('path', { d: 'M4.3 13.8a6.4 6.4 0 0 0 11.5.6' }), h('path', { d: 'M15.8 17.1v-2.8H13' }))
}

function SessionSyncButton({ directory, loadDirectory, syncSession }) {
  const state = React.useSyncExternalStore(directory.subscribe, directory.getSnapshot, directory.getSnapshot)
  const [pending, setPending] = React.useState(false)
  const [result, setResult] = React.useState('')
  const [error, setError] = React.useState('')
  React.useEffect(() => { loadDirectory?.() }, [loadDirectory])
  const provider = state?.current?.provider || ''
  if (!provider.startsWith('webbridge-')) return null
  const run = async () => {
    if (pending) return
    setPending(true); setResult(''); setError('')
    try {
      const value = await syncSession(provider)
      setResult(value.imported ? `已补齐 ${value.imported} 条` : '无缺失消息')
    } catch (reason) { setError(reason?.message || String(reason)) }
    finally { setPending(false) }
  }
  const label = pending ? '同步中' : error ? '重试' : result || '同步'
  const title = error || '读取当前会话关联的 ChatGPT 网页消息，只将本地缺少的后续消息补齐，不重建网页会话。'
  return h(React.Fragment, null,
    h('style', null, '@keyframes wb-sync-spin{to{transform:rotate(360deg)}}'),
    h('button', { type: 'button', onClick: run, disabled: pending, title, 'aria-label': error ? `同步失败：${error}` : '同步网页会话',
      style: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5, height: 30, padding: '0 8px', border: '1px solid rgba(128,128,128,.24)', borderRadius: 7, background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, lineHeight: 1, cursor: pending ? 'default' : 'pointer', opacity: pending ? .55 : 1, whiteSpace: 'nowrap' } },
    h(SyncIcon, { spinning: pending }), label))
}

function BrowserDebugPanel({ readDebug }) {
  const [result, setResult] = React.useState(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState('')
  const [pageId, setPageId] = React.useState('')
  const [filter, setFilter] = React.useState('')
  const [errors, setErrors] = React.useState(false)
  const [action, setAction] = React.useState('debug')
  const mounted = React.useRef(true)
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const load = async (nextAction, clear = false) => {
    setPending(true); setError(''); setAction(nextAction)
    try {
      const next = await readDebug({ action: nextAction, pageId, filter, errors, clear, limit: 50 })
      if (mounted.current) setResult(next)
    } catch (reason) { if (mounted.current) setError(reason.message || String(reason)) }
    finally { if (mounted.current) setPending(false) }
  }
  const { screenshot, ...details } = result || {}
  return h('div', null,
    h('p', null, '查看 WebBridge 自己的浏览器。记录保留在本次插件运行中，可在会话生成期间读取。'),
    h('label', { className: 'wb-field' }, '调试页面', h('select', { value: pageId, onChange: event => setPageId(event.target.value) }, h('option', { value: '' }, '所有页面／最近使用的页面'), ...(result?.pages || []).map(page => h('option', { key: page.pageId, value: page.pageId }, page.url)))),
    h('label', { className: 'wb-field' }, '筛选记录', h('input', { value: filter, placeholder: '输入日志文字或请求路径', onChange: event => setFilter(event.target.value) })),
    h('label', null, h('input', { type: 'checkbox', checked: errors, onChange: event => setErrors(event.target.checked) }), ' 只看错误和警告'),
    h('div', { className: 'wb-actions' }, ...[['console', '控制台'], ['network', '网络请求'], ['debug', '调试汇总与截图']].map(([value, label]) => h('button', { key: value, type: 'button', className: 'wb-button', disabled: pending, onClick: () => load(value) }, label)), h('button', { type: 'button', className: 'wb-button', disabled: pending, onClick: () => load(action, true) }, '清空记录')),
    pending && h('p', { role: 'status' }, '正在读取浏览器调试信息…'),
    error && h('div', { className: 'wb-notice', 'data-error': true, role: 'alert' }, error),
    result && h('pre', { className: 'wb-debug-output', 'aria-label': '浏览器调试结果' }, JSON.stringify(details, null, 2)),
    screenshot?.dataUrl && h('img', { className: 'wb-debug-image', src: screenshot.dataUrl, alt: '当前调试页面截图' }),
    screenshot?.error && h('p', null, `截图未能完成：${screenshot.error}`))
}

function SettingsSection({ read, execute, debug }) {
  const [state, setState] = React.useState(null)
  const [tab, setTab] = React.useState('overview')
  const [sitePanel, setSitePanel] = React.useState('chatgpt')
  const [error, setError] = React.useState('')
  const [pending, setPending] = React.useState(false)
  const [form, setForm] = React.useState({ tunnelId: '', runtimeApiKey: '', networkMode: 'system', customProxy: '', healthPort: 18484, autoReconnect: true, autoRefreshTools: true, debugMode: false, workspaceId: '', projectName: 'Default project' })
  const loaded = React.useRef(false)
  const section = React.useRef(null)
  const mounted = React.useRef(true)
  React.useEffect(() => {
    mounted.current = true
    // The host reuses its scroll container between settings sections.
    for (let parent = section.current?.parentElement; parent; parent = parent.parentElement) {
      if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) { parent.scrollTop = 0; break }
    }
    let reading = false
    const refresh = async () => {
      if (reading) return
      reading = true
      try {
        const next = await read()
        if (!mounted.current) return
        setState(next)
        if (!loaded.current) {
          loaded.current = true
          setForm(value => ({ ...value, ...next.preferences, tunnelId: next.tunnel.tunnelId, networkMode: next.tunnel.networkMode, customProxy: next.tunnel.customProxy, healthPort: next.tunnel.healthPort, autoReconnect: next.tunnel.autoReconnect, debugMode: next.browser?.debugMode === true }))
        } else setForm(value => ({
          ...value,
          debugMode: next.browser?.debugMode === true,
          ...(next.tunnel.tunnelId && !value.tunnelId ? { tunnelId: next.tunnel.tunnelId } : {}),
        }))
      } catch (reason) { if (mounted.current) setError(reason.message || String(reason)) }
      finally { reading = false }
    }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [read])
  const change = (key, value) => setForm(old => ({ ...old, [key]: value }))
  const run = async (action, extra = {}) => {
    setPending(true); setError('')
    try {
      const next = await execute({ action, ...form, ...extra })
      if (mounted.current) { setState(next); setForm(value => ({ ...value, runtimeApiKey: '' })) }
    } catch (reason) {
      if (mounted.current) {
        if (action === 'setDebugMode') change('debugMode', state?.browser?.debugMode === true)
        setError(reason.message || String(reason))
      }
    }
    finally { if (mounted.current) setPending(false) }
  }
  const busy = pending || Boolean(state?.job.busy)
  const button = (label, action, primary = false, extra = {}) => h('button', { type: 'button', className: `wb-button${primary ? ' wb-primary' : ''}`, disabled: busy || !state, onClick: () => run(action, extra) }, label)
  const badge = (label, ready) => h('span', { className: 'wb-badge' }, h('i', { className: 'wb-dot', 'data-ready': ready }), label)
  const row = (label, description, control) => h('div', { className: 'wb-row' }, h('div', null, h('strong', null, label), description && h('small', null, description)), control)
  const toggle = (key, label, description) => row(label, description, h('input', { type: 'checkbox', checked: form[key], disabled: busy, 'aria-label': label, onChange: event => { const value = event.target.checked; change(key, value); if (key === 'debugMode') run('setDebugMode', { debugMode: value }) } }))
  const field = (key, label, options = {}) => h('label', { className: 'wb-field' }, label,
    h('input', { type: options.type || 'text', value: form[key], disabled: busy, autoComplete: options.type === 'password' ? 'new-password' : 'off', placeholder: options.placeholder || '', onChange: event => change(key, options.type === 'number' ? Number(event.target.value) : event.target.value) }),
    options.help && h('small', null, options.help))
  const connected = state?.tunnel.status === 'connected'
  const debugModeDescription = state?.browser?.modeChangePending
    ? `切换已保存，当前网页任务结束后会自动进入${form.debugMode ? '可见调试模式' : '无头模式'}。`
    : form.debugMode
      ? '已开启；执行网页任务时显示窗口，历史会话按需打开。'
      : '已关闭；网页任务使用无头模式，历史会话按需打开。'
  const siteRow = entry => row(entry.label, entry.site === 'chatgpt'
    ? '在浏览器中登录，后续会话复用登录状态。'
    : `在浏览器中登录后，DSH 模型菜单会出现 WebBridge · ${entry.label}。`,
    h('div', { className: 'wb-actions', style: { marginTop: 0 } }, badge(authNames[state?.auth[entry.site]] || '尚未检查', state?.auth[entry.site] === 'ready'), button('登录网页版', 'loginSite', false, { site: entry.site })))
  // Per-site tab body. Site-specific capabilities that come later (model
  // detection for the Zhipu sites, etc.) slot in here as extra rows without
  // touching the tab layout again.
  const siteTab = entry => h(React.Fragment, null,
    siteRow(entry),
    entry.site === 'zai'
      ? h('p', null, 'Z.ai 需要你的网络能访问 z.ai；未登录或网络不通时该模型不可用。')
      : h('p', null, '网页结构变化导致输入框、发送键或回复区识别失效时，让 DSH 执行 webbridge_adapter 的 annotate 框选校准即可，无需改代码。'))
  return h('section', { ref: section, className: 'wb-settings', 'data-webbridge-settings': true }, h('style', null, css),
    h('h1', null, 'WebBridge'),
    h('div', { className: 'wb-tabs', role: 'tablist' }, ...TABS.map(([value, label]) => h('button', { key: value, role: 'tab', 'aria-selected': tab === value, onClick: () => setTab(value) }, label))),
    !state && h('p', null, '正在连接 WebBridge 设置服务…'),
    tab === 'overview' && h(React.Fragment, null,
      h('div', { className: 'wb-section-title' }, '站点设置'),
      h('div', { className: 'wb-site-layout' },
        h('div', { className: 'wb-sitelist', role: 'listbox', 'aria-label': '网页站点' },
          ...WEB_SITES.filter(entry => (state?.visibleSites || ['chatgpt']).includes(entry.site)).map(entry => h('button', { key: entry.site, type: 'button', role: 'option', 'aria-selected': sitePanel === entry.site, onClick: () => setSitePanel(entry.site), title: entry.label },
            h('i', { className: 'wb-dot', 'data-ready': state?.auth[entry.site] === 'ready', 'data-state': state?.auth[entry.site] === 'needs-login' ? 'needs-login' : undefined }),
            h('span', null, entry.label)))),
        h('div', { className: 'wb-site-panel' },
          sitePanel === 'chatgpt' && h(React.Fragment, null,
            siteRow(WEB_SITES[0]),
            row('ChatGPT 网页模型与思考档位', state?.models?.count ? `已从网页读取 ${state.models.count} 个模型与档位组合，DSH 模型菜单会同步更新。` : '按当前账号的网页菜单读取，不预设模型名或思考档位。', button('刷新模型列表', 'refreshModels')),
            h('div', { className: 'wb-section-title' }, '渠道与 API Key'),
            field('tunnelId', '渠道（Tunnel ID）', { placeholder: 'tunnel_…' }),
            field('runtimeApiKey', 'API Key（Runtime API Key）', { type: 'password', placeholder: state?.tunnel.hasApiKey ? '已安全保存；留空保留现有密钥' : 'sk-…' }),
            h('div', { className: 'wb-actions' }, button(connected ? '重新连接' : '保存并连接', 'connect', true), badge(statusNames[state?.tunnel.status] || '未配置', connected)),
            h('p', null, '还不知道去哪里获取？请看 ', h('a', { href: 'https://github.com/LearnAIHubC/DSH-WebBridge/blob/main/docs/CHANNEL-AND-API-KEY.md', target: '_blank', rel: 'noreferrer' }, '《如何获取渠道与 API Key》'), '。')),
          sitePanel !== 'chatgpt' && siteTab(WEB_SITES.find(entry => entry.site === sitePanel) || WEB_SITES[1])))),
    tab === 'advanced' && h(React.Fragment, null,
      h('label', { className: 'wb-field' }, '隧道网络', h('select', { value: form.networkMode, disabled: busy, onChange: event => change('networkMode', event.target.value) }, h('option', { value: 'system' }, '跟随系统代理'), h('option', { value: 'direct' }, '直接连接'), h('option', { value: 'custom' }, '自定义代理'))),
      form.networkMode === 'custom' && field('customProxy', '代理地址', { placeholder: 'http://127.0.0.1:7897' }),
      toggle('autoReconnect', '断线自动重连', 'DSH 启动后恢复隧道，断线后自动重试。'),
      toggle('debugMode', '浏览器调试模式', debugModeDescription),
      field('healthPort', '健康检查端口', { type: 'number' }),
      h('div', { className: 'wb-actions' }, button('保存配置', 'save'), button('保存并连接', 'connect', true))),
    tab === 'debug' && h(BrowserDebugPanel, { readDebug: debug }),
    (state?.job.stage || error) && h('div', { className: 'wb-notice', 'data-error': Boolean(error || state?.job.error), role: error || state?.job.error ? 'alert' : 'status' }, error || state?.job.error || state?.job.stage),
    state?.tunnel.error && !state?.job.error && h('div', { className: 'wb-notice', 'data-error': true }, state.tunnel.error))
}

function apply(ctx) {
  const ready = ctx.remote.$mount(setupRemote)
  ctx.effect(async () => await ready)
  ctx.inject(['remote.webbridgeSetup'], scope => {
    const unwrap = async result => {
      const value = await result
      if (!value.ok) throw value.error
      return value.value
    }
    const read = () => unwrap(scope.remote.webbridgeSetup.read())
    const execute = command => unwrap(scope.remote.webbridgeSetup.execute(command))
    const debug = query => unwrap(scope.remote.webbridgeSetup.debug(query))
    const sync = request => unwrap(scope.remote.webbridgeSetup.sync(request))
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'webbridge-chatgpt-settings', order: 21,
      label: () => 'WebBridge', inject: () => ({ read, execute, debug }),
    }, SettingsSection))
    scope.inject(['modelDirectories'], ui => {
      ui.slots.inject('conversation.input.right', () => ui.slots.register({
        name: 'conversation.input.right', id: 'webbridge-session-sync', order: -1000,
        inject: sessionId => {
          const directory = ui.modelDirectories.directoryFor(sessionId)
          return {
            directory: directory.store,
            loadDirectory: () => directory.load().catch(() => {}),
            syncSession: provider => sync({ sessionId: String(sessionId), provider }),
          }
        },
      }, SessionSyncButton))
    })
  })
}

return {apply,inject};
} });
