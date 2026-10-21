import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DOMParser } from '@xmldom/xmldom'
import ts from 'typescript'
import { RESERVOIR_STATIONS } from '../weather-worker/src/nmc.ts'

const root = fileURLToPath(new URL('../', import.meta.url)), mini = path.join(root, 'miniprogram')
const require = createRequire(path.join(mini, 'package.json'))
const sourceReservoirs = JSON.parse(fs.readFileSync(path.join(root, 'public/data/reservoirs.geojson'), 'utf8'))
const samplingScopes = JSON.parse(fs.readFileSync(path.join(root, 'public/data/reservoir-sampling-scopes.geojson'), 'utf8'))
const sourceOrbit = { ...JSON.parse(fs.readFileSync(path.join(root, 'public/data/orbit-passes.json'), 'utf8')), pipeline: 'miniprogram-static-independent-v1' }
const config = JSON.parse(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'))
const firstDate = sourceOrbit.items.map((p) => p.date).sort()[0]
const fixtureNow = Date.parse(`${firstDate}T12:00:00+08:00`)
const fixtureBaseUrl = 'https://mini.example.test/reservoir-static'
const originalNow = Date.now
Date.now = () => fixtureNow
let checks = 0, weatherFailure = false, orbitFailure = false, unauthorized = false, requestFailure = false
let writeFailure = false, openFailure = false, shareFailure = false
let switchPending = null, holdSwitch = false
const calls = { requests: [], downloads: [], clipboard: [], navigation: [], backs: [], storage: new Map(), map: [], files: [], documents: [], shares: [], modals: [], backgrounds: [] }
// All artificial weather lives in this test fixture, never in the mini program.
const fixtureWeather = Object.fromEntries(sourceReservoirs.features.map(({ properties: p }) => [p.id, {
  source: '中央气象台',
  sourceUrl: `https://www.nmc.cn/publish/forecast/AHA/${RESERVOIR_STATIONS.find((s) => s.reservoirId === p.id).slug}.html`,
  stationName: RESERVOIR_STATIONS.find((s) => s.reservoirId === p.id).stationName,
  publishedAt: `${firstDate}T08:00:00+08:00`, fetchedAt: sourceOrbit.generated_at, cacheStatus: 'cloud',
  days: Array.from({ length: 7 }, (_, i) => ({ date: new Date(Date.parse(firstDate) + i * 86400000).toISOString().slice(0, 10),
    dayCondition: i % 3 === 1 ? '多云' : '晴', nightCondition: '多云' })),
}]))
const wx = {
  env: { USER_DATA_PATH: '/private-test-files' },
  getFileSystemManager: () => ({
    writeFile(options) {
      assert.doesNotMatch(options.filePath, /\.kml$/, 'KML必须同步写入，避免异步回调丢失用户TAP手势')
      calls.files.push(options)
      if (writeFailure) options.fail({ errMsg: 'writeFile:fail storage full' }); else options.success({})
    },
    writeFileSync(filePath, data, encoding) {
      const options = { filePath, data, encoding, sync: true }
      calls.files.push(options)
      if (writeFailure) throw { errMsg: 'writeFileSync:fail storage full' }
    },
  }),
  openDocument(options) {
    calls.documents.push(options)
    if (openFailure) options.fail({ errMsg: 'openDocument:fail file error' }); else options.success({})
  },
  shareFileMessage(options) {
    calls.shares.push(options)
    if (shareFailure) options.fail({ errMsg: 'shareFileMessage:fail cancelled' }); else options.success({})
  },
  getStorageSync: (key) => calls.storage.get(key), setStorageSync: (key, value) => calls.storage.set(key, value),
  removeStorageSync: (key) => calls.storage.delete(key), stopPullDownRefresh() {}, showToast() {},
  setClipboardData: ({ data }) => calls.clipboard.push(data),
  showModal: (options) => calls.modals.push(options),
  setBackgroundColor: (options) => calls.backgrounds.push(options),
  navigateTo: ({ url }) => calls.navigation.push(url), switchTab(options) {
    calls.navigation.push(options.url)
    if (holdSwitch) switchPending = options
    else options.complete?.()
  },
  navigateBack: (options) => calls.backs.push(options),
  reLaunch: ({ url }) => calls.navigation.push(url), getWindowInfo: () => ({ pixelRatio: 2 }),
  createMapContext: (id, component) => {
    calls.map.push({ action: 'create', id, component })
    return { includePoints: (options) => calls.map.push({ action: 'include', ...options }),
      getScale: ({ success }) => success({ scale: 12 }) }
  },
  request(options) {
    calls.requests.push(options)
    assert.ok(options.url.startsWith(fixtureBaseUrl + '/'), 'JSON与Word请求必须保留服务地址中的项目目录')
    const route = new URL(options.url).pathname.slice('/reservoir-static'.length)
    const success = (data, statusCode = 200) => options.success({ data, statusCode })
    if (requestFailure) return options.fail(typeof requestFailure === 'object' ? requestFailure : { errMsg: 'request:fail timeout' })
    if (unauthorized) return success({ ok: false }, 401)
    assert.equal(options.header.Authorization, undefined); assert.equal(options.method, 'GET')
    if (route === '/data/manifest.json') return success({ pipeline: 'miniprogram-static-independent-v1', documents: Object.fromEntries(
      ['all', ...sourceReservoirs.features.map((f) => f.properties.id)].map((id) => [id, {
        path: '/documents/' + id + '.docx', bytes: 8, fileName: (id === 'all' ? '全部水库' : id) + '_方案.docx',
      }])) })
    if (route.startsWith('/documents/')) return success(new Uint8Array([80, 75, 3, 4, 0, 0, 0, 0]).buffer)
    if (route === '/data/weather.json') return weatherFailure ? success({ error: { message: 'weather unavailable' } }, 503)
      : success({ source: '中央气象台', pipeline: 'miniprogram-static-independent-v1', generatedAt: sourceOrbit.generated_at, items: fixtureWeather })
    if (route === '/data/orbits.json') return orbitFailure ? success({ error: { message: 'orbit unavailable' } }, 503) : success(sourceOrbit)
    throw new Error('Unexpected request ' + route)
  },
  cloud: {
    init() { throw new Error('免费体验环境不使用wx.cloud通道') },
    callFunction() { throw new Error('免费体验环境不使用wx.cloud通道') },
  },
  downloadFile(options) { calls.downloads.push(options); throw new Error('原生地图不应通过wx.downloadFile下载瓦片') },
}
const configPath = require.resolve('./config.js')
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { serviceBaseUrl: fixtureBaseUrl } }
globalThis.wx = wx
const data = require('./utils/data.js'), network = require('./utils/network.js')
function filesIn(dir) { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== 'node_modules').flatMap((e) => e.isDirectory() ? filesIn(path.join(dir, e.name)) : [path.join(dir, e.name)]) }
async function check(name, action) { await action(); checks++; console.log(`✓ ${name}`) }
let app
function definition(relative, kind, loadModule) {
  let result
  const filename = path.join(mini, relative)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: loadModule || createRequire(filename), wx, getApp: () => app,
    [kind]: (value) => { result = value } }, { filename })
  assert.ok(result); return result
}
app = definition('app.js', 'App')
function page(relative) {
  const value = definition(`${relative}.js`, 'Page')
  const result = { ...value, data: JSON.parse(JSON.stringify(value.data || {})) }
  result.setData = function (values, callback) {
    for (const [key, value] of Object.entries(values)) {
      const names = key.split('.'); let target = this.data
      for (const name of names.slice(0, -1)) target = target[name]
      target[names.at(-1)] = value
    }
    if (callback) callback()
  }
  return result
}
const event = (dataset) => ({ currentTarget: { dataset } })

