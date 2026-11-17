window.__ModuleLoader__.load({ id: "@local/dsh-webbridge", factory: (require) => {
const SETUP_PACKAGE = '@local/dsh-webbridge'
const SETUP_SERVICE = 'webbridgeSetup'
const ACTIONS = new Set(['loginChatgpt', 'loginConsole', 'save', 'connect', 'reinstall', 'refreshTools', 'disconnect', 'setDebugMode'])

function parseSetupCommand(value) {
  if (!value || typeof value !== 'object' || !ACTIONS.has(value.action)) throw new Error('未知的 WebBridge 设置操作。')
  const result = { action: value.action }
  for (const key of ['tunnelId', 'runtimeApiKey', 'networkMode', 'customProxy', 'workspaceId', 'projectName']) {
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
  return result
}

function parseSetupState(value) {
  if (!value || typeof value !== 'object' || !value.tunnel || !value.job) throw new Error('WebBridge 设置状态无效。')
  if ('runtimeApiKey' in value || 'runtimeApiKey' in value.tunnel) throw new Error('密钥不能返回到设置状态。')
  return value
}
const codec = (name, parse) => ({ mode: 'strict', typeSymbol: `${SETUP_PACKAGE}#${name}`, schema: { parse }, create: () => ({ parse }) })
const stateCodec = codec('SetupState', parseSetupState)
const setupRemote = {
  package: SETUP_PACKAGE,
  descriptors: [
    { id: `${SETUP_PACKAGE}#${SETUP_SERVICE}/read`, service: SETUP_SERVICE, namespace: SETUP_SERVICE, method: 'read', invocation: { kind: 'direct' }, parameters: [], result: stateCodec },
    { id: `${SETUP_PACKAGE}#${SETUP_SERVICE}/execute`, service: SETUP_SERVICE, namespace: SETUP_SERVICE, method: 'execute', invocation: { kind: 'direct' }, parameters: [{ name: 'command', wire: 'command', source: 'json', codec: codec('SetupCommand', parseSetupCommand) }], result: stateCodec },
  ],
}

const React = require("react");

const h = React.createElement
const inject = ['slots', 'remote']

const css = `
.wb-settings{max-width:760px;margin:0 auto;padding:22px 12px 36px;color:inherit;font:inherit}
.wb-settings h1{font-size:28px;font-weight:650;letter-spacing:-.5px;margin:0 0 18px}.wb-settings p{font-size:13px;line-height:1.7;opacity:.68;margin:7px 0 14px}
.wb-tabs{display:flex;gap:4px;padding:4px;border-radius:9px;background:var(--background-secondary,rgba(128,128,128,.08));border:1px solid rgba(128,128,128,.16);margin-bottom:22px}
.wb-tabs button{flex:1;border:0;background:none;color:inherit;padding:8px;border-radius:6px;cursor:pointer}.wb-tabs button[aria-selected=true]{background:var(--background-primary,Canvas);box-shadow:0 0 0 1px rgba(128,128,128,.22);font-weight:600}
.wb-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 0;border-bottom:1px solid rgba(128,128,128,.12)}.wb-row strong{font-weight:550}.wb-row small{display:block;opacity:.6;font-size:12px;line-height:1.65;margin-top:4px}
.wb-settings button.wb-button{border:1px solid rgba(128,128,128,.3);background:var(--background-primary,Canvas);color:inherit;border-radius:7px;padding:7px 12px;white-space:nowrap;font-size:13px;cursor:pointer}.wb-settings button.wb-primary{background:var(--text-primary,#151719);color:var(--background-primary,#fff);border-color:transparent;padding:10px 18px}.wb-settings button:disabled{opacity:.45;cursor:default}
.wb-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:22px}.wb-badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:4px 8px;border-radius:20px;background:rgba(128,128,128,.08)}.wb-dot{width:7px;height:7px;border-radius:50%;background:#9ca3af}.wb-dot[data-ready=true]{background:#20b977}
.wb-field{display:block;margin:17px 0;font-size:13px;font-weight:500}.wb-field input,.wb-field select{display:block;box-sizing:border-box;width:100%;border:1px solid rgba(128,128,128,.3);border-radius:7px;color:inherit;background:var(--background-primary,Canvas);padding:9px 11px;margin-top:7px;font:inherit}.wb-field small{display:block;opacity:.6;font-size:12px;font-weight:400;margin-top:6px}
.wb-notice{margin-top:18px;border:1px solid rgba(128,128,128,.18);border-radius:9px;padding:12px 14px;font-size:13px;line-height:1.6}.wb-notice[data-error=true]{color:#b74439;border-color:#b7443945;background:#b7443908}.wb-id{font-family:monospace;font-size:12px;overflow-wrap:anywhere}.wb-settings input[type=checkbox]{accent-color:currentColor;width:16px;height:16px}.wb-section-title{font-size:14px;font-weight:600;margin-top:24px}
`
const statusNames = { 'not-configured': '未配置', stopped: '已断开', starting: '启动中', 'installing-runtime': '安装隧道客户端', connecting: '连接中', connected: '已连接', reconnecting: '正在重连', error: '连接失败', 'authentication-error': '密钥需要更新' }
const authNames = { unknown: '尚未检查', ready: '已登录', 'needs-login': '请完成登录' }

function SettingsSection({ read, execute }) {
  const [state, setState] = React.useState(null)
  const [tab, setTab] = React.useState('overview')
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
        } else if (next.tunnel.tunnelId) setForm(value => value.tunnelId ? value : { ...value, tunnelId: next.tunnel.tunnelId })
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
  const button = (label, action, primary = false) => h('button', { type: 'button', className: `wb-button${primary ? ' wb-primary' : ''}`, disabled: busy || !state, onClick: () => run(action) }, label)
  const badge = (label, ready) => h('span', { className: 'wb-badge' }, h('i', { className: 'wb-dot', 'data-ready': ready }), label)
  const row = (label, description, control) => h('div', { className: 'wb-row' }, h('div', null, h('strong', null, label), description && h('small', null, description)), control)
  const toggle = (key, label, description) => row(label, description, h('input', { type: 'checkbox', checked: form[key], disabled: busy, 'aria-label': label, onChange: event => { const value = event.target.checked; change(key, value); if (key === 'debugMode') run('setDebugMode', { debugMode: value }) } }))
  const field = (key, label, options = {}) => h('label', { className: 'wb-field' }, label,
    h('input', { type: options.type || 'text', value: form[key], disabled: busy, autoComplete: options.type === 'password' ? 'new-password' : 'off', placeholder: options.placeholder || '', onChange: event => change(key, options.type === 'number' ? Number(event.target.value) : event.target.value) }),
    options.help && h('small', null, options.help))
  const connected = state?.tunnel.status === 'connected'
  return h('section', { ref: section, className: 'wb-settings', 'data-webbridge-settings': true }, h('style', null, css),
    h('h1', null, 'ChatGPT 网页版'),
    h('div', { className: 'wb-tabs', role: 'tablist' }, ...[['overview', '概览'], ['tunnel', '隧道与 API Key'], ['advanced', '高级设置']].map(([value, label]) => h('button', { key: value, role: 'tab', 'aria-selected': tab === value, onClick: () => setTab(value) }, label))),
    !state && h('p', null, '正在连接 WebBridge 设置服务…'),
    tab === 'overview' && h(React.Fragment, null,
      row('ChatGPT 网页账号', state?.accountTier === 'free' ? '免费版 · 提供思考和非思考两种模式。' : '在浏览器中登录，后续会话复用登录状态。', h('div', { className: 'wb-actions', style: { marginTop: 0 } }, badge(authNames[state?.auth.chatgpt] || '尚未检查', state?.auth.chatgpt === 'ready'), button('登录网页版', 'loginChatgpt'))),
      row('OpenAI 控制台', '登录后可自动创建隧道和 Runtime API Key。', h('div', { className: 'wb-actions', style: { marginTop: 0 } }, badge(authNames[state?.auth.console] || '尚未检查', state?.auth.console === 'ready'), button('登录控制台', 'loginConsole'))),
      row('官方 MCP 隧道', '使用 Nexus 相同的 OpenAI 官方方案，无需公网 IP 或域名。', badge(statusNames[state?.tunnel.status] || '未配置', connected)),
      row('Nexus DSH 插件', state?.pluginInstalled ? `${state.permissionsAll ? '全部工具允许' : '待设置权限'} · ${state.toolCount} 个当前可用 DSH 工具` : '连接时自动检查旧插件、卸载删除并重新安装。', badge(state?.pluginInstalled ? '已安装' : '待安装', Boolean(state?.pluginInstalled))),
      h('div', { className: 'wb-actions' }, button('连接隧道', 'connect', true), button('刷新工具', 'refreshTools'), connected && button('断开', 'disconnect')),
      h('p', null, '首次连接将创建长期保留的隧道及永不过期的专用密钥，并设置网页插件允许全部工具。账号登录和验证在浏览器中手动完成。'),
      state?.tunnel.keyExpiresAt && h('div', { className: 'wb-notice' }, `当前使用测试密钥，到期时间：${new Date(state.tunnel.keyExpiresAt).toLocaleString()}。正式密钥默认永不过期。`)),
    tab === 'tunnel' && h(React.Fragment, null,
      h('p', null, '可以直接点击连接隧道自动创建，也可以在此填写已有隧道和密钥。密钥使用 Windows 当前用户加密保存。'),
      field('tunnelId', 'Tunnel ID', { placeholder: 'tunnel_…' }),
      field('runtimeApiKey', 'Runtime API Key', { type: 'password', placeholder: state?.tunnel.hasApiKey ? '已安全保存；留空保留现有密钥' : 'sk-…', help: '专用密钥只需 Tunnels 的 Read 和 Use 权限；网页插件将允许全部 DSH 工具。' }),
      h('div', { className: 'wb-actions' }, button('保存配置', 'save'), button('连接隧道', 'connect', true), button('打开控制台', 'loginConsole')),
      state?.tunnel.tunnelId && h('p', { className: 'wb-id' }, state.tunnel.tunnelId),
      state?.toolsRefreshedAt && h('p', null, `最近刷新工具：${new Date(state.toolsRefreshedAt).toLocaleString()}`)),
    tab === 'advanced' && h(React.Fragment, null,
      h('label', { className: 'wb-field' }, '隧道网络', h('select', { value: form.networkMode, disabled: busy, onChange: event => change('networkMode', event.target.value) }, h('option', { value: 'system' }, '跟随 Windows 系统代理'), h('option', { value: 'direct' }, '直接连接'), h('option', { value: 'custom' }, '自定义代理'))),
      form.networkMode === 'custom' && field('customProxy', '代理地址', { placeholder: 'http://127.0.0.1:7897' }),
      toggle('autoReconnect', '断线自动重连', 'DSH 启动后恢复隧道，断线后自动重试。'),
      toggle('autoRefreshTools', '自动刷新工具', '检测 DSH 工具变化，等待当前网页会话完成后更新。'),
      toggle('debugMode', '浏览器调试模式', '开启后所有 WebBridge 页面都显示窗口；关闭后全部使用无头模式。切换时需等待当前网页请求结束。'),
      field('healthPort', '健康检查端口', { type: 'number' }),
      field('workspaceId', 'ChatGPT 工作区 ID（可选）', { help: '只有一个工作区时自动选择；有多个工作区时填写目标 ID。' }),
      field('projectName', 'OpenAI 项目名称'),
      h('div', { className: 'wb-actions' }, button('保存配置', 'save'), button('连接并应用', 'connect', true))),
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
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'webbridge-chatgpt-settings', order: 21,
      label: () => 'ChatGPT 网页版', inject: () => ({ read, execute }),
    }, SettingsSection))
  })
}

return {apply,inject};
} });
