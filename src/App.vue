<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import * as L from 'leaflet'
import type { GeoJsonObject } from 'geojson'
import {
  CalendarCheck, ChevronLeft, ChevronRight, CircleAlert, CloudRain, CloudSun,
  DatabaseZap, FlaskConical, LocateFixed, MapPinned, Menu, RefreshCw, Search,
  Satellite, SlidersHorizontal, Wind, X,
} from 'lucide-vue-next'
import type {
  OrbitPassPayload, ReservoirCollection, ReservoirFeature, WeatherResult,
} from './types'
import { fetchWeather, weatherLabel, weatherSymbol } from './services/weather'
import { buildExperimentRecommendation } from './services/recommendation'

const mapElement = ref<HTMLDivElement | null>(null)
const reservoirs = ref<ReservoirFeature[]>([])
const selected = ref<ReservoirFeature | null>(null)
const orbitPayload = ref<OrbitPassPayload | null>(null)
const weather = ref<WeatherResult | null>(null)
const loading = ref(true)
const weatherLoading = ref(false)
const loadError = ref('')
const weatherError = ref('')
const basemapStatus = ref<'loading' | 'tianditu' | 'osm' | 'unavailable'>('loading')
const searchQuery = ref('')
const selectedSatellite = ref('全部卫星')
const listOpenOnMobile = ref(false)
const weatherStrip = ref<HTMLDivElement | null>(null)
const satelliteFilterStrip = ref<HTMLDivElement | null>(null)
const maxCloud = ref(30)
const maxRain = ref(25)
const maxWind = ref(5)
let weatherRequest = 0
let map: L.Map | null = null
let reservoirLayer: L.GeoJSON | null = null
let activeBaseLayers: L.TileLayer[] = []
let fallbackBoundaryLayer: L.LayerGroup | null = null
const featureLayers = new Map<string, L.Layer>()
const tiandituKey = import.meta.env.VITE_TIANDITU_KEY?.trim() ?? ''

const filteredReservoirs = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase()
  if (!keyword) return reservoirs.value
  return reservoirs.value.filter(({ properties }) =>
    [properties.name_cn, properties.city, properties.code].some((value) =>
      String(value).toLowerCase().includes(keyword),
    ),
  )
})

const selectedPasses = computed(() => {
  const id = selected.value?.properties.id
  if (!id || !orbitPayload.value) return []
  return orbitPayload.value.items.filter((item) =>
    item.reservoir_id === id &&
    (selectedSatellite.value === '全部卫星' || item.satellite === selectedSatellite.value),
  )
})

const satelliteOptions = computed(() => {
  const reservoirId = selected.value?.properties.id
  const passes = (orbitPayload.value?.items ?? []).filter((item) => item.reservoir_id === reservoirId)
  return ['全部卫星', ...new Set(passes.map((item) => item.satellite))]
})

const recommendations = computed(() => selectedPasses.value.map((item) => buildExperimentRecommendation(
  item,
  weather.value,
  { maxCloud: maxCloud.value, maxRainProbability: maxRain.value, maxWind: maxWind.value },
)))
const rankedRecommendations = computed(() => [...recommendations.value].sort((a, b) => {
  if (a.score === null && b.score === null) return a.satellitePass.date.localeCompare(b.satellitePass.date)
  if (a.score === null) return 1
  if (b.score === null) return -1
  return b.score - a.score || a.satellitePass.date.localeCompare(b.satellitePass.date)
}))
const bestRecommendations = computed(() => rankedRecommendations.value.filter((item) => item.level === '推荐').slice(0, 4))

function formatDate(date: string, includeYear = false) {
  const value = new Date(`${date}T00:00:00+08:00`)
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', weekday: 'short', ...(includeYear ? { year: 'numeric' } : {}),
    timeZone: 'Asia/Shanghai',
  }).format(value)
}

function formatTimestamp(value?: string | null) {
  if (!value) return '暂无'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value))
}

function glintLabel(risk: 'high' | 'medium' | 'low' | 'minimal') {
  return { high: '高', medium: '中', low: '低', minimal: '极低' }[risk]
}

function scrollWeather(direction: number) {
  weatherStrip.value?.scrollBy({ left: direction * 360, behavior: 'smooth' })
}

