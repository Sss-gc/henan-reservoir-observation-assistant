<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import * as L from 'leaflet'
import { ArrowLeft, CircleAlert, Download, LocateFixed, Minus, Plus, RefreshCw, Ruler } from 'lucide-vue-next'
import type { ReservoirFeature, SamplingReferenceLayouts, SamplingReservoir, SamplingScopeCollection } from '../types'
import {
  addSamplingPoint, buildOviKml, buildSamplingPlan, createSamplingReservoir, getSamplingSchemes,
  MAX_POINT_COUNT, MIN_POINT_COUNT, moveSamplingPoint, removeLastSamplingPoint, reservoirBasin,
  samplingPointDistanceM,
} from '../services/sampling'
import type { SamplingPlan, SamplingScheme } from '../services/sampling'

const props = defineProps<{ reservoirs: ReservoirFeature[]; selected: ReservoirFeature }>()
const emit = defineEmits<{ close: []; select: [feature: ReservoirFeature] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const mapElement = ref<HTMLDivElement | null>(null)
const scopes = shallowRef<SamplingScopeCollection | null>(null)
const references = shallowRef<SamplingReferenceLayouts>({})
const reservoir = shallowRef<SamplingReservoir | null>(null)
const plan = shallowRef<SamplingPlan | null>(null)
const loading = ref(true)
const error = ref('')
const exportMessage = ref('')
const adjustmentMessage = ref('拖动任一编号点可手动调整位置；点位必须保留在河南库区水面内。')
const adjustmentError = ref(false)
const addingPoint = ref(false)
const measuringPoints = ref(false)
const measurementPointIds = ref<number[]>([])
const basemapUnavailable = ref(false)
const schemeId = ref<SamplingScheme['id']>('sync')
const requestController = new AbortController()
let map: L.Map | null = null
let designLayer: L.FeatureGroup | null = null
let resizeObserver: ResizeObserver | null = null
let previousBodyOverflow = ''
const schemes = computed(() => reservoir.value ? getSamplingSchemes(reservoir.value, references.value) : [])
const defaultCount = computed(() => schemes.value.find((scheme) => scheme.id === schemeId.value)?.count ?? 0)
const basinOrder = ['黄河流域', '淮河流域', '长江流域', '海河流域']
const reservoirGroups = computed(() => basinOrder.map((basin) => ({
  basin,
  features: props.reservoirs.filter((feature) =>
    (feature.properties.basin || reservoirBasin(feature.properties.id)) === basin),
})))
const sourceLabel = computed(() => plan.value?.source === 'reference'
  ? `参考实测点位${plan.value?.manualAdjustmentCount ? ` · 手动编辑${plan.value.manualAdjustmentCount}点` : ''}`
  : plan.value?.source === 'shore-candidates'
    ? `岸边候选点位${plan.value?.manualAdjustmentCount ? ` · 手动编辑${plan.value.manualAdjustmentCount}点` : ''}`
    : `自动设计点位${plan.value?.manualAdjustmentCount ? ` · 手动编辑${plan.value.manualAdjustmentCount}点` : ''}`)
const measurementText = computed(() => {
  if (!measuringPoints.value) return '依次点击两个编号点，显示两点直线距离'
  const points = measurementPointIds.value
    .map((id) => plan.value?.points.find((point) => point.id === id))
    .filter((point) => point !== undefined)
  if (!points.length) return '测距已开启：请选择第一个编号点'
  if (points.length === 1) return `已选 ${points[0].name}：请再选择一个不同点位`
  const distance = samplingPointDistanceM(points[0], points[1])
  return `${points[0].name} ↔ ${points[1].name}：${distance.toLocaleString('zh-CN')} m`
})

function close() { emit('close') }

function changeReservoir(event: Event) {
  const feature = props.reservoirs.find((item) => item.properties.id === (event.target as HTMLSelectElement).value)
  if (feature) emit('select', feature)
}

async function loadData() {
  loading.value = true
  error.value = ''
  try {
    const [scopeResponse, referenceResponse] = await Promise.all([
      fetch('/data/reservoir-sampling-scopes.geojson', { signal: requestController.signal }),
      fetch('/data/sampling-reference.json', { signal: requestController.signal }),
    ])
    if (!scopeResponse.ok || !referenceResponse.ok) throw new Error('点位设计数据加载失败，请重试')
    scopes.value = await scopeResponse.json()
    references.value = await referenceResponse.json()
    rebuild()
  } catch (cause) {
    if (!requestController.signal.aborted) error.value = cause instanceof Error ? cause.message : '点位设计数据加载失败'
  } finally {
    loading.value = false
  }
}

function rebuild(count?: number, nextScheme = schemeId.value) {
  if (!scopes.value) return
  error.value = ''
  exportMessage.value = ''
  adjustmentMessage.value = '拖动任一编号点可手动调整位置；点位必须保留在河南库区水面内。'
  adjustmentError.value = false
  addingPoint.value = false
  measuringPoints.value = false
  measurementPointIds.value = []
  try {
    const scope = scopes.value.features.find((feature) => feature.properties.id === props.selected.properties.id)
    if (!scope) throw new Error('该水库暂缺河南库区采样边界')
    const nextReservoir = createSamplingReservoir(props.selected, scope)
    const nextPlan = buildSamplingPlan(nextReservoir, references.value, { schemeId: nextScheme, count })
    reservoir.value = nextReservoir
    plan.value = nextPlan
    schemeId.value = nextScheme
    drawPlan()
  } catch (cause) {
    plan.value = null
    designLayer?.clearLayers()
    error.value = cause instanceof Error ? cause.message : '点位生成失败'
  }
}

function toggleAddingPoint() {
  if (!plan.value || plan.value.count >= MAX_POINT_COUNT) return
  addingPoint.value = !addingPoint.value
  measuringPoints.value = false
  measurementPointIds.value = []
  adjustmentError.value = false
  adjustmentMessage.value = addingPoint.value
    ? `添加模式：请在水面上点击放置 ${String(plan.value.count + 1).padStart(2, '0')} 号点。`
    : '已取消添加点位；现有布局保持不变。'
  drawPlan(false)
}

function addPointAtMapLocation(event: L.LeafletMouseEvent) {
  if (!addingPoint.value || !reservoir.value || !plan.value) return
  try {
    plan.value = addSamplingPoint(reservoir.value, plan.value, event.latlng.lng, event.latlng.lat)
    addingPoint.value = false
    measuringPoints.value = false
    measurementPointIds.value = []
    adjustmentError.value = false
    adjustmentMessage.value = `${plan.value.points.at(-1)?.name} 号点已添加；原有点位均保持不变，可继续拖动微调。`
    drawPlan(false)
  } catch (cause) {
    adjustmentError.value = true
    adjustmentMessage.value = cause instanceof Error ? cause.message : '新增点位失败，请在水面内重试'
  }
}

function removeLastPoint() {
  if (!plan.value) return
  const removedName = plan.value.points.at(-1)?.name
  try {
    plan.value = removeLastSamplingPoint(plan.value)
    addingPoint.value = false
    measuringPoints.value = false
    measurementPointIds.value = []
    adjustmentError.value = false
    adjustmentMessage.value = `${removedName} 号点已删除；其余点位位置保持不变。`
    drawPlan(false)
  } catch (cause) {
    adjustmentError.value = true
    adjustmentMessage.value = cause instanceof Error ? cause.message : '删除点位失败'
  }
}

function togglePointMeasurement() {
  measuringPoints.value = !measuringPoints.value
  measurementPointIds.value = []
  addingPoint.value = false
  adjustmentError.value = false
  drawPlan(false)
}

function selectMeasurementPoint(pointId: number) {
  if (!measuringPoints.value) return
  const selected = measurementPointIds.value
  if (selected.length === 1 && selected[0] !== pointId) measurementPointIds.value = [selected[0], pointId]
  else if (selected.length !== 1) measurementPointIds.value = [pointId]
  drawPlan(false)
}

function initializeMap() {
  if (!mapElement.value) return
  map = L.map(mapElement.value, { zoomControl: false, maxZoom: 19 }).setView([34.2, 113.6], 7)
  map.attributionControl.setPrefix(false)
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map)
  designLayer = L.featureGroup().addTo(map)
  map.on('click', addPointAtMapLocation)
  const key = import.meta.env.VITE_TIANDITU_KEY?.trim()
  if (key) {
    let loaded = false
    let failures = 0
    for (const layer of ['vec', 'cva']) {
      const tiles = L.tileLayer(`https://t{s}.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk=${encodeURIComponent(key)}`, {
        subdomains: '01234567', maxNativeZoom: 18, maxZoom: 19,
        attribution: layer === 'vec' ? '&copy; 天地图' : undefined,
      })
      if (layer === 'vec') {
        tiles.on('tileload', () => { loaded = true; basemapUnavailable.value = false })
        tiles.on('tileerror', () => { if (!loaded && ++failures >= 4) basemapUnavailable.value = true })
      }
      tiles.addTo(map)
    }
  } else basemapUnavailable.value = true
  resizeObserver = new ResizeObserver(() => map?.invalidateSize())
  resizeObserver.observe(mapElement.value)
}

