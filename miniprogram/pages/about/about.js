const { meta } = require('../../utils/data')
const data = require('../../utils/data')
const network = require('../../utils/network')

Page({
  data: { meta, website: 'https://henan-reservoir-observation-assistant.pages.dev/' },
  onShow() { this.setData({ meta: { ...data.meta } }) },
  copyWebsite() { wx.setClipboardData({ data: this.data.website }) },
  logout() { network.clearSession(); data.reset(); wx.reLaunch({ url: '/pages/login/login' }) },
})
