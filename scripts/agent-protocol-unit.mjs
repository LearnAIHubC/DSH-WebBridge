/** The text-protocol catalog must expose real parameters for both schema shapes. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToolList, composeMessage, renderToolResult } from '../src/agent.js'

test('a JSON-Schema tool exposes its real parameters, not the wrapper keys', () => {
  const rendered = JSON.parse(renderToolList([{
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  }]))
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].name, 'write')
  // The wrapper keys must never leak in as parameters.
  assert.deepEqual(Object.keys(rendered[0].parameters).sort(), ['content', 'path'])
  assert.equal(rendered[0].parameters.path.type, 'string')
  assert.equal(rendered[0].parameters.path.required, true)
  assert.equal(rendered[0].parameters.content.required, true)
})

test('the flat DSL form keeps rendering compactly', () => {
  const rendered = JSON.parse(renderToolList([{
    name: 'probe',
    description: 'Probe things.',
    parameters: { selector: { type: 'string', description: 'A selector.', required: true } },
  }]))
  assert.deepEqual(Object.keys(rendered[0].parameters), ['selector'])
  assert.equal(rendered[0].parameters.selector.type, 'string')
  assert.equal(rendered[0].parameters.selector.required, true)
})

test('the protocol prompt teaches the exact reply shapes with a worked example', () => {
  const message = composeMessage({
    task: '示例任务',
    toolDefs: [{
      name: 'write',
      description: 'Create or fully replace a UTF-8 text file.',
      parameters: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'Path.' }, content: { type: 'string', description: 'Text.' } },
        required: ['file_path', 'content'],
      },
    }],
  })
  assert.match(message, /cannot touch this machine/)
  // Both output contracts are taught, not implied.
  assert.match(message, /<<<TOOL_CALLS>>>/)
  assert.match(message, /<<<END_TOOL_CALLS>>>/)
  assert.match(message, /<<<FINAL>>>/)
  assert.match(message, /<<<END_FINAL>>>/)
  // A copyable example built from the real first tool.
  assert.match(message, /\[\{"name":"write","arguments":\{"file_path":"<string>","content":"<string>"\}\}\]/)
})

test('tool results never leak harness context updates to the web chat', () => {
  const rendered = renderToolResult({ id: '1.1', name: 'write', ok: true, body: 'created\n[DSH context updates] { "messages": [ ... ] }' })
  assert.match(rendered, /created/)
  assert.doesNotMatch(rendered, /DSH context updates/)
})
