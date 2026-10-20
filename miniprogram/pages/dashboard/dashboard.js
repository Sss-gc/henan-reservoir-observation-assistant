const data = require('../../utils/data')
const sampling = require('../../utils/sampling')
const { showTab, prepareTabPage } = require('../../utils/tab-page')

const BASIN_ORDER = ['黄河流域', '淮河流域', '长江流域', '海河流域']
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
    selected: null, keyword: '', pickerOpen: false, weatherDays: [],
    satellite: '全部卫星', satellites: [], recommendations: [], passes: [],
    passTotal: 0, visibleCount: 10, passFilter: '全部', weather: null, weatherPublishedDate: '', loading: false, syncError: '',
    map: null, pointPreviewOpen: false, pointPlan: null, pointMap: null, pointCount: 0,
    pointSchemes: [], pointSchemeId: 'sync', pointSchemeAdjustable: true,
    pointReservoirIndex: 0, pointExportLoading: false, pointExportError: '',
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
      this.setData({ pointPreviewOpen: true, pointSchemes: preview.pointSchemes,
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
    this.setData({ pointPreviewOpen: false }, () => {
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
  selectPointReservoir(event) {
    const index = Number(event.detail.value)
    const selected = this.data.reservoirs[index]
    if (!selected) return
    if (selected.id === this.data.selected.id) {
      this.setData({ pointReservoirIndex: index })
      return
    }
    this.loadReservoir(selected.id)
    const preview = createPointPreview(data.getReservoir(selected.id), this.data.pointSchemeId)
    this._pointMapPoints = preview.pointMap.includePoints
    this.setData({ pointReservoirIndex: index, pointSchemes: preview.pointSchemes,
      pointSchemeId: preview.pointSchemeId, pointSchemeAdjustable: preview.pointSchemeAdjustable,
      pointPlan: preview.pointPlan, pointMap: preview.pointMap.view, pointCount: preview.pointPlan.count,
      pointExportError: '' }, () => this.fitPointPreview())
  },
  rebuildPointPreview(count, schemeId = this.data.pointSchemeId) {
    const preview = createPointPreview(data.getReservoir(this.data.selected.id), schemeId, count)
    this._pointMapPoints = preview.pointMap.includePoints
    this.setData({ pointSchemes: preview.pointSchemes, pointSchemeId: preview.pointSchemeId,
      pointSchemeAdjustable: preview.pointSchemeAdjustable, pointPlan: preview.pointPlan,
      pointMap: preview.pointMap.view, pointCount: preview.pointPlan.count, pointExportError: '' },
      () => this.fitPointPreview())
  },
  selectPointScheme(event) {
    const schemeId = event.currentTarget.dataset.id
    if (!schemeId || schemeId === this.data.pointSchemeId) return
    this.rebuildPointPreview(undefined, schemeId)
  },
  decreasePointCount() {
    if (this.data.pointSchemeAdjustable && this.data.pointCount > 6) this.rebuildPointPreview(this.data.pointCount - 1)
  },
  increasePointCount() {
    if (this.data.pointSchemeAdjustable && this.data.pointCount < this.data.maxPointCount) {
      this.rebuildPointPreview(this.data.pointCount + 1)
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