function scrollSatelliteFilters(direction: number) {
  satelliteFilterStrip.value?.scrollBy({ left: direction * 240, behavior: 'smooth' })
}

function scrollFiltersWithWheel(event: WheelEvent) {
  const strip = event.currentTarget as HTMLDivElement | null
  if (!strip || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
  const atStart = strip.scrollLeft <= 0
  const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 1
  if ((event.deltaY < 0 && atStart) || (event.deltaY > 0 && atEnd)) return
  event.preventDefault()
  strip.scrollBy({ left: event.deltaY, behavior: 'auto' })
}

function reservoirStyle(feature?: ReservoirFeature) {
  const active = feature?.properties.id === selected.value?.properties.id
  return {
    color: active ? '#fbbf24' : '#2dd4bf', weight: active ? 3 : 1.2,
    fillColor: active ? '#f59e0b' : '#0891b2', fillOpacity: active ? 0.66 : 0.4,
  }
}

function refreshLayerStyles() {
  reservoirLayer?.setStyle((feature) => reservoirStyle(feature as ReservoirFeature))
}

function replaceBaseLayers(targetMap: L.Map, layers: L.TileLayer[]) {
  activeBaseLayers.forEach((layer) => targetMap.removeLayer(layer))
  activeBaseLayers = layers
  layers.forEach((layer) => layer.addTo(targetMap))
}

async function showLocalBoundaryFallback(targetMap: L.Map) {
  if (fallbackBoundaryLayer || map !== targetMap) return
  try {
    const [provinceResponse, citiesResponse] = await Promise.all([
      fetch('/data/henan-boundary.geojson'), fetch('/data/henan-cities.geojson'),
    ])
    if (!provinceResponse.ok || !citiesResponse.ok || map !== targetMap) return
    const [province, cities] = await Promise.all([provinceResponse.json(), citiesResponse.json()])
    fallbackBoundaryLayer = L.layerGroup([
      L.geoJSON(cities as GeoJsonObject, { style: { color: '#7899a8', weight: 1, opacity: 0.65, fillOpacity: 0 } }),
      L.geoJSON(province as GeoJsonObject, { style: { color: '#fbbf24', weight: 2, opacity: 0.8, fillOpacity: 0 } }),
    ]).addTo(targetMap)
  } catch {
    // Reservoir vectors remain usable even if the optional boundary fallback fails.
  }
}

function addOpenStreetMap(targetMap: L.Map) {
  let loaded = false
  let errorCount = 0
  const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; OpenStreetMap contributors',
  })
  osm.on('tileload', () => {
    loaded = true
    basemapStatus.value = 'osm'
  })
  osm.on('tileerror', () => {
    errorCount += 1
    if (!loaded && errorCount >= 4) {
      basemapStatus.value = 'unavailable'
      void showLocalBoundaryFallback(targetMap)
    }
  })
  replaceBaseLayers(targetMap, [osm])
}

function addConfiguredBasemap(targetMap: L.Map) {
  if (!tiandituKey) {
    addOpenStreetMap(targetMap)
    return
  }
  const key = encodeURIComponent(tiandituKey)
  let loaded = false
  let errorCount = 0
  let fallbackStarted = false
  const vector = L.tileLayer(`https://t{s}.tianditu.gov.cn/vec_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=vec&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk=${key}`, {
    subdomains: '01234567', maxZoom: 18, attribution: '&copy; 天地图',
  })
  const labels = L.tileLayer(`https://t{s}.tianditu.gov.cn/cva_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=cva&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk=${key}`, {
    subdomains: '01234567', maxZoom: 18,
  })
  vector.on('tileload', () => {
    loaded = true
    basemapStatus.value = 'tianditu'
  })
  vector.on('tileerror', () => {
    errorCount += 1
    if (!loaded && errorCount >= 4 && !fallbackStarted) {
      fallbackStarted = true
      addOpenStreetMap(targetMap)
    }
  })
  replaceBaseLayers(targetMap, [vector, labels])
}

