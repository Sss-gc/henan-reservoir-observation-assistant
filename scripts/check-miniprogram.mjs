import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DOMParser } from '@xmldom/xmldom'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url)), mini = path.join(root, 'miniprogram')
const require = createRequire(path.join(mini, 'package.json'))
const sourceReservoirs = JSON.parse(fs.readFileSync(path.join(root, 'public/data/reservoirs.geojson'), 'utf8'))
const sourceOrbit = JSON.parse(fs.readFileSync(path.join(root, 'public/data/orbit-passes.json'), 'utf8'))
const config = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'))
const firstDate = sourceOrbit.items.map((p) => p.date).sort()[0]
const fixtureNow = Date.parse(`${firstDate}T12:00:00+08:00`)
const originalNow = Date.now
Date.now = () => fixtureNow
let checks = 0, weatherFailure = false, orbitFailure = false, unauthorized = false
const calls = { requests: [], downloads: [], clipboard: [], navigation: [], storage: new Map(), map: [] }
// All artificial weather lives in this test fixture, never in the mini program.
const fixtureWeather = Object.fromEntries(sourceReservoirs.features.map(({ properties: p }) => [p.id, {
  source: '中央气象台', sourceUrl: 'https://www.nmc.cn/test-fixture', stationName: p.city,
  publishedAt: `${firstDate}T08:00:00+08:00`, fetchedAt: sourceOrbit.generated_at, cacheStatus: 'kv',
  days: Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.parse(firstDate) + i * 86400000).toISOString().slice(0, 10),
    dayCondition: i % 3 === 1 ? '多云' : '晴', nightCondition: '多云' })),
}]))
const wx = {
  getStorageSync: (key) => calls.storage.get(key), setStorageSync: (key, value) => calls.storage.set(key, value),
  removeStorageSync: (key) => calls.storage.delete(key), stopPullDownRefresh() {}, showToast() {},
  setClipboardData: ({ data }) => calls.clipboard.push(data),
  navigateTo: ({ url }) => calls.navigation.push(url), switchTab: ({ url }) => calls.navigation.push(url),
  reLaunch: ({ url }) => calls.navigation.push(url), getWindowInfo: () => ({ pixelRatio: 2 }),
  createMapContext: (id, component) => {
    calls.map.push({ action: 'create', id, component })
    return { includePoints: (options) => calls.map.push({ action: 'include', ...options }),
      getScale: ({ success }) => success({ scale: 12 }) }
  },
  request(options) {
    calls.requests.push(options)
    queueMicrotask(() => {
      if (options.url.endsWith('/api/session')) {
        options.success({ statusCode: 200, data: { token: 'test-only-signed-session', expiresAt: fixtureNow + 86400000 } }); return
      }
      if (unauthorized) { options.success({ statusCode: 401, data: { error: 'UNAUTHORIZED' } }); return }
      if (options.url.includes('/api/weather')) {
        options.success({ statusCode: weatherFailure ? 503 : 200, data: weatherFailure ? { error: 'weather unavailable' } :
          { source: '中央气象台', generatedAt: sourceOrbit.generated_at, items: fixtureWeather } }); return
      }
      options.success({ statusCode: orbitFailure ? 503 : 200, data: orbitFailure ? { error: 'orbit unavailable' } : sourceOrbit })
    })
  },
  downloadFile(options) { calls.downloads.push(options); throw new Error('原生地图不应通过wx.downloadFile下载瓦片') },
}
globalThis.wx = wx
const data = require('./utils/data.js'), network = require('./utils/network.js')
function filesIn(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? filesIn(path.join(dir, e.name)) : [path.join(dir, e.name)]) }
async function check(name, action) { await action(); checks++; console.log(`✓ ${name}`) }
let app
function definition(relative, kind) {
  let result
  const filename = path.join(mini, relative)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: createRequire(filename), wx, getApp: () => app,
    [kind]: (value) => { result = value } }, { filename })
  assert.ok(result); return result
}
app = definition('app.js', 'App')
function page(relative) {
  const value = definition(`${relative}.js`, 'Page')
  const result = { ...value, data: JSON.parse(JSON.stringify(value.data)) }
  result.setData = function (values, callback) { Object.assign(this.data, values); if (callback) callback() }
  result.selectComponent = () => ({ fitCurrent: () => calls.map.push('fit'), overview: () => calls.map.push('overview') })
  return result
}
const event = (dataset) => ({ currentTarget: { dataset } })

