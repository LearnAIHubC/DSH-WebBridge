import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserDriver } from '../src/driver.js'
import { SetupControls } from '../src/setup-controls.js'

const root = await mkdtemp(join(tmpdir(), 'wb-setup-controls-'))
const driver = new BrowserDriver({ stateDir: root, browserProfileDir: join(root, 'profile') })
try {
  const page = await driver.currentPage()
  const controls = new SetupControls(driver)
  await page.setContent('<button onclick="window.deleted=true">Uninstall</button><button onclick="window.refreshed=true;this.disabled=true;setTimeout(()=>this.disabled=false,50)">Refresh tools</button><script>document.querySelectorAll("button")[1].__reactProps$test={children:{props:{id:"browserPluginSettings.refreshActions"}}}</script>')
  await controls.refresh()
  assert.equal(await page.evaluate(() => window.refreshed), true)
  await assert.rejects(controls.click('button', '检查重复控件'), error => error.code === 'setup-ui-changed')
  assert.equal(await page.evaluate(() => Boolean(window.deleted)), false)
  console.log('SETUP_CONTROLS_SMOKE_OK: tool refresh clicks only the rendered action id')
} finally { await driver.stop(); await rm(root, { recursive: true, force: true }) }
