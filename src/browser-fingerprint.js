import { randomBytes } from 'node:crypto'
import { platform, release } from 'node:os'

export function currentPlatform() {
  return process.platform === 'win32' ? 'Win32' : process.platform === 'darwin' ? 'MacIntel' : 'Linux x86_64'
}

export function buildUserAgent(version) {
  const os = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64'
  const major = String(version || '124').split('.')[0] || '124'
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

export function buildUaMetadata(version) {
  const major = String(version || '124').split('.')[0] || '124'
  const full = version || `${major}.0.0.0`
  const os = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'
  const osVersion = process.platform === 'win32' ? (Number(release().split('.')[2]) >= 22000 ? '19.0.0' : '10.0.0') : ''
  return {
    brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not(A:Brand', version: '24' }],
    fullVersionList: [{ brand: 'Chromium', version: full }, { brand: 'Google Chrome', version: full }, { brand: 'Not(A:Brand', version: '24.0.0.0' }],
    platform: os, platformVersion: osVersion, architecture: process.arch === 'arm64' ? 'arm' : 'x86',
    model: '', mobile: false, bitness: '64', wow64: false,
  }
}

export function defaultFingerprint() {
  return {
    seed: '4cb98f09fbe92eba8bcf6b6527d7056c',
    platform: 'Win32',
    vendor: 'Google Inc.',
    webglVendor: 'Google Inc. (Intel)',
    webglRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    canvasNoise: true, audioNoise: true, webgl: 'auto', navigator: false, devtoolsFix: true,
  }
}

export function buildFingerprintScript(fingerprint, userAgent, locale) {
  const fp = fingerprint || defaultFingerprint()
  const seed = JSON.stringify(fp.seed || randomBytes(16).toString('hex'))
  const ua = JSON.stringify(userAgent)
  const appVersion = JSON.stringify(String(userAgent).replace(/^Mozilla\//, ''))
  const pf = JSON.stringify(fp.platform || currentPlatform())
  const vendor = JSON.stringify(fp.vendor || 'Google Inc.')
  const langs = JSON.stringify(Array.from(new Set([locale, String(locale || 'en-US').split('-')[0], 'en-US', 'en'].filter(Boolean))))
  const glVendor = JSON.stringify(fp.webglVendor || 'Google Inc. (Intel)')
  const glRenderer = JSON.stringify(fp.webglRenderer || 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)')
  const webglMode = fp.webgl || 'auto'
  const webglBlock = webglMode === 'auto' ? '' : webglMode === 'off'
    ? `try { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(type) { if (/^(webgl|webgl2|experimental-webgl)$/.test(type)) return null; return original.apply(this, arguments); }; } catch {}`
    : `try { for (const proto of [globalThis.WebGLRenderingContext?.prototype, globalThis.WebGL2RenderingContext?.prototype]) { if (!proto?.getParameter) continue; const original = proto.getParameter; proto.getParameter = spoof(function(p) { if (p === 0x9245) return ${glVendor}; if (p === 0x9246) return ${glRenderer}; return original.apply(this, arguments); }); } } catch {}`
  const canvasBlock = fp.canvasNoise === false ? '' : `try { for (const method of ['toDataURL','toBlob']) { const original = HTMLCanvasElement.prototype[method]; HTMLCanvasElement.prototype[method] = spoof(function() { try { const c=this.getContext('2d'), w=Math.min(this.width,16), h=Math.min(this.height,16); if(c&&w>0&&h>0){const d=c.getImageData(0,0,w,h);for(let i=0;i<d.data.length;i+=4)d.data[i]=Math.max(0,Math.min(255,d.data[i]+(hash(i)>0.5?1:-1)));c.putImageData(d,0,0);} } catch {} return original.apply(this,arguments); }); } } catch {}`
  const audioBlock = fp.audioNoise === false ? '' : `try { const original=AudioBuffer.prototype.getChannelData; AudioBuffer.prototype.getChannelData=spoof(function(ch){const d=original.call(this,ch),k='__fpn_'+ch;if(!this[k]){this[k]=true;for(let i=0;i<d.length;i++)d[i]+=(hash(i+ch*99999+3000)-0.5)*0.001;}return d;}); const copy=AudioBuffer.prototype.copyFromChannel;AudioBuffer.prototype.copyFromChannel=spoof(function(dest,ch,start){copy.call(this,dest,ch,start||0);const k='__fpcn_'+ch;if(!this[k]){this[k]=true;for(let i=0;i<dest.length;i++)dest[i]+=(hash(i+ch*77777+4000)-0.5)*0.001;}}); } catch {}`
  const navigatorBlock = fp.navigator === true ? `try { Object.defineProperty(Navigator.prototype,'userAgent',{get:spoof(()=>${ua}),configurable:true});Object.defineProperty(Navigator.prototype,'appVersion',{get:spoof(()=>${appVersion}),configurable:true});Object.defineProperty(Navigator.prototype,'platform',{get:spoof(()=>${pf}),configurable:true});Object.defineProperty(Navigator.prototype,'vendor',{get:spoof(()=>${vendor}),configurable:true});Object.defineProperty(Navigator.prototype,'languages',{get:spoof(()=>${langs}),configurable:true}); } catch {}` : ''
  const devtoolsBlock = fp.devtoolsFix === false ? '' : `try { const original=console.table;console.table=spoof(function(){const args=arguments,self=this;setTimeout(()=>{try{original.apply(self,args)}catch{}},0);}); } catch {}`
  return `(() => { 'use strict'; const seed=${seed}; function hash(n){let h=0x811c9dc5,s=seed+':'+n;for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=(h*0x01000193)>>>0;}return (h&0x7fffffff)/0x7fffffff;} const native='function () { [native code] }';function spoof(fn){try{fn.toString=()=>native;}catch{}return fn;} ${navigatorBlock} ${webglBlock} ${canvasBlock} ${audioBlock} ${devtoolsBlock} })()`
}
