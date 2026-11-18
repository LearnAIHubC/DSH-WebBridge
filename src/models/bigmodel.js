import { BridgeError } from '../envelope.js'
import { SITE_PRESETS } from '../config.js'
import { paidModelKey } from './chatgpt.js'

/**
 * 智谱体验中心 channel model source. The trial page pins its model in the
 * URL (`…?modelCode=glm-5.3`), so the catalog is derived from the address
 * without touching the page. The in-page model picker (the chatgpt.js
 * trigger→open→names pattern) lands here once its DOM is calibrated on the
 * live page; until then select() accepts only the model the current
 * conversation already uses and never switches silently.
 */
export class BigmodelTrialModels {
  constructor({ settings, driver, log = () => {}, onChange = () => {} }) {
    this.settings = settings; this.driver = driver; this.log = log; this.onChange = onChange
    this.checkedAt = 0
    this.catalog = []
  }

  #defaultCode() {
    try { return new URL(SITE_PRESETS.bigmodel.url).searchParams.get('modelCode') || 'glm-5.3' } catch { return 'glm-5.3' }
  }

  /** Current modelCode: the live page when it is on bigmodel, else the preset URL. */
  async currentModelCode() {
    try {
      if (this.driver.context && this.driver.pages?.size) {
        const state = await this.driver.state()
        const url = new URL(state.url || 'about:blank')
        if (url.hostname === 'bigmodel.cn' || url.hostname.endsWith('.bigmodel.cn')) {
          const code = url.searchParams.get('modelCode')
          if (code) return code
        }
      }
    } catch {}
    return this.#defaultCode()
  }

  async list() {
    const code = await this.currentModelCode()
    const modelName = code.toUpperCase()
    this.checkedAt = Date.now()
    if (this.catalog[0]?.modelName !== modelName) {
      this.catalog = [{ key: paidModelKey(modelName, 0), modelName, power: 0, label: modelName, effort: '', preferred: true }]
      Promise.resolve().then(() => this.onChange()).catch(() => this.log('[webbridge:models] bigmodel model-change notification failed'))
    }
    return this.catalog
  }

  async select(choice) {
    const code = await this.currentModelCode()
    if (String(choice?.modelName || '').toLowerCase() !== code.toLowerCase()) {
      throw new BridgeError('model-unavailable', `当前智谱体验会话使用 ${code.toUpperCase()}；如需其它模型，请先在网页中打开对应模型的体验页。`)
    }
    return { modelName: choice.modelName, label: choice.label || code.toUpperCase(), power: 0 }
  }
}
