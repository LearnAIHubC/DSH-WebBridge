import assert from 'node:assert/strict'
import test from 'node:test'
import { WebChatAdapter } from '../src/provider.js'
import { ContextStore } from '../src/context.js'

const user = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const collect = async (adapter, options) => {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function readContext(store, args, sessionId, firstOnly = false) {
  const pages = []
  let page = store.read(args, { sessionId })
  pages.push(page)
  while (!firstOnly && !page.completeness.complete) {
    page = store.read({ context_id: args.context_id, cursor: page.completeness.next_cursor }, { sessionId })
    pages.push(page)
  }
  return {
    pages,
    data: firstOnly && !page.completeness.complete ? null
      : pages[0].data || JSON.parse(pages.map(entry => entry.fragment).join('')),
  }
}

function fixture({ steps = [], scope: scopeOverrides = {}, adapter: adapterOverrides = {}, pageChars = 500 } = {}) {
  const store = new ContextStore({ pageChars })
  const sent = []
  const bound = []
  const scope = {
    workspaceFor: async () => ({ cwd: '/project/current' }),
    originalMessage: (_sessionId, message) => message,
    attachmentsFor: async (_sessionId, messages) => messages.flatMap(message => (Array.isArray(message.content) ? message.content : [])
      .filter(block => ['file', 'image'].includes(block.type))
      .map(block => ({ path: `/attachments/${block.attachment.attachmentId}`, name: block.attachment.name || 'image.png' }))),
    async withSession(sessionId, operation, signal, options) {
      bound.push({ sessionId, signal, ...options })
      return operation()
    },
    ...scopeOverrides,
  }
  const adapter = new WebChatAdapter({
    providerId: 'webbridge-chatgpt', displayName: 'ChatGPT', modelId: 'chatgpt-web',
    settings: { site: 'chatgpt', providers: {} },
    contextStore: store, contextAvailable: () => true, toolScope: scope,
    session: {
      async ask(message, options) {
        const step = steps[sent.length] || {}
        const newConversation = step.newConversation ?? sent.length === 0
        const conversation = { key: options.sessionKey, newConversation, reset: newConversation, reason: newConversation ? 'new-chat' : 'resume' }
        await options.onConversation?.(conversation)
        const prepared = await options.prepareMessage?.(conversation)
        const delivery = typeof prepared === 'string' ? { text: prepared } : prepared || {}
        const request = { message: delivery.text ?? message, attachment: options.attachment, attachments: options.attachments || [], ...delivery, options }
        sent.push(request)
        if (step.beforeSubmitError) throw step.beforeSubmitError
        const flags = { contextAttachmentDelivered: step.contextAttachmentDelivered ?? Boolean(request.attachment), conversation }
        options.onSubmitted?.(flags)
        if (step.progressBeforeContext) options.onProgress?.({ text: step.progressBeforeContext })
        const bootstrap = [request.message, request.attachment?.content].find(value => typeof value === 'string' && value.includes('dsh_get_context')) || ''
        const match = bootstrap.match(/参数为 (\{[^\n]*?\})。/)
        if (match) {
          request.args = JSON.parse(match[1])
          if (step.read !== 'none') Object.assign(request, readContext(store, request.args, options.sessionKey, step.read === 'first'))
        }
        if (step.progressAfterContext) options.onProgress?.({ text: step.progressAfterContext })
        if (step.afterSubmitError) throw step.afterSubmitError
        return { reply: step.reply || '完成', ...flags }
      },
    },
    ...adapterOverrides,
  })
  return { adapter, store, sent, bound }
}

test('native bootstrap exports the full effective input while keeping the composer short', async () => {
  const { adapter, sent, bound } = fixture()
  const messages = [
    { id: 'system', role: 'system', content: [{ type: 'text', text: 'SYSTEM_PROMPT '.repeat(700) }] },
    { id: 'developer', role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'read' }] },
    user('old-user', '之前的任务'),
    { id: 'assistant', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '之前的决定' }] },
    { id: 'result', role: 'user', source: { kind: 'tool', callId: 'real-call' }, content: [{ type: 'text', text: '保留已有工具结果' }] },
    user('current-user', '现在修改代码'),
    { id: 'agents', role: 'user', source: { kind: 'agent-instructions', form: 'set' }, content: '<system-reminder>AGENTS.md 完整规则</system-reminder>' },
    { id: 'skills', role: 'user', source: { kind: 'skill-catalog' }, content: '<available_skills>完整技能目录</available_skills>' },
    { id: 'runtime', role: 'user', source: { kind: 'runtime-context', sections: [{ name: 'cwd' }] }, content: 'Current DeepSeek Harness implementation checkout /implementation' },
    { id: 'time', role: 'user', source: { kind: 'time-context' }, content: 'Time sampled while preparing turn 1, step 1' },
    { id: 'unknown', role: 'user', source: { kind: 'future-plugin' }, content: [{ type: 'new-kind', metadata: ['preserve', 1] }] },
  ]
  const toolHistory = { tools: [{ name: 'read', parameters: { file_path: { type: 'string' } } }], updates: [] }
  await collect(adapter, { sessionId: 'main', messages, toolHistory })
  assert.deepEqual(sent[0].data.messages, messages)
  assert.deepEqual(sent[0].data.tool_history, toolHistory)
  assert.deepEqual(sent[0].data.workspace, { cwd: '/project/current' })
  assert.equal(sent[0].message, '现在修改代码')
  assert.ok(sent[0].attachment.content.length < 700)
  assert.match(sent[0].attachment.content, /dsh_get_context.*context_id/)
  assert.doesNotMatch(sent[0].message, /请先调用|用户：|SYSTEM_PROMPT|AGENTS\.md|available_skills|之前的决定|\/project\/current/)
  assert.ok(sent[0].pages.length > 5)
  assert.equal(bound[0].contextReference.context_id, sent[0].args.context_id)
  assert.equal(adapter.sessionState.get('main').contextDelivered, true)
})

