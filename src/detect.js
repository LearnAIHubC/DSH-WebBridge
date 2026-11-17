import { buildReadExpression } from './adapters.js'
import { BridgeError } from './envelope.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { visibleTextKey } from './stream-text.js'

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const aborted = () => {
    clearTimeout(timer)
    signal?.removeEventListener('abort', aborted)
    reject(new BridgeError('aborted', 'Reply wait was aborted'))
  }
  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', aborted)
    resolve()
  }, ms)
  if (signal?.aborted) return aborted()
  signal?.addEventListener('abort', aborted, { once: true })
})

/** Read the current reply surface. Returns {count, text, streaming, url}. */
export async function readReplyState(driver, adapter, signal) {
  const parsed = await driver.eval(buildReadExpression(adapter), { signal })
  const value = parsed?.result
  if (!value || typeof value !== 'object') {
    throw new BridgeError('read-failed', 'Could not read the reply container; the adapter selectors may be wrong')
  }
  return {
    count: Number(value.count) || 0,
    text: String(value.text || ''),
    formattedText: String(value.formattedText || ''),
    replyParts: Array.isArray(value.replyParts) ? value.replyParts.filter(part => part && typeof part.id === 'string' && typeof part.text === 'string') : [],
    streaming: Boolean(value.streaming),
    generationKnown: Boolean(value.generationKnown),
    completed: Boolean(value.completed),
    webStopped: Boolean(value.webStopped),
    // The site's first send can replace the document and its window globals.
    // The host keeps ownership until this exact request's finally block runs.
    requestActive: Boolean(value.requestActive || driver.generations?.has(driver.currentKey?.())),
    url: String(value.url || ''),
    userTurnKey: String(value.userTurnKey || ''),
    userText: String(value.userText || ''),
    replyTurnKey: String(value.replyTurnKey || ''),
    replyId: String(value.replyId || ''),
  }
}

/**
 * Wait until the assistant finishes a reply.
 *
 * Completion is judged by TEXT CHANGE plus stability, not by counting messages.
 * DeepSeek chat renders through a virtual list: older messages are removed from
 * the DOM, so the assistant-node count can stay at 1 (or even shrink) across a
 * new reply. A count-based detector would hang there forever.
 *
 * Votes:
 *   1. reached — the last assistant text changed from the pre-send baseline, or
 *      a new assistant node appeared
 *   2. quiet — no streaming indicator (when the adapter declares one)
 *   3. stable — the text stopped changing for `stableSamples` consecutive polls
 *
 * Zero (the default) waits until completion or cancellation. An explicitly
 * configured positive budget may return captured text with truncated:true.
 */
