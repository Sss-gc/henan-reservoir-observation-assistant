import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import ts from 'typescript'
import { buildWeatherSnapshot } from '../weather-worker/src/nmc.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const work = path.join(root, '.tools/mini-static-build')
const output = path.join(root, 'mini-static/dist')
const renderer = path.join(work, 'report')
const require = createRequire(import.meta.url)
await fs.mkdir(renderer, { recursive: true })
await fs.writeFile(path.join(renderer, 'package.json'), '{"type":"commonjs"}')
const template = await fs.readFile(path.join(root, 'src/assets/observation-plan-template.docx'))
for (const name of ['all-reservoir-report', 'document', 'satellite']) {
  let source = await fs.readFile(path.join(root, `src/services/${name}.ts`), 'utf8')
  if (name === 'all-reservoir-report') source = source.replace(/^import templateUrl from .*$/m,
    `const templateUrl = ${JSON.stringify(`data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,${template.toString('base64')}`)}`)
  await fs.writeFile(path.join(renderer, `${name}.js`), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: `${name}.ts`,
  }).outputText)
}
const reservoirs = JSON.parse(await fs.readFile(path.join(root, 'public/data/reservoirs.geojson'), 'utf8')).features.map((f) => f.properties)
const orbitFile = path.join(work, 'orbits.json')
function calculateOrbit() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.MINI_STATIC_PYTHON || 'python', ['-m', 'backend.app.tasks.export_miniprogram_observations', '--output', orbitFile], {
      cwd: root, stdio: 'inherit', env: { ...process.env,
        DATABASE_URL: `sqlite:///${path.join(work, 'observations.db').replaceAll('\\', '/')}`,
        SCHEDULER_ENABLED: 'false',
      },
    })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`独立轨道计算失败（${code}），未发布`)))
  })
}

async function fetchNmc(url, options) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, options)
      if (response.status < 500 || attempt === 1) return response
      await response.body?.cancel()
    } catch (error) { if (attempt === 1) throw error }
    await new Promise((resolve) => setTimeout(resolve, 3000))
    // A fresh timeout is required after an aborted first request.
    options = { ...options, signal: AbortSignal.timeout(20000) }
  }
}
const reuseOrbits = process.argv.includes('--reuse-independent-orbits')
if (reuseOrbits) {
  const cached = JSON.parse(await fs.readFile(orbitFile, 'utf8'))
  const day = (value) => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10)
  if (cached.pipeline !== 'miniprogram-static-independent-v1' || day(cached.generated_at) !== day(new Date().toISOString())) throw new Error('只能复用本任务当日独立计算的轨道结果')
}
console.log('独立获取中央气象台天气并计算小程序轨道；不读取网站接口或网站轨道文件。')
// No stale fallback for publishing: partial failures leave the currently deployed version intact.
const [, snapshot] = await Promise.all([reuseOrbits ? Promise.resolve() : calculateOrbit(),
  buildWeatherSnapshot((ms) => new Promise((resolve) => setTimeout(resolve, ms)), new Date(), null, fetchNmc)])
const orbits = JSON.parse(await fs.readFile(orbitFile, 'utf8'))
if (orbits.pipeline !== 'miniprogram-static-independent-v1' || !orbits.items?.length) throw new Error('独立轨道校验失败')
if (Object.keys(snapshot.reservoirs).length !== reservoirs.length || snapshot.staleReservoirIds.length) throw new Error('独立天气未完整更新，本次不发布')
const weather = { source: snapshot.source, generatedAt: snapshot.generatedAt, pipeline: 'miniprogram-static-independent-v1',
  staleReservoirIds: [], items: Object.fromEntries(Object.entries(snapshot.reservoirs).map(([id, value]) =>
    [id, { source: snapshot.source, ...value, days: value.forecast, cacheStatus: 'static' }])) }
const generatedAt = new Date()
const manifest = { schemaVersion: 'miniprogram-static-v1', pipeline: 'miniprogram-static-independent-v1',
  generatedAt: generatedAt.toISOString(), orbitGeneratedAt: orbits.generated_at, weatherGeneratedAt: weather.generatedAt, documents: {} }
const { createAllReservoirReportBlob, allReservoirReportFileName } = require(path.join(renderer, 'all-reservoir-report.js'))
const { observationPlanFileName } = require(path.join(renderer, 'document.js'))
await fs.mkdir(path.join(output, 'data'), { recursive: true })
await fs.mkdir(path.join(output, 'documents'), { recursive: true })
for (const selected of [reservoirs, ...reservoirs.map((reservoir) => [reservoir])]) {
  const single = selected.length === 1
  const id = single ? selected[0].id : 'all'
  const ids = new Set(selected.map((r) => r.id))
  const items = orbits.items.filter((item) => ids.has(item.reservoir_id))
  const blob = await createAllReservoirReportBlob({ reservoirs: selected,
    orbitPayload: { ...orbits, items, item_count: items.length }, weatherByReservoir: weather.items, generatedAt,
    ...(single ? { reportTitle: `${selected[0].name_cn}未来7天晴天实验方案` } : {}),
  })
  const filePath = `/documents/${id}.docx`
  const bytes = Buffer.from(await blob.arrayBuffer())
  await fs.writeFile(path.join(output, filePath), bytes)
  manifest.documents[id] = { path: filePath, bytes: bytes.length,
    fileName: single ? observationPlanFileName(selected[0].name_cn, generatedAt) : allReservoirReportFileName(generatedAt) }
}
await fs.writeFile(path.join(output, 'data/orbits.json'), JSON.stringify(orbits))
await fs.writeFile(path.join(output, 'data/weather.json'), JSON.stringify(weather))
await fs.writeFile(path.join(output, 'data/manifest.json'), JSON.stringify(manifest))
console.log(JSON.stringify({ generatedAt: manifest.generatedAt, windows: orbits.items.length,
  reservoirs: reservoirs.length, documents: Object.keys(manifest.documents).length, output }))
