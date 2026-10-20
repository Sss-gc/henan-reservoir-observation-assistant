const data = require('../../utils/data')
const document = require('../../utils/document')
const { showTab, prepareTabPage } = require('../../utils/tab-page')

Page({
  data: { meta: data.meta, scope: '当前水库', selected: null, groups: [], count: 0,
    totalReservoirCount: data.getReservoirList().length, reservoirCount: 0,
    loading: false, documentLoading: false, documentError: '' },
  onLoad() { prepareTabPage() },
  async onShow() {
    showTab(this, 1)
    if (this.data.selected?.id !== getApp().globalData.selectedReservoirId || this._renderedAt !== data.meta.loadedAt) this.refreshPlan()
    if (data.hasRecentData()) return
    this.setData({ loading: !data.hasRecentData() })
    try { await data.refresh(); this.refreshPlan() }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
    finally { this.setData({ loading: false }) }
  },
  refreshPlan() {
    const reservoirs = data.getReservoirList()
    const selected = reservoirs.find((r) => r.id === getApp().globalData.selectedReservoirId)
    const groups = data.getPlanGroups(this.data.scope === '当前水库' ? selected.id : null)
    const records = groups.flatMap((group) => group.records)
    this._renderedAt = data.meta.loadedAt
    this.setData({ meta: { ...data.meta }, selected, groups, count: records.length,
      totalReservoirCount: reservoirs.length,
      reservoirCount: this.data.scope === '当前水库' ? (selected ? 1 : 0) : reservoirs.length })
  },
  selectScope(event) { if (this.data.documentLoading) return; this.setData({ scope: event.currentTarget.dataset.scope, documentError: '' }); this.refreshPlan() },
  async downloadWord() {
    if (this.data.loading || this.data.documentLoading || !this.data.selected) return
    this.setData({ documentLoading: true, documentError: '' })
    try { await document.downloadPlan(this.data.scope === '当前水库' ? 'current' : 'all', this.data.selected.id) }
    catch (error) {
      this.setData({ documentError: error.message || error.errMsg || 'Word下载失败，请稍后重试' })
    } finally { this.setData({ documentLoading: false }) }
  },
  copyPlan() {
    if (this.data.loading || !this.data.selected) return
    wx.setClipboardData({ data: data.buildPlanText(this.data.scope === '当前水库' ? this.data.selected.id : null) })
  },
  openPass(event) { wx.navigateTo({ url: `/pages/pass/pass?id=${encodeURIComponent(event.currentTarget.dataset.id)}` }) },
  backToReservoir() { wx.switchTab({ url: '/pages/dashboard/dashboard' }) },
})
