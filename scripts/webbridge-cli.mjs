#!/usr/bin/env node
/**
 * webbridge-cli — drive the RUNNING WebBridge browser through the plugin's
 * MCP endpoint. One consistent toolkit for an external AI: page exploration,
 * console/network capture, adapter templates, calibration and end-to-end
 * tests. No DSH session needed; everything is plain JSON on stdout.
 *
 *   node scripts/webbridge-cli.mjs status
 *   node scripts/webbridge-cli.mjs explore
 *   node scripts/webbridge-cli.mjs template bigmodel
 * Docs: docs/WEBBRIDGE-CLI.md
 */
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { exploreExpression } from './webbridge-expressions.mjs'

const base = process.env.WEBBRIDGE_MCP_URL || 'http://127.0.0.1:17877'
const tokenFile = join(homedir(), '.dsh/webbridge/mcp-token.key')

function fail(message) { console.error(message); process.exit(1) }

async function call(name, arguments_) {
  if (!existsSync(tokenFile)) fail(`缺少 MCP 令牌文件 ${tokenFile}：先在 DSH 中启动 WebBridge 的 MCP 端点（webbridge_mcp start）。`)
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${readFileSync(tokenFile, 'utf8').trim()}`,
      'MCP-Protocol-Version': '2024-11-05',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: arguments_ } }),
  })
  if (!response.ok) fail(`MCP 端点返回 ${response.status}（${base}）。检查插件与 MCP 端点是否在运行。`)
  const payload = await response.json()
  if (payload.error) fail(`MCP 错误：${payload.error.message}`)
  const result = payload.result || {}
  const text = result.content?.[0]?.text ?? ''
  if (result.isError) fail(`工具执行失败：${text}`)
  try { return JSON.parse(text) } catch { return text }
}

const usage = `用法: webbridge-cli <命令> [参数]
  status                              驱动器、站点登录、隧道与 MCP 状态
  open <site|url> [--headed]          打开站点或 URL
  pages                               列出打开的页面
  state                               当前页面状态
  console [--n 30] [--filter x] [--errors] [--clear]
  network [--n 30] [--filter x] [--type xhr] [--errors] [--clear]
  debug [--pageId id]                 汇总：状态 + 控制台 + 网络 + 截图路径
  screenshot [path]                   截图（默认存 ~/.dsh/webbridge/screenshots）
  eval '<js 表达式>'                  在当前页面执行表达式
  explore                             页面探索：输入框/发送键/停止键/回复区/登录墙/模型码（每个候选带唯一选择器）
  probe <site>                        站点适配器探测
  annotate <site> start|read [--save] 标注校准（read 可直接保存）
  ask <site> '<消息>' [--timeout ms]   端到端发送测试（真实发出消息）
环境: WEBBRIDGE_MCP_URL（默认 http://127.0.0.1:17877）`

const argv = process.argv.slice(2)
const command = argv[0]
if (!command || command === 'help' || command === '--help') fail(usage)

const flags = {}
const positional = []
for (let index = 1; index < argv.length; index++) {
  const value = argv[index]
  if (value.startsWith('--')) {
    const key = value.slice(2)
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--') && ['n', 'filter', 'type', 'timeout', 'pageId', 'path'].includes(key)) { flags[key] = next; index++ }
    else flags[key] = true
  } else positional.push(value)
}

const browser = action => call('webbridge_browser', {
  action, ...(flags.pageId ? { pageId: flags.pageId } : {}),
  ...(flags.n ? { limit: Number(flags.n) } : {}), ...(flags.filter ? { filter: flags.filter } : {}),
  ...(flags.type ? { type: flags.type } : {}), ...(flags.errors ? { errors: true } : {}),
  ...(flags.clear ? { clear: true } : {}),
})

switch (command) {
  case 'status': {
    const result = await call('webbridge_status', {})
    console.log(JSON.stringify({ driver: result.driver, site: result.settings?.site, sites: result.settings?.sites, auth: result.setup?.auth, job: result.setup?.job, mcp: result.mcp, adapter: result.adapter }, null, 2))
    break
  }
  case 'open': {
    const target = positional[0]
    if (!target) fail('open 需要站点名或 URL')
    const result = await call('webbridge_open', target.startsWith('http') ? { url: target, ...(flags.headed ? { headed: true } : {}) } : { site: target, ...(flags.headed ? { headed: true } : {}) })
    console.log(JSON.stringify(result, null, 2))
    break
  }
  case 'pages': case 'state': case 'console': case 'network': case 'debug': case 'screenshot': {
    const result = await browser(command === 'screenshot' ? 'screenshot' : command)
    console.log(JSON.stringify(result, null, 2))
    break
  }
  case 'eval': {
    const expression = positional[0]
    if (!expression) fail("eval 需要一个 JS 表达式，例如: webbridge-cli eval \"(() => document.title)()\"")
    console.log(JSON.stringify(await call('webbridge_browser', { action: 'eval', expression }), null, 2))
    break
  }
  case 'explore': {
    const result = await call('webbridge_browser', { action: 'eval', expression: exploreExpression() })
    console.log(JSON.stringify(result, null, 2))
    break
  }
  case 'probe': {
    const site = positional[0]
    if (!site) fail('probe 需要站点名')
    console.log(JSON.stringify(await call('webbridge_adapter', { site, probe: true }), null, 2))
    break
  }
  case 'annotate': {
    const site = positional[0]
    const mode = positional[1]
    if (!site || !['start', 'read'].includes(mode)) fail('用法: annotate <site> start|read [--save]')
    console.log(JSON.stringify(await call('webbridge_adapter', { site, annotate: mode, ...(flags.save ? { save: true } : {}) }), null, 2))
    break
  }
  case 'ask': {
    const site = positional[0]
    const message = positional[1]
    if (!site || !message) fail('用法: ask <site> "<消息>" [--timeout ms]')
    console.log(JSON.stringify(await call('webbridge_ask', { site, message, ...(flags.timeout ? { timeoutMs: Number(flags.timeout) } : {}) }), null, 2))
    break
  }
  default: fail(`未知命令：${command}\n\n${usage}`)
}