function drawPlan(shouldFit = true) {
  if (!map || !designLayer || !reservoir.value || !plan.value) return
  designLayer.clearLayers()
  const coordinates = plan.value.points.map((point) => L.latLng(point.latitude, point.longitude))
  L.polyline(coordinates, { color: '#b44d67', weight: 2, opacity: 0.8, dashArray: '5 7', interactive: false })
    .addTo(designLayer)
  const measuredPoints = measurementPointIds.value
    .map((id) => plan.value?.points.find((point) => point.id === id))
    .filter((point) => point !== undefined)
  if (measuredPoints.length === 2) {
    const distance = samplingPointDistanceM(measuredPoints[0], measuredPoints[1])
    L.polyline(measuredPoints.map((point) => L.latLng(point.latitude, point.longitude)), {
      color: '#9b72cf', weight: 4, opacity: 0.95, interactive: false,
    }).bindTooltip(`${distance.toLocaleString('zh-CN')} m`, {
      permanent: true, direction: 'center', className: 'measurement-distance-tooltip',
    }).addTo(designLayer)
  }
  for (const point of plan.value.points) {
    const popup = document.createElement('div')
    popup.className = 'point-popup'
    popup.textContent = `${point.name} · ${point.longitude.toFixed(8)}, ${point.latitude.toFixed(8)} · WGS84`
    const marker = L.marker([point.latitude, point.longitude], {
      draggable: !measuringPoints.value,
      bubblingMouseEvents: false,
      icon: L.divIcon({
        className: `sampling-point-icon${point.manuallyAdjusted ? ' manually-adjusted' : ''}${measurementPointIds.value.includes(point.id) ? ' measurement-selected' : ''}`,
        html: `<span>${point.name}</span>`,
        iconSize: [28, 28], iconAnchor: [14, 14],
      }),
      title: `采样点 ${point.name}`,
      alt: `采样点 ${point.name}`,
    }).bindPopup(popup).addTo(designLayer)
    marker.on('click', () => {
      if (!measuringPoints.value) return
      marker.closePopup()
      selectMeasurementPoint(point.id)
    })
    marker.on('dragstart', () => {
      addingPoint.value = false
      adjustmentError.value = false
      adjustmentMessage.value = `正在调整 ${point.name}，松开后保存新位置。`
    })
    marker.on('dragend', () => {
      if (!reservoir.value || !plan.value) return
      const position = marker.getLatLng()
      try {
        plan.value = moveSamplingPoint(reservoir.value, plan.value, point.id, position.lng, position.lat)
        adjustmentError.value = false
        adjustmentMessage.value = `${point.name} 已移动；坐标、距离指标和导出 KML 已同步更新。`
      } catch (cause) {
        adjustmentError.value = true
        adjustmentMessage.value = cause instanceof Error ? cause.message : '点位移动失败，请重试'
      }
      drawPlan(false)
    })
  }
  if (shouldFit) fitMap()
}