test('context-only continuation carries updated rules without replaying the old user task', async () => {
  const { adapter, sent } = fixture()
  const initial = [user('task', '修改一个文件')]
  await collect(adapter, { sessionId: 'main', messages: initial })
  const update = { id: 'rules', role: 'user', source: { kind: 'agent-instructions', form: 'replace' }, content: '子目录新增规则' }
  await collect(adapter, { sessionId: 'main', messages: [...initial, update] })
  assert.equal(sent[1].args.since_context_id, sent[0].args.context_id)
  assert.equal(sent[1].pages[0].mode, 'delta')
  assert.deepEqual(sent[1].data.messages.map(entry => entry.message), [update])
  assert.match(sent[1].message, /DSH 上下文已更新。请继续上一任务/)
  assert.doesNotMatch(sent[1].message, /请先调用|用户：修改一个文件/)
  assert.match(sent[1].attachment.content, /dsh_get_context/)
})

test('ordinary turns and checkpoint-only continuations do not announce a context update', async () => {
  const { adapter, sent } = fixture()
  const initial = [user('task', '第一个问题')]
  await collect(adapter, { sessionId: 'main', messages: initial })
  const firstContextId = adapter.sessionState.get('main').contextReference.context_id
  const history = [
    ...initial,
    { id: 'answer', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '处理中' }] },
    { id: 'tool', role: 'user', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: '工具结果' }] },
    { id: 'checkpoint', role: 'user', source: { kind: 'webbridge-context-checkpoint' }, content: [{ type: 'text', text: 'continue' }] },
  ]
  await collect(adapter, { sessionId: 'main', messages: history })
  assert.equal(sent[1].message, '请继续上一任务，已经完成的工具操作不要重复执行。')
  assert.doesNotMatch(sent[1].message, /上下文已更新|dsh_get_context/)
  assert.equal(sent[1].attachment, null)
  assert.equal(sent[1].args, undefined)
  assert.equal(adapter.sessionState.get('main').contextReference.context_id, firstContextId)

  await collect(adapter, { sessionId: 'main', messages: [...history, user('next', '第二个问题')] })
  assert.equal(sent[2].message, '第二个问题')
  assert.doesNotMatch(sent[2].message, /请先调用|用户：/)
  assert.equal(sent[2].attachment, null)
  assert.equal(adapter.sessionState.get('main').contextReference.context_id, firstContextId)
})

