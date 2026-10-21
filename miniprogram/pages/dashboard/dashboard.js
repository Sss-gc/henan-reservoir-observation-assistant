const data = require('../../utils/data')
const sampling = require('../../utils/sampling')
const { showTab, prepareTabPage } = require('../../utils/tab-page')

const BASIN_ORDER = ['黄河流域', '淮河流域', '长江流域', '海河流域']
const POINT_NUDGE_METERS = 20
const POINT_ADJUSTMENT_IDLE_MESSAGE = '点选编号点后，用方向键每次移动约 20 米'
const basinOrder = Object.fromEntries(BASIN_ORDER.map((name, index) => [name, index]))
const reservoirOptions = data.getReservoirList()
  .sort((a, b) => basinOrder[a.basin] - basinOrder[b.basin] || a.code.localeCompare(b.code))
  .map((item) => ({ ...item, pickerLabel: `${item.basin} · ${item.name_cn}` }))

function groupReservoirOptions(items) {
  const counts = items.reduce((result, item) => ({ ...result, [item.basin]: (result[item.basin] || 0) + 1 }), {})
  let previousBasin = ''
  return items.map((item) => {
    const showBasinHeader = item.basin !== previousBasin
    previousBasin = item.basin
    return { ...item, showBasinHeader, basinResultCount: counts[item.basin] }
  })
}

function createPointPreview(reservoir, requestedSchemeId = 'sync', requestedCount) {
  const pointSchemes = sampling.getSamplingSchemes(reservoir)
  const pointScheme = pointSchemes.find((item) => item.id === requestedSchemeId) || pointSchemes[0]
  const request = { schemeId: pointScheme.id }
  if (Number.isFinite(requestedCount)) request.count = requestedCount
  const pointPlan = sampling.buildSamplingPlan(reservoir, request)
  const pointMap = sampling.buildSamplingMap(pointPlan, data.wgs84ToGcj02)
  return {
    pointSchemes,
    pointSchemeId: pointScheme.id,
    pointSchemeAdjustable: !pointScheme.fixed,
    pointPlan,
    pointMap,
  }
}

