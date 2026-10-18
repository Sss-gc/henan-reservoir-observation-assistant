const data = require('../../utils/data')
const { showTab, hideTab } = require('../../utils/tab-page')

Page({
  data: {
    meta: data.meta, reservoirs: data.getReservoirList(), filteredReservoirs: [],
    selected: null, keyword: '', pickerOpen: false, weatherDays: [],
    satellite: '全部卫星', satellites: [], recommendations: [], passes: [],
    passTotal: 0, visibleCount: 10, passFilter: '全部', weather: null, weatherPublishedDate: '', loading: false, syncError: '',
    map: null, tabActive: false,
  },
  onLoad(options) {
    if (options && data.getReservoir(options.reservoir)) getApp().selectReservoir(options.reservoir)
  },
  onReady() {
    this._mapContext = wx.createMapContext('reservoir-map')
    this._mapReady = true; this.fitMap()
  },
  onUnload() { this._mapReady = false },
  onShow() {
    showTab(this, 0)
    const id = getApp().globalData.selectedReservoirId
    if (!this.data.selected || this.data.selected.id !== id) this.loadReservoir(id)
    return this.syncData()
  },
  onHide() { hideTab(this) },
  async syncData(force = false) {
    if (this.data.loading) return
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
    const map = data.buildNativeMapData(data.getMapData(selected.id))
    const weather = data.getWeather(selected.id)
    this._markerIds = map.markerIds; this._currentBounds = map.currentBounds; this._allBounds = map.allBounds
    this.setData({
      selected, weather, weatherPublishedDate: weather?.publishedAt?.slice(0, 10) || '未标注',
      weatherDays: data.getWeatherCards(selected.id), satellites: data.getSatelliteOptions(selected.id),
      satellite: resetFilters || !data.getSatelliteOptions(selected.id).includes(this.data.satellite) ? '全部卫星' : this.data.satellite,
      passFilter: resetFilters ? '全部' : this.data.passFilter, visibleCount: resetFilters ? 10 : this.data.visibleCount,
      keyword: '', pickerOpen: false,
      map: map.view,
    }, () => this.fitMap())
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
    this.setData({ keyword, pickerOpen: true, filteredReservoirs: this.data.reservoirs.filter((r) =>
      [r.name_cn, r.city, r.code].some((value) => value.toLowerCase().includes(query))) })
  },
  openPicker() { this.setData({ pickerOpen: true, filteredReservoirs: this.data.reservoirs }) },
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
    if (this._mapReady && this._allBounds?.length) this._mapContext.includePoints({ points: this._allBounds, padding: [24, 24, 24, 24] })
  },
  zoomMapIn() { this.changeMapZoom(1) },
  zoomMapOut() { this.changeMapZoom(-1) },
  changeMapZoom(delta) {
    if (this._mapReady) this._mapContext.getScale({ success: ({ scale }) => {
      if (this._mapReady) this.setData({ 'map.scale': Math.max(4, Math.min(18, scale + delta)) })
    } })
  },
  onPullDownRefresh() {
    return this.syncData(true)
  },
  onShareAppMessage() {
    return { title: '星地同步实验助手', path: `/pages/dashboard/dashboard?reservoir=${this.data.selected.id}` }
  },
})
