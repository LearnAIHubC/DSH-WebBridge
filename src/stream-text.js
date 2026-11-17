/** Compare DOM snapshots across Markdown hydration without freezing the stream. */
export function visibleTextKey(text) {
  const source = String(text || '')
  const zeros = new Set()
  for (const match of source.matchAll(/(^|\n)([ \t]*)0+(?=\d+(?:[.)](?:\s|$)|$))/g)) {
    const start = match.index + match[1].length + match[2].length
    for (let index = start; index < match.index + match[0].length; index++) zeros.add(index)
  }
  let key = ''
  const offsets = []
  for (let index = 0; index < source.length; index++) {
    if (zeros.has(index) || /[\s*_`~]/.test(source[index])) continue
    key += source[index]
    offsets.push(index + 1)
  }
  return { key, offsets }
}

/** A pending list marker is rewritten when Markdown makes the next list item. */
export function streamPreview(text) {
  const source = String(text || '')
  const pending = source.match(/(?:^|\n)[ \t]*(?:\d+[.)]?|[-*+]|#{1,6}|`{1,3}[\w+-]*)[ \t]*$/)
  return pending ? source.slice(0, pending.index).trimEnd() : source
}

/** Return only newly visible content; null means the page revised real text. */
export function snapshotDelta(previous, next) {
  if (next.startsWith(previous)) return next.slice(previous.length)
  const before = visibleTextKey(previous).key
  const after = visibleTextKey(next)
  if (!after.key.startsWith(before)) return null
  return next.slice(before.length ? after.offsets[before.length - 1] : 0)
}
