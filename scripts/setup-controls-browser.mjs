import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserDriver } from '../src/driver.js'
import { SetupBrowser } from '../src/setup-browser.js'
import { SetupControls } from '../src/setup-controls.js'

const root = await mkdtemp(join(tmpdir(), 'wb-setup-controls-'))
const driver = new BrowserDriver({ stateDir: root, browserProfileDir: join(root, 'profile') })
try {
  const page = await driver.currentPage()
  const controls = new SetupControls(driver)
  await page.setContent(`<main><button aria-haspopup="menu" onclick="document.querySelector('[role=menu]').hidden=false">Add</button></main>
    <div role="menu" hidden><button role="menuitem">Create plugin</button><button role="menuitem" onclick="throw new Error('archive upload must not be clicked')">Upload plugin archive</button><button role="menuitem" onclick="document.querySelector('[role=dialog]').hidden=false;this.parentElement.hidden=true"><svg viewBox="0 0 24 24"><path d="M11.0514 2.79347C12 1 14 1 16 2"></path></svg>Add custom MCP server</button></div>
    <div role="dialog" hidden><form onsubmit="event.preventDefault();window.submitted=true;this.innerHTML='<button type=button>Nexus DSH</button>'">
      <label>Name<input required></label><label>Description<textarea rows="1"></textarea></label>
      <fieldset><button type="button">Server URL</button><button type="button" onclick="this.parentElement.querySelector('input').outerHTML='<input required placeholder=tunnel_...>'">Tunnel</button><input type="url" required></fieldset>
      <select onchange="window.authMode=this.value"><option value="OAUTH">OAuth</option><option value="NONE">None</option></select>
      <button type="button" role="checkbox" aria-checked="false" onclick="this.setAttribute('aria-checked','true')">I trust this server</button>
      <button type="submit">Create as a plugin</button></form></div>`)
  const browser = new SetupBrowser({ settings: { stateDir: root }, driver })
  let lookup = 0
  browser.findPlugins = async () => ++lookup === 1 ? [] : [{ id: 'plugin_local_test' }]
  browser.open = async () => ({})
  browser.allowAll = async () => {}
  browser.refresh = async () => {}
  assert.equal(await browser.install('tunnel_local_test'), 'plugin_local_test')
  assert.equal(await page.evaluate(() => window.submitted), true)
  assert.equal(await page.evaluate(() => window.authMode), 'NONE')
  await page.setContent('<input id="plugins-store-page-search"><aside><a href="/plugins/plugin_same" aria-label="Nexus DSH">Nexus DSH</a></aside><main><a href="/plugins/plugin_same" aria-label="Nexus DSH">Nexus DSH</a></main>')
  const search = new SetupBrowser({ settings: { stateDir: root }, driver })
  search.open = async () => ({})
  assert.deepEqual(await search.findPlugins(), [{ href: '/plugins/plugin_same', id: 'plugin_same' }])

  await page.setContent(`<div role="dialog"><button role="combobox" onclick="show('expiry')">Expires</button><button role="combobox" onclick="show('project')">Select project</button><button role="combobox" onclick="show('scope')">Tunnels</button>
    <button role="radio" value="all">All</button><button role="radio" value="restricted" onclick="window.restricted=true">Restricted</button><button role="radio" value="readonly">Read only</button></div>
    <script>window.selected=[];function show(kind){document.querySelector('#options')?.remove();const box=document.createElement('div');box.id='options';
    const choices=kind==='expiry'?[['1','1 day'],['never','Never']]:kind==='project'?[['proj_123','Default project']]:[['api.organization.tunnel.read','Read'],['api.organization.tunnel.use','Use']];
    for(const [id,text] of choices){const e=document.createElement('div');e.setAttribute('role','option');e.setAttribute('data-option-id',id);e.setAttribute('aria-selected','false');e.textContent=text;e.onclick=()=>{selected.push(id);e.setAttribute('aria-selected','true');if(kind!=='scope')box.remove()};box.append(e)}document.body.append(box)}
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){const box=document.querySelector('#options');if(box)box.remove();else document.querySelector('[role=dialog]').remove()}})</script>`)
  await controls.chooseOptions(null, { text: 'Default project' })
  await controls.chooseOptions(['never'])
  await controls.restrictedKey()
  await controls.chooseOptions(['api.organization.tunnel.read', 'api.organization.tunnel.use'])
  assert.deepEqual(await page.evaluate(() => window.selected), ['proj_123', 'never', 'api.organization.tunnel.read', 'api.organization.tunnel.use'])
  assert.equal(await page.locator('[role="dialog"]').count(), 1)
  assert.equal(await page.evaluate(() => window.restricted), true)

  await page.setContent('<button role="radio" value="full_access" onclick="this.setAttribute(\'aria-checked\',\'true\')">Allow all tools</button><button role="radio" value="always_ask">Ask every time</button>')
  assert.equal(await (await controls.allowAll()).getAttribute('aria-checked'), 'true')
  await page.setContent('<button role="radio" value="unrecognized">Allow all tools</button>')
  await assert.rejects(() => controls.allowAll(), error => error.code === 'setup-ui-changed')
  await page.setContent('<button onclick="window.deleted=true">Uninstall</button><button onclick="window.refreshed=true;this.disabled=true;setTimeout(()=>this.disabled=false,50)">Refresh tools</button><script>document.querySelectorAll("button")[1].__reactProps$test={children:{props:{id:"browserPluginSettings.refreshActions"}}}</script>')
  await controls.refresh()
  assert.equal(await page.evaluate(() => window.refreshed), true)
  assert.equal(await page.evaluate(() => Boolean(window.deleted)), false)
  await page.setContent('<div role="dialog"><button type="submit">Create</button><button type="submit">Create another</button></div>')
  await assert.rejects(() => controls.submit('提交测试'), error => error.code === 'setup-ui-changed')

  for (const label of ['Create tunnel', 'Create a tunnel', 'New tunnel', '新建隧道']) {
    await page.setContent(`<main><button type="button" onclick="document.querySelector('[role=dialog]').hidden=false">${label}</button>
      <button type="button" onclick="window.unrelatedClicked=true">Unrelated</button></main>
      <div role="dialog" hidden><input placeholder="Tunnel name"></div>`)
    await controls.primaryDialog('打开隧道创建表单')
    assert.equal(await page.locator('[role="dialog"]').isVisible(), true, label)
    assert.notEqual(await page.evaluate(() => window.unrelatedClicked), true, label)
  }
  await page.setContent('<main><button>Create tunnel</button><button>New tunnel</button></main>')
  await assert.rejects(() => controls.primaryDialog('打开隧道创建表单'), error => error.code === 'setup-ui-changed')
  await page.setContent('<main><p>Tunnels access required</p></main>')
  await assert.rejects(() => controls.primaryDialog('打开隧道创建表单'), error => error.code === 'setup-tunnel-permission')
  console.log('SETUP_CONTROLS_SMOKE_OK: tunnel button variants, permissions, internal option IDs, scoped submissions, and ambiguity rejection')
} finally { await driver.stop(); await rm(root, { recursive: true, force: true }) }
