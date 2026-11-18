/**
 * Curated page-side expressions for the webbridge CLI (scripts/webbridge-cli.mjs).
 *
 * These are the productized versions of the ad-hoc probes used to diagnose the
 * bigmodel send failure: one expression answers "which element is which" for
 * the AI (composer, send controls, stop controls, reply containers, login
 * wall, model hints), each candidate carrying a unique CSS selector.
 *
 * Division of labour (deliberate): the CLI explores and reports evidence; the
 * AI reads it, writes the channel adapter, and persists it deliberately via
 * the webbridge_adapter tool. The CLI never generates or saves templates.
 */

/** Page exploration: one eval, everything a channel diagnosis needs. */
export function exploreExpression() {
  return `(() => {
    const visible = el => { const b = el && el.getBoundingClientRect(); return Boolean(b && b.width > 10 && b.height > 8 && el.checkVisibility && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) }
    const unique = selector => { try { return document.querySelectorAll(selector).length === 1 } catch { return false } }
    const suggest = el => {
      if (el.id) { const byId = '#' + CSS.escape(el.id); if (unique(byId)) return byId }
      const parts = []
      let current = el
      while (current && current !== document.body && current.nodeType === 1) {
        let part = current.tagName.toLowerCase()
        if (current.id) {
          parts.unshift('#' + CSS.escape(current.id))
          const byPath = parts.join(' > ')
          if (unique(byPath)) return byPath
          break
        }
        if (current.classList && current.classList.length) {
          // Prefer one distinctive class over class-pairs. Among individually
          // unique classes, control-purpose names (btn/send/submit/stop)
          // beat generic styling names, and state classes never qualify.
          const stateClass = /^(disabled|active|loading|selected|checked|visible|hidden|open|is-[a-z-]+)$/
          const classes = [...current.classList].filter(name => !stateClass.test(name))
          const singles = []
          for (const name of classes) {
            const single = (parts.length ? parts[0] + ' > ' : '') + part + '.' + CSS.escape(name)
            if (unique(single)) singles.push(name)
          }
          const control = singles.find(name => /(btn|button|send|submit|stop|cancel)/i.test(name))
          if (control || singles.length) {
            const name = control || singles[0]
            parts.unshift(part + '.' + CSS.escape(name))
            return parts.join(' > ')
          }
          const pair = classes.slice(0, 2).map(c => '.' + CSS.escape(c)).join('')
          const byPair = (parts.length ? parts[0] + ' > ' : '') + part + pair
          if (unique(byPair)) { parts.unshift(part + pair); return parts.join(' > ') }
        }
        const parent = current.parentElement
        if (parent) {
          const siblings = Array.from(parent.children).filter(child => child.tagName === current.tagName)
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
        }
        parts.unshift(part)
        const candidate = parts.join(' > ')
        if (unique(candidate)) return candidate
        current = parent
      }
      return parts.join(' > ') || el.tagName.toLowerCase()
    }
    const info = el => { const b = el.getBoundingClientRect()
      return { tag: el.tagName.toLowerCase(), selector: suggest(el),
        cls: String(el.className && el.className.baseVal || el.className || '').split(/\\s+/).filter(Boolean).slice(0, 4).join('.'),
        aria: el.getAttribute('aria-label') || '', text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 24),
        placeholder: el.getAttribute('placeholder') || '',
        rect: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } } }
    const all = selector => [...document.querySelectorAll(selector)].filter(visible)
    const keepOurs = el => !String(el.className || '').includes('wb-annotate') && !String(el.id || '').startsWith('__wb_annotate') && !el.closest('webagent-local-review')

    const composers = all('textarea, input[type="text"], [contenteditable="true"]').filter(keepOurs).slice(0, 8).map(info)
    const first = composers[0]
    const near = first ? (() => {
      let node = document.querySelector('textarea, input[type="text"], [contenteditable="true"]')
      for (let i = 0; node && i < 3; i++) node = node.parentElement
      return node || document.body
    })() : document.body
    const nearComposer = [...near.querySelectorAll('button, [role="button"], i, div[class*="send"], div[class*="submit"], span[class*="action"], [class*="iconfont"]')]
      .filter(el => visible(el) && keepOurs(el)).slice(0, 18).map(info)
    const sendish = [...document.querySelectorAll('button, [role="button"], i, div, span')]
      .filter(el => visible(el) && keepOurs(el) && (/send|submit|发送/i.test(String(el.className || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.innerText || '').slice(0, 12))))
      .slice(0, 10).map(info)
    const stopish = [...document.querySelectorAll('button, [role="button"], i, div')]
      .filter(el => visible(el) && keepOurs(el) && (/stop|pause|停止/i.test(String(el.className || '') + ' ' + (el.getAttribute('aria-label') || ''))))
      .slice(0, 5).map(info)
    const replySelectors = ['.markdown-body', '.markdown-content', '.ds-markdown', '.chat-content', '.message-content', '.answer-content', 'model-response', '[data-testid="message-content"]', '[class*="assistant"]']
    const replies = replySelectors.map(selector => ({ selector, count: all(selector).length }))
      .filter(entry => entry.count > 0)
    const loginControls = [...document.querySelectorAll('button, a, [role="button"]')]
      .filter(el => visible(el) && /^(登录|登陆|登录\\s*\\/\\s*注册|注册\\s*\\/\\s*登录|log\\s?in|sign\\s?in|login)$/i.test((el.innerText || '').trim())).slice(0, 5).map(info)
    return {
      url: location.href.slice(0, 160), pathname: location.pathname, title: document.title.slice(0, 60),
      modelCode: new URLSearchParams(location.search).get('modelCode') || '',
      composers, nearComposer, sendCandidates: sendish, stopCandidates: stopish,
      replyContainers: replies, loginControls,
      loginWall: Boolean(loginControls.length) || location.pathname.startsWith('/login') || /^\\/sign[-_]?in/i.test(location.pathname),
    }
  })()`
}