await check('5个页面和原生地图组件配置、WXML及事件绑定完整', () => {
  assert.equal(config.pages.length, 5)
  const project = JSON.parse(fs.readFileSync(path.join(mini, 'project.config.json'), 'utf8'))
  assert.match(project.appid, /^wx[a-f0-9]{16}$/); assert.equal(project.setting.urlCheck, true)
  for (const tab of config.tabBar.list) assert.ok(config.pages.includes(tab.pagePath))
  for (const relative of [...config.pages, 'components/reservoir-map/reservoir-map']) {
    const component = relative.startsWith('components/')
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) assert.ok(fs.existsSync(path.join(mini, relative + ext)))
    JSON.parse(fs.readFileSync(path.join(mini, relative + '.json'), 'utf8'))
    const value = definition(relative + '.js', component ? 'Component' : 'Page')
    const template = fs.readFileSync(path.join(mini, relative + '.wxml'), 'utf8')
    const parser = new DOMParser({ onError: (level, message) => { throw new Error(`${relative}: ${level}: ${message}`) } })
    const doc = parser.parseFromString(`<root xmlns:wx="https://weixin.qq.com/wxml" xmlns:bind="https://weixin.qq.com/bind">${template}</root>`, 'application/xml')
    for (const element of Array.from(doc.getElementsByTagName('*'))) for (const attr of Array.from(element.attributes)) {
      if (/^(bind|catch)/.test(attr.name)) assert.equal(typeof (component ? value.methods : value)[attr.value], 'function', `${relative}: ${attr.value}`)
    }
  }
})
await check('所有JS语法与微信wcc/wcsc模板编译通过', () => {
  for (const file of filesIn(mini).filter((f) => f.endsWith('.js'))) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const compilerPath = path.join(root, '.tools/miniprogram-validation/node_modules/miniprogram-compiler')
  if (fs.existsSync(compilerPath)) {
    const compiler = require(compilerPath)
    for (const name of ['wxmlToJs', 'wxssToJs']) { const result = compiler[name](mini); assert.ok(result); new Function('global', result) }
  } else console.log('· 未安装可选wcc/wcsc，请在开发者工具中编译。')
})
await check('推荐算法与网站一致，25座水库完整保留原始边界和面积', () => {
  for (const name of ['recommendation', 'satellite']) {
    const source = fs.readFileSync(path.join(root, `src/services/${name}.ts`), 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS }, fileName: `${name}.ts` }).outputText
    assert.equal(fs.readFileSync(path.join(mini, `utils/${name}.js`), 'utf8'), `// Generated from src/services/${name}.ts.\n${compiled}`)
  }
  assert.equal(data.getReservoirList().length, 25)
  for (const feature of sourceReservoirs.features) {
    const item = data.getReservoir(feature.properties.id)
    assert.equal(item.area_km2, feature.properties.area_km2); assert.equal(item.lon, feature.properties.lon)
    const rings = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : feature.geometry.coordinates.flat()
    assert.equal(item.rings.length, rings.length)
    item.rings.forEach((ring, i) => assert.equal(ring.length, rings[i].length))
  }
  assert.ok(Math.min(...data.getMapData('HN_RSV_024').rings.flat().map((p) => p[1])) < 32.39)
})
await check('无登录先跳转、使用网站登录接口且仅保存会话', async () => {
  data.reset(); assert.equal(data.getPasses('HN_RSV_001').length, 0); assert.equal(data.getWeather('HN_RSV_001'), null)
  assert.equal(network.requireLogin(), false); assert.equal(calls.navigation.at(-1), '/pages/login/login')
  await network.login('test@example.com', 'test-only-password')
  assert.ok(network.getSession()); assert.doesNotMatch(JSON.stringify([...calls.storage]), /test-only-password/)
  await Promise.all([data.refresh(), data.refresh()])
  assert.equal(calls.requests.filter((r) => r.url.endsWith('/data/orbit-passes.json')).length, 1)
  assert.equal(calls.requests.filter((r) => r.url.includes('/api/weather?all=1')).length, 1)
  assert.ok(calls.requests.at(-1).header.Authorization.startsWith('Bearer '))
  assert.equal(data.meta.orbitGeneratedAt, sourceOrbit.generated_at)
})
await check('真实数据响应与网站推荐一致，无天气不生成晴天窗口', async () => {
  const { buildExperimentRecommendation } = require('./utils/recommendation.js')
  for (const r of data.getReservoirList()) {
    assert.equal(data.getWeatherCards(r.id).length, 7)
    for (const p of data.getPasses(r.id)) {
      const expected = buildExperimentRecommendation(p, fixtureWeather[r.id])
      assert.equal(p.level, expected.level); assert.equal(p.score, expected.score === null ? '—' : expected.score)
      assert.ok(sourceOrbit.items.some((source) => source.id === p.id && source.time_utc === p.time_utc && source.glint_angle_deg === p.glint_angle_deg))
    }
  }
  weatherFailure = true; await data.refresh(true)
  assert.equal(data.getWeather('HN_RSV_001'), null); assert.equal(data.getBestPasses('HN_RSV_001').length, 0)
  assert.ok(data.meta.weatherError); assert.ok(data.getPasses('HN_RSV_001').every((p) => p.level === '待预报'))
  weatherFailure = false; orbitFailure = true; await data.refresh(true)
  assert.equal(data.getPasses('HN_RSV_001').length, 0); assert.ok(data.meta.orbitError)
  orbitFailure = false; await data.refresh(true)
})
await check('首页搜索切换、筛选分页、详情与方案复制使用同一份数据', async () => {
  app.onLaunch(); const home = page('pages/dashboard/dashboard')
  home.onLoad({}); await home.onShow(); assert.equal(home.data.passes.length, 10)
  home.loadMore(); assert.equal(home.data.passes.length, 20)
  home.onSearch({ detail: { value: '丹江' } }); assert.equal(home.data.filteredReservoirs.length, 1)
  home.selectReservoir(event({ id: 'HN_RSV_024' })); home.selectSatellite(event({ name: 'Sentinel-2C' }))
  assert.ok(home.data.passes.every((p) => p.satellite === 'Sentinel-2C'))
  home.selectPassFilter(event({ name: '待预报' })); const id = home.data.passes[0].id
  home.openPass(event({ id })); assert.equal(new URL(calls.navigation.at(-1), 'https://test').searchParams.get('id'), id)
  home.overviewMap(); assert.equal(calls.map.at(-1), 'overview')
  home.selectMarker({ detail: { reservoirId: 'HN_RSV_001' } }); assert.equal(home.data.selected.id, 'HN_RSV_001')
  await home.onPullDownRefresh()
  const detail = page('pages/pass/pass'); await detail.onLoad({ id }); assert.equal(detail.data.pass.id, id)
  detail.copyWindow(); assert.match(calls.clipboard.at(-1), /中央气象台/); assert.doesNotMatch(calls.clipboard.at(-1), /示例|预览/)
  detail.openPlan(); const plan = page('pages/plan/plan'); await plan.onShow()
  plan.selectScope(event({ scope: '全部水库' })); plan.copyPlan()
  assert.equal(plan.data.groups.map((g) => g.name).join(','), 'Sentinel,HJ,Landsat,GF / Gaofen')
  const keys = plan.data.groups.flatMap((g) => g.records.map((p) => `${p.reservoir_id}|${p.date}|${p.satellite}`))
  assert.equal(new Set(keys).size, keys.length); assert.doesNotMatch(calls.clipboard.at(-1), /示例|预览/)
  await detail.onLoad({ id: 'not-found' }); assert.equal(detail.data.notFound, true)
})
await check('腾讯地图显示坐标转换正确，原始边界及面积保持不变', () => {
  const { wgs84ToGcj02 } = require('./utils/map-coordinates.js')
  const beijing = wgs84ToGcj02(116.397128, 39.916527)
  assert.ok(Math.abs(beijing.longitude - 116.40337249402477) < 1e-8)
  assert.ok(Math.abs(beijing.latitude - 39.91793074924595) < 1e-8)
  assert.deepEqual(wgs84ToGcj02(-74, 40), { longitude: -74, latitude: 40 })
  const value = definition('components/reservoir-map/reservoir-map.js', 'Component')
  for (const reservoir of data.getReservoirList()) {
    const source = data.getMapData(reservoir.id), before = JSON.stringify(source)
    const map = { ...value.methods, properties: { mapData: source }, data: {},
      setData(values, callback) { Object.assign(this.data, values); if (callback) callback() },
    }
    value.lifetimes.ready.call(map)
    assert.equal(JSON.stringify(source), before); assert.equal(data.getReservoir(reservoir.id).area_km2, reservoir.area_km2)
    assert.equal(map.data.polyline.length, source.rings.length)
    map.data.polyline.forEach((line, i) => assert.equal(line.points.length, source.rings[i].length))
    const [sw, ne] = map._currentBounds
    for (const line of map.data.polyline) for (const p of line.points) {
      assert.ok(p.longitude >= sw.longitude && p.longitude <= ne.longitude && p.latitude >= sw.latitude && p.latitude <= ne.latitude)
    }
    assert.ok(Buffer.byteLength(JSON.stringify(map.data)) < 1024 * 1024, '原生地图setData应低于1MiB')
    value.lifetimes.detached.call(map)
  }
})
await check('原生地图标记切换、当前/全部视野和缩放工作，不调用瓦片代理或使用Key', () => {
  const value = definition('components/reservoir-map/reservoir-map.js', 'Component'), events = []
  const map = { ...value.methods, properties: { mapData: data.getMapData('HN_RSV_024') }, data: {},
    setData(values, callback) { Object.assign(this.data, values); if (callback) callback() },
    triggerEvent(name, detail) { events.push({ name, detail }) },
  }
  value.lifetimes.ready.call(map)
  assert.equal(calls.map.at(-2).id, 'native-map'); assert.equal(calls.map.at(-2).component, map)
  assert.deepEqual(calls.map.at(-1).points, map._currentBounds)
  assert.ok(map._currentBounds[0].latitude < 32.39, '丹江口南侧汉江区域应保留')
  assert.equal(map.data.markers.length, 25); assert.equal(new Set(map.data.markers.map((m) => m.id)).size, 25)
  assert.equal(map.data.markers.filter((m) => m.callout).length, 1)
  map.onMarkerTap({ detail: { markerId: 1 } }); assert.equal(events[0].name, 'select'); assert.equal(events[0].detail.reservoirId, 'HN_RSV_001')
  map.onMarkerTap({ detail: { markerId: 999 } }); assert.equal(events.length, 1)
  map.overview(); assert.deepEqual(calls.map.at(-1).points, map._allBounds)
  const [sw, ne] = map._allBounds
  assert.ok(map.data.markers.every((m) => m.longitude >= sw.longitude && m.longitude <= ne.longitude && m.latitude >= sw.latitude && m.latitude <= ne.latitude))
  map.zoomIn(); assert.equal(map.data.scale, 13); map.zoomOut(); assert.equal(map.data.scale, 11)
  map.properties.mapData = data.getMapData('HN_RSV_001'); map.updateMap()
  assert.equal(map.data.markers.find((m) => m.callout).id, 1)
  const template = fs.readFileSync(path.join(mini, 'components/reservoir-map/reservoir-map.wxml'), 'utf8')
  assert.match(template, /<map\s/); assert.doesNotMatch(template, /subkey|show-location/)
  assert.equal(calls.downloads.length, 0); assert.ok(calls.requests.every((r) => !r.url.includes('/api/map-tile')))
  value.lifetimes.detached.call(map)
})
await check('会话失效清除数据，安装包不再包含示例天气和旧轨道', async () => {
  unauthorized = true
  await assert.rejects(data.refresh(true), /登录已过期/)
  assert.equal(network.getSession(), null); assert.equal(data.getPasses('HN_RSV_001').length, 0)
  assert.equal(data.getWeather('HN_RSV_001'), null)
  for (const name of ['data/orbits.js', 'data/meta.js']) assert.equal(fs.existsSync(path.join(mini, name)), false)
  const source = filesIn(mini).filter((f) => /\.(js|wxml)$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
  assert.doesNotMatch(source, /preview-sample|示例天气|downloadTile|\/api\/map-tile|TIANDITU_SERVER_KEY/)
  assert.ok(filesIn(mini).reduce((sum, f) => sum + fs.statSync(f).size, 0) < 2 * 1024 * 1024)
})
Date.now = originalNow
console.log(`\n${checks}组小程序检查通过。网络与页面流程使用测试替身；实际网站、模拟器和真机仍需联调。`)