export async function waitForReply({ driver, adapter, baseline, settings, signal, log, expectedText, expectedTurnKey, onProgress }) {
  const started = Date.now()
  const timeoutMs = Number(settings.replyTimeoutMs) || 0
  const deadline = timeoutMs > 0 ? started + timeoutMs : Infinity
  const pollMs = Math.max(1, Number(settings.pollIntervalMs) || 250)
  const stableSamples = Math.max(1, Number(settings.stableSamples) || 3)

  const baselineText = baseline?.text ?? ''
  const baselineCount = baseline?.count ?? 0

  let lastText = ''
  let lastCount = baselineCount
  let stable = 0
  let reached = false
  let sawStreaming = false
  let lastError = null
  let acceptedState = null
  let targetTurnKey = expectedTurnKey || ''
  let publishedText = ''
  const replyParts = new Map()
  const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim()
  const expected = normalize(expectedText)

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new BridgeError('aborted', 'Reply wait was aborted')

    let state
    try {
      state = await readReplyState(driver, adapter, signal)
      lastError = null
    } catch (err) {
      lastError = err
      if (['aborted', 'manual-auth-required', 'driver-missing', 'account-restricted'].includes(err?.code) || String(err?.code || '').startsWith('auth-required')) throw err
      await sleep(pollMs, signal)
      continue
    }

    let text = state.text || ''
    if (state.webStopped) throw new BridgeError('web-generation-stopped', '网页生成已中止。')
    const grown = state.count > baselineCount
    const changed = text !== '' && text !== baselineText
    // Sites that append a node per reply (ChatGPT) must show a new node before a
    // "stable text" is accepted; otherwise the previous answer is returned again
    // and every session appears to repeat itself.
    // Long answers can virtualize their user row. Once a turn is bound, its
    // assistant row remains sufficient to identify subsequent text snapshots.
    const actualText = normalize(state.userText)
    const promptMatches = !expected || actualText.includes(expected) || (expected.length >= 80 && actualText.includes(expected.slice(0, 80)))
    // ChatGPT may replace its optimistic client turn key after persisting the
    // message. Rebind only when the visible new user prompt still identifies
    // this request; never pin forever to a transient post-click key.
    if (state.userTurnKey && state.userTurnKey !== baseline?.userTurnKey && promptMatches && !state.userTurnKey.startsWith('fallback-')) targetTurnKey = state.userTurnKey
    const newAssistant = Boolean(state.replyTurnKey && !state.replyTurnKey.startsWith('fallback-') &&
      state.replyTurnKey !== baseline?.replyTurnKey && state.replyTurnKey !== baseline?.userTurnKey &&
      (state.replyId ? state.replyId !== baseline?.replyId : changed || grown))
    if (state.requestActive && newAssistant && (promptMatches || !state.userTurnKey || state.userTurnKey.startsWith('fallback-'))) targetTurnKey = state.replyTurnKey
    const currentUserKey = targetTurnKey && state.replyTurnKey === targetTurnKey ? targetTurnKey : state.userTurnKey
    const newUserTurn = Boolean(currentUserKey && currentUserKey !== baseline?.userTurnKey)
    const targetMatches = targetTurnKey ? currentUserKey === targetTurnKey : promptMatches
    const reachedNow = adapter.matchReplyToUserTurn
      ? Boolean(newUserTurn && state.replyTurnKey === currentUserKey && targetMatches)
      : adapter.requireCountGrowth ? grown : grown || changed
    if (settings.stateDir) {
      try { writeFileSync(join(settings.stateDir, 'reply-state.json'), JSON.stringify({ at: Date.now(), streaming: state.streaming, completed: state.completed, requestActive: state.requestActive, replyId: state.replyId, chars: text.length, count: state.count, userKey: state.userTurnKey, replyKey: state.replyTurnKey, targetTurnKey, expectedTurnKey, baselineUserKey: baseline?.userTurnKey || '', promptMatches, targetMatches, reachedNow, newUserTurn, currentUserKey })) } catch {}
    }
    if (state.streaming) sawStreaming = true
    if (reachedNow && state.replyParts.length) {
      for (const part of state.replyParts) {
        if (!part.text) continue
        let key = part.id
        for (const [oldKey, prior] of replyParts) {
          const provisional = /^(?:stream-)?part-\d+$/.test(prior.id) || /^(?:stream-)?part-\d+$/.test(part.id)
          if (prior.id === part.id || provisional && visibleTextKey(part.text).key.startsWith(visibleTextKey(prior.text).key)) {
            key = oldKey
            break
          }
        }
        replyParts.set(key, { ...replyParts.get(key), ...part })
      }
      text = [...replyParts.values()].map(part => part.text).join('\n\n')
      if (!state.streaming) state.formattedText = [...replyParts.values()].map(part => part.formattedText || part.text).join('\n\n')
    }
    if (reachedNow && text && text !== publishedText) { publishedText = text; onProgress?.({ text, streaming: state.streaming, userTurnKey: currentUserKey, replyId: state.replyId }) }
    if (adapter.matchReplyToUserTurn && !reachedNow) {
      stable = 0
      await sleep(pollMs, signal)
      continue
    }
    if (!reached && reachedNow) reached = true
    if (state.count > lastCount) lastCount = state.count

    if (state.streaming) {
      sawStreaming = true
      stable = 0
    } else if (reached && text && text === lastText && (!state.replyId || state.replyId === acceptedState?.replyId)) {
      stable += 1
    } else {
      stable = 0
    }
    if (text) lastText = text
    if (reachedNow) acceptedState = { ...state, userTurnKey: currentUserKey }

    const finished = !adapter.matchReplyToUserTurn || !state.generationKnown || state.completed || (sawStreaming && !state.streaming)
    if (reached && stable >= stableSamples && lastText && finished) {
      return {
        text: acceptedState?.formattedText || lastText,
        count: lastCount,
        elapsedMs: Date.now() - started,
        streaming: false,
        truncated: false,
        sawStreaming,
        userTurnKey: acceptedState?.userTurnKey || '',
        replyTurnKey: acceptedState?.replyTurnKey || '',
        replyId: acceptedState?.replyId || '',
      }
    }
    await sleep(pollMs, signal)
  }

  if (lastError && !lastText) throw lastError
  if (!reached || !lastText) {
    throw new BridgeError(
      'reply-timeout',
      `No new assistant reply appeared within ${settings.replyTimeoutMs}ms. Check the adapter selectors and whether the message was actually sent.`,
      { count: lastCount, baselineCount },
    )
  }
  log?.(`[webbridge] reply timed out with ${lastText.length} chars captured`)
  return {
    text: lastText,
    count: lastCount,
    elapsedMs: Date.now() - started,
    streaming: sawStreaming,
    truncated: true,
    sawStreaming,
    userTurnKey: acceptedState?.userTurnKey || '',
    replyTurnKey: acceptedState?.replyTurnKey || '',
    replyId: acceptedState?.replyId || '',
  }
}
