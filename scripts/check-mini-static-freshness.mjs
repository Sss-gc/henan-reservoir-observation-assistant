import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const { serviceBaseUrl } = createRequire(import.meta.url)('../miniprogram/config.js')
const beijingDay = (value) => {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time + 8 * 3600000).toISOString().slice(0, 10) : ''
}

export function hasCurrentBatch(manifest, now = new Date()) {
  const today = beijingDay(now.toISOString())
  return manifest?.pipeline === 'miniprogram-static-independent-v1' &&
    [manifest.generatedAt, manifest.weatherGeneratedAt, manifest.orbitGeneratedAt]
      .every((value) => beijingDay(value) === today) &&
    Object.keys(manifest.documents || {}).length === 26
}

export async function needsRefresh(eventName, fetcher = fetch, now = new Date()) {
  // Manual runs deliberately regenerate even when today's batch already exists.
  if (eventName !== 'schedule') return true
  try {
    const response = await fetcher(`${serviceBaseUrl}/data/manifest.json?check=${now.getTime()}`, {
      signal: AbortSignal.timeout(20000), headers: { 'Cache-Control': 'no-cache' },
    })
    return !response.ok || !hasCurrentBatch(await response.json(), now)
  } catch {
    // An unavailable or invalid manifest must not suppress the recovery run.
    return true
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const refresh = await needsRefresh(process.env.GITHUB_EVENT_NAME)
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `refresh=${refresh}\n`)
  console.log(refresh ? '今日独立数据待更新，执行生成和发布。' : '今日天气、轨道及26份Word已发布，跳过重复生成。')
}
