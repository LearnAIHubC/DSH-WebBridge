/** ChatGPT provider regression tests. Run with: node --test scripts/provider-chatgpt-unit.mjs */
import assert from 'node:assert/strict'
import test from 'node:test'
import { WebChatAdapter, deriveTitle, flattenMessages, stripReminders } from '../src/provider.js'
import { parseReply } from '../src/agent.js'
import { buildReadExpression } from '../src/adapters.js'

const user = (content) => ({ role: 'user', content })
const system = (content) => ({ role: 'system', content })
const contextMessages = () => [
  { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '<system-reminder>Current working directory and file policy.</system-reminder>' }] },
  { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '<system-reminder><available_skills>browser-operator</available_skills></system-reminder>' }] },
  { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-17' }] },
]
const tools = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
const toolReply = (path) => `<<<TOOL_CALLS>>>${JSON.stringify([{ name: 'read', arguments: { path } }])}<<<END_TOOL_CALLS>>>`
const textOf = (chunks) => chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')

function fixture(replies = ['ok'], overrides = {}) {
  const sent = []
  const adapter = new WebChatAdapter({
    providerId: 'webbridge-chatgpt',
    displayName: 'ChatGPT',
    modelId: 'chatgpt-web',
    settings: { providers: {} },
    session: {
      async ask(message, options) {
        sent.push({ message, ...options })
        const reply = replies[Math.min(sent.length - 1, replies.length - 1)]
        if (reply instanceof Error) throw reply
        return { reply }
      },
    },
    parseReply,
    ...overrides,
  })
  return { adapter, sent }
}

async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

test('ChatGPT returns a complete DSH text stream', async () => {
  const { adapter, sent } = fixture(['收到'])
  const chunks = await collect(adapter, { sessionId: 'text', messages: [user('只回复：收到')] })
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '收到' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '收到' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  assert.equal(sent[0].message, '用户：只回复：收到')
  assert.equal(sent[0].attachment, null)
})

test('DSH runtime reminders after the user message cannot replace the composer text', async () => {
  const { adapter, sent } = fixture()
  await collect(adapter, {
    sessionId: 'dsh-real-layout', tools,
    messages: [system('Coding assistant instructions'), user([{ type: 'text', text: 'Reply exactly: WB_DSH_TEST' }]), ...contextMessages()],
  })
  assert.equal(sent[0].message, '用户：Reply exactly: WB_DSH_TEST')
  assert.match(sent[0].attachment.content, /Coding assistant instructions/)
  assert.match(sent[0].attachment.content, /<<<NEXUS_TOOLS>>>/)
  assert.doesNotMatch(sent[0].attachment.content, /WB_DSH_TEST|available_skills|Current working directory/)
})

test('DSH reminders do not advance the conversation cursor on subsequent turns', async () => {
  const { adapter, sent } = fixture()
  await collect(adapter, { sessionId: 'dsh-next', messages: [user('第一句'), ...contextMessages()] })
  await collect(adapter, { sessionId: 'dsh-next', messages: [user('第一句'), user('第二句'), ...contextMessages()] })
  assert.equal(sent[0].message, '用户：第一句')
  assert.equal(sent[1].message, '用户：第二句')
})

test('continuing a DSH conversation forwards only new user input, not assistant replies', async () => {
  const { adapter, sent } = fixture(['FIRST_ANSWER', 'SECOND_ANSWER', 'THIRD_ANSWER'])
  const messages = [user('FIRST_QUESTION')]
  await collect(adapter, { sessionId: 'no-assistant-echo', messages: [...messages, ...contextMessages()] })
  messages.push({ role: 'assistant', content: [{ type: 'text', text: 'FIRST_ANSWER' }] }, user('SECOND_QUESTION'))
  await collect(adapter, { sessionId: 'no-assistant-echo', messages: [...messages, ...contextMessages()] })
  messages.push({ role: 'assistant', content: 'SECOND_ANSWER' }, user('THIRD_QUESTION'))
  await collect(adapter, { sessionId: 'no-assistant-echo', messages: [...messages, ...contextMessages()] })
  assert.equal(sent[1].message, '用户：SECOND_QUESTION')
  assert.equal(sent[2].message, '用户：THIRD_QUESTION')
})

