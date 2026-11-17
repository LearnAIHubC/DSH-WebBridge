import {readFile,writeFile} from 'node:fs/promises'
import { patchChatgptLoginDetection } from './browser-compat.js'

// Adds native file selection to BrowserOperator itself; browser ownership and
// manual-auth checks remain inside the skill's daemon.
const action = "async function uploadAction(body) {\r\n  const page = getPage();\r\n  const manualAuth = await manualAuthHints(page);\r\n  if (manualAuth.required) throw fail(\"manual-auth-required\", \"请先在可见浏览器完成登录或验证。\", manualAuth);\r\n  const root = await getRoot(String(body.frame || \"\"));\r\n  const inputs = root.locator(String(body.selector || 'input[type=\"file\"]'));\r\n  const count = await inputs.count();\r\n  if (!count) throw fail(\"not-found\", \"页面没有文件上传输入框\");\r\n  const files = Array.isArray(body.files) ? body.files.map(value => resolve(String(value))) : [];\r\n  if (!files.length || files.some(value => !existsSync(value) || !statSync(value).isFile())) throw fail(\"bad-request\", \"上传文件不存在\");\r\n  // ChatGPT renders several composers; the final unrestricted input belongs\r\n  // to the active one. setInputFiles supports hidden native file inputs.\r\n  let target = inputs.nth(count - 1);\r\n  for (let index = count - 1; index >= 0; index--) {\r\n    const accept = await inputs.nth(index).getAttribute(\"accept\");\r\n    if (!accept || accept === \"*\" || accept === \"*/*\") { target = inputs.nth(index); break; }\r\n  }\r\n  await target.setInputFiles(files, { timeout: Number(body.timeout) || DEFAULT_TIMEOUT });\r\n  return { ok: true, action: \"upload\", profile: currentProfile, files: files.length, url: maskUrl(page.url()) };\r\n}\r\n\r\n"
const command = "    case \"upload\": {\r\n      if (positional.length < 2) throw new Error(\"upload 需要 selector 和文件路径\");\r\n      result = await requestDaemon(info, \"/upload\", { selector: positional[0], files: positional.slice(1), frame: flags.frame || \"\", timeout });\r\n      break;\r\n    }\r\n"
export async function ensureUploadCommand(path) {
  const original = await readFile(path,'utf8')
  const source = patchChatgptLoginDetection(original)
  if (source.includes('case "/upload":') && source.includes('case "upload":')) {
    if (source !== original) await writeFile(path,source,'utf8')
    return source !== original
  }
  if (!source.includes('async function fillAction(body)') || !source.includes('case "/fill":') || !source.includes('    case "fill": {')) throw new Error('BrowserOperator 版本不支持文件上传扩展，请更新浏览器技能。')
  const next = source.replace('async function fillAction(body)', action+'async function fillAction(body)').replace('case "/fill":', 'case "/upload": result = await uploadAction(body); break;\n          case "/fill":').replace('    case "fill": {',command+'    case "fill": {')
  await writeFile(path,next,'utf8')
  return true
}
