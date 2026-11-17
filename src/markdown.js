/** Serialize a web reply for the DSH Markdown renderer; no page-specific state. */
export function domToMarkdown(root) {
  const children = (node, depth) => Array.from(node.childNodes || []).map(child => render(child, depth)).join('')
  const plain = node => String(node.innerText || node.textContent || '').trim()
  const render = (node, depth = 0) => {
    if (node.nodeType === 3) return node.textContent || ''
    if (node.nodeType !== 1) return ''
    const tag = String(node.tagName || '').toLowerCase()
    if (node.getAttribute?.('data-markdown-copy') === 'exclude') return ''
    if (['button', 'svg', 'script', 'style', 'noscript'].includes(tag)) return ''
    if (tag === 'br') return '\n'
    if (tag === 'hr') return '\n\n---\n\n'
    if (tag === 'table' || node.getAttribute?.('role') === 'table') {
      const rows = Array.from(node.querySelectorAll('tr,[role="row"]')).map(row => Array.from(row.querySelectorAll('th,td,[role="cell"],[role="columnheader"]')).map(cell => plain(cell).replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>'))).filter(row => row.length)
      if (!rows.length) return plain(node)
      const width = Math.max(...rows.map(row => row.length))
      const line = row => '| ' + Array.from({ length: width }, (_, index) => row[index] || '').join(' | ') + ' |'
      return '\n\n' + [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)].join('\n') + '\n\n'
    }
    if (tag === 'pre' || node.getAttribute?.('data-code-block') === 'true' || node.getAttribute?.('data-markdown-copy') === 'code-block') {
      const code = node.querySelector('.cm-content') || node.querySelector('code') || node
      const lines = Array.from(code.querySelectorAll?.('.cm-line') || [])
      const text = lines.length ? lines.map(line => line.textContent || '').join('\n') : code.textContent || ''
      const language = code.getAttribute?.('data-language') || String(code.className || '').match(/language-([\w+-]+)/)?.[1] || node.getAttribute?.('data-language') || ''
      const runs = text.match(/`+/g) || []
      const fence = '`'.repeat(Math.max(3, ...runs.map(run => run.length + 1)))
      return '\n\n' + fence + language + '\n' + text.replace(/\n$/, '') + '\n' + fence + '\n\n'
    }
    if (tag === 'code') {
      const text = node.textContent || ''
      const fence = '`'.repeat(Math.max(1, ...(text.match(/`+/g) || []).map(run => run.length + 1)))
      return fence + text + fence
    }
    if (tag === 'ul' || tag === 'ol') {
      let index = Number(node.getAttribute?.('start')) || 1
      return '\n' + Array.from(node.children || []).filter(child => String(child.tagName).toLowerCase() === 'li').map(item => {
        const prefix = tag === 'ol' ? `${index++}. ` : '- '
        return '    '.repeat(depth) + prefix + children(item, depth + 1).trim() + '\n'
      }).join('') + '\n'
    }
    if (/^h[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + children(node, depth).trim() + '\n\n'
    if (tag === 'blockquote') return '\n\n' + children(node, depth).trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n'
    if (tag === 'a') {
      const text = children(node, depth).trim()
      const href = node.getAttribute?.('href') || ''
      return href && !/^(javascript:|data:)/i.test(href) ? `[${text || href}](${href})` : text
    }
    if (tag === 'strong' || tag === 'b') return '**' + children(node, depth) + '**'
    if (tag === 'em' || tag === 'i') return '*' + children(node, depth) + '*'
    if (tag === 'img') return node.getAttribute?.('alt') || ''
    const text = children(node, depth)
    return tag === 'p' ? text.trim() + '\n\n' : text
  }
  return render(root).trim()
}