test('initial context history excludes assistant messages as well', async () => {
  const { adapter, sent } = fixture()
  await collect(adapter, { sessionId: 'user-history', messages: [user('OLD_USER'), { role: 'assistant', content: 'OLD_ASSISTANT' }, user('NEW_USER')] })
  assert.equal(sent[0].message, '用户：NEW_USER')
  assert.match(sent[0].attachment.content, /OLD_USER/)
  assert.doesNotMatch(sent[0].attachment.content, /OLD_ASSISTANT/)
})

test('native MCP results recorded for the DSH UI are not echoed back to ChatGPT', async () => {
  const { adapter, sent } = fixture(['FIRST_ANSWER', 'SECOND_ANSWER'], { settings: { site: 'chatgpt', providers: {} }, parseReply: null })
  await collect(adapter, { sessionId: 'native-history', messages: [user('FIRST_QUESTION')] })
  await collect(adapter, { sessionId: 'native-history', messages: [user('FIRST_QUESTION'),
    { role: 'user', source: { kind: 'tool', callId: 'wb_mcp_123_call' }, content: [{ type: 'text', text: 'ALREADY_DELIVERED_MCP_RESULT' }] },
    { role: 'assistant', content: 'FIRST_ANSWER' }, user('SECOND_QUESTION')],
  })
  assert.equal(sent[1].message, '用户：SECOND_QUESTION')
})

test('DSH tool results still reach the composer when reminders follow them', async () => {
  const { adapter, sent } = fixture([toolReply('one.txt'), '<<<FINAL>>>file contents received<<<END_FINAL>>>'])
  const messages = [user('Read one.txt')]
  const first = await collect(adapter, { sessionId: 'dsh-tool-results', messages: [...messages, ...contextMessages()], tools })
  const block = first.find((chunk) => chunk.type === 'block-end').block
  messages.push({ role: 'assistant', content: [block] })
  messages.push({ role: 'tool', content: [{ type: 'tool-result', name: 'read', result: { text: 'FILE_CONTENTS' } }] })
  const second = await collect(adapter, { sessionId: 'dsh-tool-results', messages: [...messages, ...contextMessages()], tools })
  assert.match(sent[1].message, /FILE_CONTENTS/)
  assert.doesNotMatch(sent[1].message, /Read one.txt|system-reminder/)
  assert.equal(textOf(second), 'file contents received')
})

test('a request containing only DSH reminders fails before uploading or sending', async () => {
  const { adapter, sent } = fixture()
  await assert.rejects(collect(adapter, { sessionId: 'dsh-empty', messages: contextMessages(), tools }), (error) => error.code === 'empty-message')
  assert.equal(sent.length, 0)
})

test('requests without sessionId keep a stable conversation and isolate different users', async () => {
  const { adapter, sent } = fixture()
  await collect(adapter, { messages: [user('苹果')] })
  await collect(adapter, { messages: [user('香蕉')] })
  await collect(adapter, { messages: [user('苹果'), user('继续')] })
  assert.notEqual(sent[0].sessionKey, sent[1].sessionKey)
  assert.equal(sent[0].sessionKey, sent[2].sessionKey)
})

test('purpose chat uses the same conversation as an ordinary chat request', async () => {
  const { adapter, sent } = fixture()
  await collect(adapter, { sessionId: 'main', messages: [user('第一句')] })
  await collect(adapter, { sessionId: 'main', purpose: 'chat', messages: [user('第一句'), user('第二句')] })
  assert.equal(sent[0].sessionKey, sent[1].sessionKey)
})

test('anonymous purpose chat requests do not all share one conversation', async () => {
  const { adapter, sent } = fixture()
  await collect(adapter, { purpose: 'chat', messages: [user('苹果')] })
  await collect(adapter, { purpose: 'chat', messages: [user('香蕉')] })
  assert.notEqual(sent[0].sessionKey, sent[1].sessionKey)
})

test('harness timestamps do not become the anonymous conversation identity', async () => {
  const { adapter, sent } = fixture()
  const noise = user('Time sampled while preparing turn 1, step 1: 2026-11-17')
  await collect(adapter, { messages: [noise, user('苹果')] })
  await collect(adapter, { messages: [noise, user('香蕉')] })
  assert.notEqual(sent[0].sessionKey, sent[1].sessionKey)
  assert.equal(sent[0].message, '用户：苹果')
})

