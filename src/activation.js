import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Activation self-report.
 *
 * A Host plugin has no console the user can easily read, and the agent cannot
 * call its own freshly registered tools in the session that registered them.
 * Writing one JSON file at activation gives us a verifiable channel: it proves
 * the plugin loaded, whether the browser driver is reachable, and what the tool
 * registry actually exposes to `ctx.tools.schemas()`.
 */
export function writeActivation({ settings, ctx, driver, bridge, toolScope, error }) {
  const report = {
    at: new Date().toISOString(),
    version: settings.version,
    profile: settings.browserProfileDir,
    debugMode: Boolean(driver?.debugMode),
    site: settings.site,
    driver: { type: 'native-playwright', profileDir: driver?.profileDir, available: Boolean(driver?.available) },
    registry: null,
    mcp: { enabled: Boolean(settings.mcp?.enabled), port: settings.mcp?.port },
    error: error ? String(error.message || error) : null,
  }

  try {
    const globalSchemas = ctx.tools.schemas() || []
    const allSchemas = toolScope ? toolScope.schemas() : globalSchemas
    report.registry = {
      ok: true,
      globalCount: globalSchemas.length,
      totalCount: allSchemas.length,
      agentScopes: toolScope?.agentCount ?? 0,
      sample: globalSchemas.slice(0, 40).map((schema) => schema.name),
      extraSample: allSchemas
        .filter((schema) => !globalSchemas.some((global) => global.name === schema.name))
        .slice(0, 20)
        .map((schema) => schema.name),
      hasWebbridge: allSchemas.some((schema) => String(schema.name).startsWith('webbridge_')),
    }
  } catch (err) {
    report.registry = { ok: false, error: String(err.message || err) }
  }

  try {
    if (bridge) report.mcp.status = bridge.status?.() ?? null
  } catch {}

  try {
    mkdirSync(settings.stateDir, { recursive: true })
    writeFileSync(join(settings.stateDir, 'activation.json'), JSON.stringify(report, null, 2), 'utf8')
  } catch {}
  return report
}
