const data = require('../../utils/data')
const sampling = require('../../utils/sampling')

function errorMessage(error) {
  return error?.errMsg || error?.message || String(error || '未知错误')
}

Page({
  data: {
    selected: null,
    plan: null,
    count: 0,
    defaultCount: 0,
    maxPointCount: sampling.MAX_POINT_COUNT,
    map: null,
    exportLoading: false,
    exportError: '',
  },
  onLoad(options) {
    let id = options?.reservoir || getApp().globalData.selectedReservoirId
    try { id = decodeURIComponent(id) } catch (_) {}
    const selected = data.getReservoir(id) || data.getReservoirList()[0]
    getApp().selectReservoir(selected.id)
    const defaultCount = sampling.defaultPointCount(selected)
    this.setData({ selected, defaultCount, count: defaultCount })
    this.rebuild(defaultCount)
  },
  onReady() {
    this._mapContext = wx.createMapContext('sampling-map')
    this._mapReady = true
    this.fitMap()
  },
  onUnload() { this._mapReady = false },
  rebuild(count) {
    try {
      const plan = sampling.buildSamplingPlan(this.data.selected, count)
      const map = sampling.buildSamplingMap(plan, data.wgs84ToGcj02)
      this._mapPoints = map.includePoints
      this.setData({ plan, count: plan.count, map: map.view, exportError: '' }, () => this.fitMap())
    } catch (error) {
      this.setData({ exportError: `点位生成失败：${errorMessage(error)}` })
    }
  },
  decreaseCount() { if (this.data.count > 6) this.rebuild(this.data.count - 1) },
  increaseCount() { if (this.data.count < this.data.maxPointCount) this.rebuild(this.data.count + 1) },
  restoreDefault() { this.rebuild(this.data.defaultCount) },
  fitMap() {
    if (this._mapReady && this._mapPoints?.length) this._mapContext.includePoints({ points: this._mapPoints, padding: [42, 42, 42, 42] })
  },
  exportKml() {
    if (this.data.exportLoading || !this.data.plan) return
    const fileName = `${this.data.selected.name_cn}_${this.data.plan.count}个采样点.kml`
    const filePath = `${wx.env.USER_DATA_PATH}/${fileName}`
    const content = `\ufeff${sampling.buildOviKml(this.data.selected, this.data.plan)}`
    const fileSystem = wx.getFileSystemManager()
    if (typeof wx.shareFileMessage !== 'function' || typeof fileSystem.writeFileSync !== 'function') {
      this.setData({ exportError: '当前微信版本不支持KML文件分享，请升级微信后重试。' })
      return
    }
    this.setData({ exportLoading: true, exportError: '' })
    try {
      // Keep file creation synchronous so shareFileMessage remains directly associated with this tap.
      fileSystem.writeFileSync(filePath, content, 'utf8')
    } catch (error) {
      this.setData({ exportLoading: false, exportError: `KML 保存失败：${errorMessage(error)}` })
      return
    }
    wx.shareFileMessage({
      filePath,
      fileName,
      success: () => {
        this.setData({ exportLoading: false })
        wx.showToast({ title: 'KML 已生成', icon: 'success' })
      },
      fail: (error) => this.setData({ exportLoading: false, exportError: `KML 分享失败：${errorMessage(error)}` }),
    })
  },
  onShareAppMessage() {
    return { title: `${this.data.selected.name_cn}采样点设计`, path: `/pages/sampling/sampling?reservoir=${this.data.selected.id}` }
  },
})