test('a new conversation loads full context and restores earlier user attachments', async () => {
  const { adapter, sent } = fixture({ steps: [{}, {}, { newConversation: true }] })
  const upload = { ...user('file', '请分析这个文件'), content: [{ type: 'text', text: '请分析这个文件' }, { type: 'file', attachment: { attachmentId: 'file-id', name: 'design.txt' } }] }
  await collect(adapter, { sessionId: 'main', messages: [upload] })
  await collect(adapter, { sessionId: 'main', messages: [upload, user('followup', '继续分析')] })
  await collect(adapter, { sessionId: 'main', messages: [upload, user('followup', '继续分析')] })
  assert.deepEqual(sent[0].attachments, [{ path: '/attachments/file-id', name: 'design.txt' }])
  assert.deepEqual(sent[1].attachments, [])
  assert.equal(sent[1].attachment, null)
  assert.equal(sent[1].args, undefined)
  assert.equal(Object.hasOwn(sent[2].args, 'since_context_id'), false)
  assert.equal(sent[2].pages[0].mode, 'full')
  assert.deepEqual(sent[2].attachments, sent[0].attachments)
  assert.equal(sent[2].data.messages.length, 2)
})

test('submission does not mark context delivered when the model skips initialization', async () => {
  const { adapter, sent, store } = fixture({ steps: [{ read: 'none' }, { newConversation: true }] })
  const messages = [user('task', '修改代码')]
  await assert.rejects(collect(adapter, { sessionId: 'main', messages }), /context-not-initialized/)
  assert.equal(adapter.sessionState.get('main').bootstrapped, true)
  assert.equal(adapter.sessionState.get('main').contextDelivered, false)
  assert.equal(store.isDelivered(sent[0].args.context_id), false)
  await collect(adapter, { sessionId: 'main', messages })
  assert.equal(sent[1].pages[0].mode, 'full')
  assert.equal(adapter.sessionState.get('main').contextDelivered, true)
})

test('partial pagination cannot count as initialized context', async () => {
  const { adapter, sent, store } = fixture({ steps: [{ read: 'first' }] })
  await assert.rejects(collect(adapter, { sessionId: 'main', messages: [{ role: 'system', content: 'large '.repeat(1000) }, user('task', '继续')] }), /context-not-initialized/)
  assert.ok(sent[0].pages[0].page_count > 1)
  assert.equal(store.isDelivered(sent[0].args.context_id), false)
})

test('an uninitialized streamed answer cannot leak into the DSH partial history', async () => {
  const { adapter } = fixture({ steps: [{ read: 'none', progressBeforeContext: '尚未读取规则就作答' }] })
  const chunks = []
  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({ sessionId: 'main', messages: [user('task', '修改代码')] })) chunks.push(chunk)
  }, /context-not-initialized/)
  assert.deepEqual(chunks, [])
})

test('streaming resumes with the cumulative answer once bootstrap has completed', async () => {
  const { adapter } = fixture({ steps: [{ progressBeforeContext: '先获取规则。', progressAfterContext: '先获取规则。已读取全部上下文。', reply: '先获取规则。已读取全部上下文。完成。' }] })
  const chunks = await collect(adapter, { sessionId: 'main', messages: [user('task', '修改代码')] })
  assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '先获取规则。已读取全部上下文。完成。')
  assert.equal(chunks.filter(chunk => chunk.type === 'block-start').length, 1)
  assert.equal(chunks.filter(chunk => chunk.type === 'block-end').length, 1)
})

test('an unavailable context tool fails before sending any browser message', async () => {
  const { adapter, sent, store } = fixture({ adapter: { contextAvailable: () => false } })
  await assert.rejects(collect(adapter, { sessionId: 'main', messages: [user('task', '修改代码')] }), error => error.code === 'context-tool-unavailable')
  assert.equal(sent.length, 0)
  assert.equal(store.latestReference('main'), null)
})