function fitMap() {
  if (!map || !designLayer || !designLayer.getBounds().isValid()) return
  map.invalidateSize()
  map.fitBounds(designLayer.getBounds(), { padding: [36, 36], maxZoom: 15 })
}

function changeMapZoom(delta: number) {
  map?.setZoom((map.getZoom() ?? 7) + delta)
}

function exportKml() {
  if (!reservoir.value || !plan.value) return
  try {
    const blob = new Blob(['\ufeff', buildOviKml(reservoir.value, plan.value)], { type: 'application/vnd.google-earth.kml+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${reservoir.value.name_cn}_${plan.value.schemeLabel}_${plan.value.count}点.kml`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    exportMessage.value = `已生成 ${plan.value.schemeLabel} · ${plan.value.count} 点 KML`
  } catch (cause) {
    exportMessage.value = cause instanceof Error ? cause.message : '导出失败，请重试'
  }
}

watch(() => props.selected.properties.id, () => rebuild())
onMounted(async () => {
  previousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  dialog.value?.showModal()
  await nextTick()
  initializeMap()
  await loadData()
})
onBeforeUnmount(() => {
  requestController.abort()
  resizeObserver?.disconnect()
  map?.remove()
  map = null
  document.body.style.overflow = previousBodyOverflow
})
</script>

<template>
  <dialog ref="dialog" class="sampling-dialog" aria-labelledby="sampling-title" @cancel.prevent="close">
    <div class="designer-shell">
      <header class="designer-header">
        <button class="back-button" aria-label="关闭点位设计，返回观测计划" @click="close"><ArrowLeft :size="19" /><span>返回</span></button>
        <div class="designer-title"><p class="eyebrow">WATER SAMPLING DESIGN</p><h2 id="sampling-title">采样点位设计</h2></div>
        <div class="designer-toolbar" aria-label="点位设计工具栏">
          <button :class="['tool-button', { active: measuringPoints }]" :aria-pressed="measuringPoints" @click="togglePointMeasurement"><Ruler :size="16" />{{ measuringPoints ? '退出测距' : '测两点距离' }}</button>
          <span class="tool-status" aria-live="polite">{{ measurementText }}</span>
        </div>
        <label class="reservoir-selector"><span>当前水库</span><select :value="selected.properties.id" aria-label="选择点位设计水库" @change="changeReservoir">
          <optgroup v-for="group in reservoirGroups" :key="group.basin" :label="group.basin">
            <option v-for="feature in group.features" :key="feature.properties.id" :value="feature.properties.id">{{ feature.properties.name_cn }}</option>
          </optgroup>
        </select></label>
      </header>
      <div class="designer-body">
        <section class="design-map" aria-label="采样点位地图">
          <div :class="['design-map-viewport', { 'adding-point': addingPoint }]"><div ref="mapElement" class="design-map-canvas"></div></div>
          <div class="design-map-toolbar">
            <div class="map-caption"><strong>{{ selected.properties.name_cn }}</strong><span v-if="plan">河南库区 {{ plan.samplingAreaKm2 }} km² · {{ plan.count }} 个点</span></div>
            <div class="design-map-actions"><button class="fit-button" aria-label="放大点位地图" @click="changeMapZoom(1)"><Plus :size="16" /></button><button class="fit-button" aria-label="缩小点位地图" @click="changeMapZoom(-1)"><Minus :size="16" /></button><button class="fit-button" @click="fitMap"><LocateFixed :size="15" />适配点位</button></div>
          </div>
          <div class="route-note"><span :class="['adjustment-state', { error: adjustmentError }]">{{ adjustmentMessage }}</span><br>虚线表示编号顺序，不是安全航线<span v-if="basemapUnavailable"> · 底图暂不可用，点位仍可查看</span></div>
        </section>
        <aside class="design-controls">
          <div v-if="loading" class="design-state" role="status"><RefreshCw class="spin" :size="20" />正在读取点位设计数据</div>
          <div v-else-if="error" class="design-state error" role="alert"><CircleAlert :size="20" /><p>{{ error }}</p><button @click="loadData">重新加载</button></div>
          <template v-if="!loading && plan">
            <section class="control-section">
              <p class="eyebrow">SAMPLING SCHEME</p><h3>选择布点方案</h3>
              <div class="scheme-options">
                <button v-for="scheme in schemes" :key="scheme.id" :class="{ active: schemeId === scheme.id }" :aria-pressed="schemeId === scheme.id" @click="rebuild(undefined, scheme.id)">
                  <strong>{{ scheme.label }}<small>{{ scheme.badge }}</small></strong><span>默认 {{ scheme.count }} 点</span>
                </button>
              </div>
              <p class="scheme-description">{{ plan.schemeDescription }}</p>
              <p v-if="plan.source === 'reference'" class="source-note">保留参考坐标与顺序，统一从 01 编号；使用“＋”可在现有布局后追加点位。</p>
              <p v-else-if="plan.source === 'generated'" class="source-note">自动点位按水面边界筛选，自适应离岸 {{ plan.shorelineBufferM }} m。</p>
              <p v-if="plan.manualAdjustmentCount" class="manual-note">已有 {{ plan.manualAdjustmentCount }} 个点位手动编辑；恢复默认可撤销全部编辑。</p>
              <p v-if="plan.manualAdjustmentCount && plan.bufferException" class="shore-note">手动调整后有点位低于原方案离岸距离，请结合岸线和现场条件复核。</p>
              <p v-if="plan.accessVerificationRequired" class="shore-note">{{ plan.accessNote }}</p>
            </section>
            <section class="control-section">
              <div class="control-heading"><h3>采样点数量</h3><span>{{ MIN_POINT_COUNT }}–{{ MAX_POINT_COUNT }} 点</span></div>
              <div class="count-control">
                <button :disabled="plan.count <= MIN_POINT_COUNT" aria-label="删除最后一个采样点" @click="removeLastPoint"><Minus :size="18" /></button>
                <output aria-live="polite">{{ plan.count }}</output>
                <button :class="{ active: addingPoint }" :disabled="plan.count >= MAX_POINT_COUNT" :aria-label="addingPoint ? '取消添加采样点' : '在地图上追加采样点'" :aria-pressed="addingPoint" @click="toggleAddingPoint"><Plus :size="18" /></button>
              </div>
              <p class="count-hint">点击“＋”后在水面上放置下一个编号点；“－”只删除最后一个点，不会重新排列其余点位。</p>
              <button class="restore-button" :disabled="plan.count === defaultCount && !plan.manualAdjustmentCount" @click="rebuild()">恢复默认 {{ defaultCount }} 点</button>
              <dl class="design-metrics">
                <div><dt>编号连线总长</dt><dd>{{ plan.routeDistanceKm }}<small> km</small></dd></div>
                <div><dt>相邻点平均间距</dt><dd>{{ plan.meanSpacingKm }}<small> km</small></dd></div>
                <div><dt>最小离岸距离</dt><dd>{{ plan.minimumShoreDistanceM }}<small> m</small></dd></div>
                <div><dt>点位来源</dt><dd class="source-value">{{ sourceLabel }}</dd></div>
              </dl>
            </section>
            <section class="control-section coordinate-section">
              <details>
                <summary>点位坐标明细 <span>WGS84 · {{ plan.count }} 点</span></summary>
                <div class="coordinate-scroll"><table><thead><tr><th>编号</th><th>经度</th><th>纬度</th></tr></thead><tbody>
                  <tr v-for="point in plan.points" :key="point.id"><td>{{ point.name }}<small v-if="point.manuallyAdded"> 新增</small><small v-else-if="point.manuallyAdjusted"> 手调</small></td><td>{{ point.longitude.toFixed(8) }}</td><td>{{ point.latitude.toFixed(8) }}</td></tr>
                </tbody></table></div>
              </details>
            </section>
            <div class="export-area">
              <button class="export-button" @click="exportKml"><Download :size="17" />导出当前方案 KML</button>
              <p>将导出 {{ plan.schemeLabel }} · {{ plan.count }} 点，可导入奥维。</p>
              <p v-if="exportMessage" class="export-status" role="status">{{ exportMessage }}</p>
              <p class="design-footnote">坐标保留原始经纬度。出发前请结合水位、岸线、禁航区和现场条件复核。</p>
            </div>
          </template>
        </aside>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.sampling-dialog{position:fixed;inset:0;width:100%;height:100%;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:#06141d;color:#e5f2f7}
.sampling-dialog::backdrop{background:#06141d}
.designer-shell{height:100%;display:flex;flex-direction:column}
.designer-header{display:flex;align-items:center;gap:20px;flex:none;padding:16px 24px;border-bottom:1px solid var(--line);background:#0a1d29}
.designer-title{flex:0 0 auto}.designer-title h2{font-size:20px;margin:3px 0 0}
.back-button,.fit-button,.restore-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;border:1px solid #365462;background:#102b38;border-radius:9px;padding:9px 12px;cursor:pointer;color:#c6e0e8;font-size:12px}
.designer-toolbar{display:flex;align-items:center;flex:1;min-width:260px;max-width:760px;height:42px;overflow:hidden;border:1px solid #365462;border-radius:10px;background:#091f2c}
.tool-button{display:inline-flex;align-items:center;align-self:stretch;gap:7px;flex:0 0 auto;padding:0 14px;border:0;border-right:1px solid #365462;background:#143441;color:#c7e2e8;cursor:pointer;font-size:12px;font-weight:600}.tool-button.active{background:#1f6f63;color:#effffc}.tool-status{min-width:0;overflow:hidden;padding:0 13px;color:#8fb4bf;font-size:11px;text-overflow:ellipsis;white-space:nowrap}.tool-button.active+.tool-status{color:#8fe4d4}
.reservoir-selector{display:flex;align-items:center;gap:10px;color:#8baab9;font-size:12px}
.reservoir-selector select{max-width:240px;min-width:170px;padding:10px 12px;border:1px solid #365462;border-radius:9px;background:#102b38;color:#e5f2f7;font:inherit}
.designer-body{display:grid;grid-template-columns:minmax(0,1fr) 360px;flex:1;min-height:0}
.design-map{position:relative;min-height:0;display:flex;flex-direction:column;background:#0a1d29}
.design-map-viewport{position:relative;flex:1;min-height:0;background:#e0eaeb}.design-map-canvas{position:absolute;inset:0}
.design-map-viewport.adding-point :deep(.leaflet-container){cursor:crosshair}
.design-map-toolbar{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:12px 18px;border-top:1px solid var(--line)}
.map-caption{display:flex;flex-direction:column;gap:4px;min-width:0}
.map-caption strong{font-size:15px}.map-caption span{font-size:11px;color:#aad1da}
.fit-button{flex-shrink:0}
.design-map-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}
.route-note{padding:0 18px 12px;font-size:11px;color:#91afbd;line-height:1.6}.route-note span{color:#d9a789}.route-note .adjustment-state{color:#83d7ca}.route-note .adjustment-state.error{color:#efad98}
.design-controls{min-height:0;overflow:auto;background:#0a1d29;border-left:1px solid var(--line)}
.control-section{padding:22px;border-bottom:1px solid var(--line)}.control-section h3{margin:5px 0 14px;font-size:16px}
.scheme-options{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.scheme-options button{display:flex;flex-direction:column;gap:8px;padding:13px 10px;border:1px solid #365462;border-radius:11px;background:#102b38;cursor:pointer;text-align:left;color:#bdd1dc}
.scheme-options button.active{border-color:#2dd4bf;background:#16453f;color:#e2fff9}
.scheme-options strong{font-size:13px;display:flex;gap:6px;align-items:center}.scheme-options small{font-size:9px;font-weight:400;padding:2px 4px;border-radius:4px;background:#ffffff12;color:#a7d9cf}.scheme-options span{font-size:11px}
.scheme-description,.source-note,.manual-note,.shore-note{font-size:12px;line-height:1.7;margin:12px 0 0;color:#b1cbd6}
.source-note{color:#83a5b6}.manual-note{color:#83d7ca}.shore-note{color:#e1b393;background:#c0795314;border-radius:8px;padding:10px}
.control-heading{display:flex;align-items:center;justify-content:space-between;gap:10px}.control-heading h3{margin:0}.control-heading span{color:#83a5b6;font-size:11px}
.count-control{display:flex;align-items:center;justify-content:space-between;margin-top:15px;border:1px solid #365462;border-radius:10px;overflow:hidden;background:#091f2c}
.count-control button{display:grid;place-items:center;width:48px;align-self:stretch;border:0;background:#163643;cursor:pointer;color:#d2e9ee}
.count-control output{display:grid;place-items:center;width:100%;min-width:0;height:48px;text-align:center;color:#e5f2f7;font-size:22px;font-weight:700}
.count-control button.active{background:#1f6f63;color:#ecfffb;box-shadow:inset 0 0 0 1px #61d5c2}
.count-hint{margin:9px 0 0;color:#83a5b6;font-size:11px;line-height:1.65}
button:disabled{opacity:.4;cursor:default}.restore-button{margin-top:10px;width:100%;background:transparent;font-size:11px}
.design-metrics{display:grid;grid-template-columns:1fr 1fr;gap:18px 10px;margin:22px 0 0}.design-metrics dt{color:#83a5b6;font-size:11px}.design-metrics dd{margin:5px 0 0;font-size:23px;font-weight:600;color:#d8f5f1}.design-metrics dd small{font-size:11px;font-weight:400;color:#83a5b6}.design-metrics dd.source-value{font-size:13px;line-height:28px}
.coordinate-section{padding-top:16px;padding-bottom:16px}summary{cursor:pointer;font-size:13px}summary span{float:right;color:#83a5b6;font-size:10px}
.coordinate-scroll{max-height:240px;overflow:auto;margin-top:14px}table{width:100%;border-collapse:collapse;font-size:10px;font-variant-numeric:tabular-nums}th,td{text-align:right;padding:8px 4px;border-bottom:1px solid var(--line)}th{color:#83a5b6;position:sticky;top:0;background:#0a1d29}th:first-child,td:first-child{text-align:left}.coordinate-scroll td small{color:#f1c875;font-size:8px}
.export-area{padding:22px}.export-button{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;padding:14px 10px;border:1px solid #58cbb9;border-radius:10px;background:#225d54;color:#edfffc;font-weight:600;font-size:14px;cursor:pointer}.export-button:hover{background:#2b7266}
.export-area p{font-size:11px;line-height:1.7;color:#9fbdca;margin:10px 0 0}.export-area .export-status{color:#82e2cb}.export-area .design-footnote{color:#7193a4;margin-top:18px}
.design-state{padding:30px 22px;display:flex;flex-wrap:wrap;align-items:center;gap:10px;font-size:13px}.design-state.error{color:#efb099}.design-state button{border:1px solid #365462;border-radius:8px;background:#102b38;color:#c6e0e8;padding:8px 12px;cursor:pointer}
.design-map :deep(.sampling-point-icon){border:0;background:transparent}.design-map :deep(.sampling-point-icon span){display:grid;place-items:center;width:28px;height:28px;border:2px solid #eafffa;border-radius:50%;background:#116b63;color:white;box-shadow:0 2px 7px #001e3440;cursor:grab;font:700 11px/1 system-ui}.design-map :deep(.sampling-point-icon.manually-adjusted span){background:#9a6718;border-color:#fff4ca}.design-map :deep(.sampling-point-icon.measurement-selected span){background:#6f52a3;border-color:#fff;box-shadow:0 0 0 4px #b48ead66,0 2px 7px #001e3440;cursor:pointer}.design-map :deep(.leaflet-drag-target .sampling-point-icon span){cursor:grabbing}
.design-map :deep(.measurement-distance-tooltip){border:1px solid #c9a8e8;border-radius:8px;background:#241b36;color:#fff;box-shadow:0 2px 8px #06141d80;font:700 11px/1 system-ui}
.design-map :deep(.point-popup){font-size:12px;line-height:1.7}
:where(button,input,select,summary):focus-visible{outline:2px solid #70e9d5;outline-offset:3px}
@media(max-width:800px){.designer-body{display:block;overflow:auto}.design-map{height:auto;min-height:0}.design-map-viewport{flex:none;height:clamp(280px,46vh,440px)}.design-controls{overflow:visible;border-left:0}.designer-header{padding:12px;gap:10px;flex-wrap:wrap}.designer-title h2{font-size:17px}.designer-toolbar{order:3;flex:1 0 100%;max-width:none}.reservoir-selector{width:100%}.reservoir-selector select{max-width:none;flex:1}.control-section{padding:18px}.design-metrics{grid-template-columns:repeat(4,1fr);gap:10px}.export-area{padding:18px;padding-bottom:max(18px,env(safe-area-inset-bottom))}}
@media(max-width:420px){.design-metrics{grid-template-columns:1fr 1fr}.design-map-toolbar{padding:10px 12px;flex-wrap:wrap}.fit-button{padding:10px}.route-note{padding:0 12px 10px;font-size:10px}.designer-header .eyebrow{font-size:8px}}
</style>
