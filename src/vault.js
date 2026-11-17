import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const script = fileURLToPath(new URL('./vault.ps1', import.meta.url))

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
  async read() {
    let bytes
    try { bytes = await readFile(this.path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
    return JSON.parse(await dpapi('unprotect', bytes.toString('base64')))
  }
  async write(value) {
    const ciphertext = await dpapi('protect', JSON.stringify(value))
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = join(dirname(this.path), `.tunnel-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, Buffer.from(ciphertext, 'base64'), { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.path)
    } finally { await rm(temporary, { force: true }) }
  }
}