test('final middleware changes survive even when the composer restores an original attachment message', async () => {
  const original = { ...user('upload', '用户原文'), content: [{ type: 'text', text: '用户原文' }, { type: 'image', attachment: { attachmentId: 'image-id', name: 'photo.png' } }] }
  const projected = { ...user('upload', '用户原文\nAttachment available via /project/attachment'), metadata: { final: true }, content: [
    { type: 'text', text: '用户原文\nAttachment available via /project/attachment' },
    { type: 'text', text: '<system-reminder>后置插件追加的规则</system-reminder>' },
  ] }
  const late = { id: 'late', role: 'developer', source: { kind: 'late-middleware' }, content: '后置独立规则' }
  const { adapter, sent } = fixture({ scope: {
    originalMessage: (_sessionId, message) => message.id === original.id ? original : message,
    originalRequest: () => ({ messages: [original], toolHistory: { tools: [{ name: 'fallback-tool' }], updates: [] } }),
  } })
  await collect(adapter, { sessionId: 'main', messages: [projected, late] })
  assert.deepEqual(sent[0].data.messages, [projected, late])
  assert.match(sent[0].message, /用户原文/)
  assert.doesNotMatch(sent[0].message, /后置插件|\/project\/attachment/)
  assert.deepEqual(sent[0].attachments, [{ path: '/attachments/image-id', name: 'photo.png' }])
  assert.equal(sent[0].data.tool_history.tools[0].name, 'fallback-tool')
})

test('expired bases automatically request full context on the next web turn', async () => {
  const { adapter, store, sent } = fixture()
  await collect(adapter, { sessionId: 'main', messages: [user('one', '第一句')] })
  store.deleteSession('main')
  await collect(adapter, { sessionId: 'main', messages: [user('one', '第一句'), user('two', '第二句')] })
  assert.equal(Object.hasOwn(sent[1].args, 'since_context_id'), false)
  assert.equal(sent[1].pages[0].mode, 'full')
})

test('auxiliary and title requests do not publish or modify main-session context', async () => {
  const { adapter, sent, store, bound } = fixture()
  await collect(adapter, { sessionId: 'main', purpose: 'session-title', messages: [user('title', '生成标题')] })
  assert.equal(sent.length, 0)
  await collect(adapter, { sessionId: 'main', purpose: 'compaction', messages: [{ role: 'system', content: '总结历史' }, user('summary', '历史输入')] })
  assert.equal(sent[0].options.sessionKey, 'main#compaction')
  assert.match(sent[0].message, /总结历史/)
  assert.equal(sent[0].args, undefined)
  assert.equal(bound.length, 0)
  assert.equal(store.latestReference('main'), null)
})

test('legacy TXT quota skip is not mistaken for completed context delivery', async () => {
  const { adapter, sent } = fixture({
    adapter: { settings: { site: 'deepseek', providers: {} }, parseReply: text => ({ kind: 'final', text }) },
    steps: [{ contextAttachmentDelivered: false }, { contextAttachmentDelivered: true }],
  })
  const system = { role: 'system', content: '保留系统规则' }
  const tools = [{ name: 'read', description: 'Read a file', parameters: { file_path: { type: 'string' } } }]
  await collect(adapter, { sessionId: 'legacy', messages: [system, user('first', '第一句')], tools })
  assert.equal(adapter.sessionState.get('legacy').contextDelivered, false)
  assert.equal(adapter.sessionState.get('legacy').toolContext, '')
  await collect(adapter, { sessionId: 'legacy', messages: [system, user('first', '第一句'), user('second', '第二句')], tools })
  assert.match(sent[0].attachment.content, /保留系统规则/)
  assert.match(sent[1].attachment.content, /保留系统规则/)
  assert.match(sent[1].attachment.content, /<<<NEXUS_TOOLS>>>/)
  assert.equal(adapter.sessionState.get('legacy').contextDelivered, true)
})
