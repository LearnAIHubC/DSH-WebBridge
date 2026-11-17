import { stat } from 'node:fs/promises'
import { basename } from 'node:path'

/** Return only the upload notice, never the surrounding conversation text. */
export function uploadProblem(text) {
  const value = String(text || '')
  const menuQuota = value.match(/订阅\s*Plus[^\n]{0,60}更多上传额度[\s\S]{0,100}?后再上传/i)
  if (menuQuota) return { code: 'attachment-quota-exceeded', message: menuQuota[0].trim() }
  const quota = value.match(/(?:你已达到|已达到)[^\n。]{0,24}(?:文件附件数量|文件上传|附件)[^\n。]{0,16}限制|(?:you(?:'ve| have) reached|reached your)[^\n.]{0,60}(?:file|upload)[^\n.]{0,24}limit/i)
  if (quota) {
    const surrounding = value.slice(quota.index, quota.index + 260)
    const description = surrounding.match(/升级订阅即可立即添加更多文件[^\n]{0,180}?后重试|try again after[^\n.]{0,100}/i)?.[0]
    return { code: 'attachment-quota-exceeded', message: quota[0] + (description ? `\n${description}` : '') }
  }
  const failure = value.match(/上传未成功|上传失败|无法上传|文件过大|upload failed|too large|unsupported file/i)
  return failure ? { code: 'attachment-upload-failed', message: failure[0] } : null
}

/** DSH's composer represents locally selected text files as explicit @paths. */
export async function mentionedFiles(text) {
  const value = String(text || '')
  const output = []
  const starts = [...value.matchAll(/(?:^|\s)@(?=["']?(?:[A-Za-z]:[\\/]|\/))/g)].slice(0, 32)
  for (const match of starts) {
    const start = match.index + match[0].length
    const remainder = value.slice(start).split(/\r?\n/)[0]
    const quoted = remainder[0] === '"' || remainder[0] === "'"
    const quote = quoted ? remainder[0] : ''
    const end = quoted ? remainder.indexOf(quote, 1) : -1
    if (quoted && end < 0) continue
    const raw = quoted ? remainder.slice(1, end) : remainder
    const candidates = quoted ? [raw] : [raw.trimEnd(), ...[...raw.matchAll(/\s+/g)].map(item => raw.slice(0, item.index)).reverse()].slice(0, 128)
    for (const path of candidates) {
      if (!path || path.length > 32760) continue
      try {
        if (!(await stat(path)).isFile()) continue
        const mention = quoted ? `@${quote}${path}${quote}` : `@${path}`
        if (!output.some(file => file.path === path)) output.push({ path, name: basename(path), mention })
        break
      } catch {}
    }
  }
  return output
}
