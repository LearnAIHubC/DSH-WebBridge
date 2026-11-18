/** Multi-site login flow: contract validation and model-menu gating. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSetupCommand } from '../src/setup-contract.js'
import { WebChatAdapter } from '../src/provider.js'
import { SetupBrowser } from '../src/setup-browser.js'

test('loginSite commands carry a validated site key', () => {
  const command = parseSetupCommand({ action: 'loginSite', site: 'bigmodel' })
  assert.equal(command.action, 'loginSite')
  assert.equal(command.site, 'bigmodel')
  assert.equal(parseSetupCommand({ action: 'setDefaultSite', site: 'zai' }).site, 'zai')
  assert.throws(() => parseSetupCommand({ action: 'loginSite', site: 42 }))
  assert.throws(() => parseSetupCommand({ action: 'loginSite' }))
  assert.throws(() => parseSetupCommand({ action: 'setDefaultSite' }))
})

test('a site that is not signed in keeps out of the model menu', async () => {
  const base = {
    providerId: 'webbridge-bigmodel', displayName: 'WebBridge · 智谱体验中心 (GLM-5.3)', modelId: 'bigmodel-web',
    session: {}, settings: { site: 'bigmodel', providers: { contextWindow: 32000 } }, log: () => {},
  }
  const locked = new WebChatAdapter({ ...base, siteAuth: () => 'needs-login' })
  assert.deepEqual(await locked.listModels('webbridge-bigmodel'), [])
  const open = new WebChatAdapter({ ...base, siteAuth: () => 'ready' })
  const models = await open.listModels('webbridge-bigmodel')
  assert.equal(models.length, 1)
  assert.equal(models[0].name, 'WebBridge · 智谱体验中心 (GLM-5.3)')
  assert.equal(models[0].provider, 'webbridge-bigmodel')
})

test('chatgpt keeps its own observe flow and ignores the site gate', async () => {
  const base = {
    providerId: 'webbridge-chatgpt', displayName: 'WebBridge · ChatGPT', modelId: 'chatgpt-web',
    session: {}, settings: { site: 'chatgpt', providers: { contextWindow: 32000 } }, log: () => {},
    accountTier: async () => 'free',
  }
  const adapter = new WebChatAdapter({ ...base, siteAuth: () => 'unknown' })
  const models = await adapter.listModels('webbridge-chatgpt')
  assert.equal(models.length, 2)
  assert.match(models[0].name, /WebBridge · ChatGPT（思考）/)
  assert.match(models[1].name, /WebBridge · ChatGPT（非思考）/)
})

test('a dual-reasoning site lists 思考/非思考 as two models', async () => {
  const adapter = new WebChatAdapter({
    providerId: 'webbridge-deepseek', displayName: 'WebBridge · DeepSeek', modelId: 'deepseek-web',
    session: {}, settings: { site: 'deepseek', providers: { contextWindow: 32000 } }, log: () => {},
    siteAuth: () => 'ready', dualReasoning: true,
  })
  const models = await adapter.listModels('webbridge-deepseek')
  assert.equal(models.length, 2)
  assert.equal(models[0].id, 'deepseek-web')
  assert.match(models[0].name, /WebBridge · DeepSeek（思考）/)
  assert.equal(models[1].id, 'deepseek-web-instant')
  assert.match(models[1].name, /WebBridge · DeepSeek（非思考）/)
})

test('web-site matching and the login probe expression are site-specific', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wb-site-auth-'))
  const browser = new SetupBrowser({
    settings: { stateDir: root, adapterDir: join(root, 'adapters') },
    driver: { context: null, pages: new Map() },
  })
  assert.equal(browser.webSiteMatches('bigmodel', 'https://open.bigmodel.cn/trialcenter'), true)
  assert.equal(browser.webSiteMatches('bigmodel', 'https://chatgpt.com/'), false)
  assert.equal(browser.webSiteMatches('zai', 'https://chat.z.ai/chat'), true)
  assert.equal(browser.webSiteMatches('chatglm', 'https://chatglm.cn/main/all'), true)
  assert.equal(browser.webSiteMatches('zai', 'https://bigmodel.cn/'), false)
  assert.equal(browser.webSiteMatches('deepseek', 'https://chat.deepseek.com/'), true)
  assert.equal(browser.webSiteMatches('kimi', 'https://www.kimi.com/'), true)
  assert.equal(browser.webSiteMatches('kimi', 'https://kimi.moonshot.cn/'), true)
  assert.equal(browser.webSiteMatches('qwen', 'https://chat.qwen.ai/'), true)
  assert.equal(browser.webSiteMatches('qwen', 'https://tongyi.aliyun.com/qianwen/'), true)
  assert.equal(browser.webSiteMatches('duckai', 'https://duckduckgo.com/?q=DuckDuckGo+AI+Chat'), true)
  assert.equal(browser.webSiteMatches('gemini', 'https://gemini.google.com/app'), true)
  assert.equal(browser.webSiteMatches('aistudio', 'https://aistudio.google.com/prompts/new_chat'), true)
  assert.equal(browser.webSiteMatches('deepseek', 'https://chatglm.cn/'), false)
  const expression = browser.siteStatusExpression('bigmodel')
  assert.equal(typeof expression, 'string')
  assert.match(expression, /querySelectorAll/)
  assert.equal(browser.siteStatusExpression('no-such-site'), null)
})
