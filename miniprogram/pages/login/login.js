const network = require('../../utils/network')
const data = require('../../utils/data')
Page({
  data: { email: '', password: '', loading: false, error: '' },
  onShow() { if (network.getSession()) wx.switchTab({ url: '/pages/dashboard/dashboard' }) },
  setEmail(event) { this.setData({ email: event.detail.value }) },
  setPassword(event) { this.setData({ password: event.detail.value }) },
  async submit() {
    if (this.data.loading) return
    const email = this.data.email.trim(), password = this.data.password
    if (!email || !password) { this.setData({ error: '请输入网站的邮箱和密码' }); return }
    this.setData({ loading: true, error: '' })
    try {
      await network.login(email, password); data.reset()
      this.setData({ password: '' }); wx.switchTab({ url: '/pages/dashboard/dashboard' })
    } catch (error) { this.setData({ error: error.message, password: '' }) }
    finally { this.setData({ loading: false }) }
  },
})