Page({
  data: {
    meta: data.meta, reservoirs: reservoirOptions, filteredReservoirs: [], basins: data.getBasins(), activeBasin: '',
    basinLegendCollapsed: false,
    selected: null, keyword: '', pickerOpen: false, weatherDays: [],
    satellite: '全部卫星', satellites: [], recommendations: [], passes: [],
    passTotal: 0, visibleCount: 10, passFilter: '全部', weather: null, weatherPublishedDate: '', loading: false, syncError: '',
    map: null, pointPreviewOpen: false, pointPlan: null, pointMap: null, pointCount: 0,
    pointSchemes: [], pointSchemeId: 'sync', pointSchemeAdjustable: true,
    pointReservoirIndex: 0, pointPickerOpen: false,
    pointReservoirOptions: groupReservoirOptions(reservoirOptions),
    pointAdjustingId: 0, pointAdding: false, pointMeasuring: false, pointMeasureIds: [],
    pointMeasureDistanceM: 0, pointMeasureTarget: null, pointHasEdits: false, pointAdjustmentError: false,
    pointAdjustmentMessage: POINT_ADJUSTMENT_IDLE_MESSAGE,
    pointExportLoading: false, pointExportError: '',
    maxPointCount: sampling.MAX_POINT_COUNT,
  },
  onLoad(options) {
    prepareTabPage()
    if (options && data.getReservoir(options.reservoir)) getApp().selectReservoir(options.reservoir)
  },
  onReady() {
    this._mapContext = wx.createMapContext('reservoir-map')
    this._mapReady = true; this.fitMap()
  },
  onUnload() { this._mapReady = false; this._pointMapReady = false; this.setTabBarHidden(false) },
  onShow() {
    showTab(this, 0)
    const id = getApp().globalData.selectedReservoirId
    if (!this.data.selected || this.data.selected.id !== id) this.loadReservoir(id)
    return this.syncData()
  },
  async syncData(force = false) {
    if (this.data.loading) return
    if (!force && data.hasRecentData()) {
      if (this._renderedAt !== data.meta.loadedAt) {
        this.setData({ meta: { ...data.meta } })
        this.loadReservoir(this.data.selected.id, false)
      }
      return
    }
    this.setData({ loading: force || !data.hasRecentData(), syncError: '' })
    try {
      await data.refresh(force)
      this.setData({ meta: { ...data.meta } })
      this.loadReservoir(this.data.selected.id, false)
    } catch (error) {
      this.setData({ syncError: error.message })
    } finally { this.setData({ loading: false }); wx.stopPullDownRefresh() }
  },
  loadReservoir(id, resetFilters = true) {
    const selected = data.getReservoirList().find((item) => item.id === id) || data.getReservoirList()[0]
    getApp().selectReservoir(selected.id)
    const mapChanged = !this.data.map || this.data.selected?.id !== selected.id
    const map = mapChanged ? data.buildNativeMapData(data.getMapData(selected.id)) : null
    const weather = data.getWeather(selected.id)
    if (map) {
      this._markerIds = map.markerIds; this._markerBasins = map.markerBasins
      this._currentBounds = map.currentBounds; this._allBounds = map.allBounds
    }
    this._renderedAt = data.meta.loadedAt
    this.setData({
      selected, weather, weatherPublishedDate: weather?.publishedAt?.slice(0, 10) || '未标注',
      weatherDays: data.getWeatherCards(selected.id), satellites: data.getSatelliteOptions(selected.id),
      satellite: resetFilters || !data.getSatelliteOptions(selected.id).includes(this.data.satellite) ? '全部卫星' : this.data.satellite,
      passFilter: resetFilters ? '全部' : this.data.passFilter, visibleCount: resetFilters ? 10 : this.data.visibleCount,
      keyword: '', pickerOpen: false, activeBasin: '',
      ...(map ? { map: map.view } : {}),
    }, map ? () => this.fitMap() : undefined)
    this.updatePasses()
  },
  updatePasses() {
    let passes = data.getPasses(this.data.selected.id, this.data.satellite)
    if (this.data.passFilter === '仅晴天') passes = passes.filter((pass) => pass.level === '推荐')
    if (this.data.passFilter === '待预报') passes = passes.filter((pass) => pass.level === '待预报')
    this.setData({
      passes: passes.slice(0, this.data.visibleCount), passTotal: passes.length,
      recommendations: data.getBestPasses(this.data.selected.id, this.data.satellite),
    })
  },
  onSearch(event) {
    const keyword = event.detail.value
    const query = keyword.trim().toLowerCase()
    const matches = this.data.reservoirs.filter((r) =>
      [r.name_cn, r.city, r.basin, r.code].some((value) => value.toLowerCase().includes(query)))
    this.setData({ keyword, pickerOpen: true, filteredReservoirs: groupReservoirOptions(matches) })
  },
  openPicker() { this.setData({ pickerOpen: true, filteredReservoirs: groupReservoirOptions(this.data.reservoirs) }) },
  togglePicker() { if (this.data.pickerOpen) this.closePicker(); else this.openPicker() },
  closePicker() { this.setData({ pickerOpen: false, keyword: '' }) },
  selectReservoir(event) { this.loadReservoir(event.currentTarget.dataset.id) },
  selectMarker(event) {
    const id = this._markerIds[event.detail.markerId]
    if (id) this.loadReservoir(id)
  },
  selectSatellite(event) {
    this.setData({ satellite: event.currentTarget.dataset.name, visibleCount: 10 })
    this.updatePasses()
  },
  selectPassFilter(event) {
    this.setData({ passFilter: event.currentTarget.dataset.name, visibleCount: 10 })
    this.updatePasses()
  },
  loadMore() { this.setData({ visibleCount: this.data.visibleCount + 10 }); this.updatePasses() },
  openPass(event) { wx.navigateTo({ url: `/pages/pass/pass?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }) },
  openPlan() { wx.switchTab({ url: '/pages/plan/plan' }) },
  setTabBarHidden(hidden) {
    const tabBar = typeof this.getTabBar === 'function' ? this.getTabBar() : null
    if (tabBar?.setData) tabBar.setData({ hidden })
  },
  openSamplingPreview() {
    try {
      const reservoir = data.getReservoir(this.data.selected.id)
      const preview = createPointPreview(reservoir, 'sync')
      this._mapReady = false
      this._pointMapPoints = preview.pointMap.includePoints
      this.setTabBarHidden(true)
      this.setData({ pointPreviewOpen: true, pointPickerOpen: false, pointAdjustingId: 0, pointAdding: false,
        pointMeasuring: false, pointMeasureIds: [], pointMeasureDistanceM: 0, pointMeasureTarget: null, pointHasEdits: false,
        pointAdjustmentError: false, pointAdjustmentMessage: POINT_ADJUSTMENT_IDLE_MESSAGE,
        pointSchemes: preview.pointSchemes,
        pointSchemeId: preview.pointSchemeId, pointSchemeAdjustable: preview.pointSchemeAdjustable,
        pointPlan: preview.pointPlan, pointMap: preview.pointMap.view, pointCount: preview.pointPlan.count,
        pointReservoirIndex: this.data.reservoirs.findIndex((item) => item.id === reservoir.id), pointExportError: '' }, () => {
        this._pointMapContext = wx.createMapContext('sampling-full-map')
        this._pointMapReady = true
        this.fitPointPreview()
      })
    } catch (error) {
      wx.showModal({ title: '点位预览打开失败', content: error?.message || String(error), showCancel: false })
    }
  },
  closeSamplingPreview() {
    this._pointMapReady = false
    this.setData({ pointPreviewOpen: false, pointPickerOpen: false, pointAdjustingId: 0, pointAdding: false,
      pointMeasuring: false, pointMeasureIds: [], pointMeasureDistanceM: 0, pointMeasureTarget: null }, () => {
      this.setTabBarHidden(false)
      this._mapContext = wx.createMapContext('reservoir-map')
      this._mapReady = true
      this.fitMap()
    })
  },
  fitPointPreview() {
    if (this._pointMapReady && this._pointMapPoints?.length) this._pointMapContext.includePoints({
      points: this._pointMapPoints, padding: [34, 34, 34, 34],
    })
  },
  togglePointReservoirPicker() {
    const pointPickerOpen = !this.data.pointPickerOpen
    this.setData({ pointPickerOpen }, () => {
      if (!pointPickerOpen) this.fitPointPreview()
    })
  },
  selectPointReservoir(event) {
    const requestedId = event.currentTarget?.dataset?.id
    const index = requestedId
      ? this.data.reservoirs.findIndex((item) => item.id === requestedId)
      : Number(event.detail?.value)
    const selected = this.data.reservoirs[index]
    if (!selected) return
    if (selected.id === this.data.selected.id) {
      this.setData({ pointReservoirIndex: index, pointPickerOpen: false }, () => this.fitPointPreview())
      return
    }
    this.loadReservoir(selected.id)
    const preview = createPointPreview(data.getReservoir(selected.id), this.data.pointSchemeId)
    this._pointMapPoints = preview.pointMap.includePoints
    this.setData({ pointReservoirIndex: index, pointPickerOpen: false, pointAdjustingId: 0, pointAdding: false,
      pointMeasuring: false, pointMeasureIds: [], pointMeasureDistanceM: 0, pointMeasureTarget: null, pointHasEdits: false,
      pointAdjustmentError: false, pointAdjustmentMessage: POINT_ADJUSTMENT_IDLE_MESSAGE,
      pointSchemes: preview.pointSchemes,
      pointSchemeId: preview.pointSchemeId, pointSchemeAdjustable: preview.pointSchemeAdjustable,
      pointPlan: preview.pointPlan, pointMap: preview.pointMap.view, pointCount: preview.pointPlan.count,
      pointExportError: '' }, () => this.fitPointPreview())
  },
  rebuildPointPreview(count, schemeId = this.data.pointSchemeId) {
    const preview = createPointPreview(data.getReservoir(this.data.selected.id), schemeId, count)
    this._pointMapPoints = preview.pointMap.includePoints
    this.setData({ pointSchemes: preview.pointSchemes, pointSchemeId: preview.pointSchemeId,
      pointSchemeAdjustable: preview.pointSchemeAdjustable, pointPlan: preview.pointPlan,
      pointMap: preview.pointMap.view, pointCount: preview.pointPlan.count, pointAdjustingId: 0, pointAdding: false,
      pointMeasuring: false, pointMeasureIds: [], pointMeasureDistanceM: 0, pointMeasureTarget: null, pointHasEdits: false,
      pointAdjustmentError: false, pointAdjustmentMessage: POINT_ADJUSTMENT_IDLE_MESSAGE,
      pointExportError: '' },
      () => this.fitPointPreview())
  },
  selectPointForAdjustment(event) {
    const pointId = Number(event.detail?.markerId)
    const point = this.data.pointPlan?.points.find((item) => item.id === pointId)
    if (!point) return
    this._ignorePointMapTapUntil = Date.now() + 300
    if (this.data.pointMeasuring) {
      this.selectPointForMeasurement(pointId)
      return
    }
    const pointMap = sampling.buildSamplingMap(this.data.pointPlan, data.wgs84ToGcj02, pointId)
    this.setData({ pointAdjustingId: pointId, pointAdding: false, pointMeasuring: false,
      pointMeasureIds: [], pointMeasureDistanceM: 0, pointMeasureTarget: null, pointAdjustmentError: false,
      pointAdjustmentMessage: `已选 ${point.name}，点击方向键精细移动`,
      'pointMap.markers': pointMap.view.markers })
  },
  cancelPointAdjustment() {
    const pointMap = sampling.buildSamplingMap(this.data.pointPlan, data.wgs84ToGcj02)
    this.setData({ pointAdjustingId: 0, pointAdjustmentError: false,
      pointAdjustmentMessage: POINT_ADJUSTMENT_IDLE_MESSAGE,
      'pointMap.markers': pointMap.view.markers })
  },
  restorePointPlan() {
    this.rebuildPointPreview(undefined, this.data.pointSchemeId)
  },
  togglePointMeasurement() {
    const pointMeasuring = !this.data.pointMeasuring
    const pointMap = sampling.buildSamplingMap(this.data.pointPlan, data.wgs84ToGcj02)
    this.setData({ pointMeasuring, pointMeasureIds: [], pointMeasureDistanceM: 0,
      pointMeasureTarget: null,
      pointAdding: false, pointAdjustingId: 0, pointAdjustmentError: false,
      pointAdjustmentMessage: pointMeasuring ? '测距已开启：请选择第一个编号点' : POINT_ADJUSTMENT_IDLE_MESSAGE,
      'pointMap.markers': pointMap.view.markers, 'pointMap.polyline': pointMap.view.polyline })
  },
  selectPointForMeasurement(pointId) {
    const point = this.data.pointPlan.points.find((item) => item.id === pointId)
    if (!point) return
    const selected = this.data.pointMeasureIds
    let pointMeasureIds
    if (selected.length === 1 && selected[0] !== pointId) pointMeasureIds = [selected[0], pointId]
    else if (selected.length !== 1) pointMeasureIds = [pointId]
    else pointMeasureIds = selected
    const points = pointMeasureIds.map((id) => this.data.pointPlan.points.find((point) => point.id === id))
    const pointMeasureDistanceM = points.length === 2 ? sampling.samplingPointDistanceM(points[0], points[1]) : 0
    const pointAdjustmentMessage = points.length === 2
      ? `${points[0].name} ↔ ${points[1].name}：${pointMeasureDistanceM} 米`
      : `已选 ${points[0].name}，再点一个编号点，或点击岸边位置`
    const pointMap = sampling.buildSamplingMap(this.data.pointPlan, data.wgs84ToGcj02, 0, pointMeasureIds)
    this.setData({ pointMeasureIds, pointMeasureDistanceM, pointMeasureTarget: null, pointAdjustmentMessage,
      'pointMap.markers': pointMap.view.markers, 'pointMap.polyline': pointMap.view.polyline })
  },
  nudgeSelectedPoint(event) {
    if (!this.data.pointAdjustingId) return
    const direction = event.currentTarget?.dataset?.direction
    const point = this.data.pointPlan.points.find((item) => item.id === this.data.pointAdjustingId)
    if (!point || !['up', 'down', 'left', 'right'].includes(direction)) return
    const latitudeDelta = POINT_NUDGE_METERS / 110574
    const longitudeDelta = POINT_NUDGE_METERS / (111320 * Math.cos(point.latitude * Math.PI / 180))
    const longitude = point.longitude + (direction === 'right' ? longitudeDelta : direction === 'left' ? -longitudeDelta : 0)
    const latitude = point.latitude + (direction === 'up' ? latitudeDelta : direction === 'down' ? -latitudeDelta : 0)
    const directionLabel = { up: '上', down: '下', left: '左', right: '右' }[direction]
    try {
      const nextPlan = sampling.moveSamplingPoint(data.getReservoir(this.data.selected.id), this.data.pointPlan,
        this.data.pointAdjustingId, longitude, latitude)
      const pointMap = sampling.buildSamplingMap(nextPlan, data.wgs84ToGcj02, this.data.pointAdjustingId)
      this._pointMapPoints = pointMap.includePoints
      this.setData({ pointPlan: nextPlan, pointHasEdits: true, pointAdjustmentError: false,
        pointAdjustmentMessage: `${point.name} 已向${directionLabel}移动约 ${POINT_NUDGE_METERS} 米，可继续微调`,
        'pointMap.markers': pointMap.view.markers, 'pointMap.polyline': pointMap.view.polyline })
    } catch (error) {
      this.setData({ pointAdjustmentError: true,
        pointAdjustmentMessage: error?.message || '点位移动失败，请换一个方向重试' })
    }
  },
  selectPointScheme(event) {
    const schemeId = event.currentTarget.dataset.id
    if (!schemeId || schemeId === this.data.pointSchemeId) return
    this.rebuildPointPreview(undefined, schemeId)
  },
  togglePointAddition() {
    if (!this.data.pointPlan || this.data.pointCount >= this.data.maxPointCount) return
    const pointAdding = !this.data.pointAdding
    const pointMap = sampling.buildSamplingMap(this.data.pointPlan, data.wgs84ToGcj02)
    this.setData({ pointAdding, pointAdjustingId: 0, pointMeasuring: false,
      pointMeasureIds: [], pointMeasureDistanceM: 0, pointMeasureTarget: null, pointAdjustmentError: false,
      pointAdjustmentMessage: pointAdding
        ? `追加模式：请在水面上点击放置 ${String(this.data.pointCount + 1).padStart(2, '0')} 号点`
        : '已取消追加点位；现有布局保持不变',
      'pointMap.markers': pointMap.view.markers, 'pointMap.polyline': pointMap.view.polyline })
  },
  addPointAtMapLocation(event) {
    if (this.data.pointMeasuring && this.data.pointMeasureIds.length === 1) {
      if (Date.now() < (this._ignorePointMapTapUntil || 0)) return
      const point = this.data.pointPlan?.points.find((item) => item.id === this.data.pointMeasureIds[0])
      const longitude = Number(event.detail?.longitude), latitude = Number(event.detail?.latitude)
      if (!point || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return
      const pointMeasureTarget = data.gcj02ToWgs84(longitude, latitude)
      const pointMeasureDistanceM = sampling.samplingPointDistanceM(point, pointMeasureTarget)
      const pointMap = sampling.buildSamplingMap(
        this.data.pointPlan, data.wgs84ToGcj02, 0, [point.id], pointMeasureTarget)
      this.setData({ pointMeasureTarget, pointMeasureDistanceM,
        pointAdjustmentMessage: `${point.name} 到所选岸边位置：${pointMeasureDistanceM} 米`,
        'pointMap.markers': pointMap.view.markers, 'pointMap.polyline': pointMap.view.polyline })
      return
    }
    if (!this.data.pointAdding || Date.now() < (this._ignorePointMapTapUntil || 0)) return
    const longitude = Number(event.detail?.longitude), latitude = Number(event.detail?.latitude)
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return
    try {
      const wgs84 = data.gcj02ToWgs84(longitude, latitude)
      const nextPlan = sampling.addSamplingPoint(data.getReservoir(this.data.selected.id), this.data.pointPlan,
        wgs84.longitude, wgs84.latitude)
      const addedPoint = nextPlan.points.at(-1)
      const pointMap = sampling.buildSamplingMap(nextPlan, data.wgs84ToGcj02, addedPoint.id)
      this._pointMapPoints = pointMap.includePoints
      this.setData({ pointPlan: nextPlan, pointCount: nextPlan.count, pointAdding: false,
        pointMeasuring: false, pointMeasureIds: [], pointMeasureDistanceM: 0, pointMeasureTarget: null, pointHasEdits: true,
        pointAdjustingId: addedPoint.id, pointAdjustmentError: false,
        pointAdjustmentMessage: `${addedPoint.name} 号点已添加；原有点位未改变，可用方向键继续微调`,
        'pointMap.markers': pointMap.view.markers, 'pointMap.polyline': pointMap.view.polyline })
    } catch (error) {
      this.setData({ pointAdjustmentError: true,
        pointAdjustmentMessage: error?.message || '新增点位失败，请在水面内重试' })
    }
  },
  decreasePointCount() {
    if (!this.data.pointPlan || this.data.pointCount <= sampling.MIN_POINT_COUNT) return
    try {
      const removedName = this.data.pointPlan.points.at(-1).name
      const nextPlan = sampling.removeLastSamplingPoint(this.data.pointPlan)
      const pointMap = sampling.buildSamplingMap(nextPlan, data.wgs84ToGcj02)
      this._pointMapPoints = pointMap.includePoints
      this.setData({ pointPlan: nextPlan, pointCount: nextPlan.count, pointAdding: false,
        pointMeasuring: false, pointMeasureIds: [], pointMeasureDistanceM: 0, pointMeasureTarget: null, pointHasEdits: true,
        pointAdjustingId: 0, pointAdjustmentError: false,
        pointAdjustmentMessage: `${removedName} 号点已删除；其余点位位置保持不变`,
        'pointMap.markers': pointMap.view.markers, 'pointMap.polyline': pointMap.view.polyline })
    } catch (error) {
      this.setData({ pointAdjustmentError: true,
        pointAdjustmentMessage: error?.message || '删除点位失败' })
    }
  },
  exportPointKml() {
    if (this.data.pointExportLoading || !this.data.pointPlan) return
    const schemeLabel = this.data.pointPlan.schemeLabel || '采样方案'
    const fileName = `${this.data.selected.name_cn}_${schemeLabel}_${this.data.pointPlan.count}点.kml`
    const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`
    const content = `\ufeff${sampling.buildOviKml(this.data.selected, this.data.pointPlan)}`
    const fileSystem = wx.getFileSystemManager()
    if (typeof wx.shareFileMessage !== 'function' || typeof fileSystem.writeFileSync !== 'function') {
      this.setData({ pointExportError: '当前微信版本不支持KML文件分享，请升级微信后重试。' })
      return
    }
    this.setData({ pointExportLoading: true, pointExportError: '' })
    try {
      // shareFileMessage must stay in the original user-tap call stack. An async write callback loses that gesture.
      fileSystem.writeFileSync(filePath, content, 'utf8')
    } catch (error) {
      this.setData({ pointExportLoading: false,
        pointExportError: `KML 保存失败：${error?.errMsg || error?.message || error}` })
      return
    }
    wx.shareFileMessage({
      filePath, fileName,
      success: () => { this.setData({ pointExportLoading: false }); wx.showToast({ title: 'KML 已生成', icon: 'success' }) },
      fail: (error) => this.setData({ pointExportLoading: false,
        pointExportError: `KML 分享失败：${error?.errMsg || error?.message || error}` }),
    })
  },
  showWeatherSource() {
    const weather = this.data.weather
    if (!weather?.sourceUrl) return
    wx.showModal({
      title: `${weather.stationName}站 · 中央气象台`,
      content: `官方天气预报：\n${weather.sourceUrl}\n\n复制链接后粘贴到浏览器打开。`,
      confirmText: '复制链接', cancelText: '关闭',
      success: ({ confirm }) => {
        if (confirm) wx.setClipboardData({
          data: weather.sourceUrl,
          fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' }),
        })
      },
    })
  },
  fitMap() {
    if (this._mapReady && this._currentBounds?.length) this._mapContext.includePoints({ points: this._currentBounds, padding: [24, 24, 24, 24] })
  },
  overviewMap() {
    this.setData({ activeBasin: '' })
    if (this._mapReady && this._allBounds?.length) this._mapContext.includePoints({ points: this._allBounds, padding: [24, 24, 24, 24] })
  },
  toggleBasinLegend() { this.setData({ basinLegendCollapsed: !this.data.basinLegendCollapsed }) },
  focusBasin(event) {
    const basin = event.currentTarget.dataset.basin
    const points = (this.data.map?.markers || []).filter((marker) => this._markerBasins?.[marker.id] === basin)
    if (!points.length) return
    this.setData({ activeBasin: basin })
    if (this._mapReady) this._mapContext.includePoints({ points, padding: [36, 36, 36, 36] })
  },
  zoomMapIn() { this.changeMapZoom(1) },
  zoomMapOut() { this.changeMapZoom(-1) },
  changeMapZoom(delta) {
    if (this._mapReady) this._mapContext.getScale({ success: ({ scale }) => {
      if (this._mapReady) this.setData({ 'map.scale': Math.max(4, Math.min(18, scale + delta)) })
    } })
  },
  onBackPress() {
    if (!this.data.pointPreviewOpen) return false
    if (this.data.pointPickerOpen) {
      this.setData({ pointPickerOpen: false }, () => this.fitPointPreview())
      return true
    }
    this.closeSamplingPreview()
    return true
  },
  onPullDownRefresh() {
    return this.syncData(true)
  },
  onShareAppMessage() {
    return { title: '星地同步实验助手', path: `/pages/dashboard/dashboard?reservoir=${this.data.selected.id}` }
  },
})
