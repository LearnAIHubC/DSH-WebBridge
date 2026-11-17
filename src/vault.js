import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'

const script = fileURLToPath(new URL('./vault.ps1', import.meta.url))
const keychainScript = fileURLToPath(new URL('./vault-keychain.js', import.meta.url))

/** Use macOS Keychain directly; secret data travels only through stdin/stdout. */
export async function keychain(action, account, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', keychainScript, action, account], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    let errorOutput = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { errorOutput += chunk })
    child.on('error', () => reject(new Error('无法启动 macOS 钥匙串存储。')))
    child.on('close', code => {
      const status = errorOutput.match(/Keychain status (-?\d+)/)?.[1]
      if (code === 0) resolve(output.trim())
      else reject(new Error(`macOS 钥匙串无法读取或保存密钥${status ? `（${status}）` : ''}，请检查登录钥匙串是否已解锁。`))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

/** Same CurrentUser DPAPI boundary as Nexus; secrets never enter argv. */
export async function dpapi(action, input) {
  if (process.platform !== 'win32') throw new Error('当前安全密钥存储需要 Windows DPAPI。')
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve(output.trim()) : reject(new Error('Windows DPAPI 无法读取或保存当前用户的密钥。')))
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export class SecretVault {
  constructor(path) { this.path = path }
  get keychainAccount() { return createHash('sha256').update(resolve(this.path)).digest('hex') }
  async read() {
    if (process.platform === 'darwin') return JSON.parse(await keychain('read', this.keychainAccount))
    let bytes
    try { bytes = await readFile(this.path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    return JSON.parse(await dpapi('unprotect', bytes.toString('base64')))
  }
  async write(value) {
    if (process.platform === 'darwin') {
      await keychain('write', this.keychainAccount, JSON.stringify(value))
      return
    }
    const ciphertext = await dpapi('protect', JSON.stringify(value))
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = join(dirname(this.path), `.tunnel-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, Buffer.from(ciphertext, 'base64'), { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.path)
    } finally { await rm(temporary, { force: true }) }
  }
}