test('messages that share a long prefix still get separate anonymous conversations', async () => {
  const { adapter, sent } = fixture()
  const prefix = 'a'.repeat(200)
  await collect(adapter, { messages: [user(`${prefix}苹果`)] })
  await collect(adapter, { messages: [user(`${prefix}香蕉`)] })
  assert.notEqual(sent[0].sessionKey, sent[1].sessionKey)
})

test('short system instructions and history reach the first request attachment', async () => {
  const { adapter, sent } = fixture()
  await collect(adapter, { sessionId: 'context', messages: [system('请用中文回答'), user('记住：苹果'), user('我刚才说了什么？')] })
  assert.equal(sent[0].message, '用户：我刚才说了什么？')
  assert.ok(sent[0].attachment)
  assert.match(sent[0].attachment.content, /请用中文回答/)
  assert.match(sent[0].attachment.content, /记住：苹果/)
})

test('adding system messages does not replay previously sent user messages', async () => {
  const { adapter, sent } = fixture()
  await collect(adapter, { sessionId: 'grow', messages: [system('规则一'), user('旧消息')] })
  await collect(adapter, { sessionId: 'grow', messages: [system('规则一'), system('规则二'), user('旧消息'), user('新消息')] })
  assert.equal(sent[1].message, '用户：新消息')
})

test('removing system messages does not drop new user messages', async () => {
  const { adapter, sent } = fixture()
  await collect(adapter, { sessionId: 'shrink', messages: [system('规则一'), system('规则二'), user('旧消息')] })
  await collect(adapter, { sessionId: 'shrink', messages: [user('旧消息'), user('新消息一'), user('新消息二')] })
  assert.equal(sent[1].message, '用户：新消息一\n\n用户：新消息二')
})

test('ChatGPT can request tools on successive rounds and then emit a clean final answer', async () => {
  const { adapter, sent } = fixture([toolReply('one.txt'), toolReply('two.txt'), '<<<FINAL>>>完成<<<END_FINAL>>>'])
  const messages = [user('读取两个文件')]
  for (const [index, filename] of ['one.txt', 'two.txt'].entries()) {
    const chunks = await collect(adapter, { sessionId: 'tools', messages: [...messages], tools })
    const block = chunks.find((chunk) => chunk.type === 'block-end')?.block
    assert.equal(block?.type, 'tool-call')
    assert.equal(block.name, 'read')
    assert.deepEqual(JSON.parse(block.arguments), { path: filename })
    assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'tool-use' } })
    messages.push({ role: 'assistant', content: [block] })
    messages.push({ role: 'tool', content: [{ type: 'tool-result', name: 'read', result: { text: `file ${index + 1}` } }] })
  }
  const final = await collect(adapter, { sessionId: 'tools', messages, tools })
  assert.equal(textOf(final), '完成')
  assert.deepEqual(final.at(-1), { type: 'finish', reason: { kind: 'stop' } })
  assert.match(sent[0].attachment.content, /<<<NEXUS_TOOLS>>>/)
  assert.equal(sent[1].attachment, null)
  assert.match(sent[1].message, /file 1/)
  assert.match(sent[2].message, /file 2/)
})

test('tools first enabled on a later turn are delivered to the web model', async () => {
  const { adapter, sent } = fixture(['ok', toolReply('later.txt')])
  await collect(adapter, { sessionId: 'late-tools', messages: [user('你好')] })
  const chunks = await collect(adapter, { sessionId: 'late-tools', messages: [user('你好'), user('现在读取文件')], tools })
  const toolContext = `${sent[1].attachment?.content || ''}\n${sent[1].message}`
  assert.match(toolContext, /<<<NEXUS_TOOLS>>>/)
  assert.equal(chunks.find((chunk) => chunk.type === 'tool-call-delta')?.name, 'read')
})

test('failed browser requests preserve their cause and can retry the initial context', async () => {
  const cause = Object.assign(new Error('browser unavailable'), { code: 'driver-timeout' })
  const { adapter, sent } = fixture([cause, 'ok'])
  const options = { sessionId: 'retry', messages: [user('读取文件')], tools }
  await assert.rejects(collect(adapter, options), (error) => error.cause === cause && /driver-timeout/.test(error.message))
  await collect(adapter, options)
  assert.equal(sent[0].message, sent[1].message)
  assert.deepEqual(sent[0].attachment, sent[1].attachment)
})

