const data = require('../../utils/data')
const document = require('../../utils/document')

Page({
  data: { meta: data.meta, scope: '当前水库', selected: null, groups: [], count: 0, reservoirCount: 0, loading: false, documentLoading: false, documentError: '' },
  async onShow() {
    this.setData({ loading: true })
    try { await data.refresh(); this.refreshPlan() }
    catch (error) { wx.showToast({ title: error.message, icon: 'none' }) }
    finally { this.setData({ loading: false }) }
  },
  refreshPlan() {
    const selected = data.getReservoirList().find((r) => r.id === getApp().globalData.selectedReservoirId)
    const groups = data.getPlanGroups(this.data.scope === '当前水库' ? selected.id : null)
    const records = groups.flatMap((group) => group.records)
    this.setData({ meta: { ...data.meta }, selected, groups, count: records.length, reservoirCount: new Set(records.map((p) => p.reservoir_id)).size })
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
