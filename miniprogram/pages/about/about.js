const { meta } = require('../../utils/data')
const data = require('../../utils/data')
const network = require('../../utils/network')

Page({
  data: { meta },
  onShow() { this.setData({ meta: { ...data.meta } }) },
  logout() { network.clearSession(); data.reset(); wx.reLaunch({ url: '/pages/login/login' }) },
})
