const network = require('../../utils/network')
const data = require('../../utils/data')
Page({
  data: { loading: false, error: '', accessCode: '' },
  onShow() { if (network.getSession()) wx.switchTab({ url: '/pages/dashboard/dashboard' }) },
  onAccessCode(event) { this.setData({ accessCode: event.detail.value }) },
  copyError() { if (this.data.error) wx.setClipboardData({ data: this.data.error }) },
  async submit() {
    if (this.data.loading) return
    this.setData({ loading: true, error: '' })
    try {
      await network.login(this.data.accessCode); data.reset(); this.setData({ accessCode: '' })
      wx.switchTab({ url: '/pages/dashboard/dashboard' })
    } catch (error) { this.setData({ error: error.message || error.errMsg || '登录失败，请稍后重试' }) }
    finally { this.setData({ loading: false }) }
  },
})