test('auxiliary requests use a separate conversation and receive their full input', async () => {
  const { adapter, sent } = fixture()
  await collect(adapter, { sessionId: 'aux', messages: [user('主聊天')] })
  await collect(adapter, { sessionId: 'aux', purpose: 'compaction', messages: [system('压缩这段对话'), user('历史内容')], tools })
  assert.notEqual(sent[0].sessionKey, sent[1].sessionKey)
  assert.match(sent[1].message, /压缩这段对话/)
  assert.match(sent[1].message, /历史内容/)
  assert.equal(sent[1].attachment, null)
})

test('session titles are generated locally from text blocks after removing reminders', async () => {
  const { adapter, sent } = fixture()
  const messages = [user([{ type: 'text', text: '<system-reminder>内部说明</system-reminder>修复构建问题' }])]
  assert.equal(deriveTitle(messages), '修复构建问题')
  const chunks = await collect(adapter, { purpose: 'session-title', messages })
  assert.equal(textOf(chunks), '修复构建问题')
  assert.equal(sent.length, 0)
})

test('message flattening accepts strings alongside text blocks', () => {
  assert.equal(flattenMessages([user(['第一行', { type: 'text', text: '第二行' }])]), '用户：第一行\n第二行')
})

test('stripping harness reminders preserves indentation in user code', () => {
  const code = 'def run():\n    return "two  spaces"'
  assert.equal(stripReminders(`<system-reminder>内部说明</system-reminder>\n${code}`), code)
})

test('native ChatGPT forwards partial text before the web request finishes', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const { adapter } = fixture([], {
    settings: { site: 'chatgpt', providers: {} }, parseReply: null,
    session: { async ask(_message, options) { options.onSubmitted(); options.onProgress({ text: 'First' }); return pending } },
  })
  const stream = adapter.generate({ sessionId: 'partial', messages: [user('write')] })
  assert.equal((await stream.next()).value.type, 'block-start')
  assert.equal((await stream.next()).value.text, 'First')
  finish({ reply: 'First second' })
  const rest = []
  for await (const chunk of stream) rest.push(chunk)
  assert.equal(textOf(rest), ' second')
  assert.equal(rest.at(-2).block.text, 'First second')
})

test('Markdown turning a pending 007. into list item 7. cannot freeze subsequent text deltas', async () => {
  let finish, progress
  const pending = new Promise(resolve => { finish = resolve })
  const { adapter } = fixture([], {
    settings: { site: 'chatgpt', providers: {} }, parseReply: null,
    session: { async ask(_message, options) { progress = options.onProgress; options.onSubmitted(); progress({ text: '6. previous\n\n007.' }); return pending } },
  })
  const stream = adapter.generate({ sessionId: 'hydrating-list', messages: [user('write')] })
  await stream.next()
  assert.equal((await stream.next()).value.text, '6. previous')
  progress({ text: '6. previous\n\n7. next' })
  assert.equal((await stream.next()).value.text, '\n\n7. next')
  progress({ text: '6. previous\n\n7. next\n\n008.' })
  progress({ text: '6. previous\n\n7. next\n\n8. last' })
  assert.equal((await stream.next()).value.text, '\n\n8. last')
  finish({ reply: '6. previous\n\n7. next\n\n8. last' })
  const rest = []; for await (const chunk of stream) rest.push(chunk)
  assert.equal(rest.at(-2).block.text, '6. previous\n\n7. next\n\n8. last')
})

test('bare partial list numbers including 0, 063 and 099 cannot stall the DSH stream', async () => {
  const { snapshotDelta, streamPreview } = await import('../src/stream-text.js')
  let previous = ''
  let emitted = ''
  for (let number = 1; number <= 120; number++) {
    for (const pending of ['0', String(number).padStart(3, '0'), String(number).padStart(3, '0') + '.']) {
      const next = streamPreview(emitted + '\n\n' + pending)
      const delta = snapshotDelta(previous, next)
      assert.notEqual(delta, null, `pending ${pending}`)
      previous = next
    }
    const next = `${emitted}${emitted ? '\n\n' : ''}${number}. sentence ${number}`
    const delta = snapshotDelta(previous, streamPreview(next))
    assert.ok(delta.includes(`sentence ${number}`))
    emitted = next; previous = next
  }
  assert.ok(emitted.endsWith('120. sentence 120'))
})

