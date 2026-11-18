/** webbridge-cli pure parts: the explore expression reports evidence per element. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { exploreExpression } from './webbridge-expressions.mjs'

test('the explore expression probes every channel diagnosis surface', () => {
  const expression = exploreExpression()
  assert.equal(typeof expression, 'string')
  for (const marker of ['composers', 'nearComposer', 'sendCandidates', 'stopCandidates', 'replyContainers', 'loginControls', 'loginWall', 'modelCode']) {
    assert.ok(expression.includes(marker), `missing ${marker}`)
  }
  // Login-wall matching covers the /login and /sign_in variants.
  assert.ok(expression.includes('/login'))
  assert.ok(expression.includes('sign[-_]?in'))
  // Every candidate carries a unique-selector suggestion, so the AI can act
  // on the evidence without generating anything itself.
  assert.ok(expression.includes('const suggest ='))
  assert.ok(expression.includes('submit'))
})
