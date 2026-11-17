import test from 'node:test'
import assert from 'node:assert/strict'
import { domToMarkdown } from '../src/markdown.js'
import { patchChatgptLoginDetection, signedInChatgptProfile } from '../src/browser-compat.js'

function element(tag, content = [], attributes = {}) {
  const childNodes = (typeof content === 'string' ? [content] : content).map(value => typeof value === 'string' ? { nodeType: 3, textContent: value } : value)
  const node = { nodeType: 1, tagName: tag.toUpperCase(), childNodes, children: childNodes.filter(child => child.nodeType === 1), getAttribute: name => attributes[name] ?? null, className: attributes.class || '' }
  Object.defineProperty(node, 'textContent', { get: () => childNodes.map(child => child.textContent || '').join('') })
  Object.defineProperty(node, 'innerText', { get: () => node.textContent })
  node.querySelectorAll = selector => {
    const selectors = selector.split(',')
    const matches = child => selectors.some(value => value.startsWith('.') ? child.className.split(/\s+/).includes(value.slice(1)) : value.startsWith('[') ? false : child.tagName === value.toUpperCase())
    const out = []
    const visit = parent => { for (const child of parent.children) { if (matches(child)) out.push(child); visit(child) } }
    visit(node); return out
  }
  node.querySelector = selector => node.querySelectorAll(selector)[0] || null
  return node
}

test('page tables preserve headers, columns, and pipe characters as Markdown', () => {
  const table = element('table', [element('tr', [element('th', '项目'), element('th', '状态')]), element('tr', [element('td', 'Node.js'), element('td', 'v22.14.0')]), element('tr', [element('td', 'A|B'), element('td', '完成')])])
  assert.equal(domToMarkdown(table), '| 项目 | 状态 |\n| --- | --- |\n| Node.js | v22.14.0 |\n| A\\|B | 完成 |')
})

test('page code blocks retain language, indentation, and literal fences', () => {
  const code = '  const text = "```";\n    return text;'
  assert.equal(domToMarkdown(element('pre', [element('code', code, { class: 'language-js' })])), '````js\n' + code + '\n````')
})

test('ChatGPT CodeMirror blocks preserve line breaks and indentation without language and Run controls in the body', () => {
  const block = element('div', [
    element('div', [element('div', 'Python'), element('button', '运行')], { 'data-markdown-copy': 'exclude' }),
    element('div', [element('div', 'def test_output():', { class: 'cm-line' }), element('div', '    print("测试成功")', { class: 'cm-line' })], { class: 'cm-content', 'data-language': 'python' }),
  ], { 'data-code-block': 'true' })
  assert.equal(domToMarkdown(block), '```python\ndef test_output():\n    print("测试成功")\n```')
})

test('nested lists retain the indentation required inside a numbered item', () => {
  const list = element('ol', [element('li', ['parent', element('ul', [element('li', 'child')])])])
  assert.match(domToMarkdown(list), /1\. parent\n    - child/)
})

test('page lists, headings, and links keep their structure', () => {
  const page = element('div', [element('h2', '步骤'), element('ol', [element('li', '安装'), element('li', [element('a', '项目', { href: 'https://github.com/LearnAIHubC' })])], { start: '3' })])
  const markdown = domToMarkdown(page)
  assert.match(markdown, /^## 步骤/)
  assert.match(markdown, /3\. 安装/)
  assert.match(markdown, /4\. \[项目\]\(https:\/\/github.com\/LearnAIHubC\)/)
})

test('a real signed-in ChatGPT profile avoids reply-text login false positives', () => {
  const document = { querySelectorAll: () => [{ innerText: '', hidden: true }, { innerText: 'User\n免费版' }] }
  assert.equal(signedInChatgptProfile('https://chatgpt.com/c/example', document, node => !node.hidden), true)
  assert.equal(signedInChatgptProfile('https://chatgpt.com/auth/login', document, node => !node.hidden), false)
  assert.equal(signedInChatgptProfile('https://another.example', document, node => !node.hidden), false)
})

test('the BrowserOperator auth compatibility patch is idempotent and retains password guards', () => {
  const source = 'const passwords=[];if(passwords.length)reasons.push("password-input");\nconst loggedIn =\n /退出登录/.test(bodyText);'
  const patched = patchChatgptLoginDetection(source)
  assert.equal(patchChatgptLoginDetection(patched), patched)
  assert.ok(patched.includes('password-input'))
  assert.equal(new Function('document', 'url', 'visible', 'bodyText', 'reasons', patched + '\nreturn loggedIn;')({ querySelectorAll: () => [{ innerText: 'User 免费版' }] }, 'https://chatgpt.com/c/example', () => true, '文档中提到重新登录', []), true)
})