test('a stop on the webpage closes the DSH stream as aborted with its partial text', async () => {
  const { adapter } = fixture([], {
    settings: { site: 'chatgpt', providers: {} }, parseReply: null,
    session: { async ask(_message, options) { options.onSubmitted(); options.onProgress({ text: 'Partial answer' }); throw Object.assign(new Error('stopped'), { code: 'web-generation-stopped' }) } },
  })
  const chunks = await collect(adapter, { sessionId: 'web-stop', messages: [user('write')] })
  assert.equal(textOf(chunks), 'Partial answer')
  assert.equal(chunks.at(-1).reason.kind, 'aborted')
  assert.equal(chunks.at(-1).reason.failure.code, 'ABORTED')
})

test('new DSH input interrupts the active request and the next step forwards only the follow-up', async () => {
  let notifyInput
  let calls = 0
  const sent = []
  const { adapter } = fixture([], {
    settings: { site: 'chatgpt', providers: {} }, parseReply: null,
    toolScope: {
      withSession: (_, operation) => operation(),
      watchUserInput: (_, callback) => { notifyInput = callback; return () => {} },
    },
    session: { async ask(message, options) {
      sent.push({message,attachment:options.attachment}); options.onSubmitted(); calls++
      if (calls > 1) return {reply:'FOLLOW_UP_DONE'}
      options.onProgress({text:'Partial'})
      return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('interrupted'),{code:'aborted'})),{once:true}))
    } },
  })
  const stream = adapter.generate({ sessionId: 'follow-up', messages: [system('context'), user('FIRST_REQUEST')] })
  await stream.next(); await stream.next()
  notifyInput({ role: 'user', source: {kind:'user'}, content: 'FOLLOW_UP' })
  const end = []
  for await (const chunk of stream) end.push(chunk)
  assert.equal(end.at(-1).reason.kind, 'stop')
  await collect(adapter, { sessionId: 'follow-up', messages: [system('context'), user('FIRST_REQUEST'), user('FOLLOW_UP')] })
  assert.equal(sent[1].message, '用户：FOLLOW_UP')
  assert.equal(sent[1].attachment, null)
})

test('hidden replies and empty placeholders do not count as a new chat reply', () => {
  const node = (text, visible) => ({ innerText: text, textContent: text, checkVisibility: () => visible })
  let nodes = [node('OLD_REPLY', false), node('', true)]
  const document = { querySelectorAll: () => nodes, querySelector: () => null, title: 'ChatGPT' }
  const read = new Function('document', 'location', `return ${buildReadExpression({ messageSelector: '.reply' })}`)
  const location = { href: 'https://chatgpt.com/' }
  assert.equal(read(document, location).count, 0)
  assert.equal(read(document, location).text, '')
  nodes = [...nodes, node('NEW_REPLY', true)]
  assert.equal(read(document, location).count, 1)
  assert.equal(read(document, location).text, 'NEW_REPLY')
})

test('user messages containing plugin mentions cannot be mistaken for assistant markdown', () => {
  const node = (text, role) => ({ innerText: text, textContent: text, checkVisibility: () => true,
    getAttribute: (name) => name === 'data-markdown-text-style' ? role : null })
  let nodes = [node('USER_PROMPT Nexus DSH', 'user-message')]
  const document = { querySelectorAll: (selector) => selector === '.markdown' ? nodes : [], querySelector: () => null, title: 'ChatGPT' }
  const read = new Function('document', 'location', `return ${buildReadExpression({ messageSelector: '.markdown', matchReplyToUserTurn: true })}`)
  const location = { href: 'https://chatgpt.com/c/test' }
  assert.equal(read(document, location).count, 0)
  nodes.push(node('ASSISTANT_REPLY', 'assistant-message'))
  assert.equal(read(document, location).count, 1)
  assert.equal(read(document, location).text, 'ASSISTANT_REPLY')
})
