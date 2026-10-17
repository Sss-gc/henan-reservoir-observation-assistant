const data = require('../../utils/data')
const network = require('../../utils/network')

Page({
  data: { meta: data.meta, pass: null, notFound: false, weather: null, error: '' },
  async onLoad(options) {
    if (!network.requireLogin()) return
    // WeChat already decodes query-string values before onLoad.
    try {
      await data.refresh()
      const pass = data.getPass(options.id)
      this.setData({ meta: { ...data.meta }, pass, notFound: !pass, weather: pass ? data.getWeather(pass.reservoir_id) : null })
    } catch (error) { if (error.unauthorized) network.requireLogin(); else this.setData({ error: error.message }) }
  },
  copyWindow() {
    const p = this.data.pass
    if (!p) return
    wx.setClipboardData({ data: [
      '【卫星完整覆盖窗口】',
      `${p.reservoirName} · ${p.satellite}`, `${p.date} ${p.time}（北京时间）`,
      `传感器：${p.sensor}；分辨率：${p.resolution_m} m；完整覆盖：${p.coverage}%`,
      `白天天气：${p.weatherLabel}；实验判断：${p.level}`,
      `耀光${p.glintLabel}风险，夹角 ${p.glintAngle}°`,
      `轨道生成时间：${this.data.meta.orbitGeneratedAt}`,
      `天气来源：中央气象台；更新时间：${this.data.weather?.fetchedAt || '未获取'}`,
      '窗口为几何预测，不代表卫星已安排成像。',
    ].join('\n') })
  },
  openPlan() {
    if (this.data.pass) getApp().selectReservoir(this.data.pass.reservoir_id)
    wx.switchTab({ url: '/pages/plan/plan' })
  },
})
