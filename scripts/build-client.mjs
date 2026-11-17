import { readFile, writeFile } from 'node:fs/promises'
const contracts = (await readFile(new URL('../src/setup-contract.js', import.meta.url), 'utf8')).replace(/^export /gm, '')
const client = (await readFile(new URL('../src/client.js', import.meta.url), 'utf8'))
  .replace(/^import React from 'react'\r?\n/, 'const React = require("react");\n')
  .replace(/^import \{ setupRemote \} from '.\/setup-contract.js'\r?\n/m, '')
  .replace(/^export /gm, '')
await writeFile(new URL('../client.js', import.meta.url), `window.__ModuleLoader__.load({ id: "@local/dsh-webbridge", factory: (require) => {\n${contracts}\n${client}\nreturn {apply,inject};\n} });\n`)
