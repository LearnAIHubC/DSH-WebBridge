/**
 * Page-side annotation for site adapter calibration.
 *
 * The user opens a site (headed via webbridge_open), draws boxes over the
 * composer, send button, reply container and (optionally) the stop control;
 * `annotate read` resolves each box to one unique CSS selector, and the
 * selectors are persisted through webbridge_adapter save. This gives every
 * site a zero-install calibration path: nothing is loaded into Chrome, and
 * the selectors come from the real logged-in page.
 *
 * The grid-voting and unique-selector logic is ported from the
 * browser-operator skill's annotate feature.
 */

export const ANNOTATE_ROLES = [
  { key: 'input', label: '输入框' },
  { key: 'send', label: '发送键' },
  { key: 'message', label: '回复区' },
  { key: 'streaming', label: '停止键（可选）' },
]

/** Installs the drawing overlay. Idempotent per page load. */
export function annotateOverlayExpression() {
  return `(() => {
    if (window.__wbAnnotateInstalled) return { installed: true, boxes: (window.__wbAnnotate?.boxes || []).length }
    const ROLES = ${JSON.stringify(ANNOTATE_ROLES)}
    const store = window.__wbAnnotate = { boxes: [], armed: false, roleIndex: 0 }
    const style = document.createElement('style')
    style.id = '__wb_annotate_style'
    style.textContent = [
      '#__wb_annotate_pill{position:fixed;right:24px;bottom:24px;z-index:2147483646;padding:10px 14px;border-radius:12px;background:#1d4ed8;color:#fff;font:13px -apple-system,sans-serif;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.35);user-select:none}',
      '.__wb_annotate_box{position:fixed;border:2px dashed #1d4ed8;background:rgba(29,78,216,.08);z-index:2147483645;pointer-events:none}',
      '.__wb_annotate_label{position:absolute;top:-26px;left:0;padding:2px 8px;border-radius:6px;background:#1d4ed8;color:#fff;font:12px -apple-system,sans-serif;white-space:nowrap}',
      '.__wb_annotate_remove{position:absolute;top:-26px;right:0;width:20px;height:20px;border-radius:6px;background:#ef4444;color:#fff;font:12px/20px sans-serif;text-align:center;cursor:pointer;pointer-events:auto}',
    ].join('')
    document.head.appendChild(style)

    const pill = document.createElement('div')
    pill.id = '__wb_annotate_pill'
    document.body.appendChild(pill)
    const layer = document.createElement('div')
    document.body.appendChild(layer)

    const nextRole = () => {
      for (let i = 0; i < ROLES.length; i++) if (!store.boxes.some(box => box.role === ROLES[i].key)) return i
      return ROLES.length
    }
    const updatePill = () => {
      const index = nextRole()
      if (index >= ROLES.length) { pill.textContent = '标注完成：回 DSH 执行 annotate read'; pill.style.background = '#059669' }
      else pill.textContent = (store.armed ? '框选' : '点击开始标注') + ' ' + (index + 1) + '/' + ROLES.length + '：' + ROLES[index].label
    }
    const renderBoxes = () => {
      layer.textContent = ''
      store.boxes.forEach((box, i) => {
        const el = document.createElement('div')
        el.className = '__wb_annotate_box'
        el.style.cssText = 'left:' + box.x + 'px;top:' + box.y + 'px;width:' + box.w + 'px;height:' + box.h + 'px'
        const label = document.createElement('span')
        label.className = '__wb_annotate_label'
        label.textContent = (ROLES.find(r => r.key === box.role) || {}).label || box.role
        el.appendChild(label)
        const remove = document.createElement('span')
        remove.className = '__wb_annotate_remove'
        remove.textContent = '×'
        remove.addEventListener('click', event => { event.stopPropagation(); store.boxes.splice(i, 1); renderBoxes(); updatePill() })
        el.appendChild(remove)
        layer.appendChild(el)
      })
    }

    let preview = null
    let start = null
    pill.addEventListener('click', event => {
      event.stopPropagation()
      if (store.armed) store.armed = false
      else if (nextRole() < ROLES.length) { store.roleIndex = nextRole(); store.armed = true }
      updatePill()
    })
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { store.armed = false; updatePill() } })
    document.addEventListener('mousedown', event => {
      if (!store.armed) return
      if (event.target === pill || pill.contains(event.target) || (event.target.closest && event.target.closest('.__wb_annotate_box, .__wb_annotate_remove'))) return
      start = { x: event.clientX, y: event.clientY }
      preview = document.createElement('div')
      preview.className = '__wb_annotate_box'
      layer.appendChild(preview)
      event.preventDefault()
    })
    document.addEventListener('mousemove', event => {
      if (!start || !preview) return
      const x = Math.min(start.x, event.clientX), y = Math.min(start.y, event.clientY)
      preview.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + Math.abs(event.clientX - start.x) + 'px;height:' + Math.abs(event.clientY - start.y) + 'px'
    })
    document.addEventListener('mouseup', event => {
      if (!start || !preview) return
      const x = Math.min(start.x, event.clientX), y = Math.min(start.y, event.clientY)
      const w = Math.abs(event.clientX - start.x), h = Math.abs(event.clientY - start.y)
      preview.remove(); preview = null; start = null
      if (w < 12 || h < 12) return
      const index = store.roleIndex
      if (index >= ROLES.length) return
      store.boxes = store.boxes.filter(box => box.role !== ROLES[index].key)
      store.boxes.push({ role: ROLES[index].key, x, y, w, h })
      store.roleIndex = nextRole()
      if (store.roleIndex >= ROLES.length) store.armed = false
      renderBoxes(); updatePill()
    })
    window.__wbAnnotateInstalled = true
    renderBoxes(); updatePill()
    return { installed: true, boxes: store.boxes.length, hint: '点击右下角按钮开始，按顺序框选：输入框、发送键、回复区、停止键（最后一个可不画）。画错点框右上角 × 重画。' }
  })()`
}

