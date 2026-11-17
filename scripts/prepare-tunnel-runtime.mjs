import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, copyFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const runFile = promisify(execFile)
const version = 'v0.0.14'
// Digests published in the official openai/tunnel-client v0.0.14 release.
const checksums = {
  arm64: 'c52bd95f8018b7b2903bebb45a47a1695b2c6e146b0672e2b11c38461ce729c1',
  x64: '9edcf0beebf257a765c32146d906ff2abe9a2a11013e222727593d863f1414fa',
}

export function runtimeFiles(platform = process.platform) {
  const suffix = platform === 'win32' ? '.exe' : ''
  return { runtime: `tunnel-client-runtime-cloudflared${suffix}`, cloudflared: `cloudflared${suffix}` }
}

export function macRuntimeArchive(arch = process.arch) {
  const sha256 = checksums[arch]
  if (!sha256) throw new Error(`不支持的 macOS 架构：${arch}`)
  const name = `tunnel-client-runtime-cloudflared-${version}-darwin-${arch === 'x64' ? 'amd64' : arch}.zip`
  return { name, sha256, url: `https://github.com/openai/tunnel-client/releases/download/${version}/${name}` }
}

export async function installMacRuntime(destination, { arch = process.arch, proxy = '' } = {}) {
  const release = macRuntimeArchive(arch)
  const temporary = await mkdtemp(join(tmpdir(), 'webbridge-tunnel-'))
  try {
    const archive = join(temporary, release.name)
    await runFile('/usr/bin/curl', [
      '--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', '150',
      ...(proxy ? ['--proxy', proxy] : ['--noproxy', '*']), '--output', archive, release.url,
    ], { timeout: 160000, maxBuffer: 1024 * 1024 })
    const actual = createHash('sha256').update(await readFile(archive)).digest('hex')
    if (actual !== release.sha256) throw new Error('OpenAI 隧道安装包 SHA-256 校验失败。')
    const unpacked = join(temporary, 'unpacked')
    await runFile('/usr/bin/ditto', ['-x', '-k', archive, unpacked])
    const files = await readdir(unpacked)
    const names = runtimeFiles('darwin')
    for (const name of [names.runtime, names.cloudflared, 'LICENSE']) {
      if (!files.includes(name)) throw new Error(`OpenAI 隧道安装包缺少 ${name}。`)
    }
    await mkdir(destination, { recursive: true })
    // Keep the companion manifest and all license/notice files beside the binaries.
    for (const name of files) {
      if (/^[A-Za-z0-9._-]+$/.test(name)) await copyFile(join(unpacked, name), join(destination, name))
    }
    for (const name of [names.runtime, names.cloudflared]) await chmod(join(destination, name), 0o755)
    return join(destination, names.runtime)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.platform !== 'darwin' || !process.argv[2]) throw new Error('用法：node scripts/prepare-tunnel-runtime.mjs <macOS 安装目录>')
  await installMacRuntime(resolve(process.argv[2]), { proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '' })
  console.log(`Verified OpenAI tunnel runtime ${version} installed.`)
}
