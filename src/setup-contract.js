export const SETUP_PACKAGE = '@local/dsh-webbridge'
export const SETUP_SERVICE = 'webbridgeSetup'
const ACTIONS = new Set(['loginChatgpt', 'loginConsole', 'save', 'connect', 'reinstall', 'refreshTools', 'refreshModels', 'disconnect', 'setDebugMode'])

export function parseSetupCommand(value) {
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

export function parseSetupState(value) {
  if (!value || typeof value !== 'object' || !value.tunnel || !value.job) throw new Error('WebBridge 设置状态无效。')
  if ('runtimeApiKey' in value || 'runtimeApiKey' in value.tunnel) throw new Error('密钥不能返回到设置状态。')
  return value
}
export function parseDebugQuery(value) {
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
export const setupRemote = {
  package: SETUP_PACKAGE,
  descriptors: [
    { id: `${SETUP_PACKAGE}#${SETUP_SERVICE}/read`, service: SETUP_SERVICE, namespace: SETUP_SERVICE, method: 'read', invocation: { kind: 'direct' }, parameters: [], result: stateCodec },
    { id: `${SETUP_PACKAGE}#${SETUP_SERVICE}/execute`, service: SETUP_SERVICE, namespace: SETUP_SERVICE, method: 'execute', invocation: { kind: 'direct' }, parameters: [{ name: 'command', wire: 'command', source: 'json', codec: codec('SetupCommand', parseSetupCommand) }], result: stateCodec },
    { id: `${SETUP_PACKAGE}#${SETUP_SERVICE}/debug`, service: SETUP_SERVICE, namespace: SETUP_SERVICE, method: 'debug', invocation: { kind: 'direct' }, parameters: [{ name: 'query', wire: 'query', source: 'json', codec: codec('DebugQuery', parseDebugQuery) }], result: codec('DebugResult', value => value) },
  ],
}
