import { BridgeError } from './envelope.js'
import { loadAdapter, buildReasoningStateExpression, reasoningClickSelector } from './adapters.js'
import { readReplyState, waitForReply } from './detect.js'
import { SITE_PRESETS } from './config.js'
import { uploadProblem } from './attachments.js'
import { randomUUID } from 'node:crypto'
import { buildConversationReadExpression } from './conversation-sync.js'

/**
 * One browser chat at a time, on purpose.
 *
 * Nexus learned this the hard way: a shared, single-threaded resource (there it
 * was the runner, here it is one Chrome profile) must be serialized behind a
 * queue, and every request must be able to fail with a stable code instead of
 * corrupting the next caller. `enqueue` gives us exactly that.
 */
export class ChatSession {
  constructor({ settings, driver, log, modelControl }) {
    this.settings = settings
    this.driver = driver
    this.modelControl = modelControl
    this.log = log || (() => {})
    this.chain = Promise.resolve()
    this.sessionId = `chat-session-${randomUUID()}`
    this.last = { site: null, count: 0, text: '', at: null }
    /** sessionKey -> { url } for the DSH-session <-> web-conversation mapping. */
    this.conversations = new Map()
    this.legacyConversationGeneration = randomUUID()
  }

  enqueue(fn, sessionKey = this.sessionId) {
    if (typeof this.driver.exclusive === 'function') return this.driver.exclusive(fn, sessionKey)
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  sitePreset(site = this.settings.site) {
    const preset = SITE_PRESETS[site]
    if (!preset) {
      throw new BridgeError('unknown-site', `Unknown site "${site}". Known: ${Object.keys(SITE_PRESETS).join(', ')}`)
    }
    return preset
  }

  adapter(site = this.settings.site) {
    return loadAdapter(this.settings, site)
  }

  /** Open the site if the active page is elsewhere, then report auth hints. */
  async ensurePage(site, options = {}) {
    const preset = this.sitePreset(site)
    const state = await this.driver.state()
    const host = safeHost(preset.url)
    const current = String(state.url || '')
    if (!current || !current.includes(host)) {
      this.log(`[webbridge] navigating to ${preset.url}`)
      await this.driver.open(preset.url, { headed: options.headed, signal: options.signal })
    }
    return this.authGate(await this.driver.state(), this.adapter(site).inputSelector)
  }

  /** Refuse to act on a login/verification page 鈥?this is a hard rule. */
  async authGate(state, inputSelector) {
    // Sites also show short-lived interstitials ("Just a moment…", bot checks)
    // that clear by themselves; re-check once before calling it a hard failure.
    let current = state
    for (let attempt = 0; attempt < 2 && current?.manualAuth?.required; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      try {
        current = await this.driver.state()
      } catch {
        break
      }
    }

    const manual = current?.manualAuth
    if (manual?.required) {
      const kind = manual.kind || 'login'
      throw new BridgeError(
        `auth-required:${kind}`,
        kind === 'verification'
          ? 'The page requires human verification. Ask the user to finish it in the visible browser, then retry.'
          : 'The page requires sign-in. Ask the user to sign in in the visible browser, then retry.',
        { kind, reasons: manual.reasons || [], url: current.url, headed: current.headless === false },
      )
    }
    return current
  }

  async status() {
    const state = await this.driver.state()
    const adapter = this.adapter()
    return { state, adapter }
  }

  /**
   * Apply the requested reasoning mode before asking. The control is checked on
   * every send because it can change with the selected web model or conversation.
   * A failure here must never block the actual message.
   */
  async ensureReasoning(adapter, signal, mode = 'on') {
    if (!adapter.reasoning?.selector) return { supported: false }
    try {
      const parsed = await this.driver.eval(buildReasoningStateExpression(adapter), { signal })
      const state = parsed?.result || {}
      const selected = mode !== 'off'
      if (!state.found || state.selected === selected) return { ...state, clicked: false }
      const selector = reasoningClickSelector(adapter)
      await this.driver.click(selector, { signal })
      const after = (await this.driver.eval(buildReasoningStateExpression(adapter), { signal }))?.result || {}
      if (after.found && after.selected !== selected) throw new BridgeError('reasoning-not-set', '网页思考开关没有切换到所选模式。')
      this.log(`[webbridge] reasoning ${selected ? 'on' : 'off'}`)
      return { ...after, clicked: true }
    } catch (err) {
      this.log(`[webbridge] reasoning toggle failed (${err.code || 'error'}): ${err.message}`)
      return { supported: true, clicked: false, error: err.code || 'error' }
    }
  }

  /** Select the connector from the + menu without matching sidebar history. */
  async ensurePlugin(adapter, options = {}) {
    const name = adapter.pluginName
    if (!name) return
    const expression = `(() => ({ pluginSelected: Array.from(document.querySelectorAll(${JSON.stringify(adapter.inputSelector)}))
      .filter((node) => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
      .some((node) => Array.from(node.querySelectorAll('[app-mention-display-name]'))
        .some((mention) => mention.getAttribute('app-mention-display-name') === ${JSON.stringify(name)})) }))()`
    const selected = (await this.driver.eval(expression, { signal: options.signal }))?.result?.pluginSelected
    if (selected && !options.attachment && !options.attachments?.length) return {}
    await this.driver.click('button[data-testid="composer-plus-btn"], form button:has(svg use[href*="plus"])', { signal: options.signal })
    const quotaText = (await this.driver.eval(`(() => [...document.querySelectorAll('button')].filter(button=>button.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})).map(button=>button.innerText || '').find(text=>/更多上传额度/.test(text) && /后再上传/.test(text)) || '')()`, { signal: options.signal }))?.result || ''
    const quota = uploadProblem(quotaText)
    if (selected) await this.driver.press('Escape', { signal: options.signal })
    else await this.driver.click(`button[data-plugin-impression-id]:has-text(${JSON.stringify(name)})`, { signal: options.signal })
    if (!(await this.driver.eval(expression, { signal: options.signal }))?.result?.pluginSelected) {
      throw new BridgeError('plugin-not-selected', `The ${name} plugin was not added to the web composer.`)
    }
    this.log(`[webbridge] plugin selected in composer: ${name}`)
    return { quota }
  }

  /** Fill and submit once, then confirm ChatGPT has consumed the draft. */
  async submit(text, site, adapter, options = {}) {
    if (!String(text ?? '').trim()) throw new BridgeError('empty-message', 'Cannot submit an empty web-chat message.')
    if (site === 'chatgpt' && options.webModel) {
      if (!this.modelControl) throw new BridgeError('model-control-unavailable', '网页模型控制尚未就绪，尚未发送消息。')
      await this.modelControl.select(options.webModel)
    }
    let prepared
    try {
    await this.driver.fillLong(adapter.inputSelector, text, { signal: options.signal })
    // Filling a contenteditable replaces app mentions, so choose the connector
    // after filling the user's text, immediately before sending.
    const menu = options.selectPlugin || options.attachment || options.attachments?.length ? await this.ensurePlugin(adapter, options) : null
    prepared = await this.prepareAttachments(site, options, menu?.quota)
    if (prepared.reset) {
      await this.startNewChat(site, options)
      const reset = await options.onConversationReset?.({ reason: 'attachment-quota' })
      if (typeof reset?.text === 'string') text = reset.text
      if (!String(text ?? '').trim()) throw new BridgeError('empty-message', 'Cannot submit an empty web-chat message.')
      // Resetting the page invalidates its old reply baseline as well as its
      // context. Never let the abandoned conversation satisfy this request.
      if (options.baseline) Object.assign(options.baseline, await readReplyState(this.driver, adapter, options.signal))
      await this.driver.fillLong(adapter.inputSelector, text, { signal: options.signal })
      await this.ensurePlugin(adapter, {})
    }
    if (!options.webModel) await this.ensureReasoning(adapter, options.signal, options.reasoning || 'on')
    if (options.watchId && this.driver.startGenerationWatch) await this.driver.startGenerationWatch(options.watchId, { signal: options.signal })
    // Older saved ChatGPT calibrations used an empty sendSelector. Fall back to
    // the current built-in ChatGPT selector rather than submitting with Enter.
    const sendSelector = adapter.sendSelector || this.sitePreset(site).adapter.sendSelector
    await this.driver.click(sendSelector, { signal: options.signal })
    const delivery = {
      submittedText: text,
      contextAttachmentDelivered: prepared.contextAttachmentDelivered === true,
      contextAttachmentSkipped: prepared.contextAttachmentSkipped === true,
      conversationReset: prepared.reset === true,
    }
    const expression = `(() => {
      const editors = Array.from(document.querySelectorAll(${JSON.stringify(adapter.inputSelector)}))
        .filter((node) => node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
      return { composerText: editors.map((node) => {
        if (node.value !== undefined) return node.value;
        const copy = node.cloneNode(true);
        copy.querySelectorAll('[app-mention-display-name]').forEach((mention) => mention.remove());
        return copy.textContent || '';
      }).join('\\n') };
    })()`
    const deadline = Date.now() + Math.min(5000, this.settings.commandTimeoutMs || 5000)
    do {
      if (options.signal?.aborted) throw new BridgeError('aborted', 'Message submission was aborted')
      const state = (await this.driver.eval(expression, { signal: options.signal }))?.result
      if (typeof state?.composerText === 'string' && !state.composerText.trim()) {
        const sent = await readReplyState(this.driver, adapter, options.signal).catch(() => null)
        return { ...delivery, userTurnKey: sent?.userTurnKey && !sent.userTurnKey.startsWith('fallback-') && sent.userTurnKey !== options.baseline?.userTurnKey ? sent.userTurnKey : '', url: sent?.url || '', uploadLease: prepared.lease }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    throw new BridgeError('message-not-sent', 'The message stayed in the ChatGPT composer after sending. No reply wait was started.')
    } catch (error) { await prepared?.lease?.release?.(); throw error }
  }

  async prepareAttachments(site, options, menuQuota) {
    if (!options.attachment && !options.attachments?.length) return { contextAttachmentDelivered: false, contextAttachmentSkipped: false }
    let lease
    let attempted = false
    try {
      if (menuQuota) throw new BridgeError(menuQuota.code, menuQuota.message)
      const before = await this.uploadState(options.signal)
      if (before?.problem?.code === 'attachment-quota-exceeded') throw new BridgeError(before.problem.code, before.problem.message)
      attempted = true
      if (this.driver.attachFiles) {
        lease = await this.driver.attachFiles([...(options.attachment ? [options.attachment] : []), ...(options.attachments || [])], { signal: options.signal })
      } else if (options.attachment && !options.attachments?.length && this.driver.attachTextFile) {
        const attached = await this.driver.attachTextFile(options.attachment.name, options.attachment.content, { signal: options.signal })
        if (attached?.ok === false) throw new BridgeError('attachment-upload-failed', '网页没有接受系统上下文附件。')
      } else throw new BridgeError('attachment-upload-unavailable', 'The browser driver cannot upload these attachments.')
      await this.waitUploads(options.signal)
      return { lease, contextAttachmentDelivered: Boolean(options.attachment), contextAttachmentSkipped: false }
    } catch (error) {
      await lease?.release?.()
      if (error.code !== 'attachment-quota-exceeded' || options.attachments?.length || !options.attachment) throw error
      this.log('[webbridge] attachment quota reached; skipping system TXT and preserving user text with the app')
      await this.dismissUploadNotice()
      return { reset: attempted, contextAttachmentDelivered: false, contextAttachmentSkipped: true }
    }
  }

  async send(text, options = {}) {
    return this.enqueue(async () => {
      const site = options.site || this.settings.site
      const adapter = this.adapter(site)
      if (!adapter.inputSelector) {
        throw new BridgeError('adapter-incomplete', `Adapter for "${site}" has no inputSelector. Run webbridge_adapter to calibrate.`)
      }
      await this.ensurePage(site, options)

      const baseline = await readReplyState(this.driver, adapter, options.signal)
      await this.submit(text, site, adapter, options)

      this.last = { site, count: baseline.count, text: baseline.text, at: Date.now() }
      return { site, baseline, sentAt: Date.now() }
    })
  }

  async read(options = {}) {
    return this.enqueue(async () => {
      const site = options.site || this.settings.site
      const adapter = this.adapter(site)
      const state = await readReplyState(this.driver, adapter, options.signal)
      return { site, ...state }
    })
  }

  async ask(text, options = {}) {
    const queueKey = options.sessionKey ? `${options.site || this.settings.site}:${options.sessionKey}` : this.sessionId
    return this.enqueue(async () => {
      let uploaded
      let watchId
      try {
      const site = options.site || this.settings.site
      const adapter = this.adapter(site)
      if (!adapter.inputSelector) {
        throw new BridgeError('adapter-incomplete', `Adapter for "${site}" has no inputSelector. Run webbridge_adapter to calibrate.`)
      }
      // One DSH session = one web conversation. The provider passes its
      // sessionId, we remember the concrete chat URL and reopen it next time
      // instead of appending to whatever tab happens to be active.
      const key = options.sessionKey ? `${site}:${options.sessionKey}` : null
      let known = key ? (this.conversations.get(key) || await this.driver.getSessionInfo?.(key) || null) : null
      // The driver also records navigation to a site root. That is not a
      // retained conversation and must not reuse an old context generation.
      if (known?.url && !persistedConversationURL(site, known.url, this.sitePreset(site).url)) known = { ...known, url: '' }
      let newConversation = known?.needsContext === true
      let generation = known?.generation || (key ? randomUUID() : this.legacyConversationGeneration)
      if (key && known) this.conversations.set(key, known)
      if (known?.url || known?.pending) {
        let current = await this.driver.state()
        // A pending blank conversation can survive a restart without a URL.
        // Its newly recreated browser page starts at about:blank, so restore
        // the site and verify a fresh chat before preparing the first message.
        if (key && known.pending && !known.url && !String(current?.url || '').includes(safeHost(this.sitePreset(site).url))) {
          await this.ensurePage(site, options)
          await this.startNewChat(site, options)
          current = await this.driver.state()
          generation = randomUUID()
          newConversation = true
          known = { ...known, url: '', pending: true, generation, needsContext: true, userTurnKey: '' }
          this.conversations.set(key, known)
          await this.driver.updateSessionInfo?.(key, known)
        }
        if (known.pending && persistedConversationURL(site, current?.url, this.sitePreset(site).url)) { known.url = current.url; known.pending = false }
        if (known.url && current?.url !== known.url) await this.driver.open(known.url, { headed: options.headed, signal: options.signal })
      } else {
        // A new DSH session must not inherit whatever conversation the tab
        // currently shows: start a fresh web chat so one DSH session maps to
        // exactly one web conversation. Switch to the right site first — the
        // shortcut only works on the site's own page.
        await this.ensurePage(site, options)
        if (key) {
          await this.startNewChat(site, options)
          newConversation = true
          generation = randomUUID()
          known = { url: '', pending: true, generation, needsContext: true }
          this.conversations.set(key, known)
          await this.driver.updateSessionInfo?.(key, { ...known, userTurnKey: '', title: '' })
        }
      }
      // The provider can choose a full snapshot or a continuation only after
      // this method has selected the actual web conversation. Page hydration
      // and restoring the same URL do not themselves invalidate context.
      let conversation = {
        key, conversationKey: key, site,
        url: known?.url || String((await this.driver.state())?.url || ''),
        newConversation, reset: newConversation,
        reason: newConversation ? known?.contextResetReason || 'new-chat' : 'resume',
        generation,
      }
      const sendOptions = { ...options }
      const prepareMessage = async (info) => {
        conversation = info
        await options.onConversation?.(info)
        const update = await options.prepareMessage?.(info)
        if (update == null) return
        if (typeof update === 'string') { text = update; return }
        if (typeof update !== 'object' || Array.isArray(update)) {
          throw new BridgeError('invalid-message-preparation', 'prepareMessage must return text or a message object.')
        }
        if (Object.hasOwn(update, 'text')) {
          if (typeof update.text !== 'string') throw new BridgeError('invalid-message-preparation', 'Prepared message text must be a string.')
          text = update.text
        }
        for (const field of ['attachment', 'attachments']) {
          if (Object.hasOwn(update, field)) sendOptions[field] = update[field]
        }
      }
      await prepareMessage(conversation)
      if ((sendOptions.attachment || sendOptions.attachments?.length) && this.driver.prepareUploads) await this.driver.prepareUploads()

      const baseline = await readReplyState(this.driver, adapter, options.signal)
      // A restored page may not have hydrated yet. Keep the last known user
      // turn as the baseline so its old answer cannot satisfy this request.
      if (!baseline.userTurnKey && known?.userTurnKey) baseline.userTurnKey = known.userTurnKey
      const started = Date.now()
      watchId = randomUUID()
      const submitted = await this.submit(text, site, adapter, {
        ...sendOptions, baseline, watchId, selectPlugin: Boolean(adapter.pluginName && !known?.url),
        onConversationReset: async ({ reason }) => {
          newConversation = true
          generation = randomUUID()
          known = { url: '', pending: true, generation, needsContext: true, contextResetReason: reason }
          if (key) {
            this.conversations.set(key, known)
            await this.driver.updateSessionInfo?.(key, { ...known, userTurnKey: '', title: '' })
          } else this.legacyConversationGeneration = generation
          const info = { key, conversationKey: key, site, url: String((await this.driver.state())?.url || ''), newConversation: true, reset: true, reason, generation }
          await options.onConversationReset?.(info)
          await prepareMessage(info)
          // The upload has already failed. A rewritten first message may
          // carry a full-context reference, but no attachment is retried here.
          return { text }
        },
      })
      uploaded = submitted?.uploadLease
      if (typeof submitted?.submittedText === 'string') text = submitted.submittedText
      if (key) {
        const url = submitted?.url || ''
        const persisted = persistedConversationURL(site, url, this.sitePreset(site).url)
        const savedConversation = { ...known, ...(persisted ? { url } : {}), pending: !persisted, generation, needsContext: false, contextResetReason: '', userTurnKey: submitted?.userTurnKey || '' }
        this.conversations.set(key, savedConversation)
        if (persisted) await this.driver.updateSessionInfo?.(key, { url, generation, pending: false, needsContext: false, contextResetReason: '' })
      }
      const submission = { ...(submitted || {}), conversation, conversationReset: newConversation || submitted?.conversationReset === true }
      options.onSubmitted?.(submission)

      const reply = await waitForReply({
        driver: this.driver,
        adapter,
        baseline,
        settings: this.settings,
        signal: options.signal,
        log: this.log,
        expectedText: text,
        expectedTurnKey: submitted?.userTurnKey || '',
        onProgress: options.onProgress,
      })
      // Container-less sites: the read returns the whole conversation, so drop
      // everything up to and including the prompt we just sent.
      if (adapter.stripPrompt) {
        const marker = String(text).slice(0, Math.min(40, String(text).length))
        const at = marker ? reply.text.lastIndexOf(marker) : -1
        if (at >= 0) reply.text = reply.text.slice(at + marker.length).trim()
      }
      this.last = { site, count: reply.count, text: reply.text, at: Date.now() }
      // After the exchange is over the site has definitely assigned the concrete
      // conversation URL, and the page title carries the conversation title
      // ("Reply cherry"). Remember both, so the next turn reopens this chat
      // instead of starting yet another one.
      let title = null
      if (key) {
        try {
          const current = await this.driver.state()
          const entry = this.conversations.get(key) || {}
          const url = String(current?.url || '')
          if (persistedConversationURL(site, url, this.sitePreset(site).url)) { entry.url = url; entry.pending = false }
          if (reply.userTurnKey) entry.userTurnKey = reply.userTurnKey
          if (reply.replyId) entry.replyId = reply.replyId
          if (this.sitePreset(site).readTitle !== false) {
            title = String(current?.title || '').trim() || null
            if (title) entry.title = title
          }
          this.conversations.set(key, entry)
          if (entry.url) await this.driver.updateSessionInfo?.(key, { url: entry.url, title: entry.title || '', generation, pending: false, needsContext: false, contextResetReason: '' })
        } catch {}
      }
      return { site, reply: reply.text, title, ...reply, totalMs: Date.now() - started,
        submittedText: text, conversation,
        conversationReset: submission.conversationReset,
        contextAttachmentDelivered: submitted?.contextAttachmentDelivered === true,
        contextAttachmentSkipped: submitted?.contextAttachmentSkipped === true,
      }
      } finally {
        if (watchId && options.signal?.aborted && this.driver.stopGeneration) await this.driver.stopGeneration(watchId).catch(() => {})
        if (watchId && this.driver.endGenerationWatch) await this.driver.endGenerationWatch(watchId).catch(() => {})
        await uploaded?.release?.()
        if (options.sessionKey) await this.driver.releasePage?.(queueKey)
      }
    }, queueKey)
  }

  async waitUploads(signal) {
    const until = Date.now() + 120000
    while (Date.now() < until) {
      if (signal?.aborted) throw new BridgeError('aborted', '附件上传已取消。')
      const result = await this.uploadState(signal)
      if (result?.problem) throw new BridgeError(result.problem.code, result.problem.message)
      if (!result?.uploading) {
        await new Promise(resolve => setTimeout(resolve, 1500))
        const settled = await this.uploadState(signal)
        if (settled?.problem) throw new BridgeError(settled.problem.code, settled.problem.message)
        if (!settled?.uploading) return
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw new BridgeError('attachment-upload-timeout', '附件上传超时，尚未发送消息。')
  }

  async uploadState(signal) {
    return (await this.driver.eval(`(() => {
        const visible = el => el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
        const text = document.body?.innerText || '';
        const uploading = [...document.querySelectorAll('[role="progressbar"], [aria-label*="正在上传"], [aria-label*="Uploading"]')].some(visible) || /正在上传|正在处理文件|上传中|Uploading|Processing\\s+file/i.test(text);
        const parseProblem = ${uploadProblem.toString()};
        return {problem:parseProblem(text),uploading};
      })()`, { signal })).result
  }

  async dismissUploadNotice() {
    for (const selector of [
      '[role="dialog"] button:text-is("取消")',
      '[role="alertdialog"] button:text-is("取消")',
      '[role="dialog"] button:text-is("Cancel")',
      'button[aria-label="关闭对话框"]',
    ]) {
      const result = await this.driver.run('query', [selector]).catch(() => null)
      if (result?.items?.some(item => item.rect?.width > 0 && item.rect?.height > 0)) {
        await this.driver.click(selector)
        return
      }
    }
    await this.driver.press('Escape')
  }

  /**
   * Start a new web conversation.
   *
   * Opening the site root is not enough: ChatGPT restores the previous chat on
   * load, so both DSH sessions ended up in one conversation. Click the sidebar
   * "新聊天" control first and only fall back to a plain navigation.
   */
  /**
   * Wait until the page shows an empty chat (no reply nodes). The client-side
   * route swaps the URL first and the message list later, so this is the only
   * reliable "a new chat is really ready" signal.
   */
  async waitBlank(site, options = {}) {
    const adapter = this.adapter(site)
    const deadline = Date.now() + (options.timeoutMs || 15000)
    while (Date.now() < deadline) {
      try {
        const state = await readReplyState(this.driver, adapter, options.signal)
        if (state.count === 0 && (!this.driver.composerBlank || await this.driver.composerBlank(adapter.inputSelector, { signal: options.signal }))) return true
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return false
  }

  async startNewChat(site, options = {}) {
    const preset = this.sitePreset(site)
    // Verified 2026-11-17: opening the site root does NOT reset the chat (the
    // profile restores the last conversation), while the keyboard shortcut
    // always lands on a blank composer at the top level URL.
    if (preset.newChatShortcut) {
      try {
        await this.driver.press(preset.newChatShortcut, { signal: options.signal })
        await new Promise((resolve) => setTimeout(resolve, 1200))
        const st = await this.driver.state().catch(() => null)
        // The URL changes before the message list is swapped. Give the blank
        // chat a moment to render so the reply baseline is taken on the new
        // page (a stale baseline makes the reply look like it never arrived).
        const empty = await this.waitBlank(site, { signal: options.signal, timeoutMs: 12000 })
        const blank = Boolean(st?.url) && !String(st.url).includes('/c/')
        this.log(`[webbridge] new-chat shortcut ${preset.newChatShortcut} -> ${st?.url || 'unknown'} blank=${blank} empty=${empty}`)
        if (!blank || !empty) throw new BridgeError('new-chat-not-ready', '网页新会话尚未清空，请检查浏览器。')
        return 'shortcut'
      } catch (err) {
        this.log(`[webbridge] new-chat shortcut failed (${err.code || 'error'}); trying the button`)
      }
    }
    // One click, no retries: ChatGPT creates the conversation only when the
    // first message is sent, so verifying the URL here always looked like a
    // failure and the retry loop kept hopping between conversations.
    try {
      const selector = this.adapter(site).newChatSelector || 'a[data-testid="create-new-chat-button"], nav a[href="/"]'
      await this.driver.click(selector, { signal: options.signal, timeoutMs: 8000 })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      if (!await this.waitBlank(site, options)) throw new BridgeError('new-chat-not-ready', '网页新会话尚未清空，请检查浏览器。')
      return 'new-chat'
    } catch (err) {
      this.log(`[webbridge] new-chat click failed (${err.code || 'error'}); navigating to the site root`)
      await this.driver.open(preset.url, { headed: options.headed, signal: options.signal })
      if (!await this.waitBlank(site, options)) throw new BridgeError('new-chat-not-ready', '无法打开空白网页会话，尚未发送消息。')
      return preset.url
    }
  }

  /** Inspect the web chat mapped to one DSH session; never create or switch chats. */
  async readConversation(options = {}) {
    const site = options.site || this.settings.site
    const sessionKey = String(options.sessionKey || '').trim()
    if (!sessionKey) throw new BridgeError('session-required', '读取网页消息需要当前 DSH sessionId。')
    const key = site + ':' + sessionKey
    return this.enqueue(async () => {
      const preset = this.sitePreset(site)
      const known = this.conversations.get(key) || await this.driver.getSessionInfo?.(key)
      const url = String(known?.url || '')
      if (!persistedConversationURL(site, url, preset.url) ||
          new URL(url).origin !== new URL(preset.url).origin) {
        throw new BridgeError('sync-no-conversation', '当前本地会话没有已关联的 ChatGPT 网页对话，未执行同步。')
      }
      try {
        const current = await this.driver.state()
        if (current?.url !== url) await this.driver.open(url, { signal: options.signal })
        await this.authGate(await this.driver.state(), this.adapter(site).inputSelector)
        let read
        const expected = new URL(url)
        for (let attempt = 0; attempt < 16; attempt++) {
          read = (await this.driver.eval(buildConversationReadExpression(), { signal: options.signal }))?.result
          const actual = new URL(String(read?.url || 'about:blank'))
          if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
            throw new BridgeError('sync-conversation-changed', '网页跳转到了另一段对话，未修改本地会话。')
          }
          if (read?.streaming) throw new BridgeError('sync-web-busy', '网页正在生成回复，请结束后再同步。')
          if (Array.isArray(read?.messages) && read.messages.length) break
          await new Promise(resolve => setTimeout(resolve, 300))
        }
        if (!Array.isArray(read?.messages) || !read.messages.length) {
          throw new BridgeError('sync-no-messages', '网页未加载出完整的对话内容，未修改本地会话。')
        }
        const replyState = await readReplyState(this.driver, this.adapter(site), options.signal)
        if (replyState?.streaming || replyState?.requestActive) {
          throw new BridgeError('sync-web-busy', '网页正在生成回复，请结束后再同步。')
        }
        return { ...read, site, url }
      } finally {
        await this.driver.releasePage?.(key)
      }
    }, key)
  }

  async newChat(options = {}) {
    const queueKey = options.sessionKey ? `${options.site || this.settings.site}:${options.sessionKey}` : this.sessionId
    return this.enqueue(async () => {
      const site = options.site || this.settings.site
      const result = await this.startNewChat(site, options)
      const key = options.sessionKey ? `${site}:${options.sessionKey}` : null
      const generation = randomUUID()
      const entry = { url: '', pending: true, generation, needsContext: true, contextResetReason: 'manual-reset', userTurnKey: '', title: '' }
      if (key) {
        this.conversations.set(key, entry)
        await this.driver.updateSessionInfo?.(key, entry)
      } else this.legacyConversationGeneration = generation
      const url = String((await this.driver.state())?.url || result || '')
      const conversation = { key, conversationKey: key, site, url, newConversation: true, reset: true, reason: 'manual-reset', generation }
      await options.onConversationReset?.(conversation)
      await options.onConversation?.(conversation)
      this.last = { site, count: 0, text: '', at: Date.now() }
      return { site, url, adapterSource: this.adapter(site).source, conversation }
    }, queueKey)
  }
}

function safeHost(url) {
  try {
    return new URL(url).host
  } catch {
    return String(url)
  }
}

function persistedConversationURL(_site, value, root) {
  const url = String(value || '')
  if (!url || url === root) return false
  return /\/c\//.test(url) && !/\/c\/(?:local-chatgpt|local_)/i.test(decodeURIComponent(url))
}

