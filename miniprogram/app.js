const { getReservoir } = require('./utils/data')

App({
  globalData: { selectedReservoirId: 'HN_RSV_001' },
  onLaunch() {
    const saved = wx.getStorageSync('observer:selectedReservoir') || wx.getStorageSync('preview:selectedReservoir')
    if (getReservoir(saved)) this.globalData.selectedReservoirId = saved
  },
  selectReservoir(id) {
    if (!getReservoir(id)) return
    this.globalData.selectedReservoirId = id
    wx.setStorageSync('observer:selectedReservoir', id)
  },
})
