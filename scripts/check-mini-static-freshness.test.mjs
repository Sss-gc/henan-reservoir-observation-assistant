import assert from 'node:assert/strict'
import { test } from 'vitest'
import { hasCurrentBatch, needsRefresh } from './check-mini-static-freshness.mjs'

const now = new Date('2026-10-18T01:45:00Z')
const manifest = () => ({
  pipeline: 'miniprogram-static-independent-v1',
  generatedAt: '2026-10-18T01:20:00Z', weatherGeneratedAt: '2026-10-18T01:16:00Z',
  orbitGeneratedAt: '2026-10-18T09:19:00+08:00',
  documents: Object.fromEntries(Array.from({ length: 26 }, (_, i) => [String(i), {}])),
})

test('fresh complete batch skips a scheduled recovery run', async () => {
  assert.equal(await needsRefresh('schedule', async () => ({ ok: true, json: async () => manifest() }), now), false)
})
test('stale weather or orbits still require an update even if manifest was written today', () => {
  for (const field of ['generatedAt', 'weatherGeneratedAt', 'orbitGeneratedAt']) {
    assert.equal(hasCurrentBatch({ ...manifest(), [field]: '2026-10-17T15:59:59Z' }, now), false)
  }
})
test('freshness uses the Beijing date across the UTC day boundary', () => {
  const batch = { ...manifest(), generatedAt: '2026-10-17T16:01:00Z',
    weatherGeneratedAt: '2026-10-17T16:00:00Z', orbitGeneratedAt: '2026-10-18T00:00:00+08:00' }
  assert.equal(hasCurrentBatch(batch, now), true)
})
test('invalid dates, wrong pipeline or incomplete documents require recovery', () => {
  for (const batch of [null, {}, { ...manifest(), weatherGeneratedAt: 'invalid' },
    { ...manifest(), pipeline: 'website' }, { ...manifest(), documents: {} }]) {
    assert.equal(hasCurrentBatch(batch, now), false)
  }
})
test('network, HTTP and JSON errors do not suppress recovery', async () => {
  for (const fetcher of [async () => { throw new Error('timeout') },
    async () => ({ ok: false }), async () => ({ ok: true, json: async () => { throw new Error('invalid JSON') } })]) {
    assert.equal(await needsRefresh('schedule', fetcher, now), true)
  }
})
test('manual dispatch always regenerates without depending on the published endpoint', async () => {
  assert.equal(await needsRefresh('workflow_dispatch', async () => { throw new Error('must not fetch') }, now), true)
})