async function loadSelectedWeather() {
  const feature = selected.value
  if (!feature) return
  const requestId = ++weatherRequest
  weatherLoading.value = true
  weatherError.value = ''
  weather.value = null
  try {
    const result = await fetchWeather(feature.properties.lat, feature.properties.lon)
    if (requestId === weatherRequest) weather.value = result
  } catch (error) {
    if (requestId === weatherRequest) {
      weatherError.value = error instanceof Error ? error.message : '天气数据暂不可用'
    }
  } finally {
    if (requestId === weatherRequest) weatherLoading.value = false
  }
}

function selectReservoir(feature: ReservoirFeature, focus = true) {
  selected.value = feature
  selectedSatellite.value = '全部卫星'
  listOpenOnMobile.value = false
  refreshLayerStyles()
  const layer = featureLayers.get(feature.properties.id)
  if (focus && layer && map && 'getBounds' in layer) map.fitBounds((layer as L.Polygon).getBounds(), { padding: [42, 42], maxZoom: 12 })
  void loadSelectedWeather()
}

function initializeMap(collection: ReservoirCollection) {
  if (!mapElement.value) return
  map = L.map(mapElement.value, { zoomControl: false }).setView([34.2, 113.6], 7)
  L.control.zoom({ position: 'bottomright' }).addTo(map)
  addConfiguredBasemap(map)
  reservoirLayer = L.geoJSON(collection as GeoJsonObject, {
    style: (feature) => reservoirStyle(feature as ReservoirFeature),
    onEachFeature: (rawFeature, layer) => {
      const feature = rawFeature as ReservoirFeature
      featureLayers.set(feature.properties.id, layer)
      layer.bindTooltip(feature.properties.name_cn, { className: 'reservoir-tooltip', sticky: true })
      layer.on('click', () => selectReservoir(feature, true))
    },
  }).addTo(map)
  map.fitBounds(reservoirLayer.getBounds(), { padding: [24, 24] })
}

async function loadApplication() {
  loading.value = true
  loadError.value = ''
  try {
    const [reservoirResponse, orbitResponse] = await Promise.all([
      fetch('/data/reservoirs.geojson'), fetch('/data/orbit-passes.json'),
    ])
    if (!reservoirResponse.ok || !orbitResponse.ok) throw new Error('静态观测数据加载失败')
    const collection = await reservoirResponse.json() as ReservoirCollection
    orbitPayload.value = await orbitResponse.json() as OrbitPassPayload
    reservoirs.value = collection.features
    loading.value = false
    await nextTick()
    initializeMap(collection)
    if (reservoirs.value.length) selectReservoir(reservoirs.value[0], false)
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '应用加载失败'
    loading.value = false
  }
}

