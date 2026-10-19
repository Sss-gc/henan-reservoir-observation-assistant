import assert from 'node:assert/strict'
import { test } from 'vitest'
import { hasCurrentBatch, hasCurrentWeather, needsRefresh } from './check-mini-static-freshness.mjs'

const now = new Date('2026-10-18T01:45:00Z')
const manifest = () => ({
  pipeline: 'miniprogram-static-independent-v1',
  generatedAt: '2026-10-18T01:20:00Z', weatherGeneratedAt: '2026-10-18T01:16:00Z',
  orbitGeneratedAt: '2026-10-18T09:19:00+08:00',
  documents: Object.fromEntries(Array.from({ length: 26 }, (_, i) => [String(i), {}])),
})
const weather = (publishedAt = '2026-10-18T08:00:00+08:00') => ({
  pipeline: 'miniprogram-static-independent-v1', source: '中央气象台', generatedAt: '2026-10-18T01:16:00Z',
  items: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [String(i), {
    fetchedAt: '2026-10-18T01:16:00Z', publishedAt, cacheStatus: 'static',
    days: Array.from({ length: 7 }, (_, day) => ({ date: `2026-10-${String(18 + day).padStart(2, '0')}` })),
  }])),
})
const response = (value, ok = true) => ({ ok, json: async () => value })
const service = (manifestValue = manifest(), weatherValue = weather()) => async (url) =>
  url.includes('/manifest.json') ? response(manifestValue) : response(weatherValue)

test('fresh complete batch skips a scheduled recovery run', async () => {
  assert.equal(await needsRefresh('schedule', service(), now), false)
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
test('weather freshness requires all 25 stations to be fetched and published today', () => {
  assert.equal(hasCurrentWeather(weather(), now), true)
  assert.equal(hasCurrentWeather(weather('2026-10-17T18:00:00+08:00'), now), false)
  assert.equal(hasCurrentWeather({ ...weather(), items: {} }, now), false)
})
test('an early fresh batch waits for the NMC morning release, then retries old publication dates', async () => {
  const oldWeather = weather('2026-10-17T18:00:00+08:00')
  assert.equal(await needsRefresh('schedule', service(manifest(), oldWeather), new Date('2026-10-17T23:17:00Z')), false)
  assert.equal(await needsRefresh('schedule', service(manifest(), oldWeather), now), true)
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