await check('6个页面配置、首页与点位全屏模式直接渲染原生地图、WXML及事件绑定完整', () => {
  assert.equal(config.pages.length, 6)
  const project = JSON.parse(fs.readFileSync(path.join(mini, 'project.config.json'), 'utf8'))
  assert.match(project.appid, /^wx[a-f0-9]{16}$/); assert.equal(project.setting.urlCheck, true)
  for (const tab of config.tabBar.list) assert.ok(config.pages.includes(tab.pagePath))
  for (const relative of config.pages) {
    for (const ext of ['.js', '.json', '.wxml', '.wxss']) assert.ok(fs.existsSync(path.join(mini, relative + ext)))
    JSON.parse(fs.readFileSync(path.join(mini, relative + '.json'), 'utf8'))
    const value = definition(relative + '.js', 'Page')
    const template = fs.readFileSync(path.join(mini, relative + '.wxml'), 'utf8')
    const parser = new DOMParser({ onError: (level, message) => { throw new Error(`${relative}: ${level}: ${message}`) } })
    const doc = parser.parseFromString(`<root xmlns:wx="https://weixin.qq.com/wxml" xmlns:bind="https://weixin.qq.com/bind">${template}</root>`, 'application/xml')
    for (const element of Array.from(doc.getElementsByTagName('*'))) for (const attr of Array.from(element.attributes)) {
      if (/^(bind|catch)/.test(attr.name)) assert.equal(typeof value[attr.value], 'function', `${relative}: ${attr.value}`)
    }
    if (relative === 'pages/dashboard/dashboard') {
      assert.equal(doc.getElementsByTagName('map').length, 2)
      assert.equal(doc.getElementsByTagName('reservoir-map').length, 0)
      assert.doesNotMatch(template, /让卫星过境与晴好天气在水库相遇|中央气象台天气 · 卫星过境预测/)
      assert.match(template, /class="reservoir-map" style="width:100%;height:470rpx;"/)
      assert.match(template, /class="native-map" style="display:block;width:100%;height:470rpx;"/)
      assert.doesNotMatch(template, /腾讯地图 · 水库位置/)
      assert.match(template, /搜索水库、城市、流域/)
      assert.doesNotMatch(template, /搜索水库、城市、流域或编号/)
      assert.match(template, /四大流域/)
      assert.match(template, /bindtap="focusBasin"/)
      assert.match(template, /class="basin-dot"[^>]+item\.color/)
      assert.match(template, /class="current-basin-dot"[^>]+selected\.basinColor/)
      assert.match(template, /basinLegendCollapsed[^>]+catchtap="toggleBasinLegend"/)
      assert.match(template, /class="sampling-preview-button"[^>]+catchtap="openSamplingPreview"[^>]*>点位设计<\/view>/)
      assert.doesNotMatch(template, /<picker[^>]+bindchange="selectPointReservoir"/)
      assert.match(template, /class="point-switch-label[^>]+bindtap="togglePointReservoirPicker"/)
      assert.match(template, /class="point-reservoir-panel"/)
      assert.match(template, /class="point-reservoir-basin"/)
      assert.match(template, /class="picker-basin-section"/)
      assert.doesNotMatch(template, /map-expand-button/)
      assert.ok(Array.from(doc.getElementsByTagName('map')).every((map) => map.getElementsByTagName('button').length === 0), '所有交互按钮必须放在原生地图外，避免真机吞掉点击')
      assert.match(template, /class="opportunity-date">{{item\.dateLabel}}/)
      assert.match(template, /class="pass-date pass-date-primary">{{item\.dateLabel}}/)
      assert.doesNotMatch(template, /{{item\.time}}/, '首页过境卡片只突出月日，不展示具体时刻')
    }
    if (relative === 'pages/plan/plan') {
      assert.match(template, /class="record-date">{{item\.dateLabel}}/)
      assert.doesNotMatch(template, /{{item\.time}}/, '方案卡片只突出月日，不展示具体时刻')
      assert.match(template, /7天内满足条件 · {{qualifyingReservoirCount}} 座/)
      assert.doesNotMatch(template, /全部 \d+ 座水库/)
      assert.match(template, /{{reservoirCount}}<\/text><view>满足条件水库/)
    }
    if (relative === 'pages/pass/pass') {
      assert.match(template, /class="overpass-date">{{pass\.fullDateLabel}}/)
      assert.match(template, /class="overpass-time">{{pass\.time}}/)
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
await check('推荐算法与网站一致，26座水库采样范围限定在河南库区', () => {
  for (const name of ['recommendation', 'satellite']) {
    const source = fs.readFileSync(path.join(root, `src/services/${name}.ts`), 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2018, module: ts.ModuleKind.CommonJS }, fileName: `${name}.ts` }).outputText
    assert.equal(fs.readFileSync(path.join(mini, `utils/${name}.js`), 'utf8'), `// Generated from src/services/${name}.ts.\n${compiled}`)
  }
  assert.equal(data.getReservoirList().length, 26)
  assert.deepEqual(data.getBasins().map((basin) => [basin.name, basin.count]), [
    ['黄河流域', 5], ['淮河流域', 15], ['长江流域', 3], ['海河流域', 3],
  ])
  assert.equal(data.getReservoir('HN_RSV_001').basin, '海河流域')
  assert.equal(data.getReservoir('HN_RSV_002').basin, '黄河流域')
  assert.equal(data.getReservoir('HN_RSV_006').basin, '长江流域')
  assert.equal(data.getReservoir('HN_RSV_025').basin, '淮河流域')
  assert.equal(data.getReservoir('HN_RSV_026').basin, '海河流域')
  assert.equal(data.getReservoir('HN_RSV_026').name_cn, '小南海水库')
  const scopesById = Object.fromEntries(samplingScopes.features.map((feature) => [feature.properties.id, feature]))
  for (const feature of sourceReservoirs.features) {
    const item = data.getReservoir(feature.properties.id)
    const scope = scopesById[feature.properties.id]
    assert.equal(item.area_km2, scope.properties.sampling_area_km2)
    assert.equal(item.full_area_km2, feature.properties.area_km2)
    assert.equal(item.lon, scope.properties.lon); assert.equal(item.sampling_scope, '河南省境内库区')
    assert.match(item.basin, /^(黄河|淮河|长江|海河)流域$/)
    const rings = scope.geometry.type === 'Polygon' ? scope.geometry.coordinates : scope.geometry.coordinates.flat()
    assert.equal(item.rings.length, rings.length)
    item.rings.forEach((ring, i) => assert.equal(ring.length, rings[i].length))
  }
  assert.deepEqual(data.getReservoirList().filter((item) => item.scope_retained_pct < 99.95).map((item) => item.id),
    ['HN_RSV_016', 'HN_RSV_017', 'HN_RSV_024'])
  assert.equal(data.getReservoir('HN_RSV_024').area_km2, 390.98)
  assert.ok(Math.min(...data.getMapData('HN_RSV_024').rings.flat().map((p) => p[1])) > 32.6)
})
await check('无需口令或会话即可进入首页，旧登录路径自动回首页', async () => {
  calls.storage.set('observer:static-session', { token: 'old-token', expiresAt: Date.now() + 86400000 })
  calls.storage.set('observer:session', { token: 'legacy-token' })
  app.onLaunch()
  assert.equal(calls.storage.has('observer:static-session'), false)
  assert.equal(calls.storage.has('observer:session'), false)
  data.reset(); const home = page('pages/dashboard/dashboard'); home.onLoad({}); await home.onShow()
  assert.ok(home.data.selected); assert.ok(home.data.passes.length)
  assert.equal(calls.requests.filter((r) => r.url.endsWith('/data/orbits.json')).length, 1)
  assert.equal(calls.requests.filter((r) => r.url.endsWith('/data/weather.json')).length, 1)
  assert.equal(data.meta.orbitGeneratedAt, sourceOrbit.generated_at)
  const oldEntry = page('pages/login/login'); oldEntry.onShow()
  assert.equal(calls.navigation.at(-1), '/pages/dashboard/dashboard')
  assert.ok(calls.requests.every((r) => !r.url.endsWith('/api/session') && !r.header.Authorization))
})
await check('域名与网络错误直接显示在首页，不要求登录或恢复CloudBase', async () => {
  for (const reason of ['request:fail url not in domain list', 'request:fail timeout']) {
    requestFailure = { errMsg: reason }; data.reset()
    const before = calls.navigation.length
    const home = page('pages/dashboard/dashboard'); home.onLoad({}); await home.onShow()
    assert.ok(home.data.meta.orbitError.includes(reason)); assert.ok(home.data.meta.weatherError.includes(reason))
    assert.equal(home.data.loading, false); assert.equal(calls.navigation.length, before)
  }
  requestFailure = false; data.reset(); await data.refresh()
})
await check('每座水库站名显示并复制对应官方预报链接，关闭弹窗不复制', () => {
  const home = page('pages/dashboard/dashboard')
  for (const reservoir of data.getReservoirList()) {
    home.loadReservoir(reservoir.id)
    home.showWeatherSource()
    const modal = calls.modals.at(-1)
    const expected = fixtureWeather[reservoir.id]
    assert.equal(modal.title, `${expected.stationName}站 · 中央气象台`)
    assert.ok(modal.content.includes(expected.sourceUrl))
    const copied = calls.clipboard.length
    modal.success({ confirm: false }); assert.equal(calls.clipboard.length, copied)
    modal.success({ confirm: true }); assert.equal(calls.clipboard.at(-1), expected.sourceUrl)
    assert.equal(home.data.weather.publishedAt, expected.publishedAt, '保留原始发布日期供数据逻辑使用')
    assert.equal(home.data.weatherPublishedDate, firstDate)
  }
  home.setData({ weather: null })
  const shown = calls.modals.length
  home.showWeatherSource(); assert.equal(calls.modals.length, shown)
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
  home.onLoad({}); await home.onShow(); home.onReady(); assert.equal(home.data.passes.length, 10)
  assert.deepEqual(home.data.reservoirs.map((item) => item.basin)
    .filter((basin, index, basins) => index === 0 || basin !== basins[index - 1]),
  ['黄河流域', '淮河流域', '长江流域', '海河流域'])
  assert.ok(home.data.reservoirs.every((item) => item.pickerLabel === `${item.basin} · ${item.name_cn}`))
  home.openPicker()
  assert.deepEqual(home.data.filteredReservoirs.filter((item) => item.showBasinHeader)
    .map((item) => [item.basin, item.basinResultCount]),
  [['黄河流域', 5], ['淮河流域', 15], ['长江流域', 3], ['海河流域', 3]])
  home.loadMore(); assert.equal(home.data.passes.length, 20)
  home.onSearch({ detail: { value: '丹江' } }); assert.equal(home.data.filteredReservoirs.length, 1)
  home.onSearch({ detail: { value: '淮河' } }); assert.equal(home.data.filteredReservoirs.length, 15)
  assert.equal(home.data.filteredReservoirs.filter((item) => item.showBasinHeader).length, 1)
  home.selectReservoir(event({ id: 'HN_RSV_024' })); home.selectSatellite(event({ name: 'Sentinel-2C' }))
  assert.ok(home.data.passes.every((p) => p.satellite === 'Sentinel-2C'))
  home.selectPassFilter(event({ name: '待预报' })); const id = home.data.passes[0].id
  home.openPass(event({ id })); assert.equal(new URL(calls.navigation.at(-1), 'https://test').searchParams.get('id'), id)
  home.overviewMap(); assert.deepEqual(calls.map.at(-1).points, home._allBounds)
  assert.equal(home.data.basinLegendCollapsed, false)
  home.toggleBasinLegend(); assert.equal(home.data.basinLegendCollapsed, true)
  home.toggleBasinLegend(); assert.equal(home.data.basinLegendCollapsed, false)
  home.focusBasin(event({ basin: '黄河流域' }))
  assert.equal(home.data.activeBasin, '黄河流域')
  assert.equal(calls.map.at(-1).points.length, 5)
  assert.ok(calls.map.at(-1).points.every((point) => home._markerBasins[point.id] === '黄河流域'))
  home.selectMarker({ detail: { markerId: 1 } }); assert.equal(home.data.selected.id, 'HN_RSV_001')
  await home.onPullDownRefresh()
  const detail = page('pages/pass/pass'); await detail.onLoad({ id }); assert.equal(detail.data.pass.id, id)
  assert.match(detail.data.pass.fullDateLabel, /^\d{4}年\d{1,2}月\d{1,2}日$/)
  assert.match(detail.data.pass.weekdayLabel, /^周[日一二三四五六]$/)
  detail.copyWindow(); assert.match(calls.clipboard.at(-1), /中央气象台/); assert.doesNotMatch(calls.clipboard.at(-1), /示例|预览/)
  detail.openPlan(); const plan = page('pages/plan/plan'); await plan.onShow()
  const allPlanRecords = data.getPlanGroups().flatMap((group) => group.records)
  const qualifyingReservoirCount = new Set(allPlanRecords.map((record) => record.reservoir_id)).size
  assert.equal(plan.data.qualifyingReservoirCount, qualifyingReservoirCount)
  assert.equal(plan.data.reservoirCount, new Set(data.getPlanGroups(plan.data.selected.id)
    .flatMap((group) => group.records).map((record) => record.reservoir_id)).size)
  plan.selectScope(event({ scope: '全部水库' })); plan.copyPlan()
  assert.equal(plan.data.reservoirCount, qualifyingReservoirCount)
  assert.match(calls.clipboard.at(-1), new RegExp(`未来7天内${qualifyingReservoirCount}座水库满足条件`))
  assert.equal(plan.data.groups.map((g) => g.name).join(','), 'Sentinel,HJ,Landsat,GF / Gaofen')
  const keys = plan.data.groups.flatMap((g) => g.records.map((p) => `${p.reservoir_id}|${p.date}|${p.satellite}`))
  assert.equal(new Set(keys).size, keys.length); assert.doesNotMatch(calls.clipboard.at(-1), /示例|预览/)
  await detail.onLoad({ id: 'not-found' }); assert.equal(detail.data.notFound, true)
})
await check('采样点按参考方案或水面边界设计，并导出奥维可识别的KML', () => {
  const sampling = require('./utils/sampling.js')
  const referenceCounts = { HN_RSV_002: 14, HN_RSV_010: 12, HN_RSV_012: 13, HN_RSV_016: 17,
    HN_RSV_018: 15, HN_RSV_020: 16, HN_RSV_024: 39 }
  for (const [id, count] of Object.entries(referenceCounts)) {
    const reservoir = data.getReservoir(id), plan = sampling.buildSamplingPlan(reservoir)
    assert.equal(plan.count, count); assert.equal(plan.source, 'reference')
    assert.deepEqual(plan.points.map((point) => point.name),
      Array.from({ length: count }, (_, index) => String(index + 1).padStart(2, '0')))
    assert.ok(plan.points.every((point) => Number.isFinite(point.longitude) && Number.isFinite(point.latitude)))
  }
  const reservoir = data.getReservoir('HN_RSV_010')
  const referencePlan = sampling.buildSamplingPlan(reservoir)
  assert.equal(referencePlan.points[0].name, '01'); assert.equal(referencePlan.points.at(-1).name, '12')
  assert.equal(referencePlan.points[0].longitude, 111.2791872, 'KML应保留原始经度而不是腾讯地图偏移坐标')
  assert.equal(referencePlan.referenceBasis, '用户提供的 GX.kml 点位')
  assert.equal(referencePlan.routeDistanceKm, 12.2)
  const luhunPlan = sampling.buildSamplingPlan(data.getReservoir('HN_RSV_002'))
  assert.equal(luhunPlan.referenceYear, 2024); assert.equal(luhunPlan.referenceBasis, '2024-10-23 实测点位')
  assert.deepEqual([luhunPlan.points[0].name, luhunPlan.points[0].longitude, luhunPlan.points[0].latitude],
    ['01', 112.16594722, 34.19828611])
  assert.deepEqual([luhunPlan.points.at(-1).name, luhunPlan.points.at(-1).longitude, luhunPlan.points.at(-1).latitude],
    ['14', 112.12732778, 34.14041111])
  const danjiangkouPlan = sampling.buildSamplingPlan(data.getReservoir('HN_RSV_024'))
  assert.equal(danjiangkouPlan.referenceYear, 2023)
  assert.equal(danjiangkouPlan.referenceBasis, '2023-10-30/31 实测点位')
  assert.deepEqual([danjiangkouPlan.points[0].name, danjiangkouPlan.points[0].longitude, danjiangkouPlan.points[0].latitude],
    ['01', 111.59593333, 32.69243056])
  assert.deepEqual([danjiangkouPlan.points.at(-1).name, danjiangkouPlan.points.at(-1).longitude,
    danjiangkouPlan.points.at(-1).latitude], ['39', 111.4276425, 32.94458444])
  const danjiangkouMap = sampling.buildSamplingMap(danjiangkouPlan, data.wgs84ToGcj02)
  assert.equal(danjiangkouMap.view.markers[0].label.content, '01')
  assert.equal(danjiangkouMap.view.markers.at(-1).label.content, '39')
  const danjiangkouKml = sampling.buildOviKml(data.getReservoir('HN_RSV_024'), danjiangkouPlan)
  assert.equal((danjiangkouKml.match(/<Placemark>/g) || []).length, 39)
  assert.match(danjiangkouKml, /<name>01<\/name>/)
  assert.match(danjiangkouKml, /<name>39<\/name>/)
  assert.match(danjiangkouKml, /河南库区/)
  const nianyushanPlan = sampling.buildSamplingPlan(data.getReservoir('HN_RSV_020'))
  assert.equal(nianyushanPlan.referenceBasis, '用户提供的 NYS-采样点.kml 点位')
  assert.deepEqual([nianyushanPlan.points[0].name, nianyushanPlan.points[0].longitude, nianyushanPlan.points[0].latitude],
    ['01', 115.40200953, 31.76108023])
  assert.deepEqual([nianyushanPlan.points.at(-1).name, nianyushanPlan.points.at(-1).longitude,
    nianyushanPlan.points.at(-1).latitude], ['16', 115.3013965, 31.79538795])
  assert.equal(sampling.MAX_POINT_COUNT, 50)
  const panshitouPlan = sampling.buildSamplingPlan(data.getReservoir('HN_RSV_007'), { schemeId: 'sync', count: 15 })
  assert.equal(panshitouPlan.targetShorelineBufferM, 150)
  assert.ok(panshitouPlan.minimumShoreDistanceM >= 150, '盘石头自动点位不应贴近岸线')
  assert.deepEqual(panshitouPlan.points.map((point) => point.name),
    Array.from({ length: 15 }, (_, index) => String(index + 1).padStart(2, '0')))
  const generated = sampling.buildSamplingPlan(reservoir, 13)
  assert.equal(generated.source, 'generated'); assert.equal(generated.count, 13)
  const syncPlan = sampling.buildSamplingPlan(reservoir, { schemeId: 'sync' })
  const shorePlan = sampling.buildSamplingPlan(reservoir, { schemeId: 'shore' })
  const schemeOptions = sampling.getSamplingSchemes(reservoir)
  assert.deepEqual(schemeOptions.map((scheme) => scheme.id), ['sync', 'shore'])
  assert.equal(syncPlan.schemeId, 'sync'); assert.equal(syncPlan.source, 'reference')
  assert.equal(syncPlan.count, sampling.defaultPointCount(reservoir)); assert.equal(syncPlan.fixedCount, false)
  assert.equal(shorePlan.schemeId, 'shore'); assert.equal(shorePlan.count, 10)
  assert.equal(shorePlan.source, 'shore-candidates'); assert.equal(shorePlan.accessVerificationRequired, true)
  assert.ok(shorePlan.points.every((point) => point.shoreDistanceKm >= 0.01 && point.shoreDistanceKm <= 0.2))
  for (const item of data.getReservoirList()) {
    const full = data.getReservoir(item.id), geometry = sampling.createGeometry(full)
    for (const schemeId of ['sync', 'shore']) {
      const plan = sampling.buildSamplingPlan(full, { schemeId })
      if (plan.source !== 'reference' || full.scope_retained_pct < 99.95) {
        assert.ok(plan.points.every((point) => sampling.pointInGeometry(
          geometry.project([point.longitude, point.latitude]), geometry)), `${item.id} ${schemeId}存在河南库区外点位`)
      }
      assert.deepEqual(plan.points.map((point) => point.name),
        Array.from({ length: plan.count }, (_, index) => String(index + 1).padStart(2, '0')))
      if (plan.source === 'generated') {
        assert.ok(plan.points.every((point) => point.shoreDistanceKm * 1000 + 1 >= plan.shorelineBufferM),
          `${item.id} 自动点位未满足自适应离岸距离`)
      }
      if (schemeId === 'shore') {
        const candidates = new Set(full.shore_candidates.map(([longitude, latitude]) => `${longitude},${latitude}`))
        assert.ok(plan.points.every((point) => candidates.has(`${point.longitude},${point.latitude}`)))
        assert.equal(plan.accessVerificationRequired, true)
      }
    }
  }
  const kml = sampling.buildOviKml(reservoir, referencePlan)
  assert.equal((kml.match(/<Placemark>/g) || []).length, 12)
  assert.match(kml, /<OvCoordType>CGCS2000<\/OvCoordType>/)
  assert.match(kml, /111\.27918720,34\.23451237,0/)
  const kmlDocument = new DOMParser().parseFromString(kml, 'application/xml')
  assert.equal(kmlDocument.getElementsByTagName('Placemark').length, 12)

  const samplingPage = page('pages/sampling/sampling')
  samplingPage.onLoad({ reservoir: 'HN_RSV_010' }); samplingPage.onReady()
  assert.equal(samplingPage.data.plan.source, 'reference'); assert.equal(samplingPage.data.count, 12)
  assert.deepEqual(calls.map.at(-1).points, samplingPage._mapPoints)
  assert.notEqual(samplingPage.data.map.markers[0].longitude, referencePlan.points[0].longitude, '地图显示副本应转换为GCJ-02')
  samplingPage.increaseCount(); assert.equal(samplingPage.data.count, 13); assert.equal(samplingPage.data.plan.source, 'generated')
  samplingPage.restoreDefault(); assert.equal(samplingPage.data.count, 12); assert.equal(samplingPage.data.plan.source, 'reference')
  samplingPage.exportKml()
  assert.match(calls.files.at(-1).filePath, /故县水库_12个采样点\.kml$/)
  assert.equal(calls.files.at(-1).sync, true, 'KML必须在点击调用链中同步保存后立即分享')
  assert.equal(calls.files.at(-1).encoding, 'utf8'); assert.match(calls.files.at(-1).data, /<OvCoordType>CGCS2000/)
  assert.equal(calls.shares.at(-1).filePath, calls.files.at(-1).filePath)
  assert.equal(samplingPage.data.exportLoading, false); assert.equal(samplingPage.data.exportError, '')
  shareFailure = true; samplingPage.exportKml()
  assert.match(samplingPage.data.exportError, /KML 分享失败.*cancelled/); assert.equal(samplingPage.data.exportLoading, false)
  shareFailure = false; writeFailure = true; samplingPage.exportKml()
  assert.match(samplingPage.data.exportError, /KML 保存失败.*storage full/); assert.equal(samplingPage.data.exportLoading, false)
  writeFailure = false; samplingPage.onUnload()

  const home = page('pages/dashboard/dashboard'); home.loadReservoir('HN_RSV_010')
  const fakeTabBar = { data: { hidden: false }, setData(values) { Object.assign(this.data, values) } }
  home.getTabBar = () => fakeTabBar
  const navigationCount = calls.navigation.length
  home.openSamplingPreview()
  assert.equal(calls.navigation.length, navigationCount, '全屏预览在首页内部切换，不依赖新增页面注册')
  assert.equal(home.data.pointPreviewOpen, true); assert.equal(home.data.pointSchemeId, 'sync')
  assert.equal(home.data.pointPlan.count, sampling.standardPointCount(reservoir))
  assert.equal(home.data.pointMap.markers.length, home.data.pointPlan.count)
  assert.equal(home.data.pointMap.polyline[0].points.length, home.data.pointPlan.count)
  assert.deepEqual(home.data.pointSchemes.map((scheme) => scheme.id), ['sync', 'shore'])
  assert.equal(fakeTabBar.data.hidden, true); assert.deepEqual(calls.map.at(-1).points, home._pointMapPoints)
  home.togglePointReservoirPicker(); assert.equal(home.data.pointPickerOpen, true)
  assert.deepEqual(home.data.pointReservoirOptions.filter((item) => item.showBasinHeader)
    .map((item) => [item.basin, item.basinResultCount]),
  [['黄河流域', 5], ['淮河流域', 15], ['长江流域', 3], ['海河流域', 3]])
  const luhunIndex = home.data.reservoirs.findIndex((item) => item.id === 'HN_RSV_002')
  const guxianIndex = home.data.reservoirs.findIndex((item) => item.id === 'HN_RSV_010')
  home.selectPointReservoir(event({ id: 'HN_RSV_002' }))
  assert.equal(home.data.selected.id, 'HN_RSV_002'); assert.equal(home.data.pointReservoirIndex, luhunIndex)
  assert.equal(home.data.pointPickerOpen, false)
  assert.equal(home.data.pointPlan.count, 14); assert.equal(home.data.pointPlan.schemeId, 'sync')
  assert.equal(home.data.pointMap.markers.length, 14)
  assert.deepEqual(calls.map.at(-1).points, home._pointMapPoints)
  home.togglePointReservoirPicker(); home.selectPointReservoir(event({ id: 'HN_RSV_010' }))
  assert.equal(home.data.selected.id, 'HN_RSV_010'); assert.equal(home.data.pointPlan.count, 12)
  home.togglePointMeasurement(); assert.equal(home.data.pointMeasuring, true)
  home.selectPointForAdjustment({ detail: { markerId: 1 } })
  assert.deepEqual(Array.from(home.data.pointMeasureIds), [1]); assert.match(home.data.pointAdjustmentMessage, /请再点击一个不同点位/)
  home.selectPointForAdjustment({ detail: { markerId: 2 } })
  const measuredDistance = sampling.samplingPointDistanceM(home.data.pointPlan.points[0], home.data.pointPlan.points[1])
  assert.deepEqual(Array.from(home.data.pointMeasureIds), [1, 2]); assert.equal(home.data.pointMeasureDistanceM, measuredDistance)
  assert.match(home.data.pointAdjustmentMessage, new RegExp(`${measuredDistance} 米`))
  assert.equal(home.data.pointMap.markers[0].label.bgColor, '#b48ead')
  assert.equal(home.data.pointMap.markers[1].label.bgColor, '#b48ead')
  assert.equal(home.data.pointMap.polyline.length, 2); assert.equal(home.data.pointMap.polyline[1].color, '#B48EADFF')
  home.selectPointForAdjustment({ detail: { markerId: 3 } })
  assert.deepEqual(Array.from(home.data.pointMeasureIds), [3], '完成一次测距后点击第三个点，应开始下一次测距')
  home.togglePointMeasurement(); assert.equal(home.data.pointMeasuring, false)
  const originalPoint = home.data.pointPlan.points[0]
  home.selectPointForAdjustment({ detail: { markerId: originalPoint.id } })
  assert.equal(home.data.pointAdjustingId, originalPoint.id)
  assert.equal(home.data.pointMap.markers[0].width, 40)
  const latitudeDelta = 20 / 110574
  const longitudeDelta = 20 / (111320 * Math.cos(originalPoint.latitude * Math.PI / 180))
  const nudgeTargets = [
    { direction: 'up', longitude: originalPoint.longitude, latitude: originalPoint.latitude + latitudeDelta },
    { direction: 'down', longitude: originalPoint.longitude, latitude: originalPoint.latitude - latitudeDelta },
    { direction: 'left', longitude: originalPoint.longitude - longitudeDelta, latitude: originalPoint.latitude },
    { direction: 'right', longitude: originalPoint.longitude + longitudeDelta, latitude: originalPoint.latitude },
  ]
  const validNudge = nudgeTargets.find((target) => {
    try { sampling.moveSamplingPoint(data.getReservoir(home.data.selected.id), home.data.pointPlan,
      originalPoint.id, target.longitude, target.latitude); return true } catch { return false }
  })
  assert.ok(validNudge, '至少一个方向应允许点位微调')
  home.nudgeSelectedPoint(event({ direction: validNudge.direction }))
  assert.equal(home.data.pointAdjustingId, originalPoint.id); assert.equal(home.data.pointPlan.manualAdjustmentCount, 1)
  assert.ok(Math.abs(home.data.pointPlan.points[0].longitude - validNudge.longitude) < 1e-7)
  assert.ok(Math.abs(home.data.pointPlan.points[0].latitude - validNudge.latitude) < 1e-7)
  assert.match(home.data.pointAdjustmentMessage, /可继续微调/)
  assert.match(sampling.buildOviKml(reservoir, home.data.pointPlan), /1个点位已手动编辑/)
  home.cancelPointAdjustment(); assert.equal(home.data.pointAdjustingId, 0)
  home.restorePointPlan(); assert.equal(home.data.pointPlan.manualAdjustmentCount, 0)
  home.selectPointScheme(event({ id: 'sync' }))
  const syncCount = sampling.standardPointCount(reservoir)
  assert.equal(home.data.pointCount, syncCount); assert.equal(home.data.pointSchemeAdjustable, true)
  const originalLayout = home.data.pointPlan.points.map((point) => ({ ...point }))
  const addTarget = data.wgs84ToGcj02(validNudge.longitude, validNudge.latitude)
  home.togglePointAddition(); assert.equal(home.data.pointAdding, true)
  home._ignorePointMapTapUntil = 0
  home.addPointAtMapLocation({ detail: addTarget })
  assert.equal(home.data.pointAdding, false); assert.equal(home.data.pointCount, syncCount + 1)
  assert.deepEqual(home.data.pointPlan.points.slice(0, syncCount), originalLayout)
  assert.deepEqual(home.data.pointPlan.points.at(-1), {
    id: syncCount + 1, name: String(syncCount + 1).padStart(2, '0'),
    longitude: Number(validNudge.longitude.toFixed(8)), latitude: Number(validNudge.latitude.toFixed(8)),
    shoreDistanceKm: home.data.pointPlan.points.at(-1).shoreDistanceKm,
    manuallyAdjusted: true, manuallyAdded: true,
  })
  assert.equal(home.data.pointAdjustingId, syncCount + 1)
  assert.match(sampling.buildOviKml(reservoir, home.data.pointPlan), /手动新增/)
  home.decreasePointCount(); assert.equal(home.data.pointCount, syncCount)
  assert.deepEqual(home.data.pointPlan.points, originalLayout); assert.equal(home.data.pointPlan.source, 'reference')
  assert.equal(home.data.pointHasEdits, true)
  home.togglePointAddition(); assert.equal(home.data.pointAdding, true)
  home.togglePointAddition(); assert.equal(home.data.pointAdding, false)
  home.togglePointAddition(); home._ignorePointMapTapUntil = 0
  home.addPointAtMapLocation({ detail: addTarget }); assert.equal(home.data.pointCount, syncCount + 1)
  home.restorePointPlan(); assert.equal(home.data.pointCount, syncCount); assert.equal(home.data.pointPlan.source, 'reference')
  assert.equal(home.data.pointHasEdits, false)
  home.decreasePointCount(); assert.equal(home.data.pointCount, syncCount - 1)
  assert.deepEqual(home.data.pointPlan.points, originalLayout.slice(0, -1))
  home.restorePointPlan(); assert.equal(home.data.pointCount, syncCount)
  home.selectPointScheme(event({ id: 'shore' }))
  assert.equal(home.data.pointCount, 10); assert.equal(home.data.pointPlan.schemeLabel, '岸边加密')
  assert.equal(home.data.pointPlan.accessVerificationRequired, true)
  home.exportPointKml()
  assert.match(calls.files.at(-1).filePath, /故县水库_岸边加密_10点\.kml$/)
  assert.match(calls.files.at(-1).data, /故县水库-岸边加密采样点/)
  assert.match(calls.files.at(-1).data, /须现场复核道路、坡岸与管制条件/)
  assert.equal(calls.files.at(-1).sync, true)
  assert.equal(calls.shares.at(-1).filePath, calls.files.at(-1).filePath)
  assert.equal(home.data.pointExportLoading, false); assert.equal(home.data.pointExportError, '')
  const fullTemplate = fs.readFileSync(path.join(mini, 'pages/dashboard/dashboard.wxml'), 'utf8')
  assert.match(fullTemplate, /将导出：{{pointPlan\.schemeLabel}}/)
  assert.match(fullTemplate, /bindtap="selectPointScheme"/)
  assert.match(fullTemplate, /道路、坡岸、围栏及管制条件仍须现场复核/)
  assert.match(fullTemplate, /show-compass="{{false}}"/)
  const fullDocument = new DOMParser().parseFromString(`<root xmlns:wx="https://weixin.qq.com/wxml">${fullTemplate}</root>`, 'application/xml')
  const pointMapNode = Array.from(fullDocument.getElementsByTagName('map')).find((map) => map.getAttribute('id') === 'sampling-full-map')
  assert.ok(pointMapNode); assert.equal(pointMapNode.getElementsByTagName('button').length, 0, '全屏交互按钮必须位于原生地图之外')
  assert.equal(pointMapNode.getAttribute('show-compass'), '{{false}}')
  assert.equal(pointMapNode.getAttribute('bindmarkertap'), 'selectPointForAdjustment')
  assert.equal(pointMapNode.getAttribute('bindlabeltap'), 'selectPointForAdjustment')
  assert.equal(pointMapNode.getAttribute('bindtap'), 'addPointAtMapLocation')
  assert.match(fullTemplate, /class="point-nudge-controls"/)
  assert.equal((fullTemplate.match(/bindtap="nudgeSelectedPoint"/g) || []).length, 4)
  assert.match(fullTemplate, /bindtap="togglePointAddition"/)
  assert.match(fullTemplate, /bindtap="togglePointMeasurement"/)
  assert.match(fullTemplate, /wx:elif="{{pointHasEdits}}"[^>]+bindtap="restorePointPlan"/)
  const dashboardStyles = fs.readFileSync(path.join(mini, 'pages/dashboard/dashboard.wxss'), 'utf8')
  assert.match(dashboardStyles, /\.reservoir-location[^}]+white-space:\s*nowrap/)
  assert.match(dashboardStyles, /\.point-back-button[^}]+flex:\s*0 0 74rpx[^}]+min-width:\s*74rpx[^}]+max-width:\s*74rpx/, '返回按钮必须保持紧凑且不能被页头拉伸')
  assert.match(dashboardStyles, /\.point-reservoir-copy[^}]+text-align:\s*center/, '水库信息必须在页头中间区域居中显示')
  assert.match(dashboardStyles, /\.point-switch-label[^}]+min-width:\s*108rpx[^}]+height:\s*58rpx/, '切换按钮必须保留清晰的点击尺寸')
  assert.match(dashboardStyles, /\.point-measure-button\.active[^}]+background:\s*#654c8a/, '测距模式按钮必须提供清晰的激活状态')
  assert.doesNotMatch(fullTemplate, /点击切换水库/)
  home.closeSamplingPreview(); assert.equal(home.data.pointPreviewOpen, false); assert.equal(fakeTabBar.data.hidden, false)
  assert.equal(home.onBackPress(), false)
  const dashboardTemplate = fs.readFileSync(path.join(mini, 'pages/dashboard/dashboard.wxml'), 'utf8')
  assert.doesNotMatch(dashboardTemplate, /设计采样点 · 导出 KML/)
  assert.doesNotMatch(fs.readFileSync(path.join(mini, 'app.json'), 'utf8'), /sampling-map/)
})
await check('推荐卡片、过境列表和方案链接传递编码编号时仍能打开对应详情', async () => {
  const home = page('pages/dashboard/dashboard'), plan = page('pages/plan/plan')
  let checked = 0
  for (const reservoir of data.getReservoirList()) {
    home.loadReservoir(reservoir.id)
    const targets = [home.data.recommendations[0], home.data.passes[0]].filter(Boolean)
    for (const target of targets) {
      home.openPass(event({ id: target.id }))
      const encodedId = calls.navigation.at(-1).split('?id=')[1]
      assert.equal(decodeURIComponent(encodedId), target.id)
      const detail = page('pages/pass/pass')
      await detail.onLoad({ id: encodedId })
      assert.equal(detail.data.pass?.id, target.id, `编码编号应能打开详情：${target.id}`)
      assert.equal(detail.data.notFound, false)
      await detail.onLoad({ id: target.id })
      assert.equal(detail.data.pass?.id, target.id, '已解码的编号也能打开')
      checked++
    }
  }
  assert.ok(checked >= 25)
  const target = data.getPasses('HN_RSV_001')[0]
  plan.openPass(event({ id: target.id }))
  const detail = page('pages/pass/pass')
  await detail.onLoad({ id: calls.navigation.at(-1).split('?id=')[1] })
  assert.equal(detail.data.pass?.id, target.id)
  for (const options of [{ id: 'not-found' }, { id: '%invalid' }, {}]) {
    await detail.onLoad(options); assert.equal(detail.data.notFound, true)
  }
})
await check('按钮底栏同步选中项，避免重复跳转，缓存页面切换不清空内容或闪加载', async () => {
  assert.equal(config.tabBar.custom, true)
  let component
  let currentRoute = config.tabBar.list[0].pagePath
  const filename = path.join(mini, 'custom-tab-bar/index.js')
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (specifier) => {
      assert.ok(!specifier.endsWith('.json'), '微信运行时不能通过require加载JSON配置')
      return createRequire(filename)(specifier)
    }, wx, Component: (value) => { component = value },
    getCurrentPages: () => [{ route: currentRoute }],
  }, { filename })
  const bar = { ...component.methods, data: JSON.parse(JSON.stringify(component.data)) }
  assert.deepEqual(bar.data.tabs, config.tabBar.list, '底栏按钮必须与配置中的tab路由一致')
  bar.setData = (values, callback) => { Object.assign(bar.data, values); callback?.() }
  component.lifetimes.attached.call(bar)
  assert.equal(bar.data.selected, 0)
  const before = calls.navigation.length
  bar.switchTab(event({ index: 0 })); assert.equal(calls.navigation.length, before)
  holdSwitch = true
  bar.switchTab(event({ index: 1 })); bar.switchTab(event({ index: 2 }))
  assert.equal(bar.data.selected, 1, '点击后先更新选中态')
  assert.equal(calls.navigation.length, before + 1)
  assert.equal(calls.navigation.at(-1), '/pages/plan/plan')
  switchPending.complete(); holdSwitch = false
  currentRoute = config.tabBar.list[1].pagePath
  component.pageLifetimes.show.call(bar)
  assert.equal(bar.data.selected, 1)
  holdSwitch = true
  bar.switchTab(event({ index: 2 }))
  switchPending.fail(); switchPending.complete(); holdSwitch = false
  assert.equal(bar.data.selected, 1, '失败时保持当前页选中态')
  const pages = [page('pages/dashboard/dashboard'), page('pages/plan/plan'), page('pages/about/about')]
  const requestCount = calls.requests.length
  for (let index = 0; index < pages.length; index++) {
    const tab = pages[index]
    tab.onLoad({})
    assert.equal(calls.backgrounds.at(-1).backgroundColor, '#06141d')
    assert.equal(calls.backgrounds.at(-1).backgroundColorTop, '#06141d')
    assert.equal(calls.backgrounds.at(-1).backgroundColorBottom, '#06141d')
    tab.getTabBar = () => bar
    const showing = tab.onShow()
    assert.equal(bar.data.selected, index)
    if (index < 2) {
      assert.ok(tab.data.selected, '使用缓存时，进入页面立刻有内容')
      assert.equal(tab.data.loading, false, '有效缓存不闪现加载状态')
    }
    await showing
  }
  assert.equal(calls.requests.length, requestCount, '缓存切页不重复请求网络')
  const xml = fs.readFileSync(path.join(mini, 'custom-tab-bar/index.wxml'), 'utf8')
  const doc = new DOMParser().parseFromString(`<root xmlns:wx="https://weixin.qq.com/wxml">${xml}</root>`, 'application/xml')
  assert.equal(doc.getElementsByTagName('button').length, 1)
  assert.equal(doc.getElementsByTagName('button')[0].getAttribute('bindtap'), 'switchTab')
  assert.equal(doc.getElementsByTagName('view')[0].getAttribute('hidden'), '{{hidden}}')
  for (const tab of config.tabBar.list) {
    const template = fs.readFileSync(path.join(mini, tab.pagePath + '.wxml'), 'utf8')
    const pageDoc = new DOMParser().parseFromString(`<root xmlns:wx="https://weixin.qq.com/wxml">${template}</root>`, 'application/xml')
    const meta = pageDoc.getElementsByTagName('page-meta')[0]
    assert.ok(meta, `${tab.pagePath}需要在首帧固定页面根背景`)
    assert.equal(meta.getAttribute('root-background-color'), '#06141d')
    assert.equal(meta.getAttribute('background-color'), '#06141d')
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(mini, 'custom-tab-bar/index.json'))).component, true)
})
await check('反复切页不重绘缓存内容或复位地图，强制刷新保留视野且切库仍定位', async () => {
  const home = page('pages/dashboard/dashboard'), plan = page('pages/plan/plan')
  await home.onShow(); home.onReady(); await plan.onShow()
  home.zoomMapIn()
  const map = home.data.map
  const scale = map.scale
  const moves = calls.map.filter((call) => call.action === 'include').length
  const requestCount = calls.requests.length
  const updates = []
  for (const tab of [home, plan]) {
    const originalSetData = tab.setData
    tab.setData = function (values, callback) { updates.push(Object.keys(values)); originalSetData.call(this, values, callback) }
  }
  for (let repeat = 0; repeat < 5; repeat++) { await plan.onShow(); await home.onShow() }
  assert.equal(updates.length, 0, '未变化的缓存切页不应触发页面setData')
  assert.equal(calls.requests.length, requestCount)
  assert.equal(home.data.map, map)
  assert.equal(home.data.map.scale, scale)
  assert.equal(calls.map.filter((call) => call.action === 'include').length, moves)
  await home.onPullDownRefresh()
  assert.equal(calls.requests.length, requestCount + 2, '强制刷新仍读取天气与轨道')
  assert.equal(home.data.map, map, '数据刷新不重新设置地图标记')
  assert.equal(home.data.map.scale, scale)
  assert.equal(calls.map.filter((call) => call.action === 'include').length, moves)
  const other = home.data.selected.id === 'HN_RSV_024' ? 'HN_RSV_001' : 'HN_RSV_024'
  home.loadReservoir(other)
  assert.equal(calls.map.filter((call) => call.action === 'include').length, moves + 1)
  await plan.onShow(); assert.equal(plan.data.selected.id, other)
})
await check('当前和全部水库Word写入本机后以docx打开，保存/打开失败均可重试', async () => {
  const plan = page('pages/plan/plan'); await plan.onShow()
  const before = calls.requests.length
  const pendingDownload = plan.downloadWord(); await plan.downloadWord(); await pendingDownload
  assert.equal(calls.requests.length, before + 2, '重复点击只下载一份清单和Word')
  assert.ok(calls.requests.at(-1).url.endsWith('/documents/' + plan.data.selected.id + '.docx'))
  assert.equal(calls.files.at(-1).data.byteLength, 8)
  assert.equal(calls.documents.at(-1).filePath, calls.files.at(-1).filePath)
  assert.equal(calls.documents.at(-1).fileType, 'docx'); assert.equal(calls.documents.at(-1).showMenu, true)
  assert.equal(plan.data.documentLoading, false); assert.equal(plan.data.documentError, '')
  plan.selectScope(event({ scope: '全部水库' })); await plan.downloadWord()
  assert.ok(calls.requests.at(-1).url.endsWith('/documents/all.docx'))
  assert.match(calls.files.at(-1).filePath, /全部水库_方案\.docx$/)
  writeFailure = true; const opened = calls.documents.length; await plan.downloadWord()
  assert.match(plan.data.documentError, /Word保存失败.*storage full/); assert.equal(calls.documents.length, opened)
  writeFailure = false; openFailure = true; await plan.downloadWord()
  assert.match(plan.data.documentError, /Word打开失败.*file error/); assert.equal(plan.data.documentLoading, false)
  openFailure = false; await plan.downloadWord(); assert.equal(plan.data.documentError, '')
})
await check('腾讯地图显示坐标转换正确，河南库区边界及面积保持不变', () => {
  const fixture = { selectedId: 'point', rings: [], markers: [{ id: 'point', name: 'test', longitude: 116.397128, latitude: 39.916527 }] }
  const beijing = data.buildNativeMapData(fixture).view.markers[0]
  assert.ok(Math.abs(beijing.longitude - 116.40337249402477) < 1e-8)
  assert.ok(Math.abs(beijing.latitude - 39.91793074924595) < 1e-8)
  const restoredBeijing = data.gcj02ToWgs84(beijing.longitude, beijing.latitude)
  assert.ok(Math.abs(restoredBeijing.longitude - 116.397128) < 1e-7)
  assert.ok(Math.abs(restoredBeijing.latitude - 39.916527) < 1e-7)
  fixture.markers[0] = { id: 'point', name: 'test', longitude: -74, latitude: 40 }
  const outside = data.buildNativeMapData(fixture).view.markers[0]
  assert.equal(outside.longitude, -74); assert.equal(outside.latitude, 40)
  for (const reservoir of data.getReservoirList()) {
    const source = data.getMapData(reservoir.id), before = JSON.stringify(source)
    const map = data.buildNativeMapData(source)
    assert.equal(JSON.stringify(source), before); assert.equal(data.getReservoir(reservoir.id).area_km2, reservoir.area_km2)
    assert.equal(map.view.polyline, undefined); assert.equal(map.view.polygons, undefined)
    assert.equal(map.view.markers.every((marker) => marker.label === undefined), true)
    assert.match(map.view.markers.find((marker) => marker.callout).callout.content, /水库 · (黄河|淮河|长江|海河)流域$/)
    const [sw, ne] = map.currentBounds
    const selected = map.view.markers.find((marker) => map.markerIds[marker.id] === reservoir.id)
    assert.ok(selected.longitude >= sw.longitude && selected.longitude <= ne.longitude && selected.latitude >= sw.latitude && selected.latitude <= ne.latitude)
    assert.ok(Buffer.byteLength(JSON.stringify(map.view)) < 1024 * 1024, '原生地图setData应低于1MiB')
  }
})
await check('原生地图标记切换、当前/全部视野和缩放工作，不调用瓦片代理或使用Key', () => {
  const map = page('pages/dashboard/dashboard')
  map.loadReservoir('HN_RSV_024'); map.onReady()
  assert.equal(calls.map.at(-2).id, 'reservoir-map'); assert.equal(calls.map.at(-2).component, undefined)
  assert.deepEqual(calls.map.at(-1).points, map._currentBounds)
  assert.ok(map._currentBounds[0].latitude > 32.6, '丹江口采样地图只保留河南库区')
  assert.equal(map.data.map.markers.length, 26); assert.equal(new Set(map.data.map.markers.map((m) => m.id)).size, 26)
  assert.equal(map.data.map.markers.filter((m) => m.callout).length, 1)
  assert.equal(map.data.map.markers.filter((m) => m.label).length, 0)
  assert.equal(Object.values(map._markerBasins).filter((basin) => basin === '淮河流域').length, 15)
  map.overviewMap(); assert.deepEqual(calls.map.at(-1).points, map._allBounds)
  const [sw, ne] = map._allBounds
  assert.ok(map.data.map.markers.every((m) => m.longitude >= sw.longitude && m.longitude <= ne.longitude && m.latitude >= sw.latitude && m.latitude <= ne.latitude))
  map.zoomMapIn(); assert.equal(map.data.map.scale, 13); map.zoomMapOut(); assert.equal(map.data.map.scale, 11)
  map.selectMarker({ detail: { markerId: 1 } }); assert.equal(map.data.selected.id, 'HN_RSV_001')
  map.selectMarker({ detail: { markerId: 999 } }); assert.equal(map.data.selected.id, 'HN_RSV_001')
  assert.equal(map.data.map.markers.find((m) => m.callout).id, 1)
  const template = fs.readFileSync(path.join(mini, 'pages/dashboard/dashboard.wxml'), 'utf8')
  const document = new DOMParser().parseFromString(
    `<root xmlns:wx="https://weixin.qq.com/wxml">${template}</root>`,
    'application/xml',
  )
  const reservoirMap = Array.from(document.getElementsByTagName('map'))
    .find((element) => element.getAttribute('id') === 'reservoir-map')
  assert.ok(reservoirMap)
  for (const attribute of ['subkey', 'show-location', 'polyline', 'polygons']) {
    assert.equal(reservoirMap.hasAttribute(attribute), false)
  }
  assert.equal(calls.downloads.length, 0); assert.ok(calls.requests.every((r) => r.url.startsWith(fixtureBaseUrl + '/')))
  map.onUnload()
})
await check('服务错误清除失效数据，不跳转登录，安装包无旧轨道', async () => {
  unauthorized = true
  const before = calls.navigation.length
  await data.refresh(true)
  assert.match(data.meta.orbitError, /HTTP 401/); assert.equal(calls.navigation.length, before)
  assert.equal(data.getPasses('HN_RSV_001').length, 0)
  assert.equal(data.getWeather('HN_RSV_001'), null)
  for (const name of ['data/orbits.js', 'data/meta.js']) assert.equal(fs.existsSync(path.join(mini, name)), false)
  const source = filesIn(mini).filter((f) => /\.(js|wxml)$/.test(f) && !f.includes(`${path.sep}vendor${path.sep}`)).map((f) => fs.readFileSync(f, 'utf8')).join('\n')
  assert.doesNotMatch(source, /preview-sample|示例天气|downloadTile|\/api\/map-tile|TIANDITU_SERVER_KEY|pages\.dev|wx\.cloud|@cloudbase|vendor\/cloudbase|tcloudbasegateway|\/data\/orbit-passes\.json/)
  assert.ok(filesIn(mini).reduce((sum, f) => sum + fs.statSync(f).size, 0) < 2 * 1024 * 1024)
})
Date.now = originalNow
console.log(`\n${checks}组小程序检查通过。静态服务使用测试替身；免登录静态服务另有独立测试，模拟器和真机仍需联调。`)