onMounted(loadApplication)
onBeforeUnmount(() => {
  map?.remove()
  map = null
  activeBaseLayers = []
  fallbackBoundaryLayer = null
})
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div class="brand-lockup">
        <button class="mobile-menu" aria-label="打开水库列表" @click="listOpenOnMobile = true"><Menu :size="20" /></button>
        <div class="brand-mark"><FlaskConical :size="23" /></div>
        <div><p class="eyebrow">HENAN RESERVOIR FIELD LAB</p><h1>水库实验观测助手</h1></div>
      </div>
      <div class="topbar-status">
        <span><CloudSun :size="14" />未来16天天气</span>
        <span><Satellite :size="14" />未来30天轨道</span>
        <span class="live-dot">公开访问版</span>
      </div>
    </header>

    <div v-if="loading" class="full-state"><RefreshCw class="spin" :size="28" /><strong>正在加载观测计划数据</strong></div>
    <div v-else-if="loadError" class="full-state error"><CircleAlert :size="30" /><strong>{{ loadError }}</strong><button @click="loadApplication">重新加载</button></div>

    <div v-else class="workspace">
      <aside class="reservoir-sidebar" :class="{ mobileOpen: listOpenOnMobile }">
        <div class="sidebar-title"><div><p class="eyebrow">25 RESERVOIRS</p><h2>选择实验水库</h2></div><button class="mobile-close" @click="listOpenOnMobile = false"><X :size="20" /></button></div>
        <label class="search-box"><Search :size="16" /><input v-model="searchQuery" placeholder="搜索名称、城市或编号" /><button v-if="searchQuery" @click="searchQuery = ''"><X :size="14" /></button></label>
        <div class="reservoir-list">
          <button v-for="feature in filteredReservoirs" :key="feature.properties.id" class="reservoir-item" :class="{ active: selected?.properties.id === feature.properties.id }" @click="selectReservoir(feature)">
            <span class="reservoir-dot"></span><span><strong>{{ feature.properties.name_cn }}</strong><small>{{ feature.properties.city }}</small></span><b>{{ feature.properties.area_km2.toFixed(1) }} km²</b>
          </button>
        </div>
        <div class="sidebar-source"><DatabaseZap :size="15" /><span>轨道数据每日自动更新<br />仅保留完整覆盖窗口</span></div>
      </aside>
      <button v-if="listOpenOnMobile" class="sidebar-backdrop" aria-label="关闭列表" @click="listOpenOnMobile = false"></button>

      <section class="map-panel">
        <div ref="mapElement" class="map"></div>
        <div v-if="selected" class="map-selection"><LocateFixed :size="15" /><strong>{{ selected.properties.name_cn }}</strong><span>{{ selected.properties.lon.toFixed(4) }}, {{ selected.properties.lat.toFixed(4) }}</span></div>
        <div v-if="basemapStatus === 'osm'" class="map-basemap-status fallback">天地图暂不可用，已切换备用底图</div>
        <div v-else-if="basemapStatus === 'unavailable'" class="map-basemap-status unavailable">在线底图不可用，当前显示本地边界</div>
        <div class="map-legend"><span><i></i>省控水库边界</span><span><i class="selected"></i>当前水库</span></div>
      </section>

      <aside v-if="selected" class="detail-panel">
        <section class="detail-hero">
          <p class="eyebrow">FIELD OBSERVATION PLANNER</p>
          <div class="detail-title"><div><h2>{{ selected.properties.name_cn }}</h2><p><MapPinned :size="14" />{{ selected.properties.city }} · {{ selected.properties.area_km2.toFixed(2) }} km²</p></div><span>{{ selected.properties.code }}</span></div>
          <div class="data-freshness"><span>轨道生成 {{ formatTimestamp(orbitPayload?.generated_at) }}</span><span>轨道历元 {{ formatTimestamp(orbitPayload?.element_epoch_latest) }}</span></div>
        </section>

        <section class="notice"><CircleAlert :size="16" /><p>窗口表示轨道和幅宽可完整覆盖水库，不代表卫星运营方已确认成像。耀光按太阳—平静水面—卫星镜面反射几何估算，中高风险窗口已从“推荐”中排除；风浪与实际姿态仍会改变结果，出发前请再次核验。</p></section>

        <section class="panel-section recommendation-section">
          <div class="section-heading"><div><p class="eyebrow">BEST WINDOWS</p><h3>推荐实验日期</h3></div><span>{{ bestRecommendations.length }}个推荐</span></div>
          <div class="thresholds">
            <SlidersHorizontal :size="15" /><label>云量≤<input v-model.number="maxCloud" type="number" min="0" max="100" />%</label><label>降水≤<input v-model.number="maxRain" type="number" min="0" max="100" />%</label><label>风速≤<input v-model.number="maxWind" type="number" min="1" max="20" />m/s</label><span class="glint-rule">自动避开中高耀光</span>
          </div>
          <div class="satellite-filters recommendation-satellite-filters" aria-label="筛选推荐卫星" @wheel="scrollFiltersWithWheel">
            <button v-for="name in satelliteOptions" :key="name" :class="{ active: selectedSatellite === name }" :aria-pressed="selectedSatellite === name" @click="selectedSatellite = name">{{ name }}</button>
          </div>
          <div v-if="weatherLoading" class="inline-state"><RefreshCw class="spin" :size="17" />正在读取逐小时天气</div>
          <div v-else-if="weatherError" class="inline-state error"><CircleAlert :size="17" />{{ weatherError }}<button @click="loadSelectedWeather">重试</button></div>
          <div v-else-if="bestRecommendations.length" class="recommendation-grid">
            <article v-for="item in bestRecommendations" :key="item.satellitePass.id" class="recommendation-card">
              <div class="recommendation-date"><strong>{{ formatDate(item.satellitePass.date) }}</strong><span>{{ item.satellitePass.time }} 北京时间</span></div>
              <b class="score">{{ item.score }}</b>
              <div class="recommendation-satellite"><Satellite :size="15" />{{ item.satellitePass.satellite }}<span class="coverage-badge">完整覆盖</span><span class="glint-badge" :class="`glint-${item.satellitePass.glint_risk}`">耀光{{ glintLabel(item.satellitePass.glint_risk) }}</span></div>
              <p>{{ item.reasons.join(' · ') }}</p>
            </article>
          </div>
          <div v-else-if="weather" class="empty-recommendation">当前阈值下暂无“推荐”窗口，可查看下方备选窗口或适当调整阈值。</div>
        </section>

        <section class="panel-section weather-section">
          <div class="section-heading"><div><p class="eyebrow">OPEN-METEO · 16 DAYS</p><h3>逐日天气预报</h3></div><div class="scroll-buttons"><button aria-label="向左查看天气" @click="scrollWeather(-1)"><ChevronLeft :size="16" /></button><button aria-label="向右查看天气" @click="scrollWeather(1)"><ChevronRight :size="16" /></button></div></div>
          <div v-if="weather" ref="weatherStrip" class="weather-strip">
            <article v-for="day in weather.days" :key="day.date" class="weather-card">
              <span>{{ formatDate(day.date) }}</span><b>{{ weatherSymbol(day.weatherCode) }}</b><strong>{{ Math.round(day.temperatureMax) }}°</strong><small>{{ Math.round(day.temperatureMin) }}° · {{ weatherLabel(day.weatherCode) }}</small><em><CloudRain :size="12" />{{ day.precipitationProbability }}%</em><em><Wind :size="12" />{{ day.windSpeed.toFixed(1) }}m/s</em>
            </article>
          </div>
          <small v-if="weather" class="source-line">{{ weather.source }} · 更新 {{ formatTimestamp(weather.fetchedAt) }}</small>
        </section>

        <section class="panel-section windows-section">
          <div class="section-heading"><div><p class="eyebrow">WEATHER × ORBIT</p><h3>全部联合判断</h3></div><div class="section-heading-actions"><span>{{ selectedPasses.length }}个窗口</span><div class="scroll-buttons"><button aria-label="向左查看卫星" @click="scrollSatelliteFilters(-1)"><ChevronLeft :size="16" /></button><button aria-label="向右查看卫星" @click="scrollSatelliteFilters(1)"><ChevronRight :size="16" /></button></div></div></div>
          <div ref="satelliteFilterStrip" class="satellite-filters" @wheel="scrollFiltersWithWheel">
            <button v-for="name in satelliteOptions" :key="name" :class="{ active: selectedSatellite === name }" :aria-pressed="selectedSatellite === name" @click="selectedSatellite = name">{{ name }}</button>
          </div>
          <div class="window-list">
            <article v-for="item in recommendations" :key="item.satellitePass.id" class="window-row">
              <div class="window-date"><strong>{{ formatDate(item.satellitePass.date) }}</strong><span>{{ item.satellitePass.time }}</span></div>
              <div class="window-main"><strong>{{ item.satellitePass.satellite }} <em class="glint-inline" :class="`glint-${item.satellitePass.glint_risk}`">耀光{{ glintLabel(item.satellitePass.glint_risk) }} {{ item.satellitePass.glint_angle_deg.toFixed(1) }}°</em></strong><span v-if="item.weatherHour">过境云量{{ Math.round(item.weatherHour.cloudCover) }}% · 降水{{ Math.round(item.weatherHour.precipitationProbability) }}% · 风{{ item.weatherHour.windSpeed.toFixed(1) }}m/s</span><span v-else>完整覆盖 · 天气尚未发布</span></div>
              <div class="window-score" :class="item.level"><b>{{ item.score ?? '—' }}</b><span>{{ item.level }}</span></div>
            </article>
          </div>
        </section>

        <footer><CalendarCheck :size="14" />天气按过境时刻附近的逐小时预报匹配 · 耀光角越小风险越高 · 所有时间均为北京时间</footer>
      </aside>
    </div>
  </main>
</template>