/** Resolves the drawn boxes to unique CSS selectors (grid voting, ported). */
export function annotateReadExpression() {
  return `(() => {
    const store = window.__wbAnnotate
    if (!store) return { ok: false, error: 'not-started', hint: '先执行 annotate start。' }
    const boxes = store.boxes || []
    if (!boxes.length) return { ok: false, error: 'no-boxes', hint: '先在有头窗口点右下角按钮并拖出矩形框。' }
    const skip = el => !el || el.nodeType !== 1 || el.tagName === 'HTML' || el.tagName === 'BODY' ||
      String(el.id || '').startsWith('__wb_annotate') ||
      (el.classList && (el.classList.contains('__wb_annotate_box') || el.classList.contains('__wb_annotate_label') || el.classList.contains('__wb_annotate_remove')))
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
    const describe = el => {
      const bounds = el.getBoundingClientRect()
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        name: String(el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 80),
        text: String(el.innerText ?? el.value ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        editable: Boolean(el.isContentEditable) || ['textarea', 'input'].includes(el.tagName.toLowerCase()),
        rect: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) },
      }
    }
    const rolePrefers = {
      input: entry => entry.editable,
      send: entry => entry.tag === 'button' || Boolean(entry.role),
      streaming: entry => entry.tag === 'button' || Boolean(entry.role),
      message: () => true,
    }
    const resolved = boxes.map(box => {
      const cols = 5, rows = 4
      const points = []
      for (let col = 0; col < cols; col++) for (let row = 0; row < rows; row++)
        points.push([box.x + (box.w * (col + 0.5)) / cols, box.y + (box.h * (row + 0.5)) / rows])
      points.push([box.x + box.w / 2, box.y + box.h / 2])
      const regionArea = Math.max(1, box.w * box.h)
      const votes = new Map()
      for (const [px, py] of points) {
        const x = Math.min(window.innerWidth - 1, Math.max(0, px))
        const y = Math.min(window.innerHeight - 1, Math.max(0, py))
        for (const el of document.elementsFromPoint(x, y)) {
          if (skip(el)) continue
          votes.set(el, (votes.get(el) || 0) + 1)
        }
      }
      const areaOf = el => { const b = el.getBoundingClientRect(); return Math.max(1, b.width * b.height) }
      const candidates = Array.from(votes.entries()).map(([el, count]) => {
        const bounds = el.getBoundingClientRect()
        const enclosed = bounds.left >= box.x - 2 && bounds.top >= box.y - 2 && bounds.right <= box.x + box.w + 2 && bounds.bottom <= box.y + box.h + 2
        const oversized = areaOf(el) > regionArea * 4
        return { el, count, rank: oversized ? 2 : enclosed ? 0 : 1, entry: { ...describe(el), selector: suggest(el) } }
      })
      candidates.sort((a, b) => (a.rank - b.rank) || (b.count - a.count) || (areaOf(b.el) - areaOf(a.el)))
      const ranked = candidates.slice(0, 5).map(item => item.entry)
      const prefers = rolePrefers[box.role] || (() => true)
      const chosen = candidates.find(item => item.rank === 0 && prefers(item.entry)) || candidates.find(item => prefers(item.entry)) || candidates[0]
      return {
        role: box.role,
        ok: Boolean(chosen),
        selector: chosen ? chosen.entry.selector : '',
        unique: chosen ? unique(chosen.entry.selector) : false,
        tag: chosen ? chosen.entry.tag : '',
        text: chosen ? chosen.entry.text : '',
        rect: chosen ? chosen.entry.rect : null,
        alternates: ranked.filter(entry => entry !== (chosen && chosen.entry)).slice(0, 3).map(entry => entry.selector),
      }
    })
    return { ok: true, boxes: resolved }
  })()`
}
